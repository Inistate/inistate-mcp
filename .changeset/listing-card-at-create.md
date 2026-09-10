---
"inistate-mcp": minor
---

Listing card at creation: `create_module` and `update_module` accept an optional `card` block — the listing card designed with the schema, referencing fields and activities by name (`type` detail | grid, `action`, `icon { field, size }`, rows of `field` | `state` | `activity` | `widget` items). The platform maps names to ids, validates the card and stamps it; an invalid card never fails the create — the module gets the platform's default card and the response says why in `cardStatus`. `get_module_schema` echoes the module's card by names so it round-trips through `update_module`. `design_workflow` scaffolds a card for its template, `validate_design` warns about card slips (never errors), and `inistate://schema/configure` plus the design guide document the block. Requires a platform that honours `card`: the block is forwarded only when the backend reports the `card` capability (the hosted Platform does), and logged as ignored otherwise.
