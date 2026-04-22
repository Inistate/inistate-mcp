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
  const { configureResources, frontendResources } = registerResources(server);
  const { configurePrompts } = registerPrompts(server);

  // Initial mode: runtime by default. Set INISTATE_MCP_MODE=configure to expose
  // the full configure surface on connect. Set INISTATE_MCP_MODE=frontend for
  // configure + the frontend-guide resource (for generating Vue/React UIs that
  // call the Inistate REST API directly).
  const envMode = (process.env.INISTATE_MCP_MODE || "").toLowerCase();
  const startConfigure = envMode === "configure" || envMode === "full" || envMode === "frontend";
  const startFrontend = envMode === "frontend";

  if (!startConfigure) {
    for (const t of configureTools) t.disable();
    for (const r of configureResources) r.disable();
    for (const p of configurePrompts) p.disable();
  }
  if (!startFrontend) {
    for (const r of frontendResources) r.disable();
  }

  let currentMode: "runtime" | "configure" | "frontend" =
    startFrontend ? "frontend" : startConfigure ? "configure" : "runtime";

  server.registerTool(
    "switch_mode",
    {
      description:
        "Switch tool surface. 'runtime' (default) exposes entry CRUD only. 'configure' adds module design tools (create_module, update_module, design_workflow, validate_design, get_module_canvas, get_module_schema) plus schema/configure and design-guide resources. 'frontend' is a superset of 'configure' that also exposes the inistate://frontend-guide resource — REST API reference for generating Vue/React UIs that call the Inistate API directly with a user-supplied token. Use 'frontend' when the user wants to build a custom UI (and optionally iterate on the schema in the same session). The tool/resource list refreshes via list_changed after this call.",
      inputSchema: {
        mode: z.enum(["runtime", "configure", "frontend"]).describe("Target mode"),
      },
    },
    async ({ mode }) => {
      const enableConfigure = mode === "configure" || mode === "frontend";
      const enableFrontend = mode === "frontend";
      for (const t of configureTools) enableConfigure ? t.enable() : t.disable();
      for (const r of configureResources) enableConfigure ? r.enable() : r.disable();
      for (const p of configurePrompts) enableConfigure ? p.enable() : p.disable();
      for (const r of frontendResources) enableFrontend ? r.enable() : r.disable();
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
