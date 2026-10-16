---
"inistate-mcp": patch
---

State in the descriptions of `get_module_schema`, `get_entry`, `get_form`,
`submit_activity` and `submit_activities` that each is one bounded operation:
the first three are read-only lookups, and the submit tools perform exactly one
named activity per call (activity names are data, not hidden tools).
