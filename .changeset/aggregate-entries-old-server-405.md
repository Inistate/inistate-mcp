---
"inistate-mcp": patch
---

`aggregate_entries` recognises a platform build without the route by its 405 as well as a 404: before FETIAS r33760 the GET-only `api/mcp/{moduleName}` route caught `POST /api/mcp/aggregate` and answered 405 (seen on the 132 test server), so the tool showed a raw error instead of `not_supported` with the fall-back to `list_entries`.
