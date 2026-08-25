# Inistate MCP — Anthropic Submission

## App Info

| Field | Value |
|---|---|
| Display Name | Inistate |
| Subtitle | AI teammates with audit trails |
| Description | Create, manage, and automate apps in Inistate directly from Claude using natural language. Your AI teammate can manage workflows, update records, trigger approvals, upload files, and handle daily operations with full traceability, confidence-gated escalation, and built-in human oversight. No system prompt required — the schema is the prompt. |
| Category | Business / Productivity |
| Developer | Inistate |
| Website | https://inistate.com |
| Support | https://support.inistate.com |
| Privacy Policy | https://inistate.com/privacyPolicy |
| Terms of Service | https://inistate.com/terms |

---

## Tools

### 1. `list_workspaces` — List Workspaces
List workspaces the current user has access to. Typically the first tool called in any session.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Only retrieves workspaces accessible to the authenticated user; no data is created or modified. |
| destructiveHint | false | Does not delete, overwrite, or perform any irreversible action. |
| openWorldHint | false | Only reads private workspace data from Inistate; does not interact with or publish to external services. |
| idempotentHint | true | Same search query always returns the same list; repeating the call has no side effects. |

---

### 2. `set_workspace` — Set Active Workspace
Set the active workspace context for all subsequent tool calls in the session.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | false | Mutates in-process session state by calling `api.setWorkspaceId()`. |
| destructiveHint | false | Does not delete data or perform an irreversible mutation. |
| openWorldHint | false | Only changes local session context and validates against private Inistate API; does not affect external services. |
| idempotentHint | true | Setting the same workspace ID multiple times produces the same session state. |

---

### 3. `list_modules` — List Modules
List all discoverable modules in the current workspace.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Only lists module names; no records are created or modified. |
| destructiveHint | false | Does not remove, overwrite, or irreversibly change data. |
| openWorldHint | false | Only reads private workspace module metadata from Inistate. |
| idempotentHint | true | Same workspace always returns the same module list; safe to retry. |

---

### 4. `list_entries` — List Entries
Query entries with filters, sorting, and pagination.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Issues a read-only query; no entries are created, changed, or deleted. |
| destructiveHint | false | Does not delete or overwrite any records. |
| openWorldHint | false | Only queries private workspace entry data from Inistate. |
| idempotentHint | false | Results may vary over time as entries are modified by other users; the call itself has no side effects but output is not stable. |

---

### 5. `get_entry` — Get Entry
Read a single entry by ID. Returns current field values, state, audit metadata, and available activities.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Only fetches the entry; no write occurs. |
| destructiveHint | false | Does not delete or alter the entry. |
| openWorldHint | false | Only reads private workspace record data from Inistate. |
| idempotentHint | true | Same entry ID always fetches the same record; safe to retry. |

---

### 6. `get_form` — Get Activity Form
Get form fields, current values, and valid options for a module activity. Must be called before `submit_activity`.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Returns form metadata only; nothing is submitted or persisted. |
| destructiveHint | false | Does not trigger or initiate any mutation. |
| openWorldHint | false | Only reads private activity form definitions from Inistate. |
| idempotentHint | true | Same module + activity + entryId always returns the same form definition. |

---

### 7. `submit_activity` — Submit Activity
Perform an activity on a module entry: create, edit, delete, changeStatus, comment, duplicate, manage, or any custom activity. Requires the `ai` object (reasoning, model, confidence) for full traceability.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | false | Creates, modifies, changes state of, or deletes workflow entries. |
| destructiveHint | true | Can permanently delete entries or trigger irreversible state transitions. |
| openWorldHint | false | Only updates private workflow records in Inistate; does not publish to external services. |
| idempotentHint | false | Each call may create a new record or change state; repeating is not safe without confirmation. |

---

### 8. `get_entry_history` — Get Entry History
Get the full audit trail and comments for an entry.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Only retrieves historical records; no data is written. |
| destructiveHint | false | Does not delete, alter, or trigger any mutation. |
| openWorldHint | false | Only reads private audit data from Inistate. |
| idempotentHint | true | Same entry ID + page always returns the same history page. |

---

### 9. `request_upload_url` — Request Upload URL
Step 1 of the presigned upload flow. Allocates an S3 key and returns a signed PUT URL. Follow with a direct PUT to the URL, then `confirm_upload`.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | false | Allocates a storage slot and upload intent on the server; this is a write operation. |
| destructiveHint | false | Creates a new upload slot; does not delete or overwrite existing files. |
| openWorldHint | false | Interacts only with private Inistate storage infrastructure; the presigned URL is for private workspace storage. |
| idempotentHint | false | Each call generates a distinct S3 key and URL; calling twice wastes the first slot. |

---

### 10. `confirm_upload` — Confirm Upload
Step 3 of the presigned upload flow. Verifies the S3 object exists and registers it in workspace storage. Returns the file path for use in File/Image fields.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | false | Persists file metadata to workspace storage records. |
| destructiveHint | false | Registers a new file; does not delete or overwrite existing records. |
| openWorldHint | false | Verifies against private Inistate/S3 storage only. |
| idempotentHint | true | Confirming the same S3 key a second time produces the same result without double-counting. |

---

### 11. `upload_file` — Upload File (Fallback)
Fallback upload path via base64/multipart. Use only if the `request_upload_url` + `confirm_upload` presigned flow fails. Max 50 MB.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | false | Writes a new file object to private workspace storage. |
| destructiveHint | false | Creates a new file under a unique key; does not overwrite existing files. |
| openWorldHint | false | Uploads to private Inistate workspace storage only. |
| idempotentHint | false | Each call creates a new S3 object; calling twice uploads the file twice. |

---

### 12. `download_file` — Download File
Generate a pre-signed S3 download URL (1-hour TTL) for a workspace file.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Only generates a temporary read URL; no data is written or deleted. |
| destructiveHint | false | Does not modify or delete the file. |
| openWorldHint | false | Retrieves a private Inistate file access URL; the file remains in private workspace storage. |
| idempotentHint | true | Multiple calls produce different URLs (new TTL each time) but cause no cumulative side effects. |

---

### 13. `switch_mode` — Switch Mode
Switch the active tool surface between `runtime` (entry CRUD only), `configure` (+ module design tools), and `frontend` (+ REST API reference for custom UIs).

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | false | Enables or disables tool groups and resources on the server, changing active session state. |
| destructiveHint | false | Does not delete data; the mode can be switched back at any time. |
| openWorldHint | false | Modifies only local server-side in-process state; no external API calls. |
| idempotentHint | true | Switching to the same mode twice produces the same server state. |

---

### 14. `get_module_schema` — Get Module Schema *(configure mode)*
Get a module's fields, states, activities, and flows. Use `tier=basic` for fields+states or `tier=extended` for the full schema.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Only retrieves schema metadata; no changes are made. |
| destructiveHint | false | Does not alter module definitions. |
| openWorldHint | false | Only reads private module configuration from Inistate. |
| idempotentHint | true | Same module + tier always returns the same schema. |

---

### 15. `get_module_canvas` — Get Module Canvas *(configure mode)*
Fetch the full module definition with stable IDs for round-trip editing. Use before `update_module`.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Only retrieves the module definition; no writes occur. |
| destructiveHint | false | Does not modify the module. |
| openWorldHint | false | Only reads private workspace module configuration from Inistate. |
| idempotentHint | true | Same module always returns the same canvas. |

---

### 16. `design_workflow` — Design Workflow *(configure mode)*
Generate a scaffolded ModuleSchema template from a natural language description. Runs locally — no API call.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Computes a schema draft in memory; nothing is persisted or sent to any API. |
| destructiveHint | false | No writes occur. |
| openWorldHint | false | Pure local computation; does not contact any external service. |
| idempotentHint | true | Same description + industry always produces the same template. |

---

### 17. `validate_design` — Validate Design *(configure mode)*
Validate a ModuleSchema object against all FACTSOps rules before creating or updating. Runs locally — no API call.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Only validates the provided schema in memory; nothing is saved. |
| destructiveHint | false | No writes occur. |
| openWorldHint | false | Pure local validation; does not contact any external service. |
| idempotentHint | true | Same schema + mode always returns the same validation result. |

---

### 18. `create_module` — Create Module *(configure mode)*
Create a new workflow or record list module in the workspace.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | false | Persists a new module definition to the Inistate backend. |
| destructiveHint | false | Creates a new resource; does not delete or overwrite any existing module. |
| openWorldHint | false | Only creates private workspace configuration in Inistate. |
| idempotentHint | false | Calling twice creates two separate modules. |

---

### 19. `update_module` — Update Module *(configure mode)*
Update an existing module schema. Items matched by stable ID enable renaming without data loss.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | false | Overwrites existing module configuration in the Inistate backend. |
| destructiveHint | true | Can rename, remove, or restructure fields, states, and flows — some changes are irreversible (e.g. removing a field may orphan stored values). |
| openWorldHint | false | Only modifies private workspace configuration in Inistate. |
| idempotentHint | false | Repeated calls with different inputs produce cumulative schema changes. |

---

### 20. `scaffold_module` — Scaffold Module from Existing Data *(configure mode)*
Draft a ModuleSchema from data the user already has — a Notion database, an Airtable base/table, or a local SQLite table. Discovers tables in a container, then infers typed fields and states from a chosen source. Read-only on-ramp; feed the draft into `validate_design` → `create_module`. Local-runtime only.

| Annotation | Value | Justification |
|---|---|---|
| readOnlyHint | true | Only reads the shape of existing data and returns a drafted schema; does not create or modify any Inistate module or the source data. |
| destructiveHint | false | Produces a draft only; does not delete, overwrite, or irreversibly change the source or any Inistate records. |
| openWorldHint | true | May read from external services (Notion, Airtable) using credentials supplied via the environment in order to infer a schema. |
| idempotentHint | true | Same source always returns the same discovery or draft; repeating has no side effects. |

---

## Resources

### 1. `inistate://modules`
**MIME:** `application/json`
List of all FACTSOps modules in the workspace. Use for quick capability indexing at session start.

---

### 2. `inistate://modules/{name}/canvas`
**MIME:** `application/json`
Base schema for a named module: information fields and workflow states.

---

### 3. `inistate://modules/{name}/canvas/extended`
**MIME:** `application/json`
Full schema for a named module: fields, states, activities, and flows.

---

### 4. `inistate://guardrails`
**MIME:** `text/markdown`
Server-enforced submission rules for `submit_activity`. Covers: human-actor rejection, hybrid-actor confirmation, state-change confirmation, and confidence-inflation prevention. Read once per session.

---

### 5. `inistate://schema/runtime`
**MIME:** `application/json`
**Default resource — load at session start for runtime operations.** Contains tool schemas and input shapes for: `list_entries`, `get_entry`, `get_form`, `submit_activity`, `get_entry_history`, `request_upload_url`, `confirm_upload`, `download_file`, `upload_file`. Includes field value shapes (File, Image, Module, User) and filter operators.

---

### 6. `inistate://schema/configure` *(configure mode)*
**MIME:** `application/json`
Load when the user wants to create or edit a module. Contains: ModuleSchema write format, FieldDefinition, StateDefinition, ActivityDefinition, FlowDefinition, state color palette with decision rules, module_types, and configure-mode tool schemas.

---

### 7. `inistate://design-guide` *(configure mode)*
**MIME:** `text/markdown`
FACTS Module Design Guide — requirements gathering questions, state color system, SVG workflow diagram specification, and module design rules. Load alongside `inistate://schema/configure` for design sessions.

---

### 8. `inistate://frontend-guide` *(frontend mode)*
**MIME:** `text/markdown`
REST API reference for hand-written Vue/React/etc. UIs that call the Inistate API directly (no MCP). Covers: auth headers, workspace/module discovery, list/read/form/submit/history endpoints, filter syntax, field value shapes, two-step presigned uploads, error shapes, and reference client patterns.

---

## Prompts

### 1. `execute_activity` — Execute Activity
Guide an AI agent through executing a specific activity on an entry: fetch the form, assess confidence, prepare input, and submit. Works for any module and activity.

**Parameters:**
- `module` (required) — Module name
- `activity` (required) — Activity to execute
- `entryId` (optional) — Entry ID; omit for create operations

---

### 2. `diagnose_entry` — Diagnose Entry
Guide an AI agent through investigating the current state and history of an entry: fetch the entry, audit trail, and available activities, then summarize findings.

**Parameters:**
- `module` (required) — Module name
- `entryId` (required) — Entry ID to diagnose

---

### 3. `design_factsops_workflow` — Design FACTSOps Workflow *(configure mode)*
Guide an AI agent through designing a complete FACTSOps workflow module from scratch: requirements gathering, state lifecycle, activities, flows, actor types, confidence thresholds, and color assignments.

**Parameters:**
- `entity` (required) — What entity the workflow is about (e.g. "leave request", "invoice")
- `industry` (optional) — Industry context for compliance-aware defaults

---

### 4. `modify_module` — Modify Module *(configure mode)*
Guide an AI agent through modifying an existing module schema: fetch the canvas with stable IDs, apply the requested change, validate, present for review, and update.

**Parameters:**
- `module` (required) — Module name to modify
- `change` (required) — Description of the change (e.g. "add a Priority field", "add an Escalate activity")
