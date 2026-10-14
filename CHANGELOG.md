# inistate-mcp

## 1.2.0

### Minor Changes

- 346cdb8: Listing card at creation: `create_module` and `update_module` accept an optional `card` block — the listing card designed with the schema, referencing fields and activities by name (`type` detail | grid, `action`, `icon { field, size }`, rows of `field` | `state` | `activity` | `widget` items). The platform maps names to ids, validates the card and stamps it; an invalid card never fails the create — the module gets the platform's default card and the response says why in `cardStatus`. `get_module_schema` echoes the module's card by names so it round-trips through `update_module`. `design_workflow` scaffolds a card for its template, `validate_design` warns about card slips (never errors), and `inistate://schema/configure` plus the design guide document the block. Requires a platform that honours `card`: the block is forwarded only when the backend reports the `card` capability (the hosted Platform does), and logged as ignored otherwise.

### Patch Changes

- f60a179: A field an activity's form relabels can now be addressed by the name the user sees (SS06181). The designer can give a field a different label on one activity's form; the web shows that label, but `get_form` listed only the field's own name, so "update the Text field" matched nothing. `get_form` now carries `label` on such a field (from the platform, FETIAS r33682), and `submit_activity` / `submit_activities` accept the label as an input key: it is mapped to the field it relabels and reported in `input_key_notes`. Exact field names still win, a label two fields share is never used, and a key that is a label for one field and a near-miss of another is refused as unknown. The activity's form is fetched only when an input key is not an exact field name.
- 3b50977: set_workspace resolves a name through a searched workspace list (`GET /api/mcp/workspace?search=`) before falling back to the full list, so Administrators — whose unsearched list is only their own memberships — can select any workspace by name. list_workspaces' description documents that behaviour.
- 65656a8: What a module's designer writes for an AI now reaches the agent, and the actor guard enforces it for
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

- 8d4c421: submit_activity / submit_activities `comment` guidance (and the runtime schema's ActivitySubmission.comment) now tells agents to comment only when necessary to communicate with the user directly, keep it concise, and leave the detail in the field values.
- 38287ca: `submit_activity` now publishes `input` as an object in its tool schema. It was typed as unknown, so the schema carried no JSON type, and models sent the whole input as a JSON-encoded string: in a benchmark, Claude Haiku 4.5 did so in 6 of 8 runs, and each refusal and retry roughly doubled the calls, tokens and time a task took. A non-object `input` is still refused with `invalid_input_shape` rather than a bare Zod error, and a JSON-encoded object string now gets its own message telling the agent to send the object itself.

  The `input` description (and the `ActivitySubmission` docs in `inistate://schema/runtime`) now say how to send Table fields, as an array of row objects keyed by sub-field name, and that Number, Currency and Integer values are JSON numbers, including inside Table rows. Without this, models sent rows as a single object and amounts as strings.

- 72f4aad: OAuth code exchange no longer falls back to a login-JWT session when the connection mint fails for an availability reason (a 5xx, an unexpected status, an unusable body, or no answer at all). Such a session bypasses the Connections seat gate, which the backend deliberately never enforces on login tokens (SS06119). The exchange now answers `temporarily_unavailable` and the connector retries; the JWT fallback remains only for the explicit "Connections is off" answer (404).
- be6faa0: `set_workspace` and `list_workspaces` now pass each module's `description` and `links` (the modules its fields link to) through to the agent when the API sends them, and add one hint line saying what they are for. Look-alike modules (an AR deposit and an AP deposit, a goods return and a purchase return) are told apart by what they link to: in a benchmark, Claude Haiku 4.5 filed the wrong look-alike in 4 of 27 runs from bare names and in 1 of 27 with links listed. Against an API that does not send the fields, the output is unchanged. The API side is proposed in FETIAS `docs/mcp-module-list-links-proposal.md`.
- 4d894a9: Real module canvases can be updated again. Three checks rejected or rewrote shapes the platform itself
  writes, so a module read with `get_module_canvas` could not be sent back with `update_module`:

  - A flow with no `to` is legal — it means the activity runs without moving the record — and so is an
    absent or empty `from`, meaning it can run from any state. The platform stores flows that way and
    reads them back that way; only `activity` is genuinely required. A state that is _named_ but does not
    exist is still an error.
  - An activity may reference something that is not an information field (a layout element, a label), and
    the canvas read does not return those. On an update that is now a warning rather than an error: the
    server was rejecting its own read. On create it stays an error, because there a made-up field name is
    a mistake worth stopping.
  - State colours are no longer snapped to the eight-colour palette on write. Only a value the platform
    cannot store — a colour name like "gray", or something that is not a colour — is mapped; any
    parseable hex is kept exactly as sent. The palette remains a suggestion on create.

- 2bc15a6: Three write paths discarded malformed input and reported success. Each is now refused instead, with a
  structured error naming what was wrong:

  - `submit_activity` coerced a non-object `input` to nothing, so a string or array of field values was
    dropped and the activity submitted with no fields at all — on create, an empty entry. `null` is still
    accepted as "no fields"; anything else is refused before it reaches the platform.
  - `submit_activities` filtered malformed items out of the batch, so a hundred items could submit
    eighty-eight and answer success with no way to learn which twelve never happened. A bad item now
    fails the call and names its index.
  - `update_module` forwarded an empty `information`, `states` or `activities` array. Those replace the
    section entirely, so an empty one deleted every field, state or activity on the module and reported a
    successful update. Omitting a section leaves it untouched, which is what an agent that computed
    nothing actually wants. `flows: []` is still allowed — a module with no transitions can be meant.

- 6804c4b: `submit_activity` / `submit_activities` now reject a YesNo field sent as anything but a boolean (e.g. the string `"yes"`) and a Text, MultilineText or Email field sent as anything but a string (e.g. an array of lines), with an `invalid_field_value_type` error that names the field and the correction. The platform stored such values verbatim: YesNo filters stopped matching and the mobile app could not open the entry for editing (SS06108, SS06110). `null` and `""` still clear a field, and the `input` description documents both rules.

## 1.1.4

### Patch Changes

- Persist OAuth DCR client registrations across restarts (SS05806). Registered connectors (ChatGPT, Claude) no longer get `invalid_client` after a deploy or pm2 restart; the store falls back to memory if the file is unreadable.

## 1.1.3

### Patch Changes

- Annotations update

## 1.1.2

### Patch Changes

- Improve tools robustness, improve authentication and fix listing authorization issues.

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
