import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import * as api from "./api.js";
import { SCHEMA, DESIGN_GUIDE } from "./schema.js";

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

  // 4. inistate://schema — the FACTSOps schema definition
  server.registerResource(
    "schema",
    "inistate://schema",
    {
      description:
        "The FACTSOps schema definition — field types, color palette, validation rules, workflow guide. Load this when entering design or modify mode.",
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
        "FACTS Module Design Guide — requirements gathering questions, state color system, SVG workflow diagram specification, and module design rules. Load this in design mode to generate workflow diagrams and ask structured requirements questions.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      return {
        contents: [{ uri: uri.href, text: DESIGN_GUIDE }],
      };
    },
  );
}
