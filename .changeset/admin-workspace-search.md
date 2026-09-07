---
"inistate-mcp": patch
---

set_workspace resolves a name through a searched workspace list (`GET /api/mcp/workspace?search=`) before falling back to the full list, so Administrators — whose unsearched list is only their own memberships — can select any workspace by name. list_workspaces' description documents that behaviour.
