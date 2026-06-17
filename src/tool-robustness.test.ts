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
let lastCreatePayload: Record<string, unknown> | null = null;
let lastUpdatePayload: Record<string, unknown> | null = null;

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

  async listModules(): Promise<unknown> {
    return [{ name: "Projects", emoji: "📋" }, { name: "Users", emoji: "👥" }];
  }

  async getModuleSchema(): Promise<unknown> {
    return {
      name: "Projects",
      information: [
        { name: "Title", type: "Text" },
        { name: "Due Date", type: "Date" },
        { name: "Owner", type: "User", module: "Users" },
      ],
      states: ["Draft", "Active", "Closed"],
    };
  }

  async getModuleCanvas(): Promise<unknown> {
    return {
      id: 1,
      name: "Projects",
      information: [
        { id: "FLD_TITLE", name: "Title", type: "Text" },
        { id: "FLD_DUE", name: "Due Date", type: "Date" },
        { id: "FLD_OWNER", name: "Owner", type: "User", connection: "Users" },
      ],
      states: [
        { id: "st-draft", name: "Draft", color: "#5A6070", initial: true },
        { id: "st-active", name: "Active", color: "#2A7B50" },
        { id: "st-closed", name: "Closed", color: "#1E6B45" },
      ],
      activities: [{ id: "act-start", name: "Start", actor: "human" }],
    };
  }

  async createModule(payload: Record<string, unknown>): Promise<unknown> {
    lastCreatePayload = payload;
    return { id: 1, ...payload };
  }

  async updateModule(payload: Record<string, unknown>): Promise<unknown> {
    lastUpdatePayload = payload;
    if (payload.name === "CanvasErr") {
      // Mirrors the platform's partial-information failure shape.
      throw Object.assign(new Error("Canvas consistency check failed"), {
        structured: {
          error: "Submission failed",
          message: "Canvas consistency check failed:\n[Menu]\n  default: Column references non-existent field 'Title'",
          details: null,
          agent_action: "Check the error message, correct the input, and retry.",
        },
      });
    }
    return {};
  }

  async listEntries(params: { module: string }): Promise<unknown> {
    const totalItems = params.module === "ProjectsWithData" ? 1 : 0;
    return {
      module: params.module,
      page: 0,
      pageSize: 50,
      totalItems,
      hasMore: false,
      list: totalItems > 0 ? [{ entryId: 1 }] : [],
    };
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

  // A weaker model dead-ended task_4 of the 2026-06-15 testbench by sending
  // confidence as the string "0.95" six times in a row — coerce it instead of
  // rejecting with -32602.
  it("coerces a stringly-typed confidence on submit_activity", async () => {
    const result = await client.callTool({
      name: "submit_activity",
      arguments: {
        module: "Projects",
        activity: "create",
        input: { Title: "x" },
        ai: { reasoning: "test", model: "test-model", confidence: "0.95" },
      },
    });
    expect(result.isError).toBeFalsy();
    expect((lastSubmitPayload!.ai as Record<string, unknown>).confidence).toBe(0.95);
  });

  it("coerces a stringly-typed percent confidence (\"100\" → 1)", async () => {
    const result = await client.callTool({
      name: "submit_activity",
      arguments: {
        module: "Projects",
        activity: "create",
        input: { Title: "x" },
        ai: { reasoning: "test", model: "test-model", confidence: "100" },
      },
    });
    expect(result.isError).toBeFalsy();
    expect((lastSubmitPayload!.ai as Record<string, unknown>).confidence).toBe(1);
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

  it("flags a fully unknown sortBy even when results are returned", async () => {
    const res = parse(await client.callTool({
      name: "list_entries",
      arguments: { module: "ProjectsWithData", sortBy: "Deadline" },
    }));
    expect(res.totalItems).toBe(1);
    expect(res.hint).toContain("sortBy 'Deadline' is not a field");
    expect(res.hint).not.toContain("0 results");
  });

  it("does not second-guess a case-insensitive sortBy match on non-empty results", async () => {
    const res = parse(await client.callTool({
      name: "list_entries",
      arguments: { module: "ProjectsWithData", sortBy: "due date" },
    }));
    expect(res.hint).toBeUndefined();
  });

  it("flags fields entries that match no field (silently omitted columns)", async () => {
    const res = parse(await client.callTool({
      name: "list_entries",
      arguments: { module: "ProjectsWithData", fields: ["Name", "Status", "Due Date"] },
    }));
    expect(res.hint).toContain("'Name', 'Status'");
    expect(res.hint).toContain("silently omitted");
  });

  it("stays silent when fields resolve (incl. case-insensitive and system fields)", async () => {
    const res = parse(await client.callTool({
      name: "list_entries",
      arguments: { module: "ProjectsWithData", fields: ["Title", "due date", "state"] },
    }));
    expect(res.hint).toBeUndefined();
  });
});

describe("submit_activity input key guard", () => {
  const ai = { reasoning: "test", model: "test-model", confidence: 0.9 };

  it("rejects input keys that match no field instead of dropping them silently", async () => {
    const result = await client.callTool({
      name: "submit_activity",
      arguments: {
        module: "Projects",
        activity: "create",
        input: { Title: "x", Bogus: "y" },
        ai,
      },
    });
    expect(result.isError).toBe(true);
    const res = parse(result);
    expect(res.error).toBe("unknown_input_fields");
    expect(res.unknown).toEqual(["Bogus"]);
    expect(res.message).toContain("Due Date");
  });

  it("points a stray 'State' input key at the top-level state parameter", async () => {
    const result = await client.callTool({
      name: "submit_activity",
      arguments: {
        module: "Projects",
        activity: "create",
        input: { Title: "x", State: "Active" },
        ai,
      },
    });
    expect(result.isError).toBe(true);
    const res = parse(result);
    expect(res.agent_action).toContain("top-level `state` parameter");
  });

  it("remaps near-miss keys to the exact field name and reports it", async () => {
    const result = await client.callTool({
      name: "submit_activity",
      arguments: {
        module: "Projects",
        activity: "create",
        input: { title: "x", "due date": "2026-01-01" },
        ai,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(lastSubmitPayload!.input).toEqual({ Title: "x", "Due Date": "2026-01-01" });
    const res = parse(result);
    expect(res.input_key_notes.join(" ")).toContain("'title' matched field 'Title'");
  });

  it("blocks the whole batch when any item has unknown keys", async () => {
    const result = await client.callTool({
      name: "submit_activities",
      arguments: {
        module: "Projects",
        activity: "create",
        ai,
        items: [{ input: { Title: "a" } }, { input: { Wrong: "b" } }],
      },
    });
    expect(result.isError).toBe(true);
    const res = parse(result);
    expect(res.error).toBe("unknown_input_fields");
    expect(res.items).toEqual([{ idx: 1, unknown: ["Wrong"] }]);
  });

  it("remaps near-miss keys per item in bulk", async () => {
    const result = await client.callTool({
      name: "submit_activities",
      arguments: {
        module: "Projects",
        activity: "create",
        ai,
        items: [{ input: { title: "a" } }, { input: { title: "b" } }],
      },
    });
    expect(result.isError).toBeFalsy();
    const items = lastBulkPayload!.items as Array<{ input: Record<string, unknown> }>;
    expect(items[0].input).toEqual({ Title: "a" });
    expect(items[1].input).toEqual({ Title: "b" });
    const res = parse(result);
    expect(res.input_key_notes).toHaveLength(1); // deduped
  });
});

describe("design tools — connection targets and input repair", () => {
  it("validate_design flags a connection to a module that does not exist", async () => {
    const res = parse(await client.callTool({
      name: "validate_design",
      arguments: {
        schema: {
          name: "Things",
          information: [{ name: "Owner", type: "User", connection: "Members" }],
        },
      },
    }));
    expect(res.valid).toBe(false);
    expect(res.errors.some((e: string) => e.includes("'Members'") && e.includes("does not exist in this workspace"))).toBe(true);
    expect(res.errors.some((e: string) => e.includes("Projects, Users"))).toBe(true);
  });

  it("validate_design accepts existing modules and self-references", async () => {
    const res = parse(await client.callTool({
      name: "validate_design",
      arguments: {
        schema: {
          name: "Things",
          information: [
            { name: "Owner", type: "User", connection: "Users" },
            { name: "Parent", type: "Module", connection: "Things" },
          ],
        },
      },
    }));
    expect(res.valid).toBe(true);
  });

  it("create_module blocks a dangling connection in pre-flight", async () => {
    const result = await client.callTool({
      name: "create_module",
      arguments: {
        name: "Dangle",
        information: [{ name: "Owner", type: "User", connection: "Members" }],
      },
    });
    expect(result.isError).toBe(true);
    const res = parse(result);
    expect(res.error).toBe("validation_failed");
    expect(res.errors.some((e: string) => e.includes("'Members'"))).toBe(true);
  });

  it("create_module repairs displayName, object options, and Select alias", async () => {
    const result = await client.callTool({
      name: "create_module",
      arguments: {
        name: "Repaired",
        information: [
          {
            displayName: "Priority",
            type: "Select",
            options: [{ label: "Low" }, { value: "High" }],
          },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const info = lastCreatePayload!.information as Array<Record<string, unknown>>;
    expect(info[0].name).toBe("Priority");
    expect(info[0].type).toBe("Selection");
    expect(info[0].options).toEqual(["Low", "High"]);
  });

  it("create_module accepts fromState/toState flow keys", async () => {
    const result = await client.callTool({
      name: "create_module",
      arguments: {
        name: "Flowy",
        information: [{ name: "T", type: "Text" }],
        states: [
          { name: "A", color: "#5A6070", initial: true },
          { name: "B", color: "#1E6B45" },
        ],
        activities: [{ name: "Go", actor: "human" }],
        flows: [{ fromState: "A", toState: "B", activity: "Go" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const flows = lastCreatePayload!.flows as Array<Record<string, unknown>>;
    expect(flows[0]).toMatchObject({ from: "A", to: "B", activity: "Go" });
  });

  it("update_module explains section-replacement on a canvas consistency failure", async () => {
    const result = await client.callTool({
      name: "update_module",
      arguments: {
        id: 1,
        name: "CanvasErr",
        information: [{ name: "A", type: "Text" }],
      },
    });
    expect(result.isError).toBe(true);
    const res = parse(result);
    expect(res.agent_action).toContain("get_module_canvas");
    expect(res.agent_action).toContain("replaces");
  });

  it("create_module repairs actor 'user' and a flow 'state' target", async () => {
    const result = await client.callTool({
      name: "create_module",
      arguments: {
        name: "Aliased",
        information: [{ name: "T", type: "Text" }],
        states: [
          { name: "A", color: "#5A6070", initial: true },
          { name: "B", color: "#1E6B45" },
        ],
        activities: [{ name: "Go", actor: "user" }],
        flows: [{ from: "A", state: "B", activity: "Go" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const acts = lastCreatePayload!.activities as Array<Record<string, unknown>>;
    expect(acts[0].actor).toBe("human");
    const flows = lastCreatePayload!.flows as Array<Record<string, unknown>>;
    expect(flows[0]).toMatchObject({ from: "A", to: "B", activity: "Go" });
  });

  it("create_module reports a flow missing 'activity' as a structured error, not a Zod rejection", async () => {
    const result = await client.callTool({
      name: "create_module",
      arguments: {
        name: "FlowMiss",
        information: [{ name: "T", type: "Text" }],
        states: [
          { name: "A", color: "#5A6070", initial: true },
          { name: "B", color: "#1E6B45" },
        ],
        activities: [{ name: "Go", actor: "human" }],
        flows: [{ from: "A", to: "B" }],
      },
    });
    expect(result.isError).toBe(true);
    const res = parse(result);
    expect(res.error).toBe("validation_failed");
    expect(res.errors.some((e: string) => e.includes("missing 'activity'"))).toBe(true);
  });

  it("update_module blocks an incomplete flow on a partial payload", async () => {
    const result = await client.callTool({
      name: "update_module",
      arguments: { id: 1, flows: [{ from: "A", to: "B" }] },
    });
    expect(result.isError).toBe(true);
    const res = parse(result);
    expect(res.error).toBe("validation_failed");
    expect(res.errors.some((e: string) => e.includes("missing 'activity'"))).toBe(true);
  });
});

// Two input-shape mismatches that the 2026-06-15 testbench showed weaker
// models thrash on for many calls without recovering: scalar primitives sent
// as strings, and arrays SOAP/XML-wrapped as { item: [...] }.
describe("design tools — stringly-typed primitives and {item} wrapping", () => {
  it("create_module coerces string 'initial' and string confidence_threshold", async () => {
    const result = await client.callTool({
      name: "create_module",
      arguments: {
        name: "Stringy",
        information: [{ name: "T", type: "Text" }],
        states: [
          { name: "A", color: "#5A6070", initial: "true" },
          { name: "B", color: "#1E6B45" },
        ],
        activities: [{ name: "Go", actor: "human", confidence_threshold: "0.85" }],
        flows: [{ from: "A", to: "B", activity: "Go" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const states = lastCreatePayload!.states as Array<Record<string, unknown>>;
    expect(states[0].initial).toBe(true);
    const acts = lastCreatePayload!.activities as Array<Record<string, unknown>>;
    expect(acts[0].confidence_threshold).toBe(0.85);
  });

  it("create_module unwraps {item:[…]} sections and nested options", async () => {
    const result = await client.callTool({
      name: "create_module",
      arguments: {
        name: "Wrapped",
        information: {
          item: [
            { name: "T", type: "Text" },
            { name: "Priority", type: "Selection", options: { item: ["Low", "High"] } },
          ],
        },
        states: {
          item: [
            { name: "A", color: "#5A6070", initial: true },
            { name: "B", color: "#1E6B45" },
          ],
        },
        activities: { item: [{ name: "Go", actor: "human" }] },
        flows: { item: [{ from: "A", to: "B", activity: "Go" }] },
      },
    });
    expect(result.isError).toBeFalsy();
    const info = lastCreatePayload!.information as Array<Record<string, unknown>>;
    expect(info).toHaveLength(2);
    expect(info[1].options).toEqual(["Low", "High"]);
    expect((lastCreatePayload!.states as unknown[])).toHaveLength(2);
    expect((lastCreatePayload!.flows as unknown[])).toHaveLength(1);
  });

  it("create_module coerces 1/0-style and {item}-wrapped boolean 'initial'", async () => {
    const result = await client.callTool({
      name: "create_module",
      arguments: {
        name: "Boolish",
        information: [{ name: "T", type: "Text" }],
        states: [
          { name: "A", color: "#5A6070", initial: "1" },
          { name: "B", color: "#1E6B45", initial: { item: "false" } },
        ],
        activities: [{ name: "Go", actor: "human" }],
        flows: [{ from: "A", to: "B", activity: "Go" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const states = lastCreatePayload!.states as Array<Record<string, unknown>>;
    expect(states[0].initial).toBe(true);
    expect(states[1].initial).toBe(false);
  });

  it("create_module treats an empty-string activity 'fields' as absent", async () => {
    const result = await client.callTool({
      name: "create_module",
      arguments: {
        name: "EmptyFields",
        information: [{ name: "T", type: "Text" }],
        states: [
          { name: "A", color: "#5A6070", initial: true },
          { name: "B", color: "#1E6B45" },
        ],
        activities: [{ name: "Go", actor: "human", fields: "" }],
        flows: [{ from: "A", to: "B", activity: "Go" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const acts = lastCreatePayload!.activities as Array<Record<string, unknown>>;
    expect(acts[0].fields).toBeUndefined();
  });

  it("validate_design unwraps {item:[…]} instead of crashing on 'information is not iterable'", async () => {
    const result = await client.callTool({
      name: "validate_design",
      arguments: {
        schema: {
          name: "Wrapped",
          information: { item: [{ name: "T", type: "Text" }] },
          states: {
            item: [
              { name: "A", color: "#5A6070", initial: true },
              { name: "B", color: "#1E6B45" },
            ],
          },
          activities: { item: [{ name: "Go", actor: "human" }] },
          flows: { item: [{ from: "A", to: "B", activity: "Go" }] },
        },
        mode: "create",
      },
    });
    expect(result.isError).toBeFalsy();
    const res = parse(result);
    expect(res.valid).toBe(true);
    expect(res.summary.field_count).toBe(1);
    expect(res.summary.state_count).toBe(2);
  });
});

describe("submit_activity entryId normalization", () => {
  it("treats an empty-string entryId as absent", async () => {
    const result = await client.callTool({
      name: "submit_activity",
      arguments: {
        module: "Projects",
        activity: "create",
        entryId: "",
        input: { Title: "x" },
        ai: { reasoning: "test", model: "test-model", confidence: 0.9 },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(lastSubmitPayload!.entryId).toBeUndefined();
  });
});

describe("update_module unknown-id stripping", () => {
  it("strips ids that match no canvas element and reports them", async () => {
    const result = await client.callTool({
      name: "update_module",
      arguments: {
        id: 1,
        information: [
          { id: "FLD_TITLE", name: "Title", type: "Text" },
          { id: "FLD_DUE", name: "Due Date", type: "Date" },
          { id: "FLD_OWNER", name: "Owner", type: "User", connection: "Users" },
          { id: "field_priority", name: "Priority", type: "Selection", options: ["Low", "High"] },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const info = lastUpdatePayload!.information as Array<Record<string, unknown>>;
    expect(info[0].id).toBe("FLD_TITLE");
    expect(info[3].id).toBeUndefined();
    const res = parse(result);
    expect(res.hint).toContain("field_priority");
    expect(res.hint).toContain("created as new");
  });

  it("leaves payloads with only known ids untouched", async () => {
    const result = await client.callTool({
      name: "update_module",
      arguments: {
        id: 1,
        information: [
          { id: "FLD_TITLE", name: "Title", type: "Text" },
          { id: "FLD_DUE", name: "Due Date", type: "Date" },
          { id: "FLD_OWNER", name: "Renamed Owner", type: "User", connection: "Users" },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const res = parse(result);
    expect(res.hint).toBeUndefined();
    const info = lastUpdatePayload!.information as Array<Record<string, unknown>>;
    expect(info[2].id).toBe("FLD_OWNER");
  });
});

describe("reference id sanity", () => {
  const ai = { reasoning: "test", model: "test-model", confidence: 0.9 };

  it("rejects a display name standing in as a User id", async () => {
    const result = await client.callTool({
      name: "submit_activity",
      arguments: {
        module: "Projects",
        activity: "create",
        input: { Title: "x", Owner: { id: "carol", value: "Carol", username: "carol" } },
        ai,
      },
    });
    expect(result.isError).toBe(true);
    const res = parse(result);
    expect(res.error).toBe("invalid_reference_field_shape");
    expect(res.fields[0].message).toContain("display name");
  });

  it("accepts numeric ids round-tripped from list_entries", async () => {
    const result = await client.callTool({
      name: "submit_activity",
      arguments: {
        module: "Projects",
        activity: "create",
        input: { Title: "x", Owner: { id: 803224, value: "Carol", username: "carol" } },
        ai,
      },
    });
    expect(result.isError).toBeFalsy();
  });
});
