# Inistate MCP Server

MCP server for the [Inistate](https://inistate.com) platform — module discovery, entry management, and activity submission.

## Setup

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INISTATE_API_TOKEN` | Yes | — | Bearer token for Inistate API authentication |
| `INISTATE_API_BASE` | No | `https://api.inistate.com` | API base URL |

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

| Tool | Description |
|------|-------------|
| `list_workspaces` | List workspaces the user has access to |
| `set_workspace` | Set the active workspace |
| `list_modules` | List all discoverable modules in the workspace |
| `get_module_schema` | Get the canvas schema (basic or extended tier) |
| `get_module_canvas` | Get full module definition with stable IDs (round-trippable) |
| `list_entries` | Query entries with filters, sorting, and pagination |
| `get_entry` | Read a single entry by ID |
| `get_form` | Get form fields and defaults for an activity |
| `submit_activity` | Create, edit, delete, or run custom activities |
| `get_entry_history` | Get entry audit trail and comments |
| `upload_file` | Upload a file to S3 storage |
| `download_file` | Download a file (returns pre-signed URL) |
| `design_workflow` | Generate a scaffolded module template from a description |
| `validate_design` | Validate a module schema before creating or updating |
| `create_module` | Create a new module with schema |
| `update_module` | Update an existing module's schema |

## Resources

| URI | Description |
|-----|-------------|
| `inistate://modules` | List all modules |
| `inistate://modules/{name}/canvas` | Basic module schema (fields + states) |
| `inistate://modules/{name}/canvas/extended` | Extended schema with activities and flows |
| `inistate://schema` | FACTSOps schema definition (field types, colors, validation rules) |
| `inistate://design-guide` | FACTS Module Design Guide |

## Prompts

| Prompt | Description |
|--------|-------------|
| `design_factsops_workflow` | Guide an agent through designing a complete workflow module |
| `execute_activity` | Guide an agent through executing a specific activity |
| `diagnose_entry` | Guide an agent through investigating an entry's state and history |

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

### MCP Setup
1. Setup
```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

or

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz

```

2. Verify
```
mcp-publisher --help
```

3. Authenticate
```
mcp-publisher login github
```

4. Publish: see below

### Packaging & Versioning
```bash
# Example adding new feature
git checkout -b feat/add-user-tool


# After coding
npx changeset

# Choose:
# 
# minor
# Added new user search tool

# Release
npm run release

# This does:
# install dependencies
# test
# bump version + update changelog + sync server.json
# validate MCP server config
# build (via npm prepare hook)
# publish to npm
# publish to MCP registry
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
| `src/schema.test.ts` | Unit tests (50) | `designWorkflow`, `validateDesign`, helper functions (`isValidFieldType`, `isValidColor`, `isValidActor`, `suggestColorForState`) |
| `src/server.test.ts` | Integration tests (14) | Spins up the MCP server as a child process and exercises it through the official MCP SDK client — tool discovery, resource reads, prompt retrieval, and local tool calls |

Unit tests cover:
- Field type and color validation against the schema
- State color suggestion logic
- Design validation: duplicate names, invalid types/colors/actors, initial state rules, flow integrity, unreachable states, unused activities, AI confidence warnings
- Workflow design: pattern detection (approval, ticket, pipeline, record list), industry defaults
- Intent resolution: all 5 modes, context boosting, confidence scoring

Integration tests verify (no API token needed):
- All 17 tools, 5 resources, and 3 prompts are registered
- `design_workflow`, `validate_design` work end-to-end through the MCP protocol
- Static resources (`inistate://schema`, `inistate://design-guide`) return valid content
- All 3 prompts return correctly templated messages

### Interactive testing with MCP Inspector

```bash
INISTATE_API_TOKEN=your-token npm run inspector
```

Opens a browser UI where you can interactively call tools, inspect schemas, and see responses.
