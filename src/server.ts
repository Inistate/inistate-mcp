import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "inistate-mcp",
    version: "1.0.0",
  });

  const { configureTools } = registerTools(server);
  const { configureResources } = registerResources(server);
  const { configurePrompts } = registerPrompts(server);

  // Start in runtime mode: configure-mode tools/resources/prompts are hidden until switch_mode is called.
  for (const t of configureTools) t.disable();
  for (const r of configureResources) r.disable();
  for (const p of configurePrompts) p.disable();

  let currentMode: "runtime" | "configure" = "runtime";

  server.registerTool(
    "switch_mode",
    {
      description:
        "Switch tool surface. 'runtime' (default) exposes entry CRUD only. 'configure' additionally exposes module design tools (create_module, update_module, design_workflow, validate_design, get_module_canvas, get_module_schema) plus the schema/configure and design-guide resources. Call with mode='configure' when the user asks to create, modify, or design a module; call with mode='runtime' to collapse back. The tool list refreshes via tools/list_changed after this call.",
      inputSchema: {
        mode: z.enum(["runtime", "configure"]).describe("Target mode"),
      },
    },
    async ({ mode }) => {
      const enable = mode === "configure";
      for (const t of configureTools) enable ? t.enable() : t.disable();
      for (const r of configureResources) enable ? r.enable() : r.disable();
      for (const p of configurePrompts) enable ? p.enable() : p.disable();
      currentMode = mode;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ mode: currentMode, message: `Switched to ${mode} mode` }, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
