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
| `list_modules` | List all discoverable modules in the workspace |
| `get_module_canvas` | Get module schema (fields, states, listings, activities, flows) |
| `list_entries` | Query entries with filters, sorting, and pagination |
| `get_entry` | Read a single entry by ID |
| `get_form` | Get form fields and defaults for an activity |
| `submit_activity` | Create, edit, delete, or run custom activities |
| `get_audit_trail` | Get entry history and comments |
| `create_module` | Create a new module with schema |
| `update_module` | Update an existing module's schema |

## Resources

| URI | Description |
|-----|-------------|
| `inistate://modules` | List all modules |
| `inistate://modules/{moduleId}/canvas` | Basic module schema |
| `inistate://modules/{moduleId}/canvas/extended` | Extended schema with activities and flows |

## Typical Workflow

1. `list_modules` — find the module you need
2. `get_module_canvas` — understand its fields, states, and listings
3. `get_form` — discover required fields before submitting
4. `submit_activity` — create or update entries
5. `list_entries` — query and browse data
6. `get_audit_trail` — review entry history

## Development

```bash
npm run watch          # Watch mode for TypeScript compilation
npm run inspector      # Test with MCP Inspector
```
