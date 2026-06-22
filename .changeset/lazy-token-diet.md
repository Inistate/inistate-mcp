---
"inistate-mcp": patch
---

Cut agent-facing token cost and first-write latency:

- The schema resource views no longer carry the `operations` section (schema/runtime −38%): tool inputs are documented authoritatively by the tool schemas themselves. The per-type filter operator docs moved into the `FilterOperators` definition, and `workflow_guide` now uses the real tool names.
- Capability-gated tools the active backend cannot serve register with a one-line stub description instead of the full operating manual (scaffold_module on cloud: 2.6KB → 0.6KB); trimmed wsParam, bulk per-item `ai`, upload trio, and switch_mode descriptions (configure tools/list −12% per turn).
- `get_form` warms the guard's schema cache in the background and `get_module_schema(tier=extended)` seeds it, removing one API round trip ahead of the first `submit_activity` per module. The guard's canvas-based actor fallback is likewise routed through the injected backend.
- The debug file log is now opt-in (`INISTATE_DEBUG_FILE`), asynchronous, and identifier-only — no submission field values are written to disk.
- List truncation is size-aware: responses keep as many items as fit the ~30KB budget instead of a fixed 10, and the truncation message points at the `fields` parameter.
