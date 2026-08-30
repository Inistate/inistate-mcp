/**
 * SS05806 - DCR client registrations must survive a process restart.
 *
 * Before this, the clients store was a process-local Map: any restart (deploy, crash, pm2
 * restart) wiped every registered client_id, and a connector that had registered earlier got
 * `invalid_client` at /authorize. The only recovery was to delete and re-add the connector.
 *
 * A "restart" here is a second FileClientsStore over the same file — that is exactly what the
 * next process does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileClientsStore, defaultClientsFile } from "./client-store.js";

let dir: string;
let file: string;

const REGISTRATION = {
  client_name: "ChatGPT",
  redirect_uris: ["https://chatgpt.example/cb"],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oauth-clients-"));
  file = join(dir, "oauth-clients.json");
  delete process.env.OAUTH_KNOWN_CLIENTS;
  delete process.env.OAUTH_CLIENTS_FILE;
  delete process.env.INISTATE_DATA_DIR;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("FileClientsStore persistence (SS05806)", () => {
  it("a client registered before a restart is still known after it", () => {
    const before = new FileClientsStore(file);
    const registered = before.registerClient(REGISTRATION);

    // The restart.
    const after = new FileClientsStore(file);

    expect(after.getClient(registered.client_id)).toBeDefined();
    expect(after.getClient(registered.client_id)?.client_name).toBe("ChatGPT");
  });

  it("keeps every registration, not just the last", () => {
    const before = new FileClientsStore(file);
    const a = before.registerClient({ ...REGISTRATION, client_name: "A" });
    const b = before.registerClient({ ...REGISTRATION, client_name: "B" });

    const after = new FileClientsStore(file);

    expect(after.getClient(a.client_id)?.client_name).toBe("A");
    expect(after.getClient(b.client_id)?.client_name).toBe("B");
    expect(after.dump()).toHaveLength(2);
  });

  it("issues a distinct client_id per registration and stamps issued_at", () => {
    const store = new FileClientsStore(file);
    const a = store.registerClient(REGISTRATION);
    const b = store.registerClient(REGISTRATION);

    expect(a.client_id).not.toBe(b.client_id);
    expect(typeof a.client_id_issued_at).toBe("number");
  });

  it("writes the file on registration", () => {
    const store = new FileClientsStore(file);
    store.registerClient(REGISTRATION);

    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
  });

  it("an unknown client_id is still unknown", () => {
    const store = new FileClientsStore(file);
    expect(store.getClient("never-registered")).toBeUndefined();
  });

  describe("env seeding still works", () => {
    it("OAUTH_KNOWN_CLIENTS is loaded", () => {
      process.env.OAUTH_KNOWN_CLIENTS = JSON.stringify([
        { client_id: "pinned-1", client_name: "Pinned", redirect_uris: [] },
      ]);

      const store = new FileClientsStore(file);

      expect(store.getClient("pinned-1")?.client_name).toBe("Pinned");
    });

    it("a pinned client wins over a stale file entry of the same id", () => {
      writeFileSync(
        file,
        JSON.stringify([{ client_id: "pinned-1", client_name: "Stale", redirect_uris: [] }]),
        "utf8",
      );
      process.env.OAUTH_KNOWN_CLIENTS = JSON.stringify([
        { client_id: "pinned-1", client_name: "Pinned", redirect_uris: [] },
      ]);

      const store = new FileClientsStore(file);

      expect(store.getClient("pinned-1")?.client_name).toBe("Pinned");
    });

    it("malformed OAUTH_KNOWN_CLIENTS does not stop the store working", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.OAUTH_KNOWN_CLIENTS = "not json";

      const store = new FileClientsStore(file);
      const registered = store.registerClient(REGISTRATION);

      expect(store.getClient(registered.client_id)).toBeDefined();
    });
  });

  describe("fails soft — a disk problem must never take auth down", () => {
    it("a corrupt file is ignored and registration still works in memory", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      writeFileSync(file, "{ this is not json", "utf8");

      const store = new FileClientsStore(file);
      const registered = store.registerClient(REGISTRATION);

      expect(store.getClient(registered.client_id)).toBeDefined();
    });

    it("a corrupt file is left on disk rather than overwritten", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      writeFileSync(file, "{ this is not json", "utf8");

      new FileClientsStore(file).registerClient(REGISTRATION);

      // The only copy of the registrations must survive for inspection.
      expect(readFileSync(file, "utf8")).toBe("{ this is not json");
    });

    it("a JSON file that is not an array is ignored", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      writeFileSync(file, JSON.stringify({ nope: true }), "utf8");

      const store = new FileClientsStore(file);

      expect(store.dump()).toHaveLength(0);
    });

    it("entries without a client_id are skipped, the rest still load", () => {
      writeFileSync(
        file,
        JSON.stringify([{ client_name: "no id" }, { client_id: "ok-1", client_name: "Good" }]),
        "utf8",
      );

      const store = new FileClientsStore(file);

      expect(store.dump()).toHaveLength(1);
      expect(store.getClient("ok-1")?.client_name).toBe("Good");
    });

    it("an unwritable path does not throw — the registration is served from memory", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      // A path whose parent is a FILE cannot be created as a directory.
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "x", "utf8");

      const store = new FileClientsStore(join(blocker, "nested", "clients.json"));
      const registered = store.registerClient(REGISTRATION);

      expect(store.getClient(registered.client_id)).toBeDefined();
    });
  });

  describe("defaultClientsFile", () => {
    it("honours OAUTH_CLIENTS_FILE", () => {
      process.env.OAUTH_CLIENTS_FILE = "/custom/path.json";
      expect(defaultClientsFile()).toBe("/custom/path.json");
    });

    it("falls back to INISTATE_DATA_DIR", () => {
      process.env.INISTATE_DATA_DIR = join(dir, "data");
      expect(defaultClientsFile()).toBe(join(dir, "data", "oauth-clients.json"));
    });
  });
});
