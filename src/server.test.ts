import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Integration tests — spins up the MCP server as a child process
 * and exercises it through the official MCP client SDK.
 *
 * These tests do NOT call the Inistate API (no token needed).
 * They verify the server boots, registers tools/resources/prompts,
 * and that local-only tools (design_workflow, validate_design)
 * work end-to-end through the MCP protocol.
 */

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: "node",
    args: ["build/index.js"],
    env: {
      ...process.env,
      // No API token — we only test local tools
      INISTATE_ACCESS_TOKEN: "",
      // Pin to runtime so the discovery test exercises the narrowed surface;
      // the default startup mode is now `configure`.
      INISTATE_MCP_MODE: "runtime",
    },
  });
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

// ──────────────────────────────────────────────
// Server capability discovery
// ──────────────────────────────────────────────

describe("server discovery (runtime mode default)", () => {
  it("lists runtime tools and switch_mode; hides configure-mode tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    // runtime + always-on
    expect(names).toContain("list_workspaces");
    expect(names).toContain("set_workspace");
    expect(names).toContain("list_modules");
    expect(names).toContain("list_entries");
    expect(names).toContain("get_entry");
    expect(names).toContain("get_form");
    expect(names).toContain("submit_activity");
    expect(names).toContain("get_entry_history");
    expect(names).toContain("upload_file");
    expect(names).toContain("download_file");
    expect(names).toContain("request_upload_url");
    expect(names).toContain("confirm_upload");
    expect(names).toContain("switch_mode");
    // get_module_schema is read-only and available in every mode
    expect(names).toContain("get_module_schema");
    // configure-mode tools must be hidden
    expect(names).not.toContain("get_module_canvas");
    expect(names).not.toContain("design_workflow");
    expect(names).not.toContain("validate_design");
    expect(names).not.toContain("create_module");
    expect(names).not.toContain("update_module");
  });

  it("lists runtime resources; hides configure-mode resources", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("inistate://modules");
    expect(uris).toContain("inistate://schema/runtime");
    expect(uris).not.toContain("inistate://schema/configure");
    expect(uris).not.toContain("inistate://design-guide");
    expect(uris).not.toContain("inistate://schema");
  });

  it("lists runtime prompts; hides configure-mode prompts", async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain("execute_activity");
    expect(names).toContain("diagnose_entry");
    expect(names).not.toContain("design_factsops_workflow");
    expect(names).not.toContain("modify_module");
  });
});

describe("switch_mode tool", () => {
  afterAll(async () => {
    // Always leave the server in runtime mode for sibling describes.
    await client.callTool({ name: "switch_mode", arguments: { mode: "runtime" } });
  });

  it("unlocks configure-mode tools, resources, and prompts", async () => {
    await client.callTool({ name: "switch_mode", arguments: { mode: "configure" } });

    const toolNames = (await client.listTools()).tools.map((t) => t.name);
    expect(toolNames).toContain("create_module");
    expect(toolNames).toContain("update_module");
    expect(toolNames).toContain("design_workflow");
    expect(toolNames).toContain("validate_design");
    expect(toolNames).toContain("get_module_canvas");
    expect(toolNames).toContain("get_module_schema");

    const resourceUris = (await client.listResources()).resources.map((r) => r.uri);
    expect(resourceUris).toContain("inistate://schema/configure");
    expect(resourceUris).toContain("inistate://design-guide");

    const promptNames = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(promptNames).toContain("design_factsops_workflow");
    expect(promptNames).toContain("modify_module");
  });

  it("collapses configure-mode surface when switching back to runtime", async () => {
    await client.callTool({ name: "switch_mode", arguments: { mode: "runtime" } });

    const toolNames = (await client.listTools()).tools.map((t) => t.name);
    expect(toolNames).not.toContain("create_module");
    expect(toolNames).not.toContain("design_workflow");

    const resourceUris = (await client.listResources()).resources.map((r) => r.uri);
    expect(resourceUris).not.toContain("inistate://design-guide");
  });
});

// ──────────────────────────────────────────────
// Configure-mode surface (gated behind switch_mode)
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Runtime-mode static resources and prompts (always available)
// ──────────────────────────────────────────────

describe("runtime resources", () => {
  it("reads the schema/runtime resource", async () => {
    const result = await client.readResource({ uri: "inistate://schema/runtime" });
    expect(result.contents.length).toBe(1);
    const data = JSON.parse(result.contents[0].text as string);
    expect(data.definitions).toBeDefined();
    expect(data.definitions.FieldType).toBeDefined();
  });
});

describe("runtime prompts", () => {
  it("returns the execute_activity prompt", async () => {
    const result = await client.getPrompt({
      name: "execute_activity",
      arguments: { module: "Tasks", activity: "create" },
    });
    expect(result.messages.length).toBeGreaterThan(0);
    expect((result.messages[0].content as any).text).toContain("Tasks");
  });

  it("returns the diagnose_entry prompt", async () => {
    const result = await client.getPrompt({
      name: "diagnose_entry",
      arguments: { module: "Tasks", entryId: "42" },
    });
    expect(result.messages.length).toBeGreaterThan(0);
    expect((result.messages[0].content as any).text).toContain("42");
  });
});

// ──────────────────────────────────────────────
// Configure-mode surface (gated behind switch_mode)
// ──────────────────────────────────────────────

describe("configure mode", () => {
  beforeAll(async () => {
    await client.callTool({ name: "switch_mode", arguments: { mode: "configure" } });
  });
  afterAll(async () => {
    await client.callTool({ name: "switch_mode", arguments: { mode: "runtime" } });
  });

  describe("design_workflow tool", () => {
    it("returns a template for an approval workflow", async () => {
      const result = await client.callTool({
        name: "design_workflow",
        arguments: {
          description: "expense approval workflow",
          industry: "financial_services",
        },
      });
      const data = JSON.parse((result.content as any)[0].text);
      expect(data.suggestions.detected_pattern).toBe("approval_workflow");
      expect(data.template.states.length).toBeGreaterThan(0);
      expect(data.suggestions.industry_defaults.confidence_threshold).toBe(0.9);
    });

    it("returns a record list template for a directory", async () => {
      const result = await client.callTool({
        name: "design_workflow",
        arguments: {
          description: "vendor directory",
        },
      });
      const data = JSON.parse((result.content as any)[0].text);
      expect(data.suggestions.detected_pattern).toBe("record_list");
    });
  });

  describe("create_module pre-flight validation", () => {
    it("returns validation_failed locally without calling the API", async () => {
      const result = await client.callTool({
        name: "create_module",
        arguments: {
          name: "Broken Module",
          information: [
            { name: "Title", type: "Text" },
            { name: "Title", type: "Text" },
          ],
          states: [{ name: "A" }, { name: "B" }],
          activities: [{ name: "Go", actor: "human", fields: ["Missing"] }],
          flows: [{ from: "A", to: "Ghost", activity: "Nope" }],
        },
      });
      expect(result.isError).toBe(true);
      const data = JSON.parse((result.content as any)[0].text);
      expect(data.error).toBe("validation_failed");
      expect(data.errors.length).toBeGreaterThan(0);
      expect(data.agent_action).toContain("create_module");
    });
  });

  describe("update_module pre-flight validation", () => {
    it("validates full-canvas payloads locally", async () => {
      const result = await client.callTool({
        name: "update_module",
        arguments: {
          id: 123,
          information: [{ name: "Foo", type: "Bogus" }],
        },
      });
      expect(result.isError).toBe(true);
      const data = JSON.parse((result.content as any)[0].text);
      expect(data.error).toBe("validation_failed");
      expect(data.errors.some((e: string) => e.includes("Bogus"))).toBe(true);
    });
  });

  describe("validate_design tool", () => {
    it("validates a correct workflow schema", async () => {
      const result = await client.callTool({
        name: "validate_design",
        arguments: {
          schema: {
            name: "Test",
            information: [{ name: "Title", type: "Text" }],
            states: [
              { name: "Open", color: "#5A6070", initial: true },
              { name: "Closed", color: "#1E6B45" },
            ],
            activities: [{ name: "Close", actor: "human", fields: ["Title"] }],
            flows: [{ from: "Open", to: "Closed", activity: "Close" }],
          },
          mode: "create",
        },
      });
      const data = JSON.parse((result.content as any)[0].text);
      expect(data.valid).toBe(true);
      expect(data.errors).toHaveLength(0);
    });

    it("returns errors for an invalid schema", async () => {
      const result = await client.callTool({
        name: "validate_design",
        arguments: {
          schema: {
            name: "",
            states: [
              { name: "A", initial: true },
              { name: "B", initial: true },
            ],
          },
          mode: "create",
        },
      });
      const data = JSON.parse((result.content as any)[0].text);
      expect(data.valid).toBe(false);
      expect(data.errors.length).toBeGreaterThan(0);
    });
  });

  describe("design-guide resource", () => {
    it("reads the design-guide resource", async () => {
      const result = await client.readResource({ uri: "inistate://design-guide" });
      expect(result.contents.length).toBe(1);
      expect((result.contents[0].text as string).length).toBeGreaterThan(100);
    });
  });

  describe("configure prompts", () => {
    it("returns the design_factsops_workflow prompt", async () => {
      const result = await client.getPrompt({
        name: "design_factsops_workflow",
        arguments: { entity: "invoice" },
      });
      expect(result.messages.length).toBeGreaterThan(0);
      expect((result.messages[0].content as any).text).toContain("invoice");
    });

    it("returns the modify_module prompt", async () => {
      const result = await client.getPrompt({
        name: "modify_module",
        arguments: { module: "Tasks", change: "add a Priority field" },
      });
      expect(result.messages.length).toBeGreaterThan(0);
      expect((result.messages[0].content as any).text).toContain("Tasks");
      expect((result.messages[0].content as any).text).toContain("Priority");
    });
  });
});
