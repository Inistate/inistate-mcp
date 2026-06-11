---
"inistate-mcp": patch
---

Fix the validate→create contract and dead actor guard surfaced by the harness test bench:

- `connection` is no longer stripped from information fields. The Zod field shape now declares it, so User/Users/Module/Modules fields reach the platform with their module link intact (previously every retry failed with "missing 'connection'" even when the agent supplied it).
- `validate_design` now mirrors the platform validator rule-for-rule: missing name/type, Selection/Tag without options, reference fields without `connection`, `connection` on non-reference types, and reference types inside Table sub-fields are all caught before `create_module`/`update_module`. It also warns that `required` is ignored on information fields.
- The human/hybrid actor guard now resolves actors through the module canvas when the extended schema tier returns activity names only (production shape) — `human_actor_blocked` and `hybrid_requires_confirmation` fire again instead of silently falling through to a platform flag.
- Flagged submissions (`flagged: true`) are annotated with `flag_reason` and `agent_action` in both `submit_activity` and `submit_activities`, so agents stop looping on bare flags.
