import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
const { version: pkgVersion } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
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
  /** Advertised server identity. Defaults to the open server's own name/version;
   *  an embedder (e.g. inistate-core) overrides it to identify as itself. */
  name?: string;
  version?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const { backend = new CloudBackend(), initialMode, name = "inistate-mcp", version = pkgVersion } = options;
  const caps = backend.capabilities();

  // Session-level orientation injected at initialize (clients that support
  // MCP instructions surface it as context). Encodes the canonical flows so
  // agents don't spend turns rediscovering them.
  const instructions = `Inistate MCP — canonical flows (minimize tool calls):
- Orient: list_workspaces (auto-selects if exactly one match) -> set_workspace. Both return the workspace's module list; list_modules is only for refreshing it.
- Read: list_entries with the fields parameter (keeps payloads small) and filters; get_entry for one record.
- Write: get_form once per (module, activity), then submit_activity; reuse the form schema for more entries of the same kind. Use submit_activities for bulk writes (max 100 per call).
- Design: design_workflow -> create_module (validates internally; validate_design is an optional dry-run). Modify: get_module_canvas -> edit -> update_module (full-canvas payloads validate internally).
- Files: request_upload_url -> PUT bytes -> confirm_upload (default); upload_file only if that flow fails.
- Guardrails: actor='human' activities are never executable by AI; hybrid actors, changeStatus, and state overrides need confirmed:true after explicit user approval. Load inistate://schema/runtime for response shapes and filter operators.`;

  const server = new McpServer(
    {
      name,
      version,
    },
    { instructions },
  );

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
        "Switch tool surface. 'configure' (default) = entry CRUD + module design tools and design resources. 'runtime' = entry CRUD plus get_module_schema (available in every mode). 'frontend' = configure + the inistate://frontend-guide resource (REST reference for building Vue/React UIs that call the Inistate API directly) — use it when the user wants a custom UI. The tool/resource list refreshes via list_changed after this call.",
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
            text: JSON.stringify({ mode: currentMode, message: `Switched to ${mode} mode` }),
          },
        ],
      };
    },
  );

  return server;
}
