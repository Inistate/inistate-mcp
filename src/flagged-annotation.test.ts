import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "./server.js";
import * as api from "./api.js";
import { __resetGuardCaches } from "./activity-guard.js";
import type { Backend, Capabilities, DownloadResult } from "./backend.js";

/**
 * Flagged-response annotation — when the platform suppresses a transition and
 * returns a bare `flagged: true`, the submit handlers must explain the flag
 * (flag_reason + agent_action) so agents stop retrying with higher confidence.
 * Exercised end-to-end through the MCP protocol with an in-process fake
 * backend over a linked in-memory transport pair (mirrors
 * backend-capabilities.test.ts).
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

// Submit results the tests swap per case. Factories return fresh objects —
// the handlers mutate the response when annotating.
let nextSubmitResult: () => Record<string, unknown> = () => ({});
let nextBulkResult: () => Record<string, unknown> = () => ({});

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

  setActiveWorkspace(): void {}
  async listWorkspaces(): Promise<unknown> { return []; }
  async getWorkspace(): Promise<unknown> { return {}; }
  async listModules(): Promise<unknown> { return []; }
  async getModuleSchema(): Promise<unknown> { return {}; }
  async getModuleCanvas(): Promise<unknown> { return {}; }
  async createModule(): Promise<unknown> { return {}; }
  async updateModule(): Promise<unknown> { return {}; }
  async listEntries(): Promise<unknown> { return {}; }
  async getEntry(): Promise<unknown> { return {}; }
  async getForm(): Promise<unknown> { return {}; }
  async submitActivity(): Promise<unknown> { return nextSubmitResult(); }
  async submitActivities(): Promise<unknown> { return nextBulkResult(); }
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

const AI = { reasoning: "test", model: "test-model", confidence: 0.6 };

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = LinkedTransport.createPair();
  const server = createServer({ backend: new FakeBackend() });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await server.connect(serverTransport as any);
  client = new Client({ name: "flag-test", version: "1.0.0" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.connect(clientTransport as any);
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  __resetGuardCaches();
  // The guard's schema/canvas lookups must not hit the network in tests.
  vi.spyOn(api, "get").mockRejectedValue(new Error("offline"));
});

describe("submit_activity — flagged annotation", () => {
  it("explains a flagged response", async () => {
    nextSubmitResult = () => ({ module: "Leave", activity: "create", entryId: 7, state: "Draft", flagged: true });
    const res = parse(await client.callTool({
      name: "submit_activity",
      arguments: { module: "Leave", activity: "create", input: { Title: "x" }, ai: AI },
    }));
    expect(res.flagged).toBe(true);
    expect(res.flag_reason).toContain("pending human review");
    expect(res.agent_action).toContain("Do not retry");
  });

  it("leaves unflagged responses unannotated", async () => {
    nextSubmitResult = () => ({ module: "Leave", activity: "create", entryId: 7, state: "Draft" });
    const res = parse(await client.callTool({
      name: "submit_activity",
      arguments: { module: "Leave", activity: "create", input: { Title: "x" }, ai: AI },
    }));
    expect(res.flag_reason).toBeUndefined();
    expect(res.agent_action).toBeUndefined();
  });

  it("blocks a higher-confidence retry after a flag", async () => {
    nextSubmitResult = () => ({ module: "Leave", activity: "create", entryId: 7, state: "Draft", flagged: true });
    await client.callTool({
      name: "submit_activity",
      arguments: { module: "Leave", activity: "create", input: { Title: "x" }, ai: AI },
    });
    const retry = await client.callTool({
      name: "submit_activity",
      arguments: { module: "Leave", activity: "create", input: { Title: "x" }, ai: { ...AI, confidence: 0.95 } },
    });
    expect(retry.isError).toBe(true);
    expect(parse(retry).error).toBe("confidence_inflation_blocked");
  });
});

describe("submit_activities — flagged annotation", () => {
  it("explains a batch containing flagged items", async () => {
    nextBulkResult = () => ({
      summary: { total: 2, succeeded: 1, failed: 0, flagged: 1 },
      results: [
        { index: 0, success: true, entryId: 8 },
        { index: 1, flagged: true, entryId: 9 },
      ],
    });
    const res = parse(await client.callTool({
      name: "submit_activities",
      arguments: {
        module: "Leave",
        activity: "create",
        ai: AI,
        items: [{ input: { Title: "a" } }, { input: { Title: "b" } }],
      },
    }));
    expect(res.flag_reason).toContain("pending human review");
    expect(res.agent_action).toContain("Do not retry");
  });

  it("leaves fully-successful batches unannotated", async () => {
    nextBulkResult = () => ({
      summary: { total: 1, succeeded: 1, failed: 0, flagged: 0 },
      results: [{ index: 0, success: true, entryId: 8 }],
    });
    const res = parse(await client.callTool({
      name: "submit_activities",
      arguments: { module: "Leave", activity: "create", ai: AI, items: [{ input: { Title: "a" } }] },
    }));
    expect(res.flag_reason).toBeUndefined();
  });
});
