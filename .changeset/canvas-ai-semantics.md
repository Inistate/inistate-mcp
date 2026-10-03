---
"inistate-mcp": patch
---

What a module's designer writes for an AI now reaches the agent, and the actor guard enforces it for
every caller:

- `set_workspace` (and `list_workspaces` when it auto-selects) lists each module's states with their
  `ai_hint` / `ai_instruction` — that a Cancelled invoice is no sale, say — instead of name and emoji
  only.
- `list_entries` said every system field comes back whatever `fields` holds. The platform kept only
  entryId and documentId under a projection, so a model that passed `fields` got rows without `state`
  and totalled cancelled invoices as sales. The platform now keeps `state` too; the description says
  what it returns, the tool names `state` in every projection (so builds before that change return it
  as well), and it tells the model to check `state` before totalling.
- The guard reads actors from the extended schema's new `activityDetails`, which every reader can
  fetch. Before, a schema of bare names sent it to the module canvas, which only designers may read,
  so for everyone else hybrid and human activities went unchecked.
- Standard `create` and `edit` follow a hybrid or human actor the module sets for them (creating an ERP
  invoice): `confirmed: true` is required, or the call is refused, as for a custom activity.
- Activity names match the way the platform resolves them — any casing, spaces ignored — so `post`
  meets Post's hybrid check, `Create` the create rule and `changestatus` the state-change confirmation.
- `get_form` and `get_module_schema` describe the new `actor`, `ai_hint`, `ai_instruction`,
  `stateDetails` and `activityDetails` keys, as do `inistate://guardrails` and the runtime schema.
