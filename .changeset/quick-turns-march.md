---
"inistate-mcp": patch
---

Reduce the tool calls (agent turns) canonical flows need:

- `set_workspace` returns a slim `{ workspaceId, name, modules }` built from the workspace payload instead of echoing the raw ~24KB object — the module list comes for free, so `list_modules` is only needed to refresh, and ~6.6k response tokens per session are saved.
- `list_workspaces` auto-selects when exactly one workspace matches and returns the same slim shape (`autoSelected`), collapsing session orientation to a single call for single-workspace users.
- `create_module` (and `update_module` on full-canvas payloads) validates internally with the validate_design rules and returns structured `validation_failed` errors without a network round trip — an explicit `validate_design` call beforehand is now optional.
- `get_form` guidance relaxed from always-before-submit to once per (module, activity): the form schema is stable within a session; per-entry values come from `get_entry`/`list_entries`.
- The server now sends MCP `instructions` at initialize with the canonical flow cheat-sheet, so agents stop rediscovering the flows by trial and error.
