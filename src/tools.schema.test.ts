import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Regression tests for tool inputSchema shapes.
 *
 * Purpose: catch accidental renames, removals, or additions to tool params.
 * Each test asserts the exact sorted set of property names and required params.
 * Descriptions, types, and defaults are intentionally not tested — only structural shape.
 */

type ToolList = Awaited<ReturnType<Client["listTools"]>>["tools"];

function shape(tools: ToolList, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  const s = tool.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    props: Object.keys(s.properties ?? {}).sort(),
    required: [...(s.required ?? [])].sort(),
  };
}

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: "node",
    args: ["build/index.js"],
    env: {
      ...process.env,
      INISTATE_ACCESS_TOKEN: "",
      INISTATE_MCP_MODE: "runtime",
    },
  });
  client = new Client({ name: "schema-test-client", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

// ─────────────────────────────────────────────────────────────
// Runtime tools (always available)
// ─────────────────────────────────────────────────────────────

describe("runtime tool schemas", () => {
  let tools: ToolList;

  beforeAll(async () => {
    tools = (await client.listTools()).tools;
  });

  it("list_workspaces", () => {
    expect(shape(tools, "list_workspaces")).toEqual({
      props: ["search"],
      required: [],
    });
  });

  it("set_workspace", () => {
    expect(shape(tools, "set_workspace")).toEqual({
      props: ["workspaceId"],
      required: ["workspaceId"],
    });
  });

  it("list_modules", () => {
    expect(shape(tools, "list_modules")).toEqual({
      props: ["workspaceId"],
      required: [],
    });
  });

  it("list_entries", () => {
    expect(shape(tools, "list_entries")).toEqual({
      props: ["currentPage", "filters", "module", "pageSize", "search", "sortBy", "sortDirection", "state", "workspaceId"],
      required: ["module"],
    });
  });

  it("get_entry", () => {
    expect(shape(tools, "get_entry")).toEqual({
      props: ["entryId", "module", "workspaceId"],
      required: ["entryId", "module"],
    });
  });

  it("get_form", () => {
    expect(shape(tools, "get_form")).toEqual({
      props: ["activity", "entryId", "module", "workspaceId"],
      required: ["module"],
    });
  });

  it("submit_activity", () => {
    expect(shape(tools, "submit_activity")).toEqual({
      props: ["activity", "ai", "assignees", "comment", "confirmed", "due", "entryId", "entryIds", "input", "module", "state", "workspaceId"],
      required: ["ai", "module"],
    });
  });

  it("get_entry_history", () => {
    expect(shape(tools, "get_entry_history")).toEqual({
      props: ["entryId", "module", "page", "workspaceId"],
      required: ["entryId", "module"],
    });
  });

  it("upload_file", () => {
    expect(shape(tools, "upload_file")).toEqual({
      props: ["file", "mimeType", "module", "name", "workspaceId"],
      required: ["file", "module", "name"],
    });
  });

  it("download_file", () => {
    expect(shape(tools, "download_file")).toEqual({
      props: ["fileName", "guid", "moduleName", "workspaceId"],
      required: ["fileName", "guid", "moduleName"],
    });
  });

  it("request_upload_url", () => {
    expect(shape(tools, "request_upload_url")).toEqual({
      props: ["contentType", "fileName", "fileSize", "module", "workspaceId"],
      required: ["fileName", "fileSize", "module"],
    });
  });

  it("confirm_upload", () => {
    expect(shape(tools, "confirm_upload")).toEqual({
      props: ["s3Key", "workspaceId"],
      required: ["s3Key"],
    });
  });

  it("switch_mode", () => {
    expect(shape(tools, "switch_mode")).toEqual({
      props: ["mode"],
      required: ["mode"],
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Configure tools (unlocked after switch_mode)
// ─────────────────────────────────────────────────────────────

describe("configure tool schemas", () => {
  let tools: ToolList;

  beforeAll(async () => {
    await client.callTool({ name: "switch_mode", arguments: { mode: "configure" } });
    tools = (await client.listTools()).tools;
  });

  afterAll(async () => {
    await client.callTool({ name: "switch_mode", arguments: { mode: "runtime" } });
  });

  it("get_module_schema", () => {
    expect(shape(tools, "get_module_schema")).toEqual({
      props: ["module", "tier", "workspaceId"],
      required: ["module"],
    });
  });

  it("get_module_canvas", () => {
    expect(shape(tools, "get_module_canvas")).toEqual({
      props: ["module", "workspaceId"],
      required: ["module"],
    });
  });

  it("design_workflow", () => {
    expect(shape(tools, "design_workflow")).toEqual({
      props: ["description", "industry"],
      required: ["description"],
    });
  });

  it("validate_design", () => {
    expect(shape(tools, "validate_design")).toEqual({
      props: ["mode", "schema"],
      required: ["schema"],
    });
  });

  it("create_module", () => {
    expect(shape(tools, "create_module")).toEqual({
      props: ["activities", "description", "flows", "icon", "information", "name", "states", "workspaceId"],
      required: ["name"],
    });
  });

  it("update_module", () => {
    expect(shape(tools, "update_module")).toEqual({
      props: ["activities", "description", "flows", "icon", "id", "information", "name", "states", "workspaceId"],
      required: ["id"],
    });
  });
});
