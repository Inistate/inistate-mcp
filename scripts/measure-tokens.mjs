// Measure MCP server context cost.
// Spawns build/index.js, asks for tools/list, resources/list, prompts/list,
// then estimates tokens using the standard ~4 chars/token heuristic.

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ENTRY = resolve("build/index.js");

function estimateTokens(text) {
  // Heuristic: GPT-style BPE averages ~4 chars/token for English+JSON.
  // For dense identifiers/JSON it skews ~3.5; for prose ~4.5. Report both bounds.
  const chars = text.length;
  return {
    chars,
    estimateMid: Math.round(chars / 4),
    estimateLow: Math.round(chars / 4.5),
    estimateHigh: Math.round(chars / 3.5),
  };
}

function rpc(child, id, method, params = {}) {
  return new Promise((resolveP, rejectP) => {
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const onData = (buf) => {
      const lines = buf.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            child.stdout.off("data", onData);
            if (msg.error) rejectP(new Error(JSON.stringify(msg.error)));
            else resolveP(msg.result);
            return;
          }
        } catch { /* not our line */ }
      }
    };
    child.stdout.on("data", onData);
    child.stdin.write(req);
  });
}

async function main() {
  const child = spawn("node", [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  child.stderr.on("data", () => { /* swallow logs */ });

  // Initialize
  await rpc(child, 1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "measure", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await rpc(child, 2, "tools/list");
  const resources = await rpc(child, 3, "resources/list");
  const prompts = await rpc(child, 4, "prompts/list");

  // Switch to configure mode and re-fetch
  await rpc(child, 5, "tools/call", { name: "switch_mode", arguments: { mode: "configure" } });
  const toolsCfg = await rpc(child, 6, "tools/list");
  const resourcesCfg = await rpc(child, 7, "resources/list");
  const promptsCfg = await rpc(child, 8, "prompts/list");

  child.kill();

  function reportSurface(label, t, r, p) {
    const sections = {
      tools: JSON.stringify(t, null, 2),
      resources: JSON.stringify(r, null, 2),
      prompts: JSON.stringify(p, null, 2),
    };
    console.log(`\n=== ${label} ===\n`);
    let totalChars = 0;
    for (const [name, text] of Object.entries(sections)) {
      const tk = estimateTokens(text);
      totalChars += tk.chars;
      const count =
        name === "tools" ? t.tools?.length :
        name === "resources" ? r.resources?.length :
        p.prompts?.length;
      console.log(
        `${name.padEnd(10)} count=${String(count).padStart(2)}  chars=${String(tk.chars).padStart(6)}  tokens≈${tk.estimateMid}`,
      );
    }
    console.log(`TOTAL      chars=${totalChars}  tokens≈${Math.round(totalChars / 4)}`);
    return totalChars;
  }

  const runtimeChars = reportSurface("Runtime mode (default on connect)", tools, resources, prompts);
  const cfgChars = reportSurface("Configure mode (after switch_mode)", toolsCfg, resourcesCfg, promptsCfg);
  console.log(`\nDelta when switching to configure: +${cfgChars - runtimeChars} chars (~${Math.round((cfgChars - runtimeChars) / 4)} tokens)`);

  // Per-tool breakdown so we can see which tools cost the most
  console.log("\n--- Per-tool breakdown (description + inputSchema) ---");
  const rows = tools.tools.map((t) => {
    const text = JSON.stringify(t);
    return { name: t.name, chars: text.length, tokens: Math.round(text.length / 4) };
  }).sort((a, b) => b.chars - a.chars);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(22)} chars=${String(r.chars).padStart(5)}  tokens≈${r.tokens}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
