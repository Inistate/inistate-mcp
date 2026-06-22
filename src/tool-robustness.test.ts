import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "./server.js";
import type { Backend, Capabilities, DownloadResult } from "./backend.js";

/**
 * Agent-input robustness — behaviors added after smoke-testing against small
 * models, which routinely send numeric/by-name workspace ids, percent-scale
 * confidence values, and typo'd state/sortBy names. Exercised end-to-end
 * through the MCP protocol with an in-process fake backend over a linked
 * in-memory transport pair (mirrors backend-capabilities.test.ts).
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

const WORKSPACES = [
  { id: 1138, name: "Inistate" },
  { id: 2234, name: "Test" },
];

const setWorkspaceCalls: string[] = [];
let lastSubmitPayload: Record<string, unknown> | null = null;
let lastBulkPayload: Record<string, unknown> | null = null;

class FakeBackend implements Backend {
  readonly kind = "cloud" as const;

  capabilities(): Capabilities {
    return {
      workspaces: true,
      governedHistory: true,
      files: true,
      authorization: true,
      governance: true,
      scaffold: false,
      modes: ["runtime", "configure", "frontend"],
    };
  }

  setActiveWorkspace(wsid: string): void {
    setWorkspaceCalls.push(wsid);
  }

  async listWorkspaces(): Promise<unknown> {
    return WORKSPACES;
  }

  async getWorkspace(workspaceId: string): Promise<unknown> {
    const ws = WORKSPACES.find((w) => String(w.id) === workspaceId);
    if (!ws) throw new Error("404 workspace not found");
    return { id: ws.id, name: ws.name, vectors: [{ name: "Projects", emoji: "📋", published: true }] };
  }

  async listModules(): Promise<unknown> { return []; }

  async getModuleSchema(): Promise<unknown> {
    return {
      name: "Projects",
      information: [
        { name: "Title", type: "Text" },
        { name: "Due Date", type: "Date" },
      ],
      states: ["Draft", "Active", "Closed"],
    };
  }

  async getModuleCanvas(): Promise<unknown> { return {}; }
  async createModule(): Promise<unknown> { return {}; }
  async updateModule(): Promise<unknown> { return {}; }

  async listEntries(): Promise<unknown> {
    return { module: "Projects", page: 0, pageSize: 50, totalItems: 0, hasMore: false, list: [] };
  }

  async getEntry(): Promise<unknown> { return {}; }
  async getForm(): Promise<unknown> { return {}; }

  async submitActivity(payload: Record<string, unknown>): Promise<unknown> {
    lastSubmitPayload = payload;
    return { entryId: 1 };
  }

  async submitActivities(payload: Record<string, unknown>): Promise<unknown> {
    lastBulkPayload = payload;
    return { results: [] };
  }

  async getEntryHistory(): Promise<unknown> { return {}; }
  async uploadFile(): Promise<unknown> { return {}; }
  async downloadFile(): Promise<DownloadResult> { return { redirectUrl: null, status: 200, body: {} }; }
  async requestUploadUrl(): Promise<unknown> { return {}; }
  async confirmUpload(): Promise<unknown> { return {}; }
  async scaffoldModule(): Promise<unknown> { throw new Error("not available"); }
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = LinkedTransport.createPair();
  const server = createServer({ backend: new FakeBackend() });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await server.connect(serverTransport as any);
  client = new Client({ name: "robustness-test", version: "1.0.0" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.connect(clientTransport as any);
});

afterAll(async () => {
  await client.close();
});

describe("set_workspace robustness", () => {
  it("accepts a numeric workspaceId", async () => {
    const res = parse(await client.callTool({
      name: "set_workspace",
      arguments: { workspaceId: 2234 },
    }));
    expect(res.workspaceId).toBe(2234);
    expect(res.name).toBe("Test");
    expect(res.modules).toEqual([{ name: "Projects", emoji: "📋" }]);
    expect(setWorkspaceCalls.at(-1)).toBe("2234");
  });

  it("resolves a workspace name, case-insensitively", async () => {
    const res = parse(await client.callTool({
      name: "set_workspace",
      arguments: { workspaceId: "inistate" },
    }));
    expect(res.workspaceId).toBe(1138);
    expect(setWorkspaceCalls.at(-1)).toBe("1138");
  });

  it("returns workspace_not_found without mutating the active workspace", async () => {
    const before = setWorkspaceCalls.length;
    const result = await client.callTool({
      name: "set_workspace",
      arguments: { workspaceId: "Nope" },
    });
    expect(result.isError).toBe(true);
    const res = parse(result);
    expect(res.error).toBe("workspace_not_found");
    expect(res.available).toEqual(WORKSPACES);
    expect(setWorkspaceCalls.length).toBe(before);
  });
});

describe("ai.confidence percent normalization", () => {
  it("normalizes confidence 100 to 1 on submit_activity", async () => {
    const result = await client.callTool({
      name: "submit_activity",
      arguments: {
        module: "Projects",
        activity: "create",
        input: { Title: "x" },
        ai: { reasoning: "test", model: "test-model", confidence: 100 },
      },
    });
    expect(result.isError).toBeFalsy();
    expect((lastSubmitPayload!.ai as Record<string, unknown>).confidence).toBe(1);
  });

  it("normalizes top-level and per-item confidence on submit_activities", async () => {
    const result = await client.callTool({
      name: "submit_activities",
      arguments: {
        module: "Projects",
        activity: "create",
        ai: { reasoning: "test", model: "test-model", confidence: 90 },
        items: [
          { input: { Title: "a" } },
          { input: { Title: "b" }, ai: { reasoning: "item", model: "test-model", confidence: 85 } },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    expect((lastBulkPayload!.ai as Record<string, unknown>).confidence).toBe(0.9);
    const items = lastBulkPayload!.items as Array<Record<string, unknown>>;
    expect((items[1].ai as Record<string, unknown>).confidence).toBe(0.85);
  });

  it("keeps 0-1 values untouched", async () => {
    await client.callTool({
      name: "submit_activity",
      arguments: {
        module: "Projects",
        activity: "create",
        input: { Title: "x" },
        ai: { reasoning: "test", model: "test-model", confidence: 0.7 },
      },
    });
    expect((lastSubmitPayload!.ai as Record<string, unknown>).confidence).toBe(0.7);
  });
});

describe("list_entries empty-result hints", () => {
  it("flags a nonexistent state and sortBy on an empty result", async () => {
    const res = parse(await client.callTool({
      name: "list_entries",
      arguments: { module: "Projects", state: "Activ", sortBy: "Deadline" },
    }));
    expect(res.hint).toContain("state 'Activ' does not exist");
    expect(res.hint).toContain("sortBy 'Deadline' is not a field");
    expect(res.hint).toContain("Due Date");
  });

  it("stays silent for valid names and system sort columns", async () => {
    const res = parse(await client.callTool({
      name: "list_entries",
      arguments: { module: "Projects", state: "Active", sortBy: "createdDate" },
    }));
    expect(res.hint).toBeUndefined();
  });
});
