#!/usr/bin/env node

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  const setupRequested = process.argv.slice(2).includes("setup");
  const interactive =
    process.stdin.isTTY && process.env.INISTATE_MCP_NO_SETUP !== "1";
  if (setupRequested || interactive) {
    const { runSetup } = await import("./setup.js");
    await runSetup();
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Inistate MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
