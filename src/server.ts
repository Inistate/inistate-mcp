import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { requestContext } from "./context.js";
import { setUserMode, type Mode } from "./mode-store.js";
import { Backend, CloudBackend } from "./backend.js";
import { capabilityMessage } from "./capability.js";

export interface CreateServerOptions {
  /** Data-plane backend. Defaults to CloudBackend (the hosted Inistate Platform). */
  backend?: Backend;
  /** Initial server mode (runtime / configure / frontend). */
  initialMode?: Mode;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const { backend = new CloudBackend(), initialMode } = options;
  const caps = backend.capabilities();

  const server = new McpServer({
    name: "inistate-mcp",
    version,
  });

  const { configureTools } = registerTools(server, backend);
  const { configureResources, frontendResources } = registerResources(server, backend);
  const { configurePrompts } = registerPrompts(server);

  // Initial mode: per-request override > env var > configure default.
  // Default exposes runtime CRUD + design (configure) tools on connect.
  // INISTATE_MCP_MODE=runtime narrows to entry CRUD only.
  // INISTATE_MCP_MODE=frontend adds the frontend-guide resource on top.
  // initialMode lets the HTTP transport (stateless, fresh server per request)
  // restore a per-user choice from the mode store.
  const envMode = (process.env.INISTATE_MCP_MODE || "").toLowerCase();
  const envResolved: Mode =
    envMode === "frontend"
      ? "frontend"
      : envMode === "runtime"
        ? "runtime"
        : "configure";
  const startMode: Mode = initialMode ?? envResolved;
  const startConfigure = startMode === "configure" || startMode === "frontend";
  const startFrontend = startMode === "frontend";

  if (!startConfigure) {
    for (const t of configureTools) t.disable();
    for (const r of configureResources) r.disable();
    for (const p of configurePrompts) p.disable();
  }
  if (!startFrontend) {
    for (const r of frontendResources) r.disable();
  }

  let currentMode: Mode = startMode;

  server.registerTool(
    "switch_mode",
    {
      description:
        "Switch tool surface. 'configure' (default) exposes entry CRUD plus module design tools (create_module, update_module, design_workflow, validate_design, get_module_canvas) and schema/configure and design-guide resources. 'runtime' narrows to entry CRUD plus get_module_schema (available in every mode). 'frontend' is a superset of 'configure' that also exposes the inistate://frontend-guide resource — REST API reference for generating Vue/React UIs that call the Inistate API directly with a user-supplied token. Use 'frontend' when the user wants to build a custom UI (and optionally iterate on the schema in the same session). The tool/resource list refreshes via list_changed after this call.",
      inputSchema: {
        mode: z.enum(["runtime", "configure", "frontend"]).describe("Target mode"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ mode }) => {
      if (!caps.modes.includes(mode)) {
        // The only mode a backend may withhold is `frontend` — its REST guide
        // targets the Platform API. runtime/configure are always available.
        return {
          content: [
            { type: "text", text: JSON.stringify(capabilityMessage("frontend_guide", backend.kind)) },
          ],
        };
      }
      const enableConfigure = mode === "configure" || mode === "frontend";
      const enableFrontend = mode === "frontend";
      for (const t of configureTools) enableConfigure ? t.enable() : t.disable();
      for (const r of configureResources) enableConfigure ? r.enable() : r.disable();
      for (const p of configurePrompts) enableConfigure ? p.enable() : p.disable();
      for (const r of frontendResources) enableFrontend ? r.enable() : r.disable();
      currentMode = mode;

      // Persist across the stateless HTTP transport's per-request servers.
      const userId = requestContext.getStore()?.userId;
      if (userId) setUserMode(userId, mode);

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
