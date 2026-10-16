---
"inistate-mcp": patch
---

`design_workflow` no longer offers `DateRange` or `Formula` in `field_types`, and
`validate_design` refuses either on a new field the way the platform does: a
Formula field needs an expression no MCP schema carries, so it would never
compute (SS06300). Existing fields of these types still round-trip on update.
