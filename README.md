# Inistate MCP Server

MCP server for the [Inistate](https://inistate.com) platform — module discovery, entry management, and activity submission.

## Setup

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INISTATE_API_TOKEN` | Yes | — | Bearer token for Inistate API authentication |
| `INISTATE_API_BASE` | No | `https://api.inistate.com` | API base URL |
| `INISTATE_MCP_MODE` | No | `configure` | Initial mode: `runtime`, `configure`, or `frontend` (see [Modes](#modes)) |
| `INISTATE_MCP_NO_SETUP` | No | — | Set to `1` to force server mode from a terminal (skip the interactive wizard) |
| `INISTATE_DEBUG_FILE` | No | — | Set to `1` to log write-path tool calls to `./debug.log`, or to a path to log there. Off by default; logs identifiers only, never field values |

### Install from npm (recommended)

No clone or build needed — `npx` will fetch and run the published package on demand:

```bash
npx -y inistate-mcp
```

Or install globally:

```bash
npm install -g inistate-mcp
inistate-mcp
```

### Interactive setup (recommended)

Run the binary in a terminal with no MCP client attached and it walks you through entering your API token and picks the right config file for your client:

```bash
npx -y inistate-mcp
# or, explicitly:
npx -y inistate-mcp setup
```

Supported clients: Claude Desktop, Claude Code (global or project-local `.mcp.json`), Cursor, Windsurf, Codex CLI, VS Code (user profile or workspace `.vscode/mcp.json`), Cline, Gemini CLI (global or workspace). Pick "Print config only" to get a JSON block to paste anywhere else.

The wizard only runs when stdin is a TTY (i.e., you launched it yourself). When an MCP client spawns the binary via piped stdio, it skips the wizard and runs as a normal MCP server — set `INISTATE_MCP_NO_SETUP=1` if you need to force server mode from a terminal.

### Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "inistate": {
      "command": "npx",
      "args": ["-y", "inistate-mcp"],
      "env": {
        "INISTATE_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Claude Code Configuration

```bash
claude mcp add inistate -e INISTATE_API_TOKEN=your-token-here -- npx -y inistate-mcp
```

### Install from source

```bash
git clone https://github.com/Inistate/inistate-mcp.git
cd inistate-mcp
npm install
npm run build
```

Then point your MCP client at `node /absolute/path/to/inistate-mcp/build/index.js`.

## Tools

Tools marked **(configure)** are only exposed in configure mode — see [Modes](#modes).

| Tool | Description |
|------|-------------|
| `list_workspaces` | List workspaces the user has access to |
| `set_workspace` | Set the active workspace |
| `list_modules` | List all discoverable modules in the workspace |
| `get_module_schema` | Get the canvas schema (basic or extended tier) **(configure)** |
| `get_module_canvas` | Get full module definition with stable IDs (round-trippable) **(configure)** |
| `list_entries` | Query entries with filters, sorting, and pagination |
| `get_entry` | Read a single entry by ID |
| `get_form` | Get form fields and defaults for an activity |
| `submit_activity` | Create, edit, delete, or run custom activities |
| `submit_activities` | Bulk variant — same activity applied to up to 100 entries in one call |
| `get_entry_history` | Get entry audit trail and comments |
| `request_upload_url` | Default upload path — get a presigned S3 URL to PUT file bytes to |
| `confirm_upload` | Confirm a presigned upload completed; returns the File/Image field path |
| `upload_file` | Fallback upload via base64/multipart (use only if the presigned flow fails) |
| `download_file` | Download a file (returns pre-signed URL) |
| `design_workflow` | Generate a scaffolded module template from a description **(configure)** |
| `validate_design` | Validate a module schema before creating or updating **(configure)** |
| `create_module` | Create a new module with schema **(configure)** |
| `update_module` | Update an existing module's schema **(configure)** |
| `switch_mode` | Switch the active mode (runtime / configure / frontend) |

## Resources

| URI | Description |
|-----|-------------|
| `inistate://modules` | List all modules |
| `inistate://modules/{name}/canvas` | Basic module schema (fields + states) |
| `inistate://modules/{name}/canvas/extended` | Extended schema with activities and flows |
| `inistate://guardrails` | Server-enforced `submit_activity` rules (read once per session) |
| `inistate://schema/runtime` | Runtime schema — entry/activity/file types and filter operators (default) |
| `inistate://schema/configure` | Module-design schema — write format, field types, colors **(configure)** |
| `inistate://design-guide` | FACTS Module Design Guide **(configure)** |
| `inistate://frontend-guide` | REST API reference for hand-written UIs **(frontend)** |

## Prompts

| Prompt | Description |
|--------|-------------|
| `design_factsops_workflow` | Guide an agent through designing a complete workflow module **(configure)** |
| `execute_activity` | Guide an agent through executing a specific activity |
| `diagnose_entry` | Guide an agent through investigating an entry's state and history |
| `modify_module` | Guide an agent through modifying an existing module's schema **(configure)** |

## Modes

The server exposes a focused tool/resource surface depending on the active mode, keeping agent context lean. Use `switch_mode` to change it, or set the initial mode via the `INISTATE_MCP_MODE` env var (default: `configure`).

| Mode | Surface |
|------|---------|
| `runtime` | Entry and activity operations only — querying, reading, submitting, files, history. The leanest surface for using existing modules. |
| `configure` | Everything in `runtime` plus the module-design tools, resources, and prompts (marked **(configure)** above). |
| `frontend` | Everything in `configure` plus the `inistate://frontend-guide` resource for building hand-written UIs against the REST API. |

Tools and resources marked **(configure)** / **(frontend)** are absent from the tool list in narrower modes — switch modes to reveal them.

## Typical Workflow

1. `list_workspaces` → `set_workspace` — select a workspace
2. `list_modules` — find the module you need
3. `get_module_schema` — understand its fields, states, and activities
4. `get_form` — discover required fields before submitting
5. `submit_activity` — create or update entries
6. `list_entries` — query and browse data
7. `get_entry_history` — review entry history

## Development

```bash
npm run watch          # Watch mode for TypeScript compilation
npm run inspector      # Test with MCP Inspector
```

## PM2 (Ubuntu/AWS)

Run the HTTP transport in production using PM2:

```bash
npm install
npm run build
npm run pm2:start
npx pm2 save
```

Enable startup on reboot:

```bash
sudo npx pm2 startup systemd -u ubuntu --hp /home/ubuntu
npx pm2 save
```

Common operations:

```bash
npm run pm2:restart
npm run pm2:logs
npm run pm2:stop
```

Set required environment variables (`INISTATE_API_TOKEN`, and optionally `INISTATE_API_URL`, `INISTATE_WORKSPACE_ID`, `OAUTH_ISSUER_URL`, `INISTATE_APP_URL`) in your shell, PM2 ecosystem `env`, or deployment secret manager before starting.

## Testing

### Run all tests

```bash
npm test
```

### Watch mode (re-runs on file changes)

```bash
npm run test:watch
```

### Test structure

Tests are in `src/` alongside the source files and use [Vitest](https://vitest.dev/):

| File | Type | What it covers |
|------|------|----------------|
| `src/schema.test.ts` | Unit tests (41) | `designWorkflow`, `validateDesign`, helper functions (`isValidFieldType`, `isValidColor`, `isValidActor`, `suggestColorForState`) |
| `src/activity-guard.test.ts` | Unit tests (35) | `submit_activity` guard rules — human/hybrid actor, state-change confirmation, confidence-inflation, reference-shape validation |
| `src/tools.schema.test.ts` | Unit tests (19) | Tool input-schema shapes and validation |
| `src/backend-capabilities.test.ts` | Unit tests (6) | Capability gating — Platform-only tools return a capability message on reduced backends |
| `src/server.test.ts` | Integration tests (15) | Spins up the MCP server as a child process and exercises it through the official MCP SDK client — mode-gated tool/resource/prompt discovery, `switch_mode`, resource reads, prompt retrieval, and local tool calls |

Unit tests cover:
- Field type and color validation against the schema
- State color suggestion logic
- Design validation: duplicate names, invalid types/colors/actors, initial state rules, flow integrity, unreachable states, unused activities, AI confidence warnings
- Workflow design: pattern detection (approval, ticket, pipeline, record list), industry defaults
- Intent resolution: all 5 modes, context boosting, confidence scoring

Integration tests verify (no API token needed):
- All 20 tools, 8 resources, and 4 prompts are registered (in configure mode)
- `design_workflow`, `validate_design` work end-to-end through the MCP protocol
- Static resources (`inistate://schema/runtime`, `inistate://design-guide`) return valid content
- All 4 prompts return correctly templated messages

### Interactive testing with MCP Inspector

```bash
INISTATE_API_TOKEN=your-token npm run inspector
```

Opens a browser UI where you can interactively call tools, inspect schemas, and see responses.
