# Inistate MCP Server

MCP server for the [Inistate](https://inistate.com) platform — module discovery, entry management, and activity submission.

## Setup

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INISTATE_API_TOKEN` | Yes | — | Bearer token for Inistate API authentication |
| `INISTATE_API_URL` | No | `https://api.inistate.com` | API base URL |

### Install & Build

```bash
npm install
npm run build
```

### Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "inistate": {
      "command": "node",
      "args": ["/absolute/path/to/inistate-mcp/build/index.js"],
      "env": {
        "INISTATE_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Claude Code Configuration

```bash
claude mcp add inistate -- node /absolute/path/to/inistate-mcp/build/index.js
```

Set the environment variable `INISTATE_API_TOKEN` before launching.

## Tools

| Tool | Description |
|------|-------------|
| `resolve_intent` | Classify a user request into design/execute/modify/query/ambiguous mode |
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

1. `resolve_intent` — classify the user's request
2. `list_workspaces` → `set_workspace` — select a workspace
3. `list_modules` — find the module you need
4. `get_module_schema` — understand its fields, states, and activities
5. `get_form` — discover required fields before submitting
6. `submit_activity` — create or update entries
7. `list_entries` — query and browse data
8. `get_entry_history` — review entry history

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
| `src/schema.test.ts` | Unit tests (50) | `resolveIntent`, `designWorkflow`, `validateDesign`, helper functions (`isValidFieldType`, `isValidColor`, `isValidActor`, `suggestColorForState`) |
| `src/server.test.ts` | Integration tests (14) | Spins up the MCP server as a child process and exercises it through the official MCP SDK client — tool discovery, resource reads, prompt retrieval, and local tool calls |

Unit tests cover:
- Field type and color validation against the schema
- State color suggestion logic
- Design validation: duplicate names, invalid types/colors/actors, initial state rules, flow integrity, unreachable states, unused activities, AI confidence warnings
- Workflow design: pattern detection (approval, ticket, pipeline, record list), industry defaults
- Intent resolution: all 5 modes, context boosting, confidence scoring

Integration tests verify (no API token needed):
- All 17 tools, 5 resources, and 3 prompts are registered
- `resolve_intent`, `design_workflow`, `validate_design` work end-to-end through the MCP protocol
- Static resources (`inistate://schema`, `inistate://design-guide`) return valid content
- All 3 prompts return correctly templated messages

### Interactive testing with MCP Inspector

```bash
INISTATE_API_TOKEN=your-token npm run inspector
```

Opens a browser UI where you can interactively call tools, inspect schemas, and see responses.
