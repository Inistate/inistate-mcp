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

async function spawnServer(mode) {
  const child = spawn("node", [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, INISTATE_MCP_MODE: mode },
  });
  child.stderr.on("data", () => { /* swallow logs */ });
  await rpc(child, 1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "measure", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return child;
}

async function main() {
  // Runtime mode — narrowed surface
  const rt = await spawnServer("runtime");
  const tools = await rpc(rt, 2, "tools/list");
  const resources = await rpc(rt, 3, "resources/list");
  const prompts = await rpc(rt, 4, "prompts/list");

  // Read each resource to measure content cost (skip API-backed ones that need auth)
  const STATIC_URIS = [
    "inistate://schema/runtime",
    "inistate://guardrails",
  ];
  const resourceReads = {};
  for (const uri of STATIC_URIS) {
    try {
      const res = await rpc(rt, 100, "resources/read", { uri });
      resourceReads[uri] = res.contents?.[0]?.text ?? "";
    } catch (e) { resourceReads[uri] = ""; }
  }
  rt.kill();

  // Configure mode — full surface
  const cfg = await spawnServer("configure");
  const toolsCfg = await rpc(cfg, 2, "tools/list");
  const resourcesCfg = await rpc(cfg, 3, "resources/list");
  const promptsCfg = await rpc(cfg, 4, "prompts/list");
  const CFG_STATIC_URIS = [
    "inistate://schema/configure",
    "inistate://design-guide",
  ];
  for (const uri of CFG_STATIC_URIS) {
    try {
      const res = await rpc(cfg, 100, "resources/read", { uri });
      resourceReads[uri] = res.contents?.[0]?.text ?? "";
    } catch { resourceReads[uri] = ""; }
  }
  cfg.kill();

  function reportSurface(label, t, r, p) {
    // Compact JSON = what the MCP SDK actually sends over the wire.
    const sections = {
      tools: JSON.stringify(t),
      resources: JSON.stringify(r),
      prompts: JSON.stringify(p),
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

  const runtimeChars = reportSurface("Runtime mode (INISTATE_MCP_MODE=runtime)", tools, resources, prompts);
  const cfgChars = reportSurface("Configure mode (default startup)", toolsCfg, resourcesCfg, promptsCfg);
  console.log(`\nDelta runtime → configure: +${cfgChars - runtimeChars} chars (~${Math.round((cfgChars - runtimeChars) / 4)} tokens)`);

  // Resource content cost (paid only when AI reads the resource)
  console.log("\n=== Resource content (cost when AI reads the resource) ===\n");
  for (const [uri, text] of Object.entries(resourceReads)) {
    const tk = estimateTokens(text);
    console.log(`  ${uri.padEnd(36)} chars=${String(tk.chars).padStart(6)}  tokens≈${tk.estimateMid}`);
  }

  // Per-tool breakdown so we can see which tools cost the most
  console.log("\n=== Per-tool breakdown (configure mode, description + inputSchema) ===\n");
  const rows = toolsCfg.tools.map((t) => {
    const text = JSON.stringify(t);
    return { name: t.name, chars: text.length, tokens: Math.round(text.length / 4) };
  }).sort((a, b) => b.chars - a.chars);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(22)} chars=${String(r.chars).padStart(5)}  tokens≈${r.tokens}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
