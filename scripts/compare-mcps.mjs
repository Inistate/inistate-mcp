// Compare context cost across MCP servers.
// Spawns each server, lists tools/resources/prompts, reports tokens (~chars/4).

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const CHARS_PER_TOKEN = 4;
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

const TMP = tmpdir();

const SERVERS = [
  {
    label: "inistate-mcp (runtime)",
    cmd: "node",
    args: [resolve("build/index.js")],
    env: { INISTATE_MCP_MODE: "runtime" },
  },
  {
    label: "inistate-mcp (configure)",
    cmd: "node",
    args: [resolve("build/index.js")],
    env: { INISTATE_MCP_MODE: "configure" },
  },
  {
    label: "@modelcontextprotocol/server-filesystem",
    cmd: NPX,
    args: ["-y", "@modelcontextprotocol/server-filesystem", TMP],
    env: {},
  },
  {
    label: "@modelcontextprotocol/server-memory",
    cmd: NPX,
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: {},
  },
  {
    label: "@modelcontextprotocol/server-everything",
    cmd: NPX,
    args: ["-y", "@modelcontextprotocol/server-everything"],
    env: {},
  },
  {
    label: "@modelcontextprotocol/server-sequential-thinking",
    cmd: NPX,
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    env: {},
  },
  // --- third-party ---
  {
    label: "@upstash/context7-mcp",
    cmd: NPX,
    args: ["-y", "@upstash/context7-mcp"],
    env: {},
  },
  {
    label: "@executeautomation/playwright-mcp-server",
    cmd: NPX,
    args: ["-y", "@executeautomation/playwright-mcp-server"],
    env: {},
  },
  {
    label: "@playwright/mcp",
    cmd: NPX,
    args: ["-y", "@playwright/mcp"],
    env: {},
  },
  {
    label: "chrome-devtools-mcp",
    cmd: NPX,
    args: ["-y", "chrome-devtools-mcp"],
    env: {},
  },
  {
    label: "@magicuidesign/mcp",
    cmd: NPX,
    args: ["-y", "@magicuidesign/mcp"],
    env: {},
  },
  {
    label: "firecrawl-mcp",
    cmd: NPX,
    args: ["-y", "firecrawl-mcp"],
    env: { FIRECRAWL_API_KEY: "dummy" },
  },
  {
    label: "tavily-mcp",
    cmd: NPX,
    args: ["-y", "tavily-mcp"],
    env: { TAVILY_API_KEY: "dummy" },
  },
  {
    label: "@notionhq/notion-mcp-server",
    cmd: NPX,
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: { NOTION_API_KEY: "dummy", OPENAPI_MCP_HEADERS: "{}" },
  },
];

function rpc(child, id, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolveP, rejectP) => {
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            child.stdout.off("data", onData);
            clearTimeout(t);
            if (msg.error) rejectP(new Error(JSON.stringify(msg.error)));
            else resolveP(msg.result);
            return;
          }
        } catch { /* skip */ }
      }
    };
    const t = setTimeout(() => {
      child.stdout.off("data", onData);
      rejectP(new Error(`RPC timeout: ${method}`));
    }, timeoutMs);
    child.stdout.on("data", onData);
    child.stdin.write(req);
  });
}

async function measureServer({ cmd, args, env }) {
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  child.stderr.on("data", () => {});
  child.on("error", () => {});

  try {
    await rpc(child, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "compare", version: "1" },
    }, 30000);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const result = { tools: { count: 0, chars: 0 }, resources: { count: 0, chars: 0 }, prompts: { count: 0, chars: 0 } };

    try {
      const t = await rpc(child, 2, "tools/list");
      result.tools.count = t.tools?.length ?? 0;
      result.tools.chars = JSON.stringify(t).length;
    } catch {}
    try {
      const r = await rpc(child, 3, "resources/list");
      result.resources.count = r.resources?.length ?? 0;
      result.resources.chars = JSON.stringify(r).length;
    } catch {}
    try {
      const p = await rpc(child, 4, "prompts/list");
      result.prompts.count = p.prompts?.length ?? 0;
      result.prompts.chars = JSON.stringify(p).length;
    } catch {}

    return result;
  } finally {
    child.kill();
  }
}

function tok(chars) {
  return Math.round(chars / CHARS_PER_TOKEN);
}

async function main() {
  const rows = [];
  for (const s of SERVERS) {
    process.stderr.write(`Measuring ${s.label}... `);
    try {
      const r = await measureServer(s);
      const totalChars = r.tools.chars + r.resources.chars + r.prompts.chars;
      rows.push({ label: s.label, ...r, totalChars });
      process.stderr.write("ok\n");
    } catch (e) {
      rows.push({ label: s.label, error: String(e.message) });
      process.stderr.write(`FAIL: ${e.message}\n`);
    }
  }

  console.log("\n| Server | Tools | Resources | Prompts | Total chars | Total tokens |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    if (r.error) {
      console.log(`| ${r.label} | — | — | — | — | error: ${r.error} |`);
      continue;
    }
    const t = `${r.tools.count} (${tok(r.tools.chars)})`;
    const res = `${r.resources.count} (${tok(r.resources.chars)})`;
    const p = `${r.prompts.count} (${tok(r.prompts.chars)})`;
    console.log(`| ${r.label} | ${t} | ${res} | ${p} | ${r.totalChars} | **${tok(r.totalChars)}** |`);
  }
  console.log("\nFormat for Tools/Resources/Prompts: `count (tokens)`");
}

main().catch((e) => { console.error(e); process.exit(1); });
