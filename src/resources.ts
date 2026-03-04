import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as api from "./api.js";

export function registerResources(server: McpServer) {
  // 1. inistate://modules — list all discoverable modules
  server.registerResource(
    "modules",
    "inistate://modules",
    {
      description: "List all discoverable modules in the current workspace",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await api.get("/api/m/discovery");
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // 2. inistate://modules/{moduleId}/canvas — basic canvas schema
  server.registerResource(
    "module-canvas",
    new ResourceTemplate("inistate://modules/{moduleId}/canvas", { list: undefined }),
    {
      description:
        "Get the basic canvas schema for a module: information fields, states, and listings",
      mimeType: "application/json",
    },
    async (uri, { moduleId }) => {
      const data = await api.get(`/api/m/${moduleId}/discovery?tier=basic`);
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // 3. inistate://modules/{moduleId}/canvas/extended — extended canvas schema
  server.registerResource(
    "module-canvas-extended",
    new ResourceTemplate("inistate://modules/{moduleId}/canvas/extended", {
      list: undefined,
    }),
    {
      description:
        "Get the extended canvas schema for a module: includes activities and flows in addition to basic schema",
      mimeType: "application/json",
    },
    async (uri, { moduleId }) => {
      const data = await api.get(`/api/m/${moduleId}/discovery?tier=extended`);
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
