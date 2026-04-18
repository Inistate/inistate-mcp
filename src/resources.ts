import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import * as api from "./api.js";
import { SCHEMA, SCHEMA_RUNTIME, SCHEMA_CONFIGURE, DESIGN_GUIDE } from "./schema.js";

export function registerResources(server: McpServer) {
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
        contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2) }],
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
        contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2) }],
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
        contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // 4a. inistate://schema/runtime — runtime operations (default)
  server.registerResource(
    "schema-runtime",
    "inistate://schema/runtime",
    {
      description:
        "DEFAULT resource — load this at session start for runtime operations: listing/reading entries, submitting activities, uploading/downloading files, reading history. Contains only the tools and types needed to USE existing modules: list_entries, get_entry, get_form, submit_activity, get_history, upload_file, request_upload_url, confirm_upload, download_file, plus field value shapes (File/Image/Module/User) and filter operators. Does NOT include module design content — if the user asks to create or update a module, load inistate://schema/configure + inistate://design-guide instead. Loading this AND configure together doubles context cost — pick one.",
      mimeType: "application/json",
    },
    async (uri) => {
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(SCHEMA_RUNTIME, null, 2) }],
      };
    },
  );

  // 4b. inistate://schema/configure — module design & configuration
  server.registerResource(
    "schema-configure",
    "inistate://schema/configure",
    {
      description:
        "Load ONLY when the user asks to create a new module, edit a module schema, or design a workflow. Contains ModuleSchema write format, FieldDefinition/StateDefinition/ActivityDefinition/FlowDefinition, state color palette with decision rules and keyword hints, module_types (workflow vs record list), and the configure-mode tools (get_module_schema, create_module, update_module). Pair with inistate://design-guide for a complete design context. Do NOT load for runtime data operations — use inistate://schema/runtime instead.",
      mimeType: "application/json",
    },
    async (uri) => {
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(SCHEMA_CONFIGURE, null, 2) }],
      };
    },
  );

  // 4c. inistate://schema — full schema (backward compatibility)
  server.registerResource(
    "schema",
    "inistate://schema",
    {
      description:
        "FULL FACTSOps schema — every tool, type, and design rule in one payload. Prefer inistate://schema/runtime or inistate://schema/configure for lower context cost. Use this only when you genuinely need both modes in one session or when building agents that can't load multiple resources.",
      mimeType: "application/json",
    },
    async (uri) => {
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(SCHEMA, null, 2) }],
      };
    },
  );

  // 5. inistate://design-guide — FACTS module design guide
  server.registerResource(
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
  );
}
