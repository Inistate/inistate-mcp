import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface Client {
  id: string;
  label: string;
  configPath: string;
  configKey: string;
  format?: "json" | "toml";
  postInstallNote?: string;
}

function getClients(): Client[] {
  const home = os.homedir();
  const platform = process.platform;
  const appData =
    process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const xdgConfig =
    process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");

  let claudeDesktopPath: string;
  let vscodeUserDir: string;
  if (platform === "win32") {
    claudeDesktopPath = path.join(
      appData,
      "Claude",
      "claude_desktop_config.json",
    );
    vscodeUserDir = path.join(appData, "Code", "User");
  } else if (platform === "darwin") {
    claudeDesktopPath = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    vscodeUserDir = path.join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
    );
  } else {
    claudeDesktopPath = path.join(
      xdgConfig,
      "Claude",
      "claude_desktop_config.json",
    );
    vscodeUserDir = path.join(xdgConfig, "Code", "User");
  }

  const clinePath = path.join(
    vscodeUserDir,
    "globalStorage",
    "saoudrizwan.claude-dev",
    "settings",
    "cline_mcp_settings.json",
  );

  return [
    {
      id: "claude",
      label: "Claude Desktop",
      configPath: claudeDesktopPath,
      configKey: "mcpServers",
      postInstallNote: "Restart Claude Desktop to load the server.",
    },
    {
      id: "claude-code",
      label: "Claude Code (global)",
      configPath: path.join(home, ".claude.json"),
      configKey: "mcpServers",
      postInstallNote: "Run `claude` to start a session with the new server.",
    },
    {
      id: "claude-code-local",
      label: "Claude Code (project .mcp.json)",
      configPath: path.join(process.cwd(), ".mcp.json"),
      configKey: "mcpServers",
      postInstallNote: "Commit .mcp.json to share with your team.",
    },
    {
      id: "cursor",
      label: "Cursor",
      configPath: path.join(home, ".cursor", "mcp.json"),
      configKey: "mcpServers",
      postInstallNote: "Restart Cursor to load the server.",
    },
    {
      id: "windsurf",
      label: "Windsurf",
      configPath: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      configKey: "mcpServers",
      postInstallNote: "Restart Windsurf to load the server.",
    },
    {
      id: "codex",
      label: "Codex CLI",
      configPath: path.join(
        process.env.CODEX_HOME ?? path.join(home, ".codex"),
        "config.toml",
      ),
      configKey: "mcp_servers",
      format: "toml",
      postInstallNote: "Restart Codex to load the server.",
    },
    {
      id: "vscode",
      label: "VS Code (user profile)",
      configPath: path.join(vscodeUserDir, "mcp.json"),
      configKey: "servers",
      postInstallNote:
        "VS Code picks up changes automatically. Run \"MCP: List Servers\" to verify.",
    },
    {
      id: "vscode-workspace",
      label: "VS Code (workspace .vscode/mcp.json)",
      configPath: path.join(process.cwd(), ".vscode", "mcp.json"),
      configKey: "servers",
      postInstallNote:
        "Commit .vscode/mcp.json to share with your team. Open the workspace in VS Code to load it.",
    },
    {
      id: "cline",
      label: "Cline (VS Code extension)",
      configPath: clinePath,
      configKey: "mcpServers",
      postInstallNote:
        "Reload the Cline panel in VS Code to pick up the new server.",
    },
    {
      id: "gemini-cli",
      label: "Gemini CLI (global)",
      configPath: path.join(home, ".gemini", "settings.json"),
      configKey: "mcpServers",
      postInstallNote: "Restart Gemini CLI to load the server.",
    },
    {
      id: "gemini-cli-workspace",
      label: "Gemini CLI (workspace .gemini/settings.json)",
      configPath: path.join(process.cwd(), ".gemini", "settings.json"),
      configKey: "mcpServers",
      postInstallNote:
        "Commit .gemini/settings.json to share with your team.",
    },
  ];
}

async function readClientConfig(
  client: Client,
): Promise<Record<string, unknown> | null> {
  if (!fs.existsSync(client.configPath)) return {};
  const raw = fs.readFileSync(client.configPath, "utf8");
  try {
    if (client.format === "toml") {
      const TOML = await import("@iarna/toml");
      return TOML.parse(raw) as Record<string, unknown>;
    }
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeClientConfig(
  client: Client,
  config: Record<string, unknown>,
): Promise<void> {
  let body: string;
  if (client.format === "toml") {
    const TOML = await import("@iarna/toml");
    body = TOML.stringify(config as Parameters<typeof TOML.stringify>[0]);
  } else {
    body = `${JSON.stringify(config, null, 2)}\n`;
  }
  fs.writeFileSync(client.configPath, body);
}

async function ask(
  rl: readline.Interface,
  prompt: string,
  fallback?: string,
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || fallback || "";
}

function yes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

export async function runSetup(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log();
  console.log("Inistate MCP — interactive setup");
  console.log("──────────────────────────────────");
  console.log();

  try {
    let token = process.env.INISTATE_API_TOKEN ?? "";
    if (token) {
      const masked =
        token.length > 8
          ? `${token.slice(0, 4)}…${token.slice(-4)}`
          : "***";
      const reuse = await ask(
        rl,
        `Existing INISTATE_API_TOKEN detected (${masked}). Use it? (y/n)`,
        "y",
      );
      if (!yes(reuse)) token = "";
    }
    while (!token) {
      token = (
        await rl.question("Enter your Inistate API token: ")
      ).trim();
      if (!token) console.log("  Token cannot be empty.");
    }

    const apiBase = await ask(
      rl,
      "API base URL",
      process.env.INISTATE_API_BASE ?? "https://api.inistate.com",
    );

    const clients = getClients();
    console.log();
    console.log("Choose an MCP client to configure:");
    clients.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}`));
    console.log(`  ${clients.length + 1}. Print config only (don't write)`);
    console.log();
    const rawChoice = await ask(rl, "Select", "1");
    const choice = Number.parseInt(rawChoice, 10);
    if (
      Number.isNaN(choice) ||
      choice < 1 ||
      choice > clients.length + 1
    ) {
      console.error("Invalid choice.");
      process.exitCode = 1;
      return;
    }

    const env: Record<string, string> = { INISTATE_API_TOKEN: token };
    if (apiBase && apiBase !== "https://api.inistate.com") {
      env.INISTATE_API_BASE = apiBase;
    }
    const serverEntry = {
      command: "npx",
      args: ["-y", "inistate-mcp"],
      env,
    };

    if (choice === clients.length + 1) {
      console.log();
      console.log("Add this block to your client's MCP config:");
      console.log();
      console.log(
        JSON.stringify({ mcpServers: { inistate: serverEntry } }, null, 2),
      );
      return;
    }

    const client = clients[choice - 1];
    const configDir = path.dirname(client.configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    let config = await readClientConfig(client);
    if (config === null) {
      const overwrite = await ask(
        rl,
        `Could not parse ${client.configPath}. Overwrite? (y/n)`,
        "n",
      );
      if (!yes(overwrite)) {
        console.error("Aborting — fix the config file and re-run setup.");
        process.exitCode = 1;
        return;
      }
      config = {};
    }

    let servers = config[client.configKey];
    if (!servers || typeof servers !== "object") {
      servers = {};
      config[client.configKey] = servers;
    }
    const serversObj = servers as Record<string, unknown>;
    if (serversObj.inistate) {
      const overwrite = await ask(
        rl,
        `An "inistate" entry already exists in ${client.label}. Overwrite? (y/n)`,
        "y",
      );
      if (!yes(overwrite)) {
        console.log("Aborted — existing entry kept.");
        return;
      }
    }
    serversObj.inistate = serverEntry;

    await writeClientConfig(client, config);
    console.log();
    console.log(`Wrote ${client.configPath}`);
    if (client.postInstallNote) {
      console.log(client.postInstallNote);
    }
  } finally {
    rl.close();
  }
}
