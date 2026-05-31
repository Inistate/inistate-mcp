import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "./server.js";
import { CloudBackend, type Backend, type Capabilities, type DownloadResult } from "./backend.js";

/**
 * Step 2 — capability-gated tool surface (MCP spec §1.6).
 *
 * The open server fronts any Backend. When the active backend reports a
 * capability as unavailable, the corresponding Platform-only tools return a
 * structured `capability_unavailable` message instead of attempting the call,
 * and switch_mode refuses modes the backend does not allow. `Both` tools pass
 * straight through. CloudBackend reports everything, so none of this fires for
 * the shipped default (covered by the other suites + the contract check below).
 *
 * A reduced-capability fake backend is injected in-process over a linked
 * in-memory transport pair — no child process, no network. The transport mirrors
 * the SDK's InMemoryTransport (whose package export subpath the bundler can't
 * resolve), kept deliberately minimal.
 */

/** Minimal in-process Transport pair (mirrors the SDK's InMemoryTransport). */
class LinkedTransport {
  onmessage?: (message: unknown, extra?: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  sessionId?: string;
  private other?: LinkedTransport;
  private queue: Array<{ message: unknown; extra?: unknown }> = [];

  static createPair(): [LinkedTransport, LinkedTransport] {
    const a = new LinkedTransport();
    const b = new LinkedTransport();
    a.other = b;
    b.other = a;
    return [a, b];
  }

  async start(): Promise<void> {
    while (this.queue.length) {
      const m = this.queue.shift()!;
      this.onmessage?.(m.message, m.extra);
    }
  }

  async send(message: unknown, options?: { relatedRequestId?: unknown }): Promise<void> {
    if (!this.other) throw new Error("Not connected");
    if (this.other.onmessage) {
      this.other.onmessage(message, { relatedRequestId: options?.relatedRequestId });
    } else {
      this.other.queue.push({ message });
    }
  }

  async close(): Promise<void> {
    const other = this.other;
    this.other = undefined;
    this.onclose?.();
    await other?.close();
  }

  setProtocolVersion(_version: string): void {}
}

/** A backend that serves modules/entries but withholds every governed capability. */
class FakeLocalBackend implements Backend {
  readonly kind = "local" as const;

  capabilities(): Capabilities {
    return {
      workspaces: false,
      governedHistory: false,
      files: false,
      authorization: false,
      modes: ["runtime", "configure"],
    };
  }

  setActiveWorkspace(): void {}

  // Platform-only verbs — gated before these are ever reached.
  async listWorkspaces(): Promise<unknown> { return {}; }
  async getWorkspace(): Promise<unknown> { return {}; }
  async getEntryHistory(): Promise<unknown> { return {}; }
  async uploadFile(): Promise<unknown> { return {}; }
  async downloadFile(): Promise<DownloadResult> { return { redirectUrl: null, status: 200, body: {} }; }
  async requestUploadUrl(): Promise<unknown> { return {}; }
  async confirmUpload(): Promise<unknown> { return {}; }

  // `Both` verbs — served. listModules carries a sentinel so the pass-through
  // test can prove the real handler ran (not a capability message).
  async listModules(): Promise<unknown> { return { list: [], totalItems: 0, _fake: true }; }
  async getModuleSchema(): Promise<unknown> { return { _fake: true }; }
  async getModuleCanvas(): Promise<unknown> { return { _fake: true }; }
  async createModule(): Promise<unknown> { return { _fake: true }; }
  async updateModule(): Promise<unknown> { return { _fake: true }; }
  async listEntries(): Promise<unknown> { return { _fake: true }; }
  async getEntry(): Promise<unknown> { return { _fake: true }; }
  async getForm(): Promise<unknown> { return { _fake: true }; }
  async submitActivity(): Promise<unknown> { return { _fake: true }; }
  async submitActivities(): Promise<unknown> { return { _fake: true }; }
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = LinkedTransport.createPair();
  const server = createServer({ backend: new FakeLocalBackend(), initialMode: "runtime" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await server.connect(serverTransport as any);
  client = new Client({ name: "cap-test", version: "1.0.0" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.connect(clientTransport as any);
});

afterAll(async () => {
  await client.close();
});

describe("capability gating — reduced backend", () => {
  it("workspaces capability gates list_workspaces and set_workspace", async () => {
    const a = parse(await client.callTool({ name: "list_workspaces", arguments: {} }));
    expect(a.error).toBe("capability_unavailable");
    expect(a.capability).toBe("workspaces");
    expect(a.backend).toBe("local");
    expect(a.upgrade).toMatch(/Inistate Platform/);

    const b = parse(await client.callTool({ name: "set_workspace", arguments: { workspaceId: "w1" } }));
    expect(b.error).toBe("capability_unavailable");
    expect(b.capability).toBe("workspaces");
  });

  it("governedHistory capability gates get_entry_history", async () => {
    const d = parse(await client.callTool({ name: "get_entry_history", arguments: { module: "M", entryId: 1 } }));
    expect(d.error).toBe("capability_unavailable");
    expect(d.capability).toBe("governed_history");
  });

  it("files capability gates all four file tools", async () => {
    const upload = parse(await client.callTool({ name: "upload_file", arguments: { module: "M", name: "f.txt", file: "AAAA" } }));
    expect(upload.capability).toBe("files");

    const download = parse(await client.callTool({ name: "download_file", arguments: { moduleName: "M", guid: "g", fileName: "f.txt" } }));
    expect(download.capability).toBe("files");

    const reqUrl = parse(await client.callTool({ name: "request_upload_url", arguments: { module: "M", fileName: "f.txt", fileSize: 10 } }));
    expect(reqUrl.capability).toBe("files");

    const confirm = parse(await client.callTool({ name: "confirm_upload", arguments: { s3Key: "k" } }));
    expect(confirm.capability).toBe("files");
  });

  it("`Both` tools pass through to the backend (no gating)", async () => {
    const d = parse(await client.callTool({ name: "list_modules", arguments: {} }));
    expect(d.error).toBeUndefined();
    expect(d._fake).toBe(true);
  });

  it("switch_mode refuses frontend but allows runtime/configure", async () => {
    const front = parse(await client.callTool({ name: "switch_mode", arguments: { mode: "frontend" } }));
    expect(front.error).toBe("capability_unavailable");
    expect(front.capability).toBe("frontend_guide");

    const conf = parse(await client.callTool({ name: "switch_mode", arguments: { mode: "configure" } }));
    expect(conf.mode).toBe("configure");

    const run = parse(await client.callTool({ name: "switch_mode", arguments: { mode: "runtime" } }));
    expect(run.mode).toBe("runtime");
  });
});

describe("CloudBackend capability contract", () => {
  it("reports the full governed surface and cloud kind", () => {
    const cloud = new CloudBackend();
    expect(cloud.kind).toBe("cloud");
    expect(cloud.capabilities()).toEqual({
      workspaces: true,
      governedHistory: true,
      files: true,
      authorization: true,
      modes: ["runtime", "configure", "frontend"],
    });
  });
});
