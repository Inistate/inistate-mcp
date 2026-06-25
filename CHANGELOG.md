# inistate-mcp

## 1.1.1

### Patch Changes

- Minor improvement

## 1.1.0

### Minor Changes

- 036a475: Cut agent retry loops with input normalization and upfront constraints (P1 from the harness test bench):

  - Field types normalize to canonical names — aliases ("Select", "LongText", "TextArea", "Paragraph"), casing ("text"), and spacing ("Long Text") are accepted everywhere; `validate_design` warns with the canonical name and `create_module`/`update_module` send the normalized payload.
  - State colors never block a design: names ("red", "amber", "gray") map by meaning, off-palette hex snaps to the nearest palette color, anything else falls back to the state-name suggestion. `validate_design` downgrades the old invalid-color error to a normalization warning.
  - `design_workflow` now returns a `constraints` sheet (field types, color palette, connection rule, actors) with every call, honors states explicitly enumerated in the description (with suggested colors, no invented flows), no longer misdetects lifecycle descriptions as record lists, accepts free-text `industry` (mapped to the known keys), and ships no empty placeholder rows.
  - `get_module_schema` is available in every mode — runtime agents need it to plan submissions. `get_module_canvas` remains configure-only (admin surface).
  - The guard recognizes `changeState` as an alias of `changeStatus`, and validates target states up front: unknown states return a structured `unknown_state` error listing the module's real states (previously an opaque platform error) in both `submit_activity` and `submit_activities`.

- Improved performance and flow

### Patch Changes

- 036a475: Fix the validate→create contract and dead actor guard surfaced by the harness test bench:

  - `connection` is no longer stripped from information fields. The Zod field shape now declares it, so User/Users/Module/Modules fields reach the platform with their module link intact (previously every retry failed with "missing 'connection'" even when the agent supplied it).
  - `validate_design` now mirrors the platform validator rule-for-rule: missing name/type, Selection/Tag without options, reference fields without `connection`, `connection` on non-reference types, and reference types inside Table sub-fields are all caught before `create_module`/`update_module`. It also warns that `required` is ignored on information fields.
  - The human/hybrid actor guard now resolves actors through the module canvas when the extended schema tier returns activity names only (production shape) — `human_actor_blocked` and `hybrid_requires_confirmation` fire again instead of silently falling through to a platform flag.
  - Flagged submissions (`flagged: true`) are annotated with `flag_reason` and `agent_action` in both `submit_activity` and `submit_activities`, so agents stop looping on bare flags.

- Cut agent-facing token cost and first-write latency:

  - The schema resource views no longer carry the `operations` section (schema/runtime −38%): tool inputs are documented authoritatively by the tool schemas themselves. The per-type filter operator docs moved into the `FilterOperators` definition, and `workflow_guide` now uses the real tool names.
  - Capability-gated tools the active backend cannot serve register with a one-line stub description instead of the full operating manual (scaffold_module on cloud: 2.6KB → 0.6KB); trimmed wsParam, bulk per-item `ai`, upload trio, and switch_mode descriptions (configure tools/list −12% per turn).
  - `get_form` warms the guard's schema cache in the background and `get_module_schema(tier=extended)` seeds it, removing one API round trip ahead of the first `submit_activity` per module. The guard's canvas-based actor fallback is likewise routed through the injected backend.
  - The debug file log is now opt-in (`INISTATE_DEBUG_FILE`), asynchronous, and identifier-only — no submission field values are written to disk.
  - List truncation is size-aware: responses keep as many items as fit the ~30KB budget instead of a fixed 10, and the truncation message points at the `fields` parameter.

- 3d20c1a: Reduce the tool calls (agent turns) canonical flows need:

  - `set_workspace` returns a slim `{ workspaceId, name, modules }` built from the workspace payload instead of echoing the raw ~24KB object — the module list comes for free, so `list_modules` is only needed to refresh, and ~6.6k response tokens per session are saved.
  - `list_workspaces` auto-selects when exactly one workspace matches and returns the same slim shape (`autoSelected`), collapsing session orientation to a single call for single-workspace users.
  - `create_module` (and `update_module` on full-canvas payloads) validates internally with the validate_design rules and returns structured `validation_failed` errors without a network round trip — an explicit `validate_design` call beforehand is now optional.
  - `get_form` guidance relaxed from always-before-submit to once per (module, activity): the form schema is stable within a session; per-entry values come from `get_entry`/`list_entries`.
  - The server now sends MCP `instructions` at initialize with the canonical flow cheat-sheet, so agents stop rediscovering the flows by trial and error.

## 1.0.3

### Patch Changes

- Include schema and guide files in npm package; update README release docs

## 1.0.2

### Patch Changes

- Fix bin commands via `npm pkg fix`

## 1.0.1

### Patch Changes

- Initial release
