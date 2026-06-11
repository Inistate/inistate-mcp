---
"inistate-mcp": minor
---

Cut agent retry loops with input normalization and upfront constraints (P1 from the harness test bench):

- Field types normalize to canonical names — aliases ("Select", "LongText", "TextArea", "Paragraph"), casing ("text"), and spacing ("Long Text") are accepted everywhere; `validate_design` warns with the canonical name and `create_module`/`update_module` send the normalized payload.
- State colors never block a design: names ("red", "amber", "gray") map by meaning, off-palette hex snaps to the nearest palette color, anything else falls back to the state-name suggestion. `validate_design` downgrades the old invalid-color error to a normalization warning.
- `design_workflow` now returns a `constraints` sheet (field types, color palette, connection rule, actors) with every call, honors states explicitly enumerated in the description (with suggested colors, no invented flows), no longer misdetects lifecycle descriptions as record lists, accepts free-text `industry` (mapped to the known keys), and ships no empty placeholder rows.
- `get_module_schema` is available in every mode — runtime agents need it to plan submissions. `get_module_canvas` remains configure-only (admin surface).
- The guard recognizes `changeState` as an alias of `changeStatus`, and validates target states up front: unknown states return a structured `unknown_state` error listing the module's real states (previously an opaque platform error) in both `submit_activity` and `submit_activities`.
