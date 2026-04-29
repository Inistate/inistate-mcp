import {
  McpServer,
  RegisteredResource,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import * as api from "./api.js";
import { SCHEMA_RUNTIME, SCHEMA_CONFIGURE, DESIGN_GUIDE, FRONTEND_GUIDE } from "./schema.js";

export function registerResources(server: McpServer): {
  configureResources: RegisteredResource[];
  frontendResources: RegisteredResource[];
} {
  const configureResources: RegisteredResource[] = [];
  const frontendResources: RegisteredResource[] = [];
  // 1. inistate://modules — list all discoverable modules
  server.registerResource(
    "modules",
    "inistate://modules",
    {
      description:
        "List of all FACTSOps modules in the workspace — quick capability indexing",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await api.get("/api/mcp/");
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(data) }],
      };
    },
  );

  // 2. inistate://modules/{name}/canvas — basic canvas schema
  server.registerResource(
    "module-canvas",
    new ResourceTemplate("inistate://modules/{name}/canvas", {
      list: undefined,
    }),
    {
      description:
        "Base schema for a module: information fields and states",
      mimeType: "application/json",
    },
    async (uri, { name }) => {
      const moduleName = Array.isArray(name) ? name[0] : name;
      const data = await api.get(
        `/api/mcp/${api.enc(moduleName)}?tier=basic`,
      );
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(data) }],
      };
    },
  );

  // 3. inistate://modules/{name}/canvas/extended — extended canvas schema
  server.registerResource(
    "module-canvas-extended",
    new ResourceTemplate("inistate://modules/{name}/canvas/extended", {
      list: undefined,
    }),
    {
      description:
        "Full schema for a module: fields, states, activities, and flows",
      mimeType: "application/json",
    },
    async (uri, { name }) => {
      const moduleName = Array.isArray(name) ? name[0] : name;
      const data = await api.get(
        `/api/mcp/${api.enc(moduleName)}?tier=extended`,
      );
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(data) }],
      };
    },
  );

  // 4. inistate://guardrails — server-side submit_activity rules
  server.registerResource(
    "guardrails",
    "inistate://guardrails",
    {
      description:
        "Server-enforced rules for submit_activity. Read once per session — they apply silently and only surface as structured errors when triggered.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: `# submit_activity guard rules

The MCP server enforces four rules before forwarding submissions to the API.
Each rule, when triggered, returns a structured error with an \`agent_action\`
field telling you exactly what to do.

1. **Human actor** — activities with \`actor: "human"\` are rejected. AI cannot execute them under any condition. \`confirmed\` does not unlock.
2. **Hybrid actor** — activities with \`actor: "hybrid"\` require \`confirmed: true\`. Show the planned submission to the user, get explicit approval, then retry with \`confirmed: true\`.
3. **State change** — \`activity: "changeStatus"\` and any \`state\` override require \`confirmed: true\`. Do not initiate state changes on your own.
4. **Confidence inflation** — after a \`flagged: true\` response, resubmitting the same \`(module, entryId, activity)\` with higher confidence is rejected. Surface the flag to the user; only retry with \`confirmed: true\` if they explicitly authorize.

Standard activities (\`create\`, \`edit\`, \`delete\`, \`comment\`, \`duplicate\`, \`manage\`, \`view\`) skip the actor check but still trigger the state-change and confidence-inflation rules where applicable.
`,
        },
      ],
    }),
  );

  // 4a. inistate://schema/runtime — runtime operations (default)
  server.registerResource(
    "schema-runtime",
    "inistate://schema/runtime",
    {
      description:
        "DEFAULT resource — load this at session start for runtime operations: listing/reading entries, submitting activities, uploading/downloading files, reading history. Contains only the tools and types needed to USE existing modules: list_entries, get_entry, get_form, submit_activity, get_history, request_upload_url + confirm_upload (ALWAYS the default upload flow), download_file, upload_file (fallback only — use only if the presigned flow fails), plus field value shapes (File/Image/Module/User) and filter operators. Does NOT include module design content — if the user asks to create or update a module, load inistate://schema/configure + inistate://design-guide instead. Loading this AND configure together doubles context cost — pick one.",
      mimeType: "application/json",
    },
    async (uri) => {
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(SCHEMA_RUNTIME) }],
      };
    },
  );

  // 4b. inistate://schema/configure — module design & configuration (configure mode)
  configureResources.push(server.registerResource(
    "schema-configure",
    "inistate://schema/configure",
    {
      description:
        "Load ONLY when the user asks to create a new module, edit a module schema, or design a workflow. Contains ModuleSchema write format, FieldDefinition/StateDefinition/ActivityDefinition/FlowDefinition, state color palette with decision rules and keyword hints, module_types (workflow vs record list), and the configure-mode tools (get_module_schema, create_module, update_module). Pair with inistate://design-guide for a complete design context. Do NOT load for runtime data operations — use inistate://schema/runtime instead.",
      mimeType: "application/json",
    },
    async (uri) => {
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(SCHEMA_CONFIGURE) }],
      };
    },
  ));

  // 5. inistate://design-guide — FACTS module design guide (configure mode)
  configureResources.push(server.registerResource(
    "design-guide",
    "inistate://design-guide",
    {
      description:
        "FACTS Module Design Guide — requirements gathering questions, state color system, SVG workflow diagram specification, and module design rules. Load this in design mode alongside inistate://schema/configure to generate workflow diagrams and ask structured requirements questions. Do NOT load for runtime operations.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      return {
        contents: [{ uri: uri.href, text: DESIGN_GUIDE }],
      };
    },
  ));

  // 6. inistate://frontend-guide — REST API reference for generated UIs (frontend mode)
  frontendResources.push(server.registerResource(
    "frontend-guide",
    "inistate://frontend-guide",
    {
      description:
        "Load ONLY in frontend mode. REST API reference for hand-written Vue/React/etc. UIs that call api.inistate.com directly (no MCP). Covers: auth header + wsid, workspace/module discovery, list/read/form/submit/history endpoints, filter operator syntax, field value shapes (File/Image/User/Module), two-step presigned uploads, error shapes, and a framework-agnostic client plus minimal Vue and React reference patterns. Token is user-supplied at runtime — never hardcoded. Pair with get_module_schema(tier=extended) for the target module.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      return {
        contents: [{ uri: uri.href, text: FRONTEND_GUIDE }],
      };
    },
  ));

  return { configureResources, frontendResources };
}
