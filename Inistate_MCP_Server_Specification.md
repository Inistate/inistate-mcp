# Inistate MCP Server — Complete Specification

> **Version:** 1.0 · **Date:** March 2026 · **Status:** Authoritative  
> **Patent:** US20230266946A1 · **Platform:** Inistate (inistate.com)  
> **Framework:** FACTSOps (Form → Activity → Controlled Transition → State + Operations)

---

## How to Use This Document

This document serves three audiences simultaneously:

| Audience | Read For | Key Sections |
|---|---|---|
| **MCP Server Implementors** | Build or extend the server | §2–§5, §9–§11, §14 |
| **AI Agents** | Operational instructions — read as a system prompt | §1.4, §2, §6, §7, §8 |
| **Process Designers** | Define FACTSOps workflows | §1.2, §8, §10, §12, §13 |

Sections marked with `AGENT INSTRUCTION` contain directives that AI agents must follow when operating against this server.

---

## Table of Contents

1. [Overview and Purpose](#1-overview-and-purpose)
2. [MCP Tool Reference](#2-mcp-tool-reference)
3. [MCP Resources](#3-mcp-resources)
4. [MCP Prompts](#4-mcp-prompts)
5. [Authentication and Authorization](#5-authentication-and-authorization)
6. [AI Agent Execution Model](#6-ai-agent-execution-model)
7. [Confidence Gating and Escalation](#7-confidence-gating-and-escalation)
8. [Module Design Specification](#8-module-design-specification)
9. [Filtering Reference](#9-filtering-reference)
10. [Error Handling](#10-error-handling)
11. [AI Audit Trail](#11-ai-audit-trail)
12. [State Color System](#12-state-color-system)
13. [Workflow Validation Rules](#13-workflow-validation-rules)
14. [Implementation Architecture](#14-implementation-architecture)
15. [A2A Coordination (Future)](#15-a2a-coordination-future)
16. [Appendix: Conceptual Mapping](#16-appendix-conceptual-mapping)
17. [Appendix: End-to-End Walkthrough](#17-appendix-end-to-end-walkthrough)
18. [Appendix: Workflow Diagram Specification](#18-appendix-workflow-diagram-specification)
19. [Appendix: Complete Design Example — Aircon Service Issues](#19-appendix-complete-design-example--aircon-service-issues)

---

## 1. Overview and Purpose

This document is the authoritative specification for building, operating, and extending the Inistate MCP Server. It is designed to be consumed by three audiences simultaneously:

- **MCP Server Implementors** — engineers building or extending the server
- **AI Agents** — the document is structured so that an AI agent can read it as operational instructions
- **Process Designers** — business analysts defining FACTSOps workflows

### 1.1 What the Inistate MCP Server Does

The Inistate MCP Server exposes the Inistate process platform as a structured, AI-navigable set of MCP tools, prompts, and resources. It enables any MCP-compatible AI agent — Claude, GPT, Gemini, or any framework — to:

- **Design** new FACTSOps workflow modules with validated schemas
- **Execute** state transitions on process instances through structured forms
- **Modify** existing process definitions without redeployment
- **Query** process data with rich filtering and audit trail access
- **Coordinate** multi-agent workflows where different AI agents handle different activities

### 1.2 The Core Execution Primitive

Everything in FACTSOps derives from one primitive:

```
State → Activity(Form) → State
```

| Concept | Definition |
|---|---|
| **State** | Current condition of an entity in its lifecycle |
| **Activity** | Action performed by human, AI, or hybrid actor |
| **Form** | Typed data interface that captures the activity |
| **Transition** | Validated movement from one state to the next |

**One-line summary:** A process is a chain of validated state transitions driven by structured activities, where each activity is performed by a human, an AI agent, or both, and captured through a typed form that serves as the sole mechanism for advancing state.

### 1.3 The Three-Layer Architecture

| Layer | Protocol | Purpose |
|---|---|---|
| **Tool Connectivity** | MCP | Agent accesses FACTSOps tools, resources, and prompts |
| **Agent Coordination** | A2A (future) | Agent-to-agent handoff via process definition routing |
| **Process Governance** | FACTSOps | States, activities, forms, hooks, audit trail |

The MCP layer is the primary interface. A2A coordination is a future extension (see §15). The FACTSOps governance layer is the Inistate platform itself.

### 1.4 Intent Resolution — Agent-Driven

> **AGENT INSTRUCTION:** Identify the user's intent from their request and follow the corresponding workflow sequence. The tool descriptions and prompts provide the necessary guidance. If no API key is configured, call `login` first. Then start with `list_workspaces` → `set_workspace` to bootstrap the session.

| Mode | Example Request | Tool Chain |
|---|---|---|
| `design` | "Set up a KYC approval process" | `switch_mode(configure)` → `design_workflow` → `validate_design` → `create_module` → `get_module_schema` |
| `execute` | "Approve Sarah's leave request" | `list_modules` → `list_entries` → `get_form` → `submit_activity` |
| `modify` | "Add a compliance step to onboarding" | `switch_mode(configure)` → `list_modules` → `get_module_canvas` → `validate_design` → `update_module` |
| `query` | "Show overdue invoices" | `list_modules` → `list_entries` |
| `frontend` | "Generate a Vue page for invoices" | `switch_mode(frontend)` → load `inistate://frontend-guide` → `get_module_schema(tier=extended)` |
| `ambiguous` | "Handle the invoice thing" | Ask clarification questions before proceeding |

### 1.5 Server Modes (runtime / configure / frontend)

The MCP server exposes its full capability set behind three **server modes** that control which tools, resources, and prompts are visible to the agent at any moment. This is distinct from the agent-side *operational* modes in §1.4 and §6.1 — the server modes only control the surface area; the agent still chooses which of the visible tools to use.

| Server mode | Default? | Exposed surface | When to select |
|---|---|---|---|
| `runtime` | **yes** | All auth/discovery/runtime tools (`login`, `list_workspaces`, `set_workspace`, `list_modules`, `list_entries`, `get_entry`, `get_form`, `submit_activity`, `get_entry_history`, `request_upload_url`, `confirm_upload`, `upload_file`, `download_file`) plus `inistate://schema/runtime`, `inistate://modules`, and the runtime prompts (`execute_activity`, `diagnose_entry`). | Executing or querying entries on existing modules. This covers the majority of sessions. |
| `configure` | no | Runtime surface **plus** design/modify tools (`design_workflow`, `validate_design`, `create_module`, `update_module`, `get_module_canvas`, `get_module_schema`), `inistate://schema/configure`, `inistate://design-guide`, and the design prompts (`design_factsops_workflow`, `modify_module`). | Creating a new module or editing an existing module's schema. |
| `frontend` | no | Full `configure` surface **plus** `inistate://frontend-guide` — REST API reference for generating Vue/React/etc. UIs that call `api.inistate.com` directly. | Hand-writing a custom UI (and optionally iterating on the module schema in the same session). |

**Why modes matter.** Gating the configure and frontend surfaces keeps the on-connect tool/resource payload small for the common case. Measured on-connect cost drops roughly in half when a session stays in `runtime` (~5.5k tokens vs. ~11k for the full surface).

**How to switch.** Every session starts in `runtime` unless the operator sets `INISTATE_MCP_MODE=configure` or `INISTATE_MCP_MODE=frontend` in the server environment (§14.2). Agents switch modes at runtime by calling the `switch_mode` tool (§2.4), which fires an `tools/list_changed` notification so clients refresh their local tool catalog.

> **AGENT INSTRUCTION:** Stay in `runtime` unless the user explicitly asks to design, modify, or generate UI. When the user's intent requires configure- or frontend-only tools, call `switch_mode(mode)` once and re-read resources as needed. Switch back to `runtime` when the design/frontend task is complete to keep subsequent turns cheap.

---

## 2. MCP Tool Reference

The MCP server exposes three types of MCP primitives:
- **Tools** — executable actions (this section)
- **Resources** — background knowledge (§3)
- **Prompts** — guided workflows (§4)

All tools require valid authentication — either an API key (`fsk` prefix) or a JWT obtained via the `login` tool. See §5 for details.

### Tool Summary

The **Surface** column indicates the server mode(s) in which the tool is visible (§1.5). Tools marked `runtime` are visible in all three modes; `configure+` tools are only visible after `switch_mode(configure)` or `switch_mode(frontend)`. The **Agent Mode** column is the agent's operational mode from §1.4 / §6.1.

| # | Tool | Resolver | Surface | Agent Mode | Purpose |
|---|---|---|---|---|---|
| 0 | `login` | `POST /token` | runtime | All | Authenticate with username/password to obtain a JWT |
| 1 | `list_workspaces` | `GET /api/workspace` | runtime | All | List accessible workspaces |
| 2 | `set_workspace` | `GET /api/workspace/{id}` | runtime | All | Set active workspace for session |
| 3 | `list_modules` | `GET /api/mcp/` | runtime | All | List all modules in workspace |
| 4 | `switch_mode` | Server-side | runtime | All | Switch between `runtime` / `configure` / `frontend` server modes |
| 5 | `get_module_schema` | `GET /api/mcp/{name}?tier=` | configure+ | design, modify | Get module fields, states, activities, flows |
| 6 | `get_module_canvas` | `GET /api/configure/{name}` | configure+ | modify | Get full module definition with stable IDs |
| 7 | `list_entries` | `POST /api/mcp/list` | runtime | execute, query | Query entries with filters |
| 8 | `get_entry` | `POST /api/mcp/entry` | runtime | execute, query | Read a single entry |
| 9 | `get_form` | `POST /api/mcp/form` | runtime | execute | Get activity form fields and defaults |
| 10 | `submit_activity` | `POST /api/mcp/activity` | runtime | execute | Perform create/edit/delete/custom activity |
| 11 | `get_entry_history` | `POST /api/mcp/history` | runtime | query | Get audit trail for an entry |
| 12 | `upload_file` | `POST /api/mcp/upload` | runtime | execute | Upload a file for File/Image fields (fallback — use the presigned flow by default) |
| 13 | `download_file` | `GET /api/mcp/download/{name}/s/{guid}/{file}` | runtime | query | Download a file by module name |
| 14 | `design_workflow` | Server-side | configure+ | design | AI generates a module schema from description |
| 15 | `validate_design` | Server-side | configure+ | design, modify | Validate a module schema before submission |
| 16 | `create_module` | `POST /api/configure/{name}` | configure+ | design | Create a new module |
| 17 | `update_module` | `PUT /api/configure/{name}` | configure+ | modify | Update existing module schema |
| 18 | `request_upload_url` | `POST /api/mcp/request-upload-url` | runtime | execute | Request a presigned S3 PUT URL for direct large-file upload (up to 500MB) |
| 19 | `confirm_upload` | `POST /api/mcp/confirm-upload` | runtime | execute | Finalize a presigned upload after the client PUTs the file to S3 |

> **Note:** `get_module_schema` moved behind `configure+` when the mode-switching surface was introduced — runtime sessions discover activity shapes via `get_form` and entry `availableActivities` instead. Switch to `configure` if you need the full fields/states/activities/flows payload.

---

### 2.0a switch_mode

Change the server's visible surface between `runtime`, `configure`, and `frontend` (§1.5). This is the only tool that reveals `configure+` tools/resources/prompts — without calling it, a default-start session can only perform runtime operations.

**Resolver:** Server-side. After state changes, the server emits an `notifications/tools/list_changed` event so connected clients refresh their tool catalog. `notifications/resources/list_changed` and `notifications/prompts/list_changed` fire likewise.

**Input Schema:**

```json
{
  "type": "object",
  "required": ["mode"],
  "properties": {
    "mode": {
      "type": "string",
      "enum": ["runtime", "configure", "frontend"],
      "description": "Target server mode. runtime = entry CRUD only. configure = adds module design tools and design-guide. frontend = configure + frontend-guide resource for generating custom UIs."
    }
  }
}
```

**Response:**

```json
{ "mode": "configure", "message": "Switched to configure mode" }
```

**Behavior:**

- Switching to `configure` enables `get_module_schema`, `get_module_canvas`, `design_workflow`, `validate_design`, `create_module`, `update_module`, the `inistate://schema/configure` and `inistate://design-guide` resources, and the `design_factsops_workflow` / `modify_module` prompts.
- Switching to `frontend` additionally enables `inistate://frontend-guide`.
- Switching back to `runtime` disables all `configure+` tools, resources, and prompts. Call this when the design/frontend task is complete to reduce per-turn tool-list payload.
- Idempotent. Calling `switch_mode(runtime)` from `runtime` is a no-op (other than the `message` echo).

> **AGENT INSTRUCTION:** Do not call `switch_mode` speculatively. Switch only when the user's next step actually needs the gated tools. Typical triggers: user asks to create/edit a module (`configure`), or to generate a custom frontend (`frontend`). After the switch, re-read the relevant mode resource (`inistate://schema/configure` + `inistate://design-guide`, or `inistate://frontend-guide`) if you have not already loaded it in this session.

---

### 2.0 login

Authenticate with username and password to obtain a session token. Use this when no API key is configured and the user provides credentials. Subsequent API calls will use the obtained token automatically.

**Resolver:** `POST /token` (form-encoded, `grant_type=password`)

**Input Schema:**

```json
{
  "type": "object",
  "required": ["username", "password"],
  "properties": {
    "username": { "type": "string", "description": "Inistate account username or email" },
    "password": { "type": "string", "description": "Account password" }
  }
}
```

**Response:**

```json
{ "message": "Login successful" }
```

> **Note:** The server stores the JWT and optional refresh token internally. Credentials are also retained in memory so the server can transparently re-authenticate on 401 responses. See §5 for the full authentication lifecycle.

---

### 2.1 list_workspaces

List workspaces the current user has access to. Returns workspace IDs and names. The agent should call `set_workspace` to select one before calling other tools.

**Resolver:** `GET /api/workspace`

**Input Schema:**

```json
{
  "type": "object",
  "properties": {}
}
```

**Response:**

```json
[
  { "id": "ws-001", "name": "Acme Corp" },
  { "id": "ws-002", "name": "Demo Workspace" }
]
```

---

### 2.2 set_workspace

Set the active workspace. Retrieves workspace details for the agent to store. The MCP server stores the workspace ID and sends it as a `wsid` header on all subsequent API requests.

**Resolver:** `GET /api/workspace/{workspaceId}`

**Input Schema:**

```json
{
  "type": "object",
  "required": ["workspaceId"],
  "properties": {
    "workspaceId": {
      "type": "string",
      "description": "Workspace ID from list_workspaces"
    }
  }
}
```

---

### 2.3 list_modules

List all discoverable modules in the current workspace. Call this first to find module names for subsequent operations.

**Resolver:** `GET /api/mcp/`

**Input Schema:**

```json
{
  "type": "object",
  "properties": {}
}
```

**Response:**

```json
[
  { "name": "Leave Requests", "emoji": "🏖️" },
  { "name": "Purchase Orders", "emoji": "📦" },
  { "name": "KYC Applications", "emoji": "🔍" }
]
```

---

### 2.4 get_module_schema

Get the canvas schema for a module. Use `tier=basic` (default) for fields and states only. Use `tier=extended` to also include activities and flows.

**Resolver:** `GET /api/mcp/{moduleName}?tier={tier}`

**Input Schema:**

```json
{
  "type": "object",
  "required": ["module"],
  "properties": {
    "module": { "type": "string", "description": "Module name from list_modules" },
    "tier": { "type": "string", "enum": ["basic", "extended"], "default": "basic" }
  }
}
```

**Basic response (fields + states):**

```json
{
  "name": "Leave Requests",
  "icon": "🏖️",
  "description": "Employee leave request management with approval workflow",
  "information": [
    { "id": "xKfLmNpQ", "name": "Leave Type", "type": "Selection", "options": ["Annual Leave", "Sick Leave", "Unpaid Leave"] },
    { "id": "yRsTuVwX", "name": "Start Date", "type": "Date" },
    { "id": "zAbCdEfG", "name": "End Date", "type": "Date" },
    { "id": "hIjKlMnO", "name": "Remarks", "type": "Text" },
    { "id": "pQrStUvW", "name": "Days Requested", "type": "Number" },
    { "id": "iJkLmNoP", "name": "Attachments", "type": "File" },
    { "id": "tGhIjKlM", "name": "Is Urgent", "type": "YesNo", "ai_hint": "Set to true if leave is requested within 24 hours" }
  ],
  "states": [
    { "id": "f47ac10b-...", "name": "Draft", "color": "#5A6070", "initial": true },
    { "id": "550e8400-...", "name": "Pending Approval", "color": "#2968A8" },
    { "id": "550e8400-...", "name": "Approved", "color": "#1E6B45" },
    { "id": "550e8400-...", "name": "Rejected", "color": "#8B2D2D" },
    { "id": "550e8400-...", "name": "Cancelled", "color": "#8B2D2D" }
  ]
}
```

**Extended response (additionally includes):**

```json
{
  "activities": [
    {
      "id": "d4e5f6a7-...",
      "name": "Approve",
      "actor": "human",
      "fields": [
        { "name": "Leave Type", "readOnly": true },
        { "name": "Days Requested", "readOnly": true },
        { "name": "Remarks", "required": true }
      ],
      "ai_hint": "Manager approves the leave request"
    },
    {
      "id": "e5f6a7b8-...",
      "name": "Reject",
      "actor": "human",
      "fields": [{ "name": "Remarks", "required": true }]
    },
    {
      "id": "a1b2c3d4-...",
      "name": "Cancel",
      "actor": "human"
    },
    {
      "id": "b2c3d4e5-...",
      "name": "Submit",
      "actor": "hybrid",
      "ai_hint": "Employee submits the leave request for approval"
    }
  ],
  "flows": [
    { "from": "Draft", "to": "Pending Approval", "activity": "Submit" },
    { "from": "Pending Approval", "to": "Approved", "activity": "Approve" },
    { "from": "Pending Approval", "to": "Rejected", "activity": "Reject" },
    { "from": "Pending Approval", "to": "Cancelled", "activity": "Cancel" }
  ]
}
```

---

### 2.5 get_module_canvas

Get an existing module definition in full FACTSOps format with stable IDs. The output is round-trippable — it can be modified and sent back via `update_module`.

**Resolver:** `GET /api/configure/{moduleName}`

**Input Schema:**

```json
{
  "type": "object",
  "required": ["module"],
  "properties": {
    "module": { "type": "string", "description": "Module name or numeric ID" }
  }
}
```

**Response:** Full `ModuleSchema` object with all `id` fields populated (see §8 for the complete schema). Use this when you need to modify a module — the IDs enable renaming fields/states/activities without losing existing entry data.

**Response example:**

```json
{
  "id": 9001,
  "name": "Leave Requests",
  "icon": "🏖️",
  "description": "Employee leave request management with approval workflow",
  "published": true,
  "information": [
    { "id": "xKfLmNpQ", "name": "Leave Type", "type": "Selection", "options": ["Annual Leave", "Sick Leave", "Unpaid Leave"] },
    { "id": "yRsTuVwX", "name": "Start Date", "type": "Date" },
    { "id": "zAbCdEfG", "name": "End Date", "type": "Date" },
    { "id": "hIjKlMnO", "name": "Remarks", "type": "Text" },
    { "id": "pQrStUvW", "name": "Days Requested", "type": "Number" },
    { "id": "iJkLmNoP", "name": "Attachments", "type": "File" },
    { "id": "tGhIjKlM", "name": "Is Urgent", "type": "YesNo", "ai_hint": "Set to true if leave is requested within 24 hours" }
  ],
  "states": [
    { "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "name": "Draft", "color": "#5A6070", "initial": true },
    { "id": "550e8400-e29b-41d4-a716-446655440001", "name": "Pending Approval", "color": "#2968A8" },
    { "id": "550e8400-e29b-41d4-a716-446655440002", "name": "Approved", "color": "#1E6B45" },
    { "id": "550e8400-e29b-41d4-a716-446655440003", "name": "Rejected", "color": "#8B2D2D" },
    { "id": "550e8400-e29b-41d4-a716-446655440004", "name": "Cancelled", "color": "#8B2D2D" }
  ],
  "activities": [
    {
      "id": "d4e5f6a7-b8c9-0123-defg-456789abcdef",
      "name": "Approve",
      "actor": "human",
      "fields": [
        { "name": "Leave Type", "readOnly": true },
        { "name": "Days Requested", "readOnly": true },
        { "name": "Remarks", "required": true }
      ],
      "ai_hint": "Manager approves the leave request"
    },
    {
      "id": "e5f6a7b8-c9d0-1234-efgh-56789abcdef0",
      "name": "Reject",
      "actor": "human",
      "fields": [{ "name": "Remarks", "required": true }]
    },
    {
      "id": "a1b2c3d4-e5f6-7890-ijkl-mnopqrstuvwx",
      "name": "Cancel",
      "actor": "human"
    },
    {
      "id": "b2c3d4e5-f6a7-8901-jklm-nopqrstuvwxy",
      "name": "Submit",
      "actor": "hybrid",
      "ai_hint": "Employee submits the leave request for approval"
    }
  ],
  "flows": [
    { "from": "Draft", "to": "Pending Approval", "activity": "Submit" },
    { "from": "Pending Approval", "to": "Approved", "activity": "Approve" },
    { "from": "Pending Approval", "to": "Rejected", "activity": "Reject" },
    { "from": "Pending Approval", "to": "Cancelled", "activity": "Cancel" }
  ]
}
```

> **Note:** Every `id` field is populated — these are the stable opaque identifiers that enable renaming via `update_module`. When modifying this schema, preserve the `id` values and change only the `name` to rename without losing data.

---

### 2.6 list_entries

Query entries from a module with filtering, sorting, and pagination. Use flat parameters for common filters (`state`, `search`). Use the `filters` object for field-specific queries with operator syntax. See §9 for the full filtering reference.

**Resolver:** `POST /api/mcp/list`

**Input Schema:**

```json
{
  "type": "object",
  "required": ["module"],
  "properties": {
    "module":        { "type": "string", "description": "Module name from list_modules" },
    "state":         { "type": "string", "description": "Filter by state name" },
    "search":        { "type": "string", "description": "Search by document ID" },
    "filters":       { "type": "object", "description": "Field filters keyed by displayName. See §9." },
    "sortBy":        { "type": "string", "description": "Field displayName to sort by" },
    "sortDirection": { "type": "string", "enum": ["asc", "desc"], "default": "asc" },
    "currentPage":   { "type": "integer", "default": 0 },
    "pageSize":      { "type": "integer", "default": 50, "description": "Max 500" }
  }
}
```

**Response:**

```json
{
  "moduleId": "Leave Requests",
  "page": 0,
  "pageSize": 50,
  "totalItems": 127,
  "list": [
    {
      "entryId": 12034,
      "documentId": "LV-2026-0042",
      "state": "Approved",
      "date": "2026-03-20T00:00:00Z",
      "data": {
        "Leave Type": "Annual Leave",
        "Start Date": "2026-03-20",
        "End Date": "2026-03-25",
        "Days Requested": 4,
        "Remarks": "Family vacation",
        "Is Urgent": false
      },
      "createdBy": "jane.smith",
      "createdDate": "2026-02-14T10:00:00Z",
      "updatedBy": "admin@example.com",
      "updatedDate": "2026-02-15T09:00:00Z",
      "assignees": ["manager@example.com"],
      "due": "2026-03-15T00:00:00Z",
      "availableActivities": {
        "standard": ["edit", "comment"],
        "custom": [],
        "stateFlow": {
          "currentState": "Approved",
          "transitions": {}
        }
      }
    }
  ]
}
```

**Response fields:**
- `list[].module` — Module name
- `list[].entryId` — Entry identifier (use in `submit_activity` and `get_form`)
- `list[].documentId` — Human-readable document ID
- `list[].state` — Current state name
- `list[].date` — Business date (distinct from audit timestamps)
- `list[].data` — Field values keyed by display name. File/Image fields contain `{ name, path }` objects.
- `list[].createdBy`, `createdDate`, `updatedBy`, `updatedDate` — Audit metadata
- `list[].assignees` — Assigned usernames (optional)
- `list[].due` — Due date (optional)
- `list[].availableActivities` — Activities available on this entry based on current state and authorization. Contains `standard[]`, `custom[]`, and `stateFlow` with `currentState` and `transitions`.
- `totalItems` — Total matching entries across all pages
- `page`, `pageSize` — Pagination info

---

### 2.7 get_entry

Read a single entry by its ID. Returns current field values for the entry.

**Resolver:** `POST /api/mcp/entry`

**Input Schema:**

```json
{
  "type": "object",
  "required": ["module", "entryId"],
  "properties": {
    "module":  { "type": "string", "description": "Module name from list_modules" },
    "entryId": { "type": ["string", "integer"] }
  }
}
```

**Response:** Single entry object with full field data:

```json
{
  "module": "Leave Requests",
  "entryId": 12034,
  "documentId": "LV-2026-0042",
  "state": "Approved",
  "date": "2026-03-20T00:00:00Z",
  "data": {
    "Leave Type": "Annual Leave",
    "Start Date": "2026-03-20",
    "End Date": "2026-03-25",
    "Days Requested": 4,
    "Remarks": "Approved — enjoy your vacation",
    "Is Urgent": false,
    "Attachments": null
  },
  "createdBy": "jane.smith",
  "createdDate": "2026-02-14T10:00:00Z",
  "updatedBy": "john.doe",
  "updatedDate": "2026-02-15T09:00:00Z",
  "assignees": ["john.doe"],
  "due": "2026-03-15T00:00:00Z",
  "availableActivities": {
    "standard": ["edit", "comment"],
    "custom": [],
    "stateFlow": {
      "currentState": "Approved",
      "transitions": {}
    }
  }
}
```

**New fields (vs. previous schema):**
- `module` — Module name returned on the entry itself
- `date` — Business date (distinct from audit timestamps `createdDate`/`updatedDate`)
- `availableActivities` — Activities the current user can perform, based on authorization and current state. Contains `standard[]` (e.g., edit, comment, delete), `custom[]` (e.g., Approve, Reject), and `stateFlow` with `currentState` and `transitions` (per-activity target state names). This eliminates the need to call `get_module_schema(extended)` to discover what actions are available.

---

### 2.8 get_form

Get the form fields and current values for a module activity.

> **AGENT INSTRUCTION:** Always call `get_form` before `submit_activity` to discover required fields, their types, valid options, default values, and the confidence threshold.

**Resolver:** `POST /api/mcp/form`

**Input Schema:**

```json
{
  "type": "object",
  "required": ["module"],
  "properties": {
    "module":   { "type": "string", "description": "Module name from list_modules" },
    "activity": { "type": "string", "default": "create", "description": "create, edit, view, or custom activity name" },
    "entryId":  { "type": ["string", "integer", "null"], "description": "Entry ID for edit/view/custom activities" }
  }
}
```

**Response:**

```json
{
  "module": "Leave Requests",
  "activity": "Approve",
  "entryId": 1042,
  "documentId": "LV-2026-0042",
  "form": [
    { "Leave Type": { "type": "Selection", "readOnly": true, "options": ["Annual Leave", "Sick Leave", "Unpaid Leave"] } },
    { "Days Requested": { "type": "Number", "readOnly": true } },
    { "Remarks": { "type": "Text", "required": true } }
  ],
  "defaults": {
    "Leave Type": "Annual Leave",
    "Days Requested": 4,
    "Remarks": "Family vacation"
  },
  "states": ["Approved"],
  "confidence_threshold": 0.8,
  "availableActivities": {
    "standard": ["edit", "comment"],
    "custom": ["Approve", "Reject", "Cancel"],
    "stateFlow": {
      "currentState": "Pending Approval",
      "transitions": {
        "Approve": ["Approved"],
        "Reject": ["Rejected"],
        "Cancel": ["Cancelled"]
      }
    }
  }
}
```

**Response fields:**
- `form[]` — Form fields. Each item is an object keyed by field display name. The key is the display name; the value contains `type`, `required`, `readOnly`, `options`, `module` (for Module/User types), and `fields` (for Table sub-fields). Use the display name key in `submit_activity`'s `input` object.
- `defaults` — Current/default values keyed by display name. For edit/view: current entry data. For create: any default values.
- `states` — Available target states for this activity from the current entry state
- `confidence_threshold` — Present only when the activity has a threshold configured (> 0). AI agents must compare their confidence against this value before submitting. See §7.
- `availableActivities` — Activities available on this entry based on current state and authorization. See §2.8.1.

---

### 2.9 submit_activity

Perform an activity on a module entry.

**Resolver:** `POST /api/mcp/activity`

**Standard activities:** `create` (no entryId), `edit`, `delete`, `changeStatus`, `comment`, `duplicate`, `manage`. Custom activities use the activity name from `get_module_schema`.

**Input Schema:**

```json
{
  "type": "object",
  "required": ["module", "activity"],
  "properties": {
    "module":    { "type": "string", "description": "Module name" },
    "activity":  { "type": "string", "description": "create, edit, delete, or custom activity name" },
    "entryId":   { "type": ["string", "integer"], "description": "Required for edit/delete/custom. Omit for create." },
    "entryIds":  { "type": "array", "items": { "type": ["string", "integer"] }, "description": "Multiple entry IDs for bulk operations" },
    "input":     { "type": "object", "description": "Field values keyed by display name. For File/Image fields, use { name, path } where path is from upload_file() or an external URL (see §8.7). For Module fields, use { value, id }; for User fields, use { value, id, username } (see §8.8). Plural variants (Files/Images/Modules/Users) use arrays of these objects." },
    "state":     { "type": "string", "description": "Target state name (resolved to internal ID automatically)" },
    "comment":   { "type": "string", "description": "Comment to attach to the activity" },
    "assignees": { "type": "array", "items": { "type": "string" }, "description": "Usernames to assign" },
    "due":       { "type": "string", "format": "date-time", "description": "Due date for assignment" },
    "ai": {
      "type": "object",
      "description": "AI agent traceability context. See §11 for full specification.",
      "properties": {
        "reasoning":     { "type": "string", "description": "Natural language explanation of the AI's decision" },
        "sources":       { "type": "array", "items": { "type": "object", "properties": { "type": { "type": "string" }, "reference": { "type": "string" }, "excerpt": { "type": "string" } } }, "description": "What data the AI used and from where" },
        "model":         { "type": "string", "description": "Which model made this decision" },
        "model_version": { "type": "string", "description": "Model version / checkpoint" },
        "prompt_hash":   { "type": "string", "description": "Hash of the system prompt used" },
        "confidence":    { "type": "number", "minimum": 0, "maximum": 1, "description": "Confidence score. If below confidence_threshold, state transition is suppressed." }
      }
    }
  }
}
```

**Success response (single entry):**

```json
{
  "module": "Leave Requests",
  "activity": "Approve",
  "entryId": 1042,
  "documentId": "LV-2026-0042",
  "state": "Approved",
  "message": null,
  "availableActivities": {
    "standard": ["edit", "comment"],
    "custom": [],
    "stateFlow": {
      "currentState": "Approved",
      "transitions": {}
    }
  }
}
```

**Flagged response (confidence below threshold):**

```json
{
  "module": "Leave Requests",
  "activity": "Approve",
  "entryId": 1042,
  "documentId": "LV-2026-0042",
  "state": null,
  "message": "Confidence below threshold — flagged for human review",
  "flagged": true
}
```

**Bulk response:**

```json
{
  "module": "Leave Requests",
  "activity": "changeStatus",
  "entryIds": [12034, 12035, 12036]
}
```

---

### 2.10 get_entry_history

Get the audit trail and comments for an entry. Returns chronological list of actions with field-level change details and AI traceability context.

**Resolver:** `POST /api/mcp/history`

**Input Schema:**

```json
{
  "type": "object",
  "required": ["module", "entryId"],
  "properties": {
    "module":  { "type": "string", "description": "Module name from list_modules" },
    "entryId": { "type": ["string", "integer"], "description": "Entry ID to get history for" },
    "page":    { "type": "integer", "description": "Page number (0-based, 50 items per page)", "default": 0 }
  }
}
```

**Response:**

```json
{
  "moduleId": "Leave Requests",
  "entryId": 1042,
  "histories": [
    {
      "id": "h-001",
      "type": "create",
      "by": "jane.smith",
      "on": "2026-03-12T09:15:00Z",
      "state": "Pending Approval",
      "changes": [
        { "field": "Leave Type", "from": null, "to": "Annual Leave" },
        { "field": "Start Date", "from": null, "to": "2026-03-20" },
        { "field": "Days Requested", "from": null, "to": 4 }
      ]
    },
    {
      "id": "h-002",
      "type": "intention",
      "activity": "Approve",
      "by": "ai-agent@example.com",
      "on": "2026-03-12T14:00:00Z",
      "state": null,
      "ai": {
        "reasoning": "Documents incomplete — missing medical certificate.",
        "model": "claude-sonnet-4-20250514",
        "confidence": 0.45
      }
    },
    {
      "id": "h-003",
      "type": "activity",
      "activity": "Approve",
      "by": "john.doe",
      "on": "2026-03-12T14:30:00Z",
      "state": "Approved",
      "comment": "Approved by manager",
      "changes": [
        { "field": "Remarks", "from": "Family vacation", "to": "Approved — enjoy your vacation" }
      ]
    },
    {
      "id": "h-004",
      "type": "comment",
      "by": "jane.smith",
      "on": "2026-03-12T15:00:00Z",
      "comment": "Thank you!",
      "replies": [
        { "id": "r-001", "by": "john.doe", "on": "2026-03-12T15:05:00Z", "comment": "No problem!" }
      ]
    }
  ],
  "hasMore": false,
  "page": 0
}
```

**History event types:** `create`, `edit`, `activity`, `changeStatus`, `delete`, `duplicate`, `assign`, `import`, `intention`, `comment`, `clone`, `manage`

**Response fields per event:**
- `id` — History record ID
- `type` — Human-readable event type
- `by` — Username who performed the action
- `on` — Timestamp (UTC)
- `activity` — Activity name (for custom activities)
- `actor` — On-behalf-of user (if applicable)
- `state` — Target state name after the action (null for intentions and comments)
- `comment` — Comment text (HTML stripped)
- `changes` — Array of field-level changes with `field` (display name), `from`, `to`
- `assignees` — Updated assignee list
- `due` — Updated due date
- `replies` — Threaded replies, each with `id`, `by`, `on`, `comment`
- `ai` — AI traceability context (present only on AI-submitted events). See §11.

---

### 2.11 upload_file

Upload a file to S3 storage. Returns a `/s/` URL that can be used as a File/Image field value in `submit_activity`. For files larger than 50MB, use `request_upload_url` + `confirm_upload` (§2.17, §2.18) instead.

**Resolver:** `POST /api/mcp/upload`

**Input:** Multipart form-data with the file as a form part. Optional `module` form field scopes the file to a module's S3 folder.

**Constraints:**
- Maximum file size: 50MB (use `request_upload_url` for larger files)
- Blocked extensions: `.exe`, `.bat`, `.cmd`, `.dll`, `.msi`, and other executable types
- Filenames are sanitized (path traversal characters stripped)

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "module": { "type": "string", "description": "Module name (optional, for scoping)" },
    "file": { "type": "string", "format": "binary", "description": "The file to upload (multipart/form-data)" }
  }
}
```

**Response (`FileUploadResult`):**

```json
{
  "path": "/s/xK8m/report.pdf",
  "filename": "report.pdf",
  "mimeType": "application/pdf",
  "size": 245760
}
```

**Usage in submit_activity:** After uploading, pass the returned `path` directly as the File/Image field value:

```json
{
  "module": "Leave Requests",
  "activity": "create",
  "input": {
    "Attachments": { "name": "report.pdf", "path": "/s/xK8m/report.pdf" }
  }
}
```

An external URL can be used directly as `path` without calling `upload_file` first:

```json
{
  "input": {
    "Attachments": { "name": "report.pdf", "path": "https://example.com/report.pdf" }
  }
}
```

For `Files`/`Images` (plural) fields, use arrays:

```json
{
  "input": {
    "Photos": [
      { "name": "before.jpg", "path": "/s/xK8m/before.jpg" },
      { "name": "after.jpg", "path": "/s/xK8m/after.jpg" }
    ]
  }
}
```

---

### 2.12 download_file

Download a file by module name. AI agents construct the URL by prepending `/api/mcp/download/{moduleName}` to any `/s/{shortId}/{fileName}` path from a File/Image field value.

**Resolver:** `GET /api/mcp/download/{moduleName}/s/{guid}/{fileName}`

**Input Schema:**

```json
{
  "type": "object",
  "required": ["moduleName", "guid", "fileName"],
  "properties": {
    "moduleName": { "type": "string", "description": "Module name (resolved to vectorId internally)" },
    "guid": { "type": "string", "description": "Short ID from the file URL" },
    "fileName": { "type": "string", "description": "Original filename" }
  }
}
```

**Response:** Redirects to a pre-signed S3 URL (1hr TTL). Office user-agents receive a direct stream instead.

**How to construct the download URL from a field value:**

```
Field value:  { "name": "report.pdf", "path": "/s/xK8m/report.pdf" }
Download URL: /api/mcp/download/Leave%20Requests/s/xK8m/report.pdf
```

---

### 2.13 design_workflow

> **AGENT INSTRUCTION:** Use this tool when the user wants to design a new module or workflow. This is an **agent-constructed, server-assisted** tool — the AI agent builds the `ModuleSchema` JSON, and the server provides the scaffolding template and industry defaults. Load resources `inistate://schema` and `inistate://design-guide` before designing.

**Type:** Server-side (no API call — the server returns a schema template that the agent populates)

**Requirements gathering — always do this before generating the schema:**

> **AGENT INSTRUCTION:** Before calling `design_workflow`, ask the user 2–3 targeted questions to understand their process. Present these as selectable choices when possible. Follow this sequence:

**Question 1 — Item types:** Ask what categories of items the module will track. Use multi-select so the user can pick several. Example for a service company: Installation issues, Maintenance/servicing, Repair/breakdown, Warranty claims.

**Question 2 — Typical workflow:** Ask how work typically flows from start to finish. Offer common patterns as single-select options:
- Customer reports → Technician assigned → On-site visit → Resolution
- Request → Review → Approval → Processing → Complete
- Submission → Triage → Assignment → Work → Verification → Close
- Other (user describes their own)

**Question 3 — Tracking priorities:** Ask what matters most to track. Use rank-priorities so the user can order them. Example: Assignment & scheduling, Cost tracking, SLA & response time, Communication history, Compliance documentation.

Only after gathering these answers should the agent construct the description for `design_workflow`.

**How it works:**
1. The agent gathers requirements from the user (questions above)
2. The agent calls `design_workflow` with a natural language description synthesized from the answers
3. The server returns a **scaffolded ModuleSchema template** with structure hints based on the description and industry
4. The agent reviews and completes the template — filling in field names/types, state names/colors, activities, flows, ai_hints, actor types, and confidence thresholds
5. The agent calls `validate_design` to check the completed schema
6. If valid, the agent calls `create_module` to persist it

The server does NOT use an LLM to generate the schema. It uses pattern matching on the description to select a base template (e.g., "approval workflow", "ticket management", "multi-stage pipeline") and pre-populates obvious defaults (initial state, terminal states, color assignments) using the loaded `inistate-schema.json` (§14.5) — reading valid field types from `definitions.FieldType.enum`, colors from `workflow_guide.state_color_system`, and auto-assigning colors via `keyword_hints`. The agent is responsible for the actual design decisions.

**Input Schema:**

```json
{
  "type": "object",
  "required": ["description"],
  "properties": {
    "description": {
      "type": "string",
      "description": "Natural language description of the desired workflow. Include: entity type, lifecycle states, activities, who performs each activity, what data is collected."
    },
    "industry": {
      "type": "string",
      "enum": ["financial_services", "healthcare", "legal", "hr", "procurement", "it_service", "general"],
      "default": "general",
      "description": "Industry context for compliance-aware defaults. Affects: default audit fields, confidence thresholds, actor type suggestions."
    }
  }
}
```

**Output Schema:**

```json
{
  "template": {
    "name": "",
    "icon": "",
    "description": "",
    "published": true,
    "information": [
      { "name": "Title", "type": "Text", "ai_hint": "" },
      { "name": "", "type": "", "ai_hint": "" }
    ],
    "states": [
      { "name": "Draft", "color": "#5A6070", "initial": true, "ai_hint": "" },
      { "name": "", "color": "#2968A8", "ai_hint": "" },
      { "name": "Completed", "color": "#1E6B45", "ai_hint": "" },
      { "name": "Rejected", "color": "#8B2D2D", "ai_hint": "" }
    ],
    "activities": [
      { "name": "", "actor": "human", "fields": [], "ai_hint": "", "confidence_threshold": 0 }
    ],
    "flows": [
      { "from": "", "to": "", "activity": "" }
    ]
  },
  "suggestions": {
    "detected_pattern": "approval_workflow",
    "recommended_fields": ["Requested By", "Amount", "Justification", "Attachments"],
    "recommended_states": ["Draft", "Pending Approval", "Approved", "Rejected"],
    "industry_defaults": {
      "confidence_threshold": 0.8,
      "audit_fields": ["Approval Note"],
      "actor_suggestion": "hybrid for approval activities in regulated industries"
    }
  },
  "next_step": "Complete the template fields, then call validate_design with the finished schema."
}
```

**Industry defaults:**

| Industry | Default confidence_threshold | Extra audit fields | Actor suggestion |
|---|---|---|---|
| `financial_services` | 0.9 | Compliance Note, Risk Score | `hybrid` for all approval activities |
| `healthcare` | 0.9 | Clinical Justification, HIPAA Flag | `human` for patient-affecting activities |
| `legal` | 0.85 | Legal Review Note, Privilege Flag | `hybrid` for review activities |
| `hr` | 0.8 | HR Note | `hybrid` for approval activities |
| `procurement` | 0.8 | Budget Code, PO Reference | `ai` for matching/validation activities |
| `it_service` | 0.7 | Resolution Note | `ai` for triage activities |
| `general` | 0.8 | (none) | `human` default |

---

### 2.14 validate_design

Validate a module schema before creating or updating a module. Checks for structural integrity without submitting to the API.

**Type:** Server-side validation (no API call)

**Implementation:** The MCP server validates the schema against every rule in §13, using the loaded `inistate-schema.json` (§14.5) as the source of truth for valid field types, color values, and actor enums. This is a deterministic check — no LLM involved. The validation runs the same rules that the Inistate API enforces on `create_module`/`update_module`, so passing `validate_design` guarantees the subsequent API call will not fail with a `422`.

**Input Schema:**

```json
{
  "type": "object",
  "required": ["schema"],
  "properties": {
    "schema": {
      "type": "object",
      "description": "A complete or partial ModuleSchema object. Must conform to the schema defined in §8.6."
    },
    "mode": {
      "type": "string",
      "enum": ["create", "update"],
      "default": "create",
      "description": "Validation mode. 'create' validates as a new module (all rules apply). 'update' validates as a merge (omitted sections are acceptable)."
    }
  }
}
```

**Output Schema:**

```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    "Activity 'Approve' has no confidence_threshold — AI agents will not be gated on this activity"
  ],
  "summary": {
    "field_count": 7,
    "state_count": 5,
    "activity_count": 4,
    "flow_count": 4,
    "initial_state": "Draft",
    "terminal_states": ["Approved", "Rejected", "Cancelled"],
    "ai_activities": 0,
    "hybrid_activities": 1,
    "gated_activities": 0
  }
}
```

**Error example:**

```json
{
  "valid": false,
  "errors": [
    "Activity 'Resolve' references field 'Resolution Note' which is not defined in information. Available fields: Title, Priority, Assignee.",
    "Flow from 'New' to 'Resolved' references activity 'Complete' which is not defined in activities. Available activities: Assign, Resolve.",
    "No initial state defined — exactly one state must have initial: true."
  ],
  "warnings": [],
  "summary": null
}
```

**Complete validation rules** (checked in order):

| # | Rule | Error Type |
|---|---|---|
| 1 | `name` is required and non-empty | error |
| 2 | At least one state must exist | error |
| 3 | Exactly one state must be `initial: true` | error |
| 4 | No duplicate field names in `information` | error |
| 5 | No duplicate state names in `states` | error |
| 6 | No duplicate activity names in `activities` | error |
| 7 | Every activity field must reference a field defined in `information` | error |
| 8 | Every flow must reference a defined activity | error |
| 9 | Every flow `from` and `to` must reference defined states (or `""` for `from`) | error |
| 10 | Field `type` must be a valid FieldType from §8.1 | error |
| 11 | State `color` must be a valid hex from the palette in §12.1 | error |
| 12 | Activity `actor` must be `human`, `ai`, or `hybrid` (or omitted) | error |
| 13 | Activity `confidence_threshold` must be 0–1 | error |
| 14 | Activity with `actor: "ai"` but no `confidence_threshold` | warning |
| 15 | State with no incoming flows (except initial) | warning |
| 16 | Activity not referenced by any flow | warning |
| 17 | No terminal states (no states without outgoing flows) | warning |
| 18 | Missing `ai_hint` on activities with `actor: "ai"` | warning |
| 19 | Missing state colors | warning |
```

---

### 2.15 create_module

Create a new module in the current workspace with information fields, states, activities, and flows. Requires Administrator, Consultant, or Workspace Admin role.

**Resolver:** `POST /api/configure/{moduleName}`

**Input Schema:** See §8 for the complete `ModuleSchema` definition. The full schema includes `name`, `icon`, `description`, `published`, `information[]`, `states[]`, `activities[]`, `flows[]`.

**Response:**

```json
{
  "id": 4201,
  "name": "IT Ticket",
  "emoji": "wrench",
  "updatedDate": "2026-03-01T12:00:00Z",
  "version": null
}
```

---

### 2.16 update_module

Update an existing module's schema. Merges changes into the existing canvas, preserving internal IDs for items matched by name. Omitted sections are left unchanged.

**Resolver:** `PUT /api/configure/{moduleName}`

**Input Schema:** Same shape as `create_module`. Only include sections you want to change.

**Key behavior:**
- Existing items are matched by `id` when present (enabling rename), falling back to `name` for matching
- New items (no `id`) get fresh IDs
- Omitted sections (`information`, `states`, `activities`, `flows`) are left unchanged
- This enables renaming fields, states, and activities without losing existing entry data

**Rename example:**

```json
{
  "module": "Leave Requests",
  "information": [
    { "id": "xKfLmNpQ", "name": "Leave Category", "type": "Selection", "options": ["Annual", "Sick", "Unpaid", "Compassionate"] },
    { "name": "Priority", "type": "Selection", "options": ["Low", "Medium", "High"] }
  ],
  "states": [
    { "id": "550e8400-...", "name": "Awaiting Review", "color": "#2968A8" }
  ]
}
```

**What happens:**
- `Leave Type → Leave Category` — id matched → displayName updated, existing data preserved
- `Priority` — no id → new field created with generated ShortId
- `Pending Approval → Awaiting Review` — id matched → state name updated, existing entries now show new name

**Response:**

```json
{
  "id": 4201,
  "updatedDate": "2026-03-01T14:00:00Z",
  "version": "v2"
}
```

---

### 2.17 request_upload_url

Request a presigned S3 `PUT` URL so the client uploads the file bytes directly to S3 — the file never transits the MCP server. Use this for files above ~50MB or when you want to avoid base64/JSON encoding overhead.

**Resolver:** `POST /api/mcp/request-upload-url`

**Constraints:**
- Maximum file size: 500MB
- Blocked extensions: `.exe`, `.bat`, `.cmd`, `.dll`, `.msi`, and other executable types
- Filenames are sanitized (path traversal characters stripped)
- Presigned URL TTL: 3600 seconds (1 hour) — cannot be renewed; call this tool again on expiry

**Input Schema:**

```json
{
  "type": "object",
  "required": ["module", "fileName", "fileSize"],
  "properties": {
    "module":      { "type": "string",  "description": "Module name — scopes the file to the module's storage folder" },
    "fileName":    { "type": "string",  "description": "Original filename including extension" },
    "contentType": { "type": "string",  "description": "MIME type (default: application/octet-stream)" },
    "fileSize":    { "type": "integer", "description": "File size in bytes. Must be > 0 and ≤ 500MB" }
  }
}
```

**Response (`PresignedUploadResult`):**

```json
{
  "uploadUrl": "https://s3.amazonaws.com/.../xK8m/report.pdf?X-Amz-Signature=...",
  "s3Key": "workspaces/42/modules/leave-requests/xK8m/report.pdf",
  "path": "/s/xK8m/report.pdf",
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "expiresIn": 3600
}
```

**Three-step flow:**

1. Call `request_upload_url` — get `{ uploadUrl, s3Key, path, contentType, ... }`.
2. Client uploads directly to S3:
   ```http
   PUT <uploadUrl>
   Content-Type: <contentType>   ← MUST exactly match the response contentType
   Body: <raw file bytes>
   ```
   **IMPORTANT:** The `Content-Type` header on the PUT must equal the `contentType` returned here. S3 presigned URLs sign headers — a mismatch returns `403 SignatureDoesNotMatch` with no useful diagnostic.
3. Call `confirm_upload({ s3Key })` — §2.18.
4. Pass `{ name: filename, path }` as the File/Image field value in `submit_activity`.

**Error handling:**
- `400` — `fileSize` out of range or `fileName` has a blocked extension. Do not retry.
- `403` on the S3 PUT — typically a Content-Type mismatch or expired URL. Call `request_upload_url` again to get a fresh URL.

**Orphan handling:** If the client PUTs the file but never calls `confirm_upload`, the S3 object is orphaned. The backend must have an S3 lifecycle policy to expire unconfirmed uploads (recommended: 24h).

---

### 2.18 confirm_upload

Finalize a presigned upload after the client PUTs the file bytes to S3. Verifies the file exists in S3, reads its metadata, and tracks workspace storage quota. Only `s3Key` is required — all other fields (filename, size, MIME type) are resolved from the S3 object.

**Resolver:** `POST /api/mcp/confirm-upload`

**Input Schema:**

```json
{
  "type": "object",
  "required": ["s3Key"],
  "properties": {
    "s3Key": { "type": "string", "description": "The s3Key returned from request_upload_url" }
  }
}
```

**Response (`FileUploadResult`):**

```json
{
  "path": "/s/xK8m/report.pdf",
  "filename": "report.pdf",
  "mimeType": "application/pdf",
  "size": 52428800
}
```

The `path` field matches `FileFieldValue.path` / `PresignedUploadResult.path`, so it can be dropped directly into a File/Image field value in `submit_activity`.

**Error handling:**
- `400 "File not found in S3"` — the PUT upload didn't complete, or `s3Key` is wrong. Re-PUT the file, then retry.
- `403` from the preceding S3 PUT means the presigned URL expired. Call `request_upload_url` again before retrying the whole flow.

---

## 3. MCP Resources

Resources are read-only data sources that agents can load for background context without making tool calls. They provide ambient knowledge about the workspace and its modules.

| Resource URI | Resolver | Surface | Description |
|---|---|---|---|
| `inistate://modules` | `GET /api/mcp/` | runtime | List of all modules — quick capability indexing |
| `inistate://modules/{name}/canvas` | `GET /api/mcp/{name}?tier=basic` | runtime | Base schema (fields, states) |
| `inistate://modules/{name}/canvas/extended` | `GET /api/mcp/{name}?tier=extended` | runtime | Full schema with activities and flows |
| `inistate://schema/runtime` | Bundled file (filtered view) | runtime | **Default schema for runtime ops** — runtime tool specs, entry/filter types, field value shapes |
| `inistate://schema/configure` | Bundled file (filtered view) | configure+ | **Design-mode schema** — ModuleSchema write format, state color palette, module_types, configure tools |
| `inistate://design-guide` | Bundled file (read from disk) | configure+ | FACTS Module Design Guide — requirements questions, state color system, SVG workflow diagrams, design rules |
| `inistate://frontend-guide` | Bundled file (read from disk) | frontend | Inistate REST API reference for hand-writing custom UIs (Vue/React/etc.) that call `api.inistate.com` directly |

The **Surface** column follows §1.5: `runtime` resources are visible in every mode; `configure+` resources appear after `switch_mode(configure)` or `switch_mode(frontend)`; the `frontend` resource appears only after `switch_mode(frontend)`. The legacy full-schema resource `inistate://schema` was removed in favor of the filtered variants.

> **AGENT INSTRUCTION:** Load resources based on your current server mode. Only load ONE schema variant — loading both doubles context cost without adding information.
> - **runtime mode (default, most sessions):** Load `inistate://schema/runtime` + `inistate://modules`. This gives you the runtime tool specs, entry/filter types, and file/module/user value shapes needed for listing, reading, and submitting. Do NOT call `switch_mode` unless the user pivots to design/frontend work.
> - **configure mode:** Load `inistate://schema/configure` + `inistate://design-guide`. This gives you ModuleSchema, field/state/activity definitions, state color palette, and design rules.
> - **frontend mode:** Load `inistate://frontend-guide` (plus `inistate://schema/configure` if you also need to iterate on the module schema in the same session). Pair with `get_module_schema(tier=extended)` for the target module so the generated UI knows its fields, states, and activities.
> - **Mid-session escalation:** if the user pivots from runtime to design or UI-generation, call `switch_mode(configure)` or `switch_mode(frontend)` first, then read the newly-available resource.

### 3.1 The Schema Resources

The machine-readable schema is served as two filtered views, both derived from the same `inistate-schema.json` file:

| Resource | Approx size | Contents |
|---|---|---|
| `inistate://schema/runtime` | ~40 KB | Runtime tools (list/get/submit/upload/download/history), shared types (FieldType, FieldDefinition, StateDefinition, File/Module/User value shapes), entry types, filter operators, `confidence_gate` and `ai_audit_trail` workflow notes |
| `inistate://schema/configure` | ~25 KB | Configure tools (get_module_schema, create_module, update_module), shared types, ActivityDefinition, FlowDefinition, ModuleSchema write format, `module_types` and `state_color_system` workflow notes |

The two variants partition the source schema so each mode carries only the content it needs:

- **Valid field types** (`definitions.FieldType.enum`) — both variants
- **State color palette** (`workflow_guide.state_color_system`) — **configure only**
- **Confidence gate behavior** (`workflow_guide.confidence_gate`) — **runtime only**
- **AI audit trail expectations** (`workflow_guide.ai_audit_trail`) — **runtime only**
- **Key rules** (`workflow_guide.key_rules`) — both variants

> **AGENT INSTRUCTION:** Load exactly one schema variant per session based on the user's intent. Most sessions are runtime — default to `inistate://schema/runtime`. Escalate to `inistate://schema/configure` (plus `inistate://design-guide`) only when the user explicitly asks to design or modify a module, after calling `switch_mode(configure)`.

**Implementation:**

```typescript
// Register the schema resources — the configure variant is gated behind
// switch_mode(configure|frontend) and starts disabled when the server
// boots in runtime mode.
server.registerResource(
  "schema-runtime",
  "inistate://schema/runtime",
  { mimeType: "application/json", description: "..." },
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(SCHEMA_RUNTIME, null, 2) }],
  }),
);

const schemaConfigure = server.registerResource(
  "schema-configure",
  "inistate://schema/configure",
  { mimeType: "application/json", description: "..." },
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(SCHEMA_CONFIGURE, null, 2) }],
  }),
);
if (!startConfigure) schemaConfigure.disable();   // see §14.4
```

### 3.2 The Frontend Guide Resource

`inistate://frontend-guide` is exposed only in `frontend` mode (§1.5). It returns a Markdown reference (~13 KB) covering:

- `Authorization` header formats (`fsk` API key and `Bearer` JWT) and the `wsid` workspace header
- Workspace and module discovery (`/api/workspace`, `/api/mcp/`, `/api/mcp/{name}?tier=`)
- List / read / form / submit / history endpoints and their request/response shapes
- Filter operator syntax (mirrors §9)
- Field value shapes — `Text`, `Number`, `Date`, `File/Image`, `User`, `Module`, `Table`, etc.
- Two-step presigned uploads (`request-upload-url` → S3 PUT → `confirm-upload`)
- Error response shape + HTTP status mapping
- A framework-agnostic reference client plus minimal Vue and React patterns

The guide is intentionally framework-agnostic — it covers the API contract only. The generated UI's look, feel, and component choices are up to the user. Tokens are **user-supplied at runtime** (login form, env var in the host app, OAuth callback) and never baked into generated source. Pair the guide with `get_module_schema(tier=extended)` for the target module to drive form generation.

---

## 4. MCP Prompts

Prompts are guided workflows that the MCP server offers to agents. They provide structured templates for common multi-step operations.

| Prompt | Surface | Agent Mode |
|---|---|---|
| `execute_activity` | runtime | execute |
| `diagnose_entry` | runtime | query |
| `design_factsops_workflow` | configure+ | design |
| `modify_module` | configure+ | modify |

The configure-gated prompts are hidden until `switch_mode(configure)` or `switch_mode(frontend)` is called (§1.5).

### 4.1 prompt: design_factsops_workflow

**Description:** Guide an AI agent through designing a complete FACTSOps module from scratch.

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `entity` | string | yes | What entity is this workflow about? (e.g., "leave request", "invoice", "KYC application") |
| `industry` | string | no | Industry context for compliance-aware defaults |

**Prompt template:**

```
You are designing a FACTSOps workflow module for: {entity}
{industry context if provided}

Follow this sequence:
1. Define the entity's information fields (what data is captured)
2. Define the lifecycle states (where the entity can be)
3. Define activities (what actions move the entity between states)
4. Define flows (which activities connect which states)
5. Assign actor types to each activity (human, ai, hybrid)
6. Set confidence thresholds for AI-executed activities
7. Add ai_hints to guide AI agents
8. Assign state colors using the FACTSOps color system (§12)

Rules:
- Every activity must be referenced by at least one flow
- Every activity field must reference a field defined in information
- Exactly one state must be initial
- Terminal states need no outgoing flows
- Use the Three Laws: No transition without a form. No actor without a trail. No automation without escalation.

Output a complete ModuleSchema JSON object.
```

### 4.2 prompt: execute_activity

**Description:** Guide an AI agent through executing a specific activity on an entry.

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `module` | string | yes | Module name |
| `activity` | string | yes | Activity to execute |
| `entryId` | string/integer | no | Entry ID (omit for create) |

**Prompt template:**

```
You are executing the "{activity}" activity on module "{module}".
{entryId context if provided}

Follow this sequence:
1. Call get_form(module="{module}", activity="{activity}", entryId={entryId})
2. Review the required fields, their types, and available options
3. Check if confidence_threshold is present — if so, assess your confidence
4. Prepare the input object with display-name-keyed field values
5. If your confidence is below the threshold, include ai.confidence in the submission — the platform will flag it for human review
6. Call submit_activity with the prepared input
7. Report the result to the user

Always include the ai object with reasoning, sources, model, and confidence.
```

### 4.3 prompt: diagnose_entry

**Description:** Guide an AI agent through investigating the current state and history of an entry.

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `module` | string | yes | Module name |
| `entryId` | string/integer | yes | Entry ID to diagnose |

**Prompt template:**

```
You are diagnosing entry {entryId} in module "{module}".

Follow this sequence:
1. Call get_entry(module="{module}", entryId={entryId}) to see current state and field values
2. Call get_entry_history(module="{module}", entryId={entryId}) to see the full audit trail
3. Call get_module_schema(module="{module}", tier="extended") to understand available activities
4. Identify: current state, how it got there, what actions are available next, any flagged intentions
5. Summarize findings to the user
```

### 4.4 prompt: modify_module

**Description:** Guide an AI agent through modifying an existing module's schema — adding fields, states, activities, or flows.

**Arguments:**

| Name | Type | Required | Description |
|---|---|---|---|
| `module` | string | yes | Module name to modify |
| `change` | string | yes | Description of the change to make (e.g., "add a Priority field", "add an Escalate activity") |

**Prompt template:**

```
You are modifying the module "{module}".
Change requested: {change}

Follow this sequence:
1. Call get_module_canvas(module="{module}") to get the full definition with stable IDs
2. Review the current schema — fields, states, activities, and flows
3. Apply the requested change while preserving all existing stable IDs
4. Call validate_design with the modified schema (mode="update") to check structural integrity
5. If errors: fix and re-validate
6. Present the changes to the user for review
7. Call update_module with the modified schema

Rules:
- Always use get_module_canvas (not get_module_schema) to get stable IDs for update
- Match existing items by their id field to enable renaming without data loss
- Every new activity must be referenced by at least one flow
- Every activity field must reference a field defined in information
- Load inistate://schema/configure (plus inistate://design-guide) if you need valid field types, colors, or actor types — both are visible once you are in configure mode
```

---

## 5. Authentication and Authorization

The MCP server supports two authentication methods. Only one is needed.

### 5.1 API Key Authentication

When an API key (prefixed with `fsk`) is configured via environment variable, all requests use it directly:

```
Authorization: fsk <api_key>
```

**Configuration:**

```
INISTATE_ACCESS_TOKEN=<api_key>
# or
INISTATE_API_TOKEN=<api_key>
```

### 5.2 Username/Password Authentication (JWT)

When no API key is configured, the server authenticates via username and password to obtain a JWT. This can happen two ways:

1. **Environment variables at startup** — if `INISTATE_USERNAME` and `INISTATE_PASSWORD` are set, the server auto-authenticates on the first API call.
2. **Interactive login** — the agent calls the `login` tool with user-provided credentials.

**Token lifecycle:**

```
POST /token (grant_type=password) → JWT + refresh token
  ↓
All requests use: Authorization: Bearer <jwt>
  ↓
On 401 → POST /token/refresh (refresh token) → new JWT
  ↓
If refresh fails → re-login with stored credentials
```

The server automatically handles 401 responses by refreshing the JWT or re-authenticating, then retrying the failed request. This is transparent to the agent.

### 5.3 Workspace Context

A workspace must be selected before calling any module or entry tools. The agent calls `set_workspace` to activate a workspace. The MCP server stores the workspace ID and includes it as a `wsid` header on all subsequent API requests. If no workspace has been set, the API returns HTTP 400:

```json
{
  "error": "Workspace required",
  "message": "No workspace context found. Set the active workspace before calling this endpoint."
}
```

### 5.4 Authorization Scopes

| Operation | Required Role | Notes |
|---|---|---|
| `login` | Unauthenticated | Produces a JWT for subsequent calls |
| `list_workspaces`, `set_workspace` | Any authenticated user | |
| `list_modules`, `get_module_schema`, `get_module_canvas` | Any authenticated user | Respects module-level access |
| `list_entries`, `get_entry`, `get_form` | Any authenticated user | Respects module-level access |
| `submit_activity` | Any authenticated user | Activity-level permissions apply |
| `get_entry_history` | Any authenticated user | |
| `create_module`, `update_module` | Administrator, Consultant, or Workspace Admin | Elevated privilege required |

When a user lacks module access, the API returns HTTP 403:

```json
{
  "error": "Access denied",
  "message": "You do not have access to this module. Please contact your administrator."
}
```

---

## 6. AI Agent Execution Model

### 6.1 The Five Modes

Every interaction with the FACTSOps MCP server falls into one of five modes, determined by the AI agent from the user's request:

| Mode | Agent Behavior | Key Tools |
|---|---|---|
| **design** | Generate a new module schema, validate it, create it | `design_workflow`, `validate_design`, `create_module` |
| **execute** | Find an entry, get the form, submit the activity | `list_entries`, `get_form`, `submit_activity` |
| **modify** | Get the current module definition, change it, update it | `get_module_canvas`, `validate_design`, `update_module` |
| **query** | Search entries, read history, report on data | `list_entries`, `get_entry`, `get_entry_history` |
| **ambiguous** | Ask for clarification before proceeding | None — ask the user |

### 6.2 Key Rules for All Modes

> **AGENT INSTRUCTION:** Follow these rules in every interaction:

1. **Identify the mode from the user request** (design/execute/modify/query/ambiguous) and follow the corresponding workflow sequence from tool descriptions
2. **Always bootstrap the session** — if no API key is configured, call `login` first. Then call `list_workspaces` → `set_workspace` before any module operations
3. **All input/output keys use field DISPLAY NAMES** — never use internal IDs
3. **State references use state NAMES** — never GUIDs
4. **Activity references use activity NAMES** — resolved to IDs internally
5. **Always call `get_form()` before `submit_activity()`** — to discover required fields and valid options
6. **Use `tier=basic` by default** — only request `extended` when activity details are needed
7. **Never fabricate form data** — if required fields cannot be confidently populated, escalate to human
8. **Always include the `ai` object when submitting** — for audit trail compliance
9. **Check `confidence_threshold` from `get_form` response** — if your confidence is below it, the transition will be suppressed

### 6.3 Execute Mode — Detailed Sequence

This is the most common mode. The agent finds an entry and performs an activity on it:

```
[login(username, password)]  ← only if no API key configured

list_workspaces() → set_workspace(workspaceId)

list_modules()
  → find target module name

list_entries(module, filters)
  → find target entry by state, document ID, or field values
  → check availableActivities on the entry to see what actions are available

get_form(module, activity, entryId)
  → discover required fields, types, options, defaults
  → check confidence_threshold
  → check availableActivities for valid transitions

[If form has File/Image fields and user provides files:]
upload_file(module, file)
  → get /s/ URL for each file

submit_activity(module, activity, entryId, input, state, ai)
  → include /s/ URLs for File/Image fields in input
  → perform the activity
  → check if flagged: true (confidence gate triggered)
  → check availableActivities in response for next possible actions
```

> **Note:** The `availableActivities` object on entries, forms, and activity results eliminates the need to call `get_module_schema(extended)` to discover what actions are available. The agent can use inline `availableActivities` throughout the execute flow.

### 6.4 Design Mode — Detailed Sequence

```
list_workspaces() → set_workspace(workspaceId)

switch_mode("configure")
  → reveals design tools + design resources

[Load resources: inistate://schema/configure, inistate://design-guide]

design_workflow(description, industry)
  → generate ModuleSchema from natural language

validate_design(schema)
  → check for structural errors
  → if errors: fix and re-validate
  → if valid: proceed

[Present schema to user for review]

create_module(schema)
  → create the module in Inistate

get_module_schema(module, tier="extended")
  → confirm the module was created correctly

[Optional] switch_mode("runtime")
  → when returning to entry operations
```

### 6.5 Modify Mode — Detailed Sequence

```
list_workspaces() → set_workspace(workspaceId)

switch_mode("configure")
  → reveals get_module_canvas, validate_design, update_module

[Load resource: inistate://schema/configure]

list_modules()
  → find target module

get_module_canvas(module)
  → get full definition with stable IDs

[Apply requested changes to the schema]

validate_design(modified_schema)
  → check structural integrity

update_module(module, modified_schema)
  → apply changes

[Optional] switch_mode("runtime")
  → when returning to entry operations
```

### 6.6 Frontend Mode — Detailed Sequence

Used when the user asks to generate a custom UI (Vue, React, or any framework) that calls `api.inistate.com` directly. The MCP server does not serve the generated app at runtime — it only supplies schema + guide so the agent can emit source files.

```
list_workspaces() → set_workspace(workspaceId)

switch_mode("frontend")
  → reveals configure tools + inistate://frontend-guide

[Load resources: inistate://frontend-guide, inistate://schema/configure]

list_modules()
  → confirm the target module exists

get_module_schema(module, tier="extended")
  → know the fields, states, activities, and flows the UI must render

[Optional: design_workflow / validate_design / create_module / update_module
 if the user also wants to iterate on the module schema in the same session.]

[Emit framework-specific source files that use the §10 client pattern
 from the frontend guide. The generated app reads the user's API token
 + workspace ID from runtime config — never hard-coded.]
```

---

## 7. Confidence Gating and Escalation

Confidence gating is the core safety mechanism for AI-driven state transitions. It implements the FACTSOps Third Law: **No automation without escalation.**

### 7.1 How It Works

1. **Activity design time:** Process designers set a `confidence_threshold` (0–1) on activities where AI execution is allowed
2. **Form retrieval:** `get_form` returns the `confidence_threshold` so the agent can check before submitting
3. **Submission:** The AI agent includes `ai.confidence` in the `submit_activity` call
4. **Gate evaluation:** The platform compares `ai.confidence` against `confidence_threshold`

### 7.2 Gate Outcomes

| Condition | Result |
|---|---|
| `ai.confidence >= confidence_threshold` | State transition proceeds normally |
| `ai.confidence < confidence_threshold` | State transition **suppressed** |
| No `ai.confidence` provided | State transition proceeds (no gate) |
| No `confidence_threshold` on activity | State transition proceeds (no gate) |

### 7.3 What Happens When Gated

When an AI submission is gated (confidence below threshold):

1. **Entry stays in current state** — the target state is not reached
2. **History event type is `intention`** — not the normal activity type
3. **Collaboration flags set:** `WithIntention` + `LastIntention` on the entry
4. **Response includes `"flagged": true`** — so the agent knows human review is needed
5. **Entry becomes queryable** via collaboration filter `intention` or `lastIntention`

### 7.4 Agent Behavior After Gating

> **AGENT INSTRUCTION:** When `submit_activity` returns `flagged: true`:
> 1. Inform the user that the action requires human review
> 2. Explain your reasoning (from the `ai.reasoning` field)
> 3. Note the confidence level and why it was below threshold
> 4. Do NOT retry the same submission — it will be gated again

### 7.5 Example: Gated Intention in History

```json
{
  "id": "h-002",
  "type": "intention",
  "activity": "Approve",
  "by": "ai-agent@example.com",
  "on": "2026-03-12T14:00:00Z",
  "state": null,
  "ai": {
    "reasoning": "Documents incomplete — missing medical certificate. Cannot verify leave type eligibility.",
    "sources": [
      { "type": "field", "reference": "Attachments", "excerpt": "No files attached" },
      { "type": "policy", "reference": "sick-leave-policy-v2", "excerpt": "Medical certificate required for sick leave > 2 days" }
    ],
    "model": "claude-sonnet-4-20250514",
    "confidence": 0.45
  }
}
```

---

## 8. Module Design Specification

This section defines the complete schema for creating and updating FACTSOps modules.

> **Scope note (v1.0):** Listings (named views with pre-configured filters) and Documents (document templates with auto-numbering prefixes) are supported by the Inistate platform but are **not included in this MCP server specification**. They will be added in a future version. For now, listings and document templates should be configured through the Inistate Studio UI.

### 8.0 Module Types

A module can be one of two types:

| Type | Has States | Has Activities | Has Flows | Use Case |
|---|---|---|---|---|
| **Workflow module** | Yes | Yes | Yes | Process lifecycle — entries move through states via activities (e.g., Leave Request, Purchase Order, Support Ticket) |
| **Record list module** | No | No | No | Master data, lookup tables, registries — entries are created, edited, and deleted with standard activities only (e.g., Employee Directory, Department List, Product Catalog, Holiday Calendar, Cost Centers) |

Record list modules omit `states`, `activities`, and `flows` entirely from their schema. Entries are managed with the implicit standard activities (`create`, `edit`, `delete`, `comment`). No state transitions, no custom activities, no workflows.

> **AGENT INSTRUCTION:** When a user requests a "simple list", "directory", "catalog", "registry", or "lookup table", design it as a record list module — omit states, activities, and flows. Only include `name`, `icon`, `description`, and `information` fields.

### 8.1 Field Types

| Type | Description | Platform Validation |
|---|---|---|
| `Text` | Single-line text | None |
| `MultiText` | Multi-line / rich text | None |
| `Integer` | Whole number | Must be parseable integer |
| `Number` | Decimal number | Must be parseable numeric |
| `Currency` | Monetary value | Must be parseable numeric |
| `Date` | Date only | Valid date string (e.g., `2026-03-01`) |
| `DateTime` | Date and time | Valid ISO 8601 string |
| `DateRange` | Date range (from/to) | `from`/`to` must be valid dates |
| `Selection` | Single-choice dropdown | No restriction on custom values |
| `Tag` | Multi-choice tags | No restriction on custom values |
| `YesNo` | Boolean toggle | Must be boolean or `true`/`false`/`yes`/`no` string |
| `Email` | Email address(es) | Each must contain `@` and `.` |
| `Phone` | Phone number | None |
| `Link` | URL | Must be well-formed absolute URL |
| `Image` / `Images` | Single/multiple images | Value: `FileFieldValue` object or array. See §8.7. |
| `File` / `Files` | Single/multiple files | Value: `FileFieldValue` object or array. See §8.7. |
| `Module` / `Modules` | Reference to entries in another module | Value: `ModuleFieldValue` object or array (`{ value, id }`). See §8.8. |
| `User` / `Users` | Reference to platform user(s) | Value: `UserFieldValue` object or array (`{ value, id, username }`). See §8.8. |
| `Table` | Sub-fields (columns) with rows | Must be an array. Sub-fields validated recursively. See §8.9. |
| `Signature` | Digital signature | None |
| `Formula` | Computed field | None |

**Selection options** can be provided two ways:
- Via `options` array: `{ "type": "Selection", "options": ["A", "B", "C"] }`
- Inline shorthand: `{ "type": "Selection(A/B/C)" }`

**Null/missing values** are not rejected by type validation — required-field enforcement is separate.

### 8.2 Field Definition

```json
{
  "id": "xKfLmNpQ",
  "name": "Leave Type",
  "type": "Selection",
  "options": ["Annual Leave", "Sick Leave", "Unpaid Leave"],
  "ai_hint": "Type of leave being requested. Default to Annual Leave unless specified otherwise."
}
```

| Property | Type | Required | Description |
|---|---|---|---|
| `id` | string | No (create) / Yes (update) | Stable opaque identifier. Absent on create, present on read/update. Enables renaming. |
| `name` | string | Yes | Display name. Used as the key in all input/output payloads. |
| `type` | FieldType | Yes | See §8.1 |
| `options` | string[] | No | Option names for Selection/Tag fields |
| `fields` | SubFieldDefinition[] | No | Sub-field definitions for `Table` type. Each sub-field defines a column. See §8.9. |
| `ai_hint` | string | No | Natural-language guidance for AI agents |

### 8.3 State Definition

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440002",
  "name": "Approved",
  "color": "#1E6B45",
  "initial": false,
  "ai_hint": "Leave request has been approved by the manager"
}
```

| Property | Type | Required | Description |
|---|---|---|---|
| `id` | string | No (create) / Yes (update) | Stable opaque identifier |
| `name` | string | Yes | State display name |
| `color` | string | No | Hex color code from the FACTSOps palette (see §12) |
| `initial` | boolean | No | When true, new entries default to this state. Only one state should be initial. |
| `ai_hint` | string | No | Guidance for AI agents on when an entry should be in this state |

### 8.4 Activity Definition

```json
{
  "id": "d4e5f6a7-b8c9-0123-defg-456789abcdef",
  "name": "Approve",
  "actor": "human",
  "fields": [
    { "name": "Leave Type", "readOnly": true },
    { "name": "Days Requested", "readOnly": true },
    { "name": "Remarks", "required": true }
  ],
  "ai_hint": "Manager approves the leave request after reviewing dates and coverage",
  "confidence_threshold": 0.8
}
```

| Property | Type | Required | Description |
|---|---|---|---|
| `id` | string | No (create) / Yes (update) | Stable opaque identifier |
| `name` | string | Yes | Activity display name |
| `fields` | array | No | Fields in the form — strings (shorthand) or objects with `name`, `required`, `readOnly`, `options` |
| `ai_hint` | string | No | Guidance for AI agents on when/how to perform this activity |
| `actor` | enum | No | `human` / `ai` / `hybrid` (default: `human`) |
| `confidence_threshold` | number (0–1) | No | Min AI confidence for state transition to proceed. Omit or 0 to disable. |

**Actor types:**

| Actor | Behavior |
|---|---|
| `human` | Only a person can execute. AI should surface the form to the appropriate person and wait. |
| `ai` | AI agent performs autonomously. Fills and submits the form programmatically. |
| `hybrid` | Either person or AI may perform. AI pre-fills based on context; human reviews before commit. |

**Activity field references:**

Fields can be specified as simple strings (shorthand) or as objects with constraints:

```json
// Shorthand — defaults to required=false, readOnly=false
"fields": ["Title", "Priority", "Assignee"]

// Object form — with per-field constraints
"fields": [
  { "name": "Leave Type", "readOnly": true },
  { "name": "Remarks", "required": true },
  { "name": "Priority", "required": true, "options": ["Medium", "High"] }
]
```

The `options` array on an activity field reference constrains the allowed options to a subset of the field's full options list.

### 8.5 Flow Definition

```json
{
  "from": "Draft",
  "to": "Pending Approval",
  "activity": "Submit",
  "ai_hint": "Triggered when employee completes and submits the leave form"
}
```

| Property | Type | Required | Description |
|---|---|---|---|
| `from` | string | Yes | Source state name. Empty string `""` = any state. |
| `to` | string | Yes | Target state name |
| `activity` | string | Yes | Activity name that triggers this transition |
| `ai_hint` | string | No | Guidance for AI agents |

### 8.6 Complete ModuleSchema

```json
{
  "name": "Leave Requests",
  "icon": "🏖️",
  "description": "Employee leave request management with approval workflow",
  "published": true,
  "information": [ ...FieldDefinition[] ],
  "states": [ ...StateDefinition[] ],
  "activities": [ ...ActivityDefinition[] ],
  "flows": [ ...FlowDefinition[] ]
}
```

| Property | Type | Required | Description |
|---|---|---|---|
| `moduleId` | string | For update only | Module identifier for updates |
| `name` | string | Yes | Module name |
| `icon` | string | No | Emoji identifier |
| `description` | string | No | Human-readable module description |
| `published` | boolean | No | Whether the module is published (default: `true`) |
| `information` | FieldDefinition[] | No | Field definitions. Order determines display order. |
| `states` | StateDefinition[] | No | Workflow states. **Omit for record list modules.** |
| `activities` | ActivityDefinition[] | No | Custom activities. **Omit for record list modules.** |
| `flows` | FlowDefinition[] | No | State transition rules. **Omit for record list modules.** |

### 8.7 File/Image Field Values

File and Image fields use object values, not plain strings.

**Stored/returned format (`FileFieldValue`):**

```json
{ "name": "report.pdf", "path": "/s/xK8m/report.pdf" }
```

**Submission format (`FileFieldInput`):**

```json
{ "name": "report.pdf", "path": "/s/xK8m/report.pdf" }
```

`path` must be either a path returned by `upload_file()` / `confirm_upload()` (e.g. `/s/xK8m/report.pdf`) or an external URL (e.g. `https://example.com/report.pdf`). Inline base64 bytes are not supported — pre-upload via `upload_file` or `request_upload_url`, or provide a URL.

For singular fields (`File`, `Image`): value is one object.
For plural fields (`Files`, `Images`): value is an array of objects.

**Upload path selection:**

| File size | Tool | Data flow |
|---|---|---|
| ≤ 50MB | `upload_file` (§2.11) | Agent base64 → MCP server → multipart POST → S3 |
| > 50MB (up to 500MB) | `request_upload_url` + `confirm_upload` (§2.17, §2.18) | Agent PUT → S3 directly; MCP server never sees the bytes |
| Already hosted at a URL | skip upload | Pass the URL as `path` directly |

**Download:** To download a file, prepend `/api/mcp/download/{moduleName}` to any `/s/` path. See §2.12.

### 8.8 Module/User Field Values

`Module`, `Modules`, `User`, and `Users` fields reference entries in other modules or platform users. They use object values and are round-trippable — output from `get_entry`/`list_entries` and input to `submit_activity` use the same shape.

**Module / Modules (`ModuleFieldValue`):**

```json
{ "value": "PO-2024-0042", "id": 187 }
```

| Property | Type | Description |
|---|---|---|
| `value` | string | Display value of the referenced entry |
| `id` | integer \| string | Entry ID of the referenced entry |

**User / Users (`UserFieldValue`):**

```json
{ "value": "Alice Tan", "id": 42, "username": "alice.tan" }
```

| Property | Type | Description |
|---|---|---|
| `value` | string | Display name of the user |
| `id` | integer \| string | Entry ID of the user entry |
| `username` | string | Username of the user |

For singular fields (`Module`, `User`): value is one object.
For plural fields (`Modules`, `Users`): value is an array of objects.

The MCP layer decomposes these objects into the internal storage format on submission, so agents only need to pass the object shape shown above.

**Discovering referenced module:** When a field's type is `Module`/`Modules` or `User`/`Users`, `get_form` includes a `module` property on the field entry identifying which module the reference points at. Use `list_entries` on that module to find valid `id` values.

### 8.9 Table Sub-fields

`Table` type fields contain rows with sub-fields (columns). Each sub-field is a `SubFieldDefinition`:

```json
{
  "name": "Parts Used",
  "type": "Table",
  "fields": [
    { "name": "Part Name", "type": "Text" },
    { "name": "Quantity", "type": "Integer" },
    { "name": "Unit Cost", "type": "Currency" },
    { "name": "Category", "type": "Selection", "options": ["Compressor", "Filter", "Refrigerant", "Other"] }
  ],
  "ai_hint": "List of parts used in the repair. Add one row per part."
}
```

**SubFieldDefinition properties:**

| Property | Type | Required | Description |
|---|---|---|---|
| `id` | string | No (create) / Yes (update) | Stable opaque identifier |
| `name` | string | Yes | Sub-field display name |
| `type` | FieldType | Yes | Any valid FieldType |
| `options` | string[] | No | Options for Selection/Tag sub-fields |

**Table field values in entries** are arrays of row objects, keyed by sub-field display name:

```json
{
  "Parts Used": [
    { "Part Name": "Compressor Fan", "Quantity": 1, "Unit Cost": 250, "Category": "Compressor" },
    { "Part Name": "Air Filter", "Quantity": 2, "Unit Cost": 45, "Category": "Filter" }
  ]
}
```

---

## 9. Filtering Reference

The `list_entries` tool supports rich filtering via the `filters` object. All filters use display names as keys.

### 9.1 Simple Equality

Pass a plain value to match exactly:

```json
{ "filters": { "Priority": "High", "Score": 95 } }
```

### 9.2 Text Operators

```json
{ "filters": { "Title": { "contains": "report" } } }
```

| Operator | Description |
|---|---|
| `is` | Exact match |
| `not` | Not equal |
| `contains` | Substring match |
| `startsWith` | Starts with value |
| `endsWith` | Ends with value |
| `excludes` | Does not contain substring |

### 9.3 Number Operators

```json
{ "filters": { "Amount": { "min": 1000, "max": 5000 } } }
```

| Operator | Description |
|---|---|
| `min` | Greater than or equal (≥) |
| `above` | Greater than (>) |
| `max` | Less than or equal (≤) |
| `below` | Less than (<) |
| `between` | Range — pass `{ "min": N, "max": N }` |

### 9.4 Date Operators

```json
{ "filters": { "DueDate": { "after": "2026-01-01", "before": "2026-12-31" } } }
```

| Operator | Description |
|---|---|
| `after` | On or after date (≥) |
| `before` | On or before date (≤) |
| `upcoming` | Next N time units: `{ "duration": "day"\|"week"\|"month", "offset": N }` |
| `past` | Previous N time units: `{ "duration": "day"\|"week"\|"month", "offset": N }` |
| `within` | Current time window: `{ "duration": "day"\|"week"\|"month", "offset": N }` |

`after` and `before` can be combined for a date range. Relative operators use `duration` + `offset`.

### 9.5 User Operators

```json
{ "filters": { "assignee": "me", "Reviewer": { "me": true } } }
```

Pass `"me"` as a simple string on any user field, or use the object form `{ "me": true }`.

### 9.6 Null / Existence Checks

```json
{ "filters": { "Notes": { "empty": true }, "Assignee": { "exists": true } } }
```

| Operator | Description |
|---|---|
| `empty` | Field is null or empty |
| `exists` | Field has a value |

### 9.7 Boolean (YesNo) Fields

```json
{ "filters": { "Active": { "yes": true }, "Archived": { "no": true } } }
```

### 9.8 Table/List Fields

Filter rows within a Table or List field using the `rows` array:

```json
{
  "filters": {
    "Lines": {
      "rows": [
        { "Item": { "contains": "Widget" } },
        { "Quantity": { "min": 5 } }
      ]
    }
  }
}
```

All sub-field conditions are AND-ed. Additional operators: `excludes` (exclude matching rows), `none` (table is empty), `exists` (has at least one row).

### 9.9 Logical Grouping (AND/OR)

```json
{
  "filters": {
    "and": [
      { "state": "Open" },
      {
        "or": [
          { "Priority": "High" },
          { "Score": { "min": 90 } }
        ]
      }
    ]
  }
}
```

Multiple fields in a single object without `and`/`or` are treated as implicit AND.

### 9.10 Operator Aliases

All operators are case-insensitive and accept multiple aliases:

| Canonical | Aliases |
|---|---|
| `min` | `gte`, `atLeast`, `minimum`, `greaterThanEqual` |
| `not` | `isNot`, `ne`, `neq` |
| `empty` | `none`, `null`, `isNull`, `blank` |
| `exists` | `any`, `notNull`, `hasValue`, `notEmpty` |
| `me` | `myself`, `currentUser` |
| `upcoming` | `in`, `next`, `coming` |
| `past` | `ago`, `previous`, `last` |
| `within` | `around` |

### 9.11 Standard Fields in Filters

Standard fields can be used alongside custom fields: `state`, `documentId`, `createdBy`, `assignee`, `due`, `date`, `createdDate`, `updatedDate`. They are automatically resolved to their internal field IDs.

### 9.12 Sorting and Pagination

| Parameter | Type | Default | Description |
|---|---|---|---|
| `sortBy` | string | — | Display name of the field to sort by |
| `sortDirection` | string | `"asc"` | `"asc"` or `"desc"` |
| `currentPage` | integer | 0 | Zero-based page index |
| `pageSize` | integer | 50 | Items per page (max 500) |

---

## 10. Error Handling

### 10.1 Error Response Shape

All MCP endpoints return errors in a consistent JSON shape:

```json
{
  "error": "Short error code",
  "message": "Human-readable description of what went wrong",
  "details": [
    { "field": "Start Date", "message": "Start Date must be a valid date (e.g. 2026-03-01)" }
  ]
}
```

The `details` array is only present on `422` validation errors.

### 10.2 HTTP Status Code Mapping

| Status | Meaning | Error Values | Agent Action |
|---|---|---|---|
| `400` | Bad request | `"Workspace required"`, `"Invalid moduleId"`, `"Invalid entryId"`, `"Invalid tier"`, `"Submission failed"`, `"Duplicate field mapping"`, `"Request failed"` | Check message, correct, retry |
| `401` | Unauthorized | `"Unauthorized"` | Refresh bearer token, retry |
| `403` | Forbidden | `"Access denied"` | Do NOT retry. Inform user they lack access. |
| `404` | Not found | `"Not found"` | Do NOT retry. Module or entry ID is wrong. |
| `422` | Validation failure | `"Validation failed"` | Surface `details[].field` and `details[].message`. |

### 10.3 Validation Error Examples

**Field type validation (submit_activity):**

```json
{
  "error": "Validation failed",
  "message": "One or more fields failed validation",
  "details": [
    { "field": "Start Date", "message": "Start Date must be a valid date (e.g. 2026-03-01)" },
    { "field": "Score", "message": "Score must be a whole number" },
    { "field": "Amount", "message": "Amount must be a number" },
    { "field": "Active", "message": "Active must be true or false" },
    { "field": "Email", "message": "Email contains an invalid email address: bad-email" },
    { "field": "Items[1].Amount", "message": "Items[1].Amount must be a number" }
  ]
}
```

**Schema validation (create_module / update_module):**

```json
{
  "error": "Validation failed",
  "message": "Activity 'Resolve' references field 'Resolution Note' which is not defined in information. Available fields: Title, Priority, Assignee."
}
```

> **AGENT INSTRUCTION:** On `422` errors with `details`, iterate through `details[].field` to identify which fields failed and `details[].message` for the expected format. Fix the input and retry.

---

## 11. AI Audit Trail

Every activity submitted by an AI agent should include the `ai` object for full traceability. This is critical for compliance with EU AI Act, FINRA, HIPAA, and Colorado AI Act requirements.

### 11.1 AI Context Schema

```json
{
  "ai": {
    "reasoning": "All required documents are present and values are within policy limits.",
    "sources": [
      { "type": "policy", "reference": "leave-policy-v3", "excerpt": "Annual leave up to 20 days" },
      { "type": "field", "reference": "Days Requested", "excerpt": "4" },
      { "type": "document", "reference": "medical-cert-2026.pdf", "excerpt": "Certified sick leave" }
    ],
    "model": "claude-sonnet-4-20250514",
    "model_version": "2025-05-14",
    "prompt_hash": "abc123def456",
    "confidence": 0.95
  }
}
```

| Property | Type | Description |
|---|---|---|
| `reasoning` | string | Natural language explanation of the AI's decision |
| `sources` | array | What data the AI used — each with `type`, `reference`, `excerpt` |
| `model` | string | Which model made this decision (e.g., `claude-sonnet-4-20250514`) |
| `model_version` | string | Model version / checkpoint for reproducibility |
| `prompt_hash` | string | Hash of the system prompt used, for version tracking |
| `confidence` | number (0–1) | Confidence score. Compared against `confidence_threshold` for gating. |

### 11.2 Source Types

| Source Type | When to Use | Example |
|---|---|---|
| `field` | Decision based on entry field values | `{ "type": "field", "reference": "Amount", "excerpt": "4500" }` |
| `document` | Decision based on attached documents | `{ "type": "document", "reference": "invoice-2026.pdf", "excerpt": "..." }` |
| `policy` | Decision based on business rules/policies | `{ "type": "policy", "reference": "expense-policy-v2", "excerpt": "..." }` |
| `history` | Decision based on entry history | `{ "type": "history", "reference": "h-001", "excerpt": "Previously rejected" }` |
| `external` | Decision based on external data sources | `{ "type": "external", "reference": "credit-check-api", "excerpt": "Score: 720" }` |

### 11.3 Audit Trail Visibility

- The `ai` object is persisted on each history event and returned by `get_entry_history`
- This enables full chain-of-reasoning reconstruction for any entry
- The `ai` object is **only present** on events submitted with AI context — human actions have no `ai` field
- Intention events (gated submissions) also include the `ai` object, showing why the AI attempted the action and why it was gated

### 11.4 The Three Laws Compliance

The audit trail enforces the FACTSOps Three Laws:

| Law | How It's Enforced |
|---|---|
| **No transition without a form** | Every state change requires a `submit_activity` call with structured `input` |
| **No actor without a trail** | Every history event records `by` (who), `on` (when), `changes` (what), and `ai` (why) |
| **No automation without escalation** | `confidence_threshold` gates suppress transitions below threshold, recording `intention` events |

---

## 12. State Color System

When creating modules, states must be assigned colors from the fixed 8-color FACTSOps palette. All colors are designed for white text on colored background (WCAG AA 4.5:1+ contrast).

### 12.1 Color Palette

| Hex Code | Name | When to Use |
|---|---|---|
| `#5A6070` | Grey | Not started, idle, queued, no action expected |
| `#2968A8` | Blue | Waiting for actor to take next action, no urgency |
| `#2A7B50` | Green | Work actively being executed by an actor right now |
| `#A07828` | Amber | Deadline approaching, condition flagged, action needed soon |
| `#C0392B` | Red | SLA breached, escalation required, process stuck |
| `#6B4D91` | Purple | Blocked by external dependency outside this workflow |
| `#1E6B45` | Dark Green | Terminal success (approved, completed, closed) |
| `#8B2D2D` | Dark Red | Terminal failure (rejected, cancelled, failed) |

### 12.2 Decision Order

Apply colors in this priority order:

1. Terminal success → `#1E6B45`
2. Terminal failure / rejection / cancellation → `#8B2D2D`
3. Active work being executed → `#2A7B50`
4. SLA breached or escalation required → `#C0392B`
5. Deadline approaching or flagged → `#A07828`
6. Blocked by external dependency → `#6B4D91`
7. Waiting for next action, no urgency → `#2968A8`
8. Not started, queued, idle → `#5A6070`

### 12.3 Rules

- **Only use the 8 hex codes listed.** Never generate custom hex values.
- **Terminal states must be `#1E6B45` or `#8B2D2D`** — never grey, blue, or green.
- **Never use `#2A7B50` (green)** for states where no actor is actively working.
- **Never use `#C0392B` (red)** unless a real SLA breach or escalation condition exists.
- **Only one state in a linear workflow** should typically be green — the active work state.
- **When unsure, default to `#2968A8` (blue)** — it is the safest general-purpose color.
- In parallel/branching workflows, multiple states may use green if each represents genuinely concurrent active work.

### 12.4 Keyword Hints

When a state name contains these keywords, use the mapped color. Always check terminal rules first.

| Color | Keywords |
|---|---|
| `#5A6070` | draft, new, open, backlog, queued, not started, inactive, parked, unassigned |
| `#2968A8` | pending, submitted, awaiting, assigned, ready, scheduled, planned, under review, to do |
| `#2A7B50` | in progress, processing, working, executing, building, running, reviewing, implementing, testing |
| `#A07828` | due soon, at risk, warning, expiring, needs attention, follow up, reminder |
| `#C0392B` | overdue, escalated, breached, stuck, critical, urgent, sla |
| `#6B4D91` | blocked, waiting on, on hold, external, vendor, third party, dependency |
| `#1E6B45` | approved, completed, done, resolved, closed, delivered, passed, accepted, verified, fulfilled, signed off |
| `#8B2D2D` | rejected, cancelled, failed, denied, expired, voided, abandoned, withdrawn, terminated, declined |

### 12.5 Common Mistakes

| Mistake | Correct |
|---|---|
| Green (`#2A7B50`) for "Approved" | Blue (`#2968A8`) if awaiting next step, Dark green (`#1E6B45`) if terminal |
| Grey (`#5A6070`) for "Closed" or "Cancelled" | Dark green (`#1E6B45`) or dark red (`#8B2D2D`) — these are terminal |
| Red (`#C0392B`) for "Rejected" | Dark red (`#8B2D2D`) — rejection is terminal, not escalation |
| Green (`#2A7B50`) for "Pending" or "Waiting" | Blue (`#2968A8`) — no one is actively working |

### 12.6 Reference Examples

**Approval workflow** (linear: submit → wait → approve/reject):
| State | Color |
|---|---|
| Draft | `#5A6070` |
| Submitted | `#2968A8` |
| Under Review | `#2A7B50` |
| Approved | `#1E6B45` |
| Rejected | `#8B2D2D` |

**Support ticket** (external dependency + escalation):
| State | Color |
|---|---|
| New | `#5A6070` |
| Triaged | `#2968A8` |
| In Progress | `#2A7B50` |
| Awaiting Customer | `#6B4D91` |
| Escalated | `#C0392B` |
| Resolved | `#1E6B45` |
| Closed | `#1E6B45` |

**Procurement** (multi-stage handoffs):
| State | Color |
|---|---|
| Requested | `#5A6070` |
| Budget Review | `#2968A8` |
| Approved | `#2968A8` |
| Ordering | `#2A7B50` |
| Shipped | `#2968A8` |
| Delivered | `#1E6B45` |
| Cancelled | `#8B2D2D` |

**Record list module** (no workflow — master data / lookup table):

> Record list modules have no states, activities, or flows. Only standard create/edit/delete operations apply. No state colors needed. See §8.0.

---

## 13. Workflow Validation Rules

These rules are enforced by `validate_design` (server-side) and by the Inistate API on `create_module`/`update_module`.

### 13.1 Structural Rules

**For workflow modules** (with states, activities, flows):

| Rule | Error If Violated |
|---|---|
| **At least one state must exist** | "No states defined" |
| **Exactly one state must be `initial: true`** | "No initial state defined" or "Multiple initial states" |
| **Every activity field must reference a field in `information`** | "Activity '{name}' references field '{field}' which is not defined in information" |
| **Every flow must reference a defined activity** | "Flow from '{from}' to '{to}' references activity '{activity}' which is not defined" |
| **Every flow must reference defined states** | "Flow references state '{name}' which is not defined" |
| **No duplicate field names** | "Duplicate field name: '{name}'" |
| **No duplicate state names** | "Duplicate state name: '{name}'" |
| **No duplicate activity names** | "Duplicate activity name: '{name}'" |
| **Table fields must have `fields` array** | "Table field '{name}' has no sub-fields defined" |
| **Table sub-fields must have valid types** | "Table field '{name}' sub-field '{subField}' has invalid type" |

**For record list modules** (no states, activities, or flows):

| Rule | Error If Violated |
|---|---|
| **`name` is required** | "Module name is required" |
| **No duplicate field names** | "Duplicate field name: '{name}'" |
| **States, activities, and flows must be omitted or empty** | (no error — simply ignored) |
| **Table fields must have `fields` array** | Same as workflow modules |

### 13.2 Warnings (Non-Blocking)

| Condition | Warning |
|---|---|
| Activity with `actor: "ai"` but no `confidence_threshold` | "Activity '{name}' has no confidence_threshold — AI agents will not be gated" |
| State with no incoming flows (except initial state) | "State '{name}' is unreachable — no flows lead to it" |
| Activity not referenced by any flow | "Activity '{name}' is not used in any flow" |
| No terminal states defined | "No terminal states — process may run indefinitely" |
| Missing `ai_hint` on activities with `actor: "ai"` | "Activity '{name}' has actor 'ai' but no ai_hint — agents may struggle to execute correctly" |
| Missing state colors | "State '{name}' has no color — will use default" |

### 13.3 Design Best Practices

> **AGENT INSTRUCTION:** When designing workflows, follow these practices:

**Field design:**
1. **Group related fields logically** — customer info, issue details, assignee info, cost tracking.
2. **Use `Selection` for bounded choices**, `Tag` for open-ended categories.
3. **Use `Table` type for line items** (parts used, checklist items) with sub-fields via `fields` array.
4. **Add `ai_hint` to any field** that requires business logic interpretation (e.g., how to calculate a value, when to set a boolean, what format to use).
5. **Include file/image fields** for supporting documentation and photos.

**Workflow design:**
6. **Keep the main path linear** — the "happy path" should flow clearly from initial state to terminal success.
7. **Add side branches** for external blockers, escalations, and cancellations.
8. **Always include a cancellation path** from early states.
9. **Include a verification/confirmation step** before terminal success.
10. **Allow reopening** from verification back to active work.
11. **Use `confidence_threshold`** on activities where AI auto-decisions need human oversight.

**Activity design:**
12. **Mark context fields as `readOnly`** in activity forms (so reviewers see them but cannot change them).
13. **Mark decision fields as `required`** (e.g., remarks when rejecting, feedback when verifying).
14. **Keep activity names short and action-oriented** — Triage, Assign, Escalate, Resolve, Verify.
15. **Every activity that performs a state transition** must have a matching flow entry.

**State design:**
16. **Name states as conditions** — "Pending Approval" not "Step 2". States describe WHERE the entity IS.
17. **Name activities as actions** — "Approve", "Submit", "Escalate". Activities describe WHAT is DONE.
18. **Start simple** — begin with 3–5 states and 2–3 activities. Add complexity later.
19. **Every terminal state should be reachable** — validate that at least one flow leads to each terminal state.
20. **Follow the Three Laws** — every transition needs a form, every actor needs a trail, every automation needs an escalation path.

### 13.4 Output Checklist

> **AGENT INSTRUCTION:** Before delivering a module design, verify every item:

**Module structure:**
- [ ] Module has `name`, `icon`, and `description`
- [ ] All fields use valid FieldType values from the schema (§8.1)
- [ ] Selection/Tag fields have an `options` array
- [ ] Fields with business logic have `ai_hint`
- [ ] Exactly one state has `initial: true`
- [ ] Every state uses one of the 8 palette hex colors (§12.1)
- [ ] Every state has an `ai_hint`
- [ ] Every activity that changes state has a corresponding flow entry
- [ ] Activity fields use `required`/`readOnly` constraints appropriately
- [ ] No orphan states (every non-initial state is reachable via at least one flow)
- [ ] No duplicate field names, state names, or activity names

**Structural integrity (same as validate_design rules):**
- [ ] Every activity field references a field defined in `information`
- [ ] Every flow references a defined activity
- [ ] Every flow `from` and `to` reference defined states
- [ ] Activity `actor` is `human`, `ai`, or `hybrid`
- [ ] Activity `confidence_threshold` is 0–1

**Design quality:**
- [ ] Main workflow path is linear and clear
- [ ] Side branches exist for blockers, escalations, cancellations
- [ ] Terminal success and terminal failure states both exist
- [ ] AI-actor activities have `confidence_threshold` set
- [ ] AI-actor activities have `ai_hint` explaining when/how to execute
- [ ] Context fields in approval/review activities are marked `readOnly`
- [ ] Decision fields in approval/review activities are marked `required`

---

## 14. Implementation Architecture

### 14.1 Technology Stack

| Component | Recommendation | Rationale |
|---|---|---|
| Runtime | Node.js 20+ / TypeScript | MCP SDK is TypeScript-first |
| MCP SDK | `@modelcontextprotocol/sdk` | Official SDK; handles transport, protocol, serialization |
| HTTP Client | `fetch` (native) | For proxying to `api.inistate.com` |
| Transport | stdio (default), Streamable HTTP | stdio for local CLI; Streamable HTTP for remote/web deployment |
| Env loader | `dotenv` | Loads `.env` files for configuration |
| Package Registry | npm | For MCP registry submission |

### 14.2 Server Configuration

```
# API base URL (optional, defaults to https://api.inistate.com)
INISTATE_API_URL=https://api.inistate.com

# Authentication — choose one method:

# Method 1: API key (fsk prefix)
INISTATE_ACCESS_TOKEN=<api_key>
# or
INISTATE_API_TOKEN=<api_key>

# Method 2: Username/password (auto-login on first API call)
INISTATE_USERNAME=<username>
INISTATE_PASSWORD=<password>

# Initial server mode (optional, defaults to "runtime"; see §1.5)
# runtime   — entry CRUD only (default; smallest on-connect payload)
# configure — adds module design tools, design-guide, configure prompts
# frontend  — configure + inistate://frontend-guide
INISTATE_MCP_MODE=runtime

# HTTP transport port (only for http entry point)
PORT=3000
```

### 14.3 Project Structure

```
inistate-mcp/
├── src/
│   ├── index.ts        # stdio entry point (dotenv + StdioServerTransport)
│   ├── http.ts         # Streamable HTTP entry point (dotenv + node:http + StreamableHTTPServerTransport)
│   ├── server.ts       # createServer() factory — registers tools, resources, prompts; owns switch_mode + mode gating
│   ├── api.ts          # HTTP client: auth (API key / JWT / refresh), headers, wsid, request wrapper
│   ├── tools.ts        # MCP tool registrations (login … update_module); returns configureTools[]
│   ├── resources.ts    # MCP resource handlers; returns configureResources[], frontendResources[]
│   ├── prompts.ts      # MCP prompt templates; returns configurePrompts[]
│   ├── schema.ts       # FACTSOps schema loading + filtered views, design_workflow logic, validate_design logic
│   └── schema.test.ts  # Schema validation tests
├── package.json
├── tsconfig.json
└── README.md
```

**Dual entry points:**

| Entry point | Binary | Transport | Use case |
|---|---|---|---|
| `src/index.ts` | `inistate-mcp` | `StdioServerTransport` | Local CLI (Claude Code, etc.) |
| `src/http.ts` | `inistate-mcp-http` | `StreamableHTTPServerTransport` | Remote/web deployment, Docker |

Both entry points call `createServer()` from `server.ts`, which returns a fully configured `McpServer` instance. The HTTP entry point manages session-scoped transports keyed by `mcp-session-id` header, with a `/health` endpoint and CORS support.

### 14.4 Tool Registration Pattern

The server uses the `McpServer` high-level API from `@modelcontextprotocol/sdk` with Zod schemas for input validation. The registration helpers return handles to the `configure+` tools, resources, and prompts so the `createServer` factory can disable them when the server boots in `runtime` mode and re-enable them on `switch_mode` (§1.5, §2.0a):

```typescript
// server.ts — factory function
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "inistate-mcp",
    version: "1.0.0",
  });

  const { configureTools } = registerTools(server);
  const { configureResources, frontendResources } = registerResources(server);
  const { configurePrompts } = registerPrompts(server);

  // Initial mode: runtime by default. Set INISTATE_MCP_MODE=configure to expose
  // the full configure surface on connect. Set INISTATE_MCP_MODE=frontend for
  // configure + the frontend-guide resource.
  const envMode = (process.env.INISTATE_MCP_MODE || "").toLowerCase();
  const startConfigure = envMode === "configure" || envMode === "frontend";
  const startFrontend = envMode === "frontend";

  if (!startConfigure) {
    for (const t of configureTools) t.disable();
    for (const r of configureResources) r.disable();
    for (const p of configurePrompts) p.disable();
  }
  if (!startFrontend) {
    for (const r of frontendResources) r.disable();
  }

  server.registerTool(
    "switch_mode",
    {
      description: "Switch tool surface between runtime / configure / frontend.",
      inputSchema: {
        mode: z.enum(["runtime", "configure", "frontend"]),
      },
    },
    async ({ mode }) => {
      const enableConfigure = mode === "configure" || mode === "frontend";
      const enableFrontend = mode === "frontend";
      for (const t of configureTools) enableConfigure ? t.enable() : t.disable();
      for (const r of configureResources) enableConfigure ? r.enable() : r.disable();
      for (const p of configurePrompts) enableConfigure ? p.enable() : p.disable();
      for (const r of frontendResources) enableFrontend ? r.enable() : r.disable();
      return {
        content: [{ type: "text", text: JSON.stringify({ mode, message: `Switched to ${mode} mode` }, null, 2) }],
      };
    },
  );

  return server;
}
```

`RegisteredTool.disable()` / `.enable()` (and the equivalent on resources and prompts) automatically fire `notifications/tools/list_changed`, `notifications/resources/list_changed`, and `notifications/prompts/list_changed` so connected clients refresh their local catalog without reconnecting. Measured on-connect payload for a `runtime` start: ~5.5k tokens (vs. ~11k for `configure` / `frontend`).

```typescript
// tools.ts — tool registration returns handles for mode-gated tools
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as api from "./api.js";

export function registerTools(server: McpServer): { configureTools: RegisteredTool[] } {
  const configureTools: RegisteredTool[] = [];

  // Runtime-visible tool (always on)
  server.registerTool(
    "login",
    {
      description: "Authenticate with username and password...",
      inputSchema: {
        username: z.string().describe("Inistate account username or email"),
        password: z.string().describe("Account password"),
      },
    },
    async ({ username, password }) => {
      await api.loginWithCredentials(username, password);
      return { content: [{ type: "text", text: JSON.stringify({ message: "Login successful" }) }] };
    },
  );

  server.registerTool("list_workspaces", { /* ... */ }, async () => { /* ... */ });

  // Configure-gated tool — returned to the factory so it can be disabled
  // when the server starts in runtime mode.
  configureTools.push(
    server.registerTool(
      "create_module",
      {
        description: "Create a new module from a ModuleSchema...",
        inputSchema: { /* ... */ },
      },
      async (input) => { /* ... */ },
    ),
  );

  // ... remaining tools (configureTools.push(...) for every configure-gated tool)

  return { configureTools };
}
```

`registerResources` and `registerPrompts` follow the same pattern, returning `configureResources`, `frontendResources`, and `configurePrompts` respectively so the factory can toggle them together.

```typescript
// index.ts — stdio entry point
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

### 14.5 Schema Loading at Startup

The MCP server loads `inistate-schema.json` once at startup and holds it in memory as a read-only reference. This schema drives validation, design assistance, and is exposed as an MCP resource for agents.

**What the schema provides at runtime:**

| Schema Section | Used By | Purpose |
|---|---|---|
| `definitions.FieldType.enum` | `validate_design`, `design_workflow` | Valid field type list |
| `definitions.StateDefinition.properties.color` | `validate_design` | Valid hex color palette |
| `definitions.ActivityDefinition.properties.actor.enum` | `validate_design` | Valid actor types |
| `workflow_guide.state_color_system.palette` | `validate_design`, `design_workflow` | Color-to-meaning mapping |
| `workflow_guide.state_color_system.keyword_hints` | `design_workflow` | Auto-assign colors from state names |
| `workflow_guide.state_color_system.decision_order` | `design_workflow` | Color priority rules |
| `workflow_guide.state_color_system.rules` | `validate_design` | Color assignment validation |
| `workflow_guide.confidence_gate` | Agent resource | Confidence gating behavior reference |
| `workflow_guide.ai_audit_trail` | Agent resource | Audit trail expectations |
| `workflow_guide.key_rules` | Agent resource | Agent execution rules |

**Implementation:**

```typescript
import { readFileSync } from "fs";
import { resolve } from "path";

// Load once at startup — immutable after this
const SCHEMA_PATH = resolve(__dirname, "../schema/inistate-schema.json");
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

// Derived lookups — built once from schema
const VALID_FIELD_TYPES: string[] = SCHEMA.definitions.FieldType.enum;
const VALID_ACTOR_TYPES: string[] = SCHEMA.definitions.ActivityDefinition.properties.actor.enum;
const COLOR_PALETTE: Record<string, string> = SCHEMA.workflow_guide.state_color_system.palette;
const VALID_COLORS: string[] = Object.keys(COLOR_PALETTE);
const COLOR_KEYWORDS: Record<string, string[]> = SCHEMA.workflow_guide.state_color_system.keyword_hints;
const COLOR_DECISION_ORDER: string[] = SCHEMA.workflow_guide.state_color_system.decision_order;
const COLOR_RULES: string[] = SCHEMA.workflow_guide.state_color_system.rules;

// Used by validate_design
function isValidFieldType(type: string): boolean {
  // Handle inline Selection syntax: "Selection(A/B/C)"
  if (type.startsWith("Selection(") && type.endsWith(")")) return true;
  return VALID_FIELD_TYPES.includes(type);
}

function isValidColor(hex: string): boolean {
  return VALID_COLORS.includes(hex);
}

function isValidActor(actor: string): boolean {
  return VALID_ACTOR_TYPES.includes(actor);
}

// Used by design_workflow — auto-assign color from state name
function suggestColorForState(stateName: string): string {
  const lower = stateName.toLowerCase();
  for (const [hex, keywords] of Object.entries(COLOR_KEYWORDS)) {
    if (keywords.some((kw: string) => lower.includes(kw))) return hex;
  }
  return "#2968A8"; // Default when unsure
}
```

**Schema versioning:**

The schema file is bundled with the MCP server package. When the schema changes (new field types, new colors, etc.), a new version of the MCP server is released. The schema version is in the file itself (`"version": "1.0.0"`).

---

### 14.6 HTTP Request Construction

Every tool that resolves to an Inistate API endpoint must construct the HTTP request according to these rules.

**Base URL and headers:**

```typescript
const BASE_URL = process.env.INISTATE_API_URL || "https://api.inistate.com";

// API key auth (fsk prefix)
const API_KEY = process.env.INISTATE_ACCESS_TOKEN || process.env.INISTATE_API_TOKEN;

// JWT auth (populated after login)
let jwt: string | null = null;
let workspaceId: string | null = null;

function authorizationValue(): string | null {
  if (API_KEY) return `fsk ${API_KEY}`;
  if (jwt) return `Bearer ${jwt}`;
  return null;
}

function buildHeaders(contentType?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (contentType) h["Content-Type"] = contentType;
  const auth = authorizationValue();
  if (auth) h["Authorization"] = auth;
  if (workspaceId) h["wsid"] = workspaceId;
  return h;
}

function headers(): Record<string, string> {
  return buildHeaders("application/json");
}
```

**Automatic 401 refresh+retry:**

All requests go through a `request()` wrapper that intercepts 401 responses. For JWT auth, it attempts a token refresh (or re-login with stored credentials) and retries the original request once. This is transparent to tool handlers.

```typescript
// getHeaders is a callback (not a pre-built object) so that headers are
// rebuilt with the fresh JWT after a refresh cycle.
async function request(
  url: string,
  init: RequestInit,
  getHeaders: () => Record<string, string>,
): Promise<Response> {
  await ensureAuth(); // auto-login if credentials are configured but no JWT yet
  const res = await fetch(url, { ...init, headers: getHeaders() });
  if (res.status === 401 && canRefresh()) {
    const refreshed = await refreshAuth();
    if (refreshed) {
      return fetch(url, { ...init, headers: getHeaders() });
    }
  }
  return res;
}
```

**URL encoding for module names:**

Module names can contain spaces and special characters (e.g., "Leave Requests", "KYC — Applications"). Always use `encodeURIComponent` for path segments:

```typescript
// ✅ Correct
const url = `${BASE_URL}/api/mcp/${encodeURIComponent(moduleName)}`;
// Produces: /api/mcp/Leave%20Requests

// ❌ Wrong — spaces break the URL
const url = `${BASE_URL}/api/mcp/${moduleName}`;
```

**Query parameters:**

```typescript
// get_module_schema with tier
const url = `${BASE_URL}/api/mcp/${encodeURIComponent(moduleName)}?tier=${tier}`;
```

**POST body construction:**

All POST endpoints (`/api/mcp/list`, `/api/mcp/form`, `/api/mcp/activity`, `/api/mcp/history`, `/api/mcp/entry`) accept JSON bodies. Map MCP tool arguments directly to the request body:

```typescript
// list_entries → POST /api/mcp/list
async function listEntries(args: ListEntriesArgs) {
  const body = {
    module: args.module,
    ...(args.state && { state: args.state }),
    ...(args.search && { search: args.search }),
    ...(args.filters && { filters: args.filters }),
    ...(args.sortBy && { sortBy: args.sortBy }),
    ...(args.sortDirection && { sortDirection: args.sortDirection }),
    currentPage: args.currentPage ?? 0,
    pageSize: args.pageSize ?? 50
  };

  const response = await request(`${BASE_URL}/api/mcp/list`, {
    method: "POST",
    body: JSON.stringify(body),
  }, headers);

  return handleResponse(response);
}
```

**PUT for update_module:**

```typescript
// update_module → PUT /api/configure/{moduleName}
async function updateModule(args: UpdateModuleArgs) {
  const moduleName = args.module; // The current module name (for URL)
  const body = { ...args };
  delete body.module; // module is in the URL path, not the body

  const response = await request(
    `${BASE_URL}/api/configure/${encodeURIComponent(moduleName)}`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
    headers,
  );

  return handleResponse(response);
}
```

**Complete resolver mapping:**

| Tool | Method | URL | Body |
|---|---|---|---|
| `login` | POST | `/token` | Form-encoded: `grant_type=password&username=...&password=...` |
| `list_workspaces` | GET | `/api/workspace` | — |
| `set_workspace` | GET | `/api/workspace/{workspaceId}` | — |
| `list_modules` | GET | `/api/mcp/` | — |
| `get_module_schema` | GET | `/api/mcp/{moduleName}?tier={tier}` | — |
| `get_module_canvas` | GET | `/api/configure/{moduleName}` | — |
| `list_entries` | POST | `/api/mcp/list` | `{ module, state?, search?, filters?, sortBy?, sortDirection?, currentPage?, pageSize? }` |
| `get_entry` | POST | `/api/mcp/entry` | `{ module, entryId }` |
| `get_form` | POST | `/api/mcp/form` | `{ module, activity?, entryId? }` |
| `submit_activity` | POST | `/api/mcp/activity` | `{ module, activity, entryId?, entryIds?, input?, state?, comment?, assignees?, due?, ai? }` |
| `get_entry_history` | POST | `/api/mcp/history` | `{ module, entryId, page? }` |
| `upload_file` | POST | `/api/mcp/upload` | Multipart form-data: `file` (binary) + optional `module` (string) |
| `download_file` | GET | `/api/mcp/download/{moduleName}/s/{guid}/{fileName}` | — |
| `create_module` | POST | `/api/configure/{moduleName}` | Full `ModuleSchema` |
| `update_module` | PUT | `/api/configure/{moduleName}` | Partial `ModuleSchema` |

---

### 14.7 API-to-MCP Response Transformation

MCP tool responses use a specific content block format. Every Inistate API response must be transformed into this format before returning to the agent.

**Success responses — return as JSON text:**

```typescript
function successResponse(data: any): ToolResponse {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(data, null, 2)
    }]
  };
}
```

**Error responses — return as structured error with isError flag:**

```typescript
async function handleResponse(response: Response): Promise<ToolResponse> {
  const body = await response.json();

  if (response.ok) {
    return successResponse(body);
  }

  // Map HTTP errors to MCP error responses
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        error: body.error || `HTTP ${response.status}`,
        message: body.message || response.statusText,
        details: body.details || null,
        // Include agent guidance based on status code
        agent_action: getAgentAction(response.status)
      }, null, 2)
    }],
    isError: true
  };
}

function getAgentAction(status: number): string {
  switch (status) {
    case 400: return "Check the error message, correct the input, and retry.";
    case 401: return "API key or token is invalid or expired. Check credentials and retry.";
    case 403: return "User lacks access to this resource. Inform the user.";
    case 404: return "Resource not found. Verify the module name or entry ID.";
    case 422: return "Validation failed. Check details[].field and details[].message for specifics.";
    default:  return "Unexpected error. Report to user.";
  }
}
```

**Pagination handling:**

For `list_entries` and `get_entry_history`, the response includes pagination metadata. The MCP server should pass this through as-is — the agent uses `totalItems`, `hasMore`, and `page` to decide whether to fetch more pages:

```typescript
// The agent sees:
{
  "moduleId": "Leave Requests",
  "page": 0,
  "pageSize": 50,
  "totalItems": 127,   // Agent knows there are 127 total
  "list": [ ... ]       // First 50 entries
}
// If totalItems > pageSize, the agent can call list_entries again with currentPage: 1
```

**Do NOT pre-fetch all pages.** Let the agent decide whether it needs more data. Most queries are answered by the first page.

**Large response truncation:**

If a response exceeds 100KB of JSON text, truncate `list` arrays and append a note:

```typescript
if (jsonText.length > 100_000) {
  // Truncate list to first 20 items
  data.list = data.list.slice(0, 20);
  data._truncated = true;
  data._truncated_message = `Response truncated to 20 of ${data.totalItems} items. Use pagination (currentPage, pageSize) to retrieve more.`;
}
```

**Empty results:**

Return the standard response shape with an empty `list` array — do NOT return an error:

```json
{
  "moduleId": "Leave Requests",
  "page": 0,
  "pageSize": 50,
  "totalItems": 0,
  "list": []
}
```

**upload_file — special handling:**

`upload_file` is the only tool that uses `multipart/form-data` instead of JSON. The MCP server must construct the request differently:

```typescript
async function uploadFile(args: { module?: string; file: Buffer; fileName: string; mimeType: string }) {
  const formData = new FormData();
  formData.append("file", new Blob([args.file], { type: args.mimeType }), args.fileName);
  if (args.module) formData.append("module", args.module);

  // authHeader() omits Content-Type — FormData sets it with boundary automatically
  const response = await request(`${BASE_URL}/api/mcp/upload`, {
    method: "POST",
    body: formData,
  }, authHeader);

  return handleResponse(response);
}
```

**download_file — redirect handling:**

`download_file` returns a 302 redirect to a pre-signed S3 URL. The MCP server should return the redirect URL to the agent, not follow the redirect:

```typescript
async function downloadFile(args: { moduleName: string; guid: string; fileName: string }) {
  const url = `${BASE_URL}/api/mcp/download/${encodeURIComponent(args.moduleName)}/s/${encodeURIComponent(args.guid)}/${encodeURIComponent(args.fileName)}`;
  const response = await request(url, { redirect: "manual" }, authHeader);

  if (response.status === 302) {
    const downloadUrl = response.headers.get("Location");
    return successResponse({ downloadUrl, fileName: args.fileName });
  }

  return handleResponse(response);
}
```

---

### 14.8 Server State

The MCP server maintains minimal in-process state to manage authentication and workspace context:

| State | Stored In | Purpose |
|---|---|---|
| JWT + refresh token | `api.ts` module scope | Authenticate API requests, auto-refresh on 401 |
| Stored credentials | `api.ts` module scope | Re-login if refresh token is unavailable |
| Workspace ID | `api.ts` module scope | Sent as `wsid` header on all API requests |

**How workspace selection works:**

1. Agent calls `list_workspaces` → server proxies `GET /api/workspace` → returns list
2. Agent calls `set_workspace(workspaceId)` → server stores the workspace ID via `setWorkspaceId()` and proxies `GET /api/workspace/{workspaceId}` → returns workspace details
3. All subsequent API requests include the `wsid` header automatically

**Where context lives (agent vs. server):**

| Context | Stored By | Notes |
|---|---|---|
| Auth credentials / JWT | MCP server (`api.ts`) | Managed automatically, transparent to agent |
| Workspace ID | MCP server (`api.ts`) | Set once via `set_workspace`, sent as header |
| Current module name | AI agent | Agent includes `module` parameter in every module-scoped call |
| Current entry ID | AI agent | Agent includes `entryId` parameter in every entry-scoped call |
| Pagination position | AI agent | Agent tracks `currentPage` and `totalItems` from responses |

> **AGENT INSTRUCTION:** After calling `set_workspace`, the server remembers the workspace. You do not need to pass `workspaceId` to subsequent tools. But you must call `set_workspace` at least once per conversation before calling module or entry tools.

---

### 14.9 MCP Protocol Version

Target **MCP specification version 2025-11-25** (the current stable release). This version includes:

- **Tasks primitive** for long-running operations
- **Server Identity** for pre-connection discovery
- **Extensions Framework**
- **Specification Enhancement Proposals (SEPs)** governance

Use `@modelcontextprotocol/sdk` version `^1.x` (latest stable). Pin the exact version in `package.json` for reproducibility.

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
```

The server should declare its supported protocol version in the server info:

```typescript
const server = new Server(
  {
    name: "inistate-mcp-server",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  }
);
```

---

### 14.10 Registry Submission

After implementation, submit to these registries for maximum discoverability:

1. **Official MCP Registry** (`registry.modelcontextprotocol.io`) — primary listing
2. **GitHub MCP Registry** (`github.com/modelcontextprotocol/servers`) — curated list
3. **PulseMCP** (`pulsemcp.com`) — 5,500+ servers directory
4. **MCP.so** — 18,000+ servers directory
5. **npm** — for direct installation via `npx inistate-mcp-server`

### 14.11 Testing Checklist

- [ ] All 16 tools register and appear in tool discovery
- [ ] Workspace context persists on API side after `set_workspace` call
- [ ] `set_workspace` returns workspace data for agent to store
- [ ] MCP server stores no state between tool calls (fully stateless)
- [ ] Module names with spaces are correctly URL-encoded in path segments
- [ ] Display name resolution works for all field, state, and activity references
- [ ] `get_form` returns `form[]` with keyed-by-name format (not `fields[]`)
- [ ] `get_form` response includes `availableActivities`
- [ ] `get_entry` response includes `module`, `date`, and `availableActivities`
- [ ] `list_entries` response includes `date` and `availableActivities` on each entry
- [ ] `submit_activity` response includes `availableActivities`
- [ ] `upload_file` accepts multipart form-data and returns `/s/` URL
- [ ] `upload_file` rejects blocked extensions (.exe, .bat, etc.) and files > 50MB
- [ ] `request_upload_url` returns `PresignedUploadResult` (`uploadUrl`, `s3Key`, `path`, `contentType`, `expiresIn`) for files ≤ 500MB
- [ ] `request_upload_url` rejects blocked extensions and `fileSize` out of range
- [ ] `confirm_upload` requires only `s3Key` and resolves filename/size/MIME from S3
- [ ] `confirm_upload` returns `FileUploadResult` (`path`, `filename`, `mimeType`, `size`)
- [ ] `download_file` constructs correct URL from module name + `/s/` path
- [ ] `submit_activity` accepts `FileFieldInput` objects (`{ name, path }`) for File/Image fields, where `path` is a `/s/` upload or external URL
- [ ] `submit_activity` accepts `ModuleFieldValue` (`{ value, id }`) and `UserFieldValue` (`{ value, id, username }`) objects for Module/User fields
- [ ] File/Image field values in responses use `FileFieldValue` format (`{ name, path }`)
- [ ] Module/User field values in responses use `ModuleFieldValue`/`UserFieldValue` format; plural variants return arrays
- [ ] Confidence gating suppresses state transition when below threshold
- [ ] Flagged response includes `flagged: true` and records `intention` history type
- [ ] AI audit trail (`ai` object) is passed through and persisted
- [ ] All error codes (400, 401, 403, 404, 422) return structured MCP error responses with `isError: true`
- [ ] Error responses include `agent_action` guidance string
- [ ] Filtering operators (text, number, date, boolean, null, table, logical) work correctly
- [ ] Pagination returns correct `totalItems` and `hasMore` values
- [ ] Large responses (>100KB) are truncated with `_truncated` flag
- [ ] Empty results return standard shape with empty `list` array, not an error
- [ ] Module create/update validates field references in activities
- [ ] Record list modules (no states/activities/flows) can be created and updated
- [ ] Workflow validation rules are relaxed for record list modules (§13.1)
- [ ] Table field sub-fields are validated (type, name required)
- [ ] ID-based matching preserves data on rename operations
- [ ] `design_workflow` returns a scaffolded template with industry defaults
- [ ] `design_workflow` reads field types and color palette from loaded schema
- [ ] `validate_design` reads valid field types, colors, actor enums from loaded schema
- [ ] `validate_design` catches all structural errors and warnings from §13
- [ ] `validate_design` with `mode: "update"` accepts partial schemas
- [ ] All 5 MCP resources are accessible and return correct data
- [ ] `inistate://schema` resource returns the full inistate-schema.json contents
- [ ] All 4 MCP prompts are registered and return correct templates
- [ ] Server works correctly over stdio transport
- [ ] Server declares MCP protocol version 2025-11-25

---

## 15. A2A Coordination (Future)

> **Status:** Future extension — not implemented in v1.0

The Agent-to-Agent (A2A) protocol complements MCP by handling horizontal agent-to-agent communication. While MCP handles agent-to-tool connectivity (vertical), A2A handles coordination between agents that participate in the same FACTSOps workflow.

### 15.1 Planned Architecture

```
Agent A (AI — handles "Submit" activity)
  ↓ A2A handoff
Agent B (Human + AI — handles "Approve" activity)
  ↓ A2A handoff  
Agent C (AI — handles "Process Payment" activity)
```

### 15.2 Design Principles

- **Process-driven routing:** A2A handoffs are determined by the FACTSOps flow definitions, not ad-hoc agent coordination
- **Activity-scoped delegation:** Each agent is assigned specific activities based on `actor` type and role
- **Audit-continuous:** A2A handoffs are recorded in the entry history just like human/AI transitions
- **Fallback to MCP:** If A2A is unavailable, agents fall back to the MCP tool surface

### 15.3 When to Implement

A2A coordination becomes valuable when:
- Multiple AI agents (potentially from different vendors) participate in the same workflow
- Different activities require different AI capabilities (e.g., document analysis vs. code review)
- Enterprise architectures mandate agent-level isolation for compliance

---

## 16. Appendix: Conceptual Mapping

### 16.1 FACTSOps ↔ AI Agent Concepts

| FACTSOps Concept | AI Agent Equivalent | Purpose |
|---|---|---|
| State | Memory anchor | Always know where the process is |
| Activity | Tool call | Bounded, auditable action |
| Form | Structured reasoning input | Prevent hallucination and drift |
| Transition | Safe state mutation | Only valid paths forward |
| Guardrails | Constraints / policy rules | Prevent unauthorized actions |
| Audit Trail | Execution log | Full traceability of every decision |
| Terminal State | Completion signal | Stop condition for agent loop |
| Hybrid Actor | Escalation trigger | Route to human when AI confidence is low |
| Confidence Gate | Safety valve | Suppress action when certainty is insufficient |
| Intention | Attempted but gated action | Record of AI reasoning even when blocked |

### 16.2 The FACTSOps Ecosystem

| Layer | Name | Function |
|---|---|---|
| The Discipline | FACTSOps | What you practice |
| The Specification | FACTS Protocol | How you implement |
| The Visual Model | ProcessCanvas (patented) | What you see |
| The Platform | Inistate | What you buy |

### 16.3 The FACTSOps Manifesto — Five Beliefs

| Belief | Meaning |
|---|---|
| **Structure over Autonomy** | Bounded action spaces beat open-ended agent freedom |
| **Transitions over Tasks** | State machines beat task lists for governance |
| **Actors over Roles** | Polymorphic dispatch (human/AI/hybrid) beats static role assignment |
| **Forms over Prompts** | Typed structured input beats free-text reasoning |
| **Trails over Trust** | Auditable evidence beats assumed reliability |

### 16.4 The Three Laws

1. **No transition without a form.** Every state change requires structured data input.
2. **No actor without a trail.** Every action — human or AI — is logged with full context.
3. **No automation without escalation.** Every AI action has a confidence gate and a human fallback.

---

## 17. Appendix: End-to-End Walkthrough

This appendix shows a complete execute-mode scenario with exact request/response payloads for every tool call. The scenario: an AI agent approves a pending leave request.

### 17.1 User Request

> "Approve Sarah's annual leave request for March 20–25"

### 17.2 Step 1 — list_workspaces

**Tool call:**
```json
{ "name": "list_workspaces", "arguments": {} }
```

**MCP server action:** `GET https://api.inistate.com/api/workspace`

**Response:**
```json
[
  { "id": "ws-acme-001", "name": "Acme Corp" }
]
```

*Agent notes: Only one workspace — will use "ws-acme-001".*

### 17.3 Step 2 — set_workspace

**Tool call:**
```json
{
  "name": "set_workspace",
  "arguments": { "workspaceId": "ws-acme-001" }
}
```

**MCP server action:** `GET https://api.inistate.com/api/workspace/ws-acme-001`

**Response:**
```json
{
  "id": "ws-acme-001",
  "name": "Acme Corp",
  "settings": { "timezone": "America/New_York" }
}
```

*Agent stores workspace context in its conversation memory.*

### 17.4 Step 3 — list_modules

**Tool call:**
```json
{ "name": "list_modules", "arguments": {} }
```

**MCP server action:** `GET https://api.inistate.com/api/mcp/`

**Response:**
```json
[
  { "name": "Leave Requests", "emoji": "🏖️" },
  { "name": "Purchase Orders", "emoji": "📦" }
]
```

*Agent identifies "Leave Requests" as the target module.*

### 17.5 Step 4 — list_entries

Search for Sarah's pending leave request.

**Tool call:**
```json
{
  "name": "list_entries",
  "arguments": {
    "module": "Leave Requests",
    "state": "Pending Approval",
    "filters": {
      "Leave Type": "Annual Leave",
      "Start Date": { "after": "2026-03-19", "before": "2026-03-21" }
    },
    "pageSize": 10
  }
}
```

**MCP server action:** `POST https://api.inistate.com/api/mcp/list`

**Request body:**
```json
{
  "module": "Leave Requests",
  "state": "Pending Approval",
  "filters": {
    "Leave Type": "Annual Leave",
    "Start Date": { "after": "2026-03-19", "before": "2026-03-21" }
  },
  "currentPage": 0,
  "pageSize": 10
}
```

**Response:**
```json
{
  "moduleId": "Leave Requests",
  "page": 0,
  "pageSize": 10,
  "totalItems": 1,
  "list": [
    {
      "entryId": 1042,
      "documentId": "LV-2026-0042",
      "state": "Pending Approval",
      "data": {
        "Leave Type": "Annual Leave",
        "Start Date": "2026-03-20",
        "End Date": "2026-03-25",
        "Days Requested": 4,
        "Remarks": "Family vacation",
        "Is Urgent": false
      },
      "createdBy": "sarah.connor",
      "createdDate": "2026-03-12T09:15:00Z",
      "updatedBy": "sarah.connor",
      "updatedDate": "2026-03-12T09:15:00Z",
      "assignees": ["manager@example.com"],
      "due": null
    }
  ]
}
```

*Agent identifies entry 1042 (LV-2026-0042) as the target.*

### 17.6 Step 5 — get_form

Get the Approve activity form for this entry.

**Tool call:**
```json
{
  "name": "get_form",
  "arguments": {
    "module": "Leave Requests",
    "activity": "Approve",
    "entryId": 1042
  }
}
```

**MCP server action:** `POST https://api.inistate.com/api/mcp/form`

**Request body:**
```json
{
  "module": "Leave Requests",
  "activity": "Approve",
  "entryId": 1042
}
```

**Response:**
```json
{
  "module": "Leave Requests",
  "activity": "Approve",
  "fields": [
    { "name": "Leave Type", "type": "Selection", "required": false, "readOnly": true, "options": ["Annual Leave", "Sick Leave", "Unpaid Leave"] },
    { "name": "Days Requested", "type": "Number", "required": false, "readOnly": true },
    { "name": "Remarks", "type": "Text", "required": true }
  ],
  "defaults": {
    "Leave Type": "Annual Leave",
    "Days Requested": 4,
    "Remarks": "Family vacation"
  },
  "states": ["Approved"]
}
```

*Agent notes: Remarks is required. Leave Type and Days Requested are read-only (pre-filled). No confidence_threshold — this is a human-actor activity, no AI gate.*

### 17.7 Step 6 — submit_activity

Approve the leave request.

**Tool call:**
```json
{
  "name": "submit_activity",
  "arguments": {
    "module": "Leave Requests",
    "activity": "Approve",
    "entryId": 1042,
    "input": {
      "Remarks": "Approved — enjoy your vacation"
    },
    "comment": "Approved by manager via AI assistant",
    "ai": {
      "reasoning": "Leave request is for 4 days of annual leave. Dates do not conflict with any known team schedule. Leave balance sufficient.",
      "sources": [
        { "type": "field", "reference": "Days Requested", "excerpt": "4" },
        { "type": "field", "reference": "Leave Type", "excerpt": "Annual Leave" },
        { "type": "field", "reference": "Start Date", "excerpt": "2026-03-20" }
      ],
      "model": "claude-sonnet-4-20250514",
      "confidence": 0.95
    }
  }
}
```

**MCP server action:** `POST https://api.inistate.com/api/mcp/activity`

**Request body:** Same as arguments above.

**Response:**
```json
{
  "module": "Leave Requests",
  "activity": "Approve",
  "entryId": 1042,
  "documentId": "LV-2026-0042",
  "state": "Approved",
  "message": null
}
```

*Success — entry 1042 transitioned from "Pending Approval" to "Approved".*

### 17.8 Step 7 (Optional) — get_entry_history

Verify the audit trail.

**Tool call:**
```json
{
  "name": "get_entry_history",
  "arguments": {
    "module": "Leave Requests",
    "entryId": 1042
  }
}
```

**MCP server action:** `POST https://api.inistate.com/api/mcp/history`

**Response:**
```json
{
  "moduleId": "Leave Requests",
  "entryId": 1042,
  "histories": [
    {
      "id": "h-001",
      "type": "create",
      "by": "sarah.connor",
      "on": "2026-03-12T09:15:00Z",
      "state": "Pending Approval",
      "changes": [
        { "field": "Leave Type", "from": null, "to": "Annual Leave" },
        { "field": "Start Date", "from": null, "to": "2026-03-20" },
        { "field": "End Date", "from": null, "to": "2026-03-25" },
        { "field": "Days Requested", "from": null, "to": 4 },
        { "field": "Remarks", "from": null, "to": "Family vacation" }
      ]
    },
    {
      "id": "h-002",
      "type": "activity",
      "activity": "Approve",
      "by": "manager@example.com",
      "on": "2026-03-12T14:30:00Z",
      "state": "Approved",
      "comment": "Approved by manager via AI assistant",
      "changes": [
        { "field": "Remarks", "from": "Family vacation", "to": "Approved — enjoy your vacation" }
      ],
      "ai": {
        "reasoning": "Leave request is for 4 days of annual leave. Dates do not conflict with any known team schedule. Leave balance sufficient.",
        "sources": [
          { "type": "field", "reference": "Days Requested", "excerpt": "4" },
          { "type": "field", "reference": "Leave Type", "excerpt": "Annual Leave" },
          { "type": "field", "reference": "Start Date", "excerpt": "2026-03-20" }
        ],
        "model": "claude-sonnet-4-20250514",
        "confidence": 0.95
      }
    }
  ],
  "hasMore": false,
  "page": 0
}
```

*The audit trail shows the complete chain: sarah.connor created the entry → manager approved it with AI assistance → full AI reasoning captured.*

### 17.9 Summary

| Step | Tool | API Call | Result |
|---|---|---|---|
| 1 | `list_workspaces` | `GET /api/workspace` | Found "Acme Corp" |
| 2 | `set_workspace` | `GET /api/workspace/ws-acme-001` | Workspace activated |
| 3 | `list_modules` | `GET /api/mcp/` | Found "Leave Requests" |
| 4 | `list_entries` | `POST /api/mcp/list` | Found entry 1042 (Sarah's request) |
| 5 | `get_form` | `POST /api/mcp/form` | Discovered Remarks is required, no confidence gate |
| 6 | `submit_activity` | `POST /api/mcp/activity` | Entry approved, state → "Approved" |
| 7 | `get_entry_history` | `POST /api/mcp/history` | Full audit trail with AI reasoning confirmed |

**Total tool calls:** 7 (6 required + 1 optional verification)
**Total API calls:** 7

---

## 18. Appendix: Workflow Diagram Specification

When an agent designs a module (design mode), it should also generate an SVG workflow diagram visualizing the state transitions. The diagram uses the exact hex colors from the FACTSOps state color system.

### 18.1 SVG Structure

```svg
<svg width="100%" viewBox="0 0 680 H">
```

Where `H` is the computed height based on content. Safe drawing area is x=20 to x=660, y=40 to y=(H-40).

### 18.2 Arrow Marker

Always include this arrow marker in `<defs>` at the start of every SVG:

```svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5"
    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke"
      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
```

### 18.3 State Box Rendering

Each state is a rounded rectangle filled with the exact hex color from the FACTSOps palette, with white text:

```svg
<g class="node" onclick="sendPrompt('Tell me about the [State] state')">
  <rect x="X" y="Y" width="W" height="56" rx="8"
    fill="#HEX_COLOR" stroke="#DARKER_SHADE" stroke-width="0.5"/>
  <text x="CX" y="TY1" text-anchor="middle" dominant-baseline="central"
    fill="#FFFFFF" font-size="14" font-weight="500"
    font-family="var(--font-sans)">State Name</text>
  <text x="CX" y="TY2" text-anchor="middle" dominant-baseline="central"
    fill="#FFFFFF" font-size="12" opacity="0.8"
    font-family="var(--font-sans)">Subtitle</text>
</g>
```

**Rules:**
- `fill` = exact hex from the FACTSOps state color palette (§12.1)
- `stroke` = a slightly darker shade of the same color
- All text `fill="#FFFFFF"` — white text on colored background
- Title: font-size=14, font-weight=500
- Subtitle: font-size=12, opacity=0.8
- Height: 56px for two-line boxes (title + subtitle)
- `rx="8"` for rounded corners

### 18.4 Layout Rules

**Main flow (vertical):** The primary happy path flows top-to-bottom, centered at x=340. Each main-flow state box is 180px wide (x=250 to x=430). Leave 54px minimum vertical gap between boxes for the arrow and activity label.

**Vertical arrows with labels:** Place the activity name to the right of the arrow:

```svg
<line x1="340" y1="96" x2="340" y2="150"
  class="arr" marker-end="url(#arrow)"/>
<text class="ts" x="348" y="128" text-anchor="start">Activity Name</text>
```

**Side branches (horizontal):** Side branches (escalation, external blockers, cancellation) extend left or right from the main flow.

> **CRITICAL: Leave at least 100px horizontal gap between the main-flow box edge and the side-branch box edge.** This gap must be wide enough to fit the longest activity label without overlapping either box.

For bidirectional horizontal connections (e.g., In Progress ↔ Awaiting Parts), split the arrows into two separate lines at different y-positions:
- **Forward arrow (top):** Draw at y = box_y + 15. Place label above the arrow.
- **Return arrow (bottom, dashed):** Draw at y = box_y + 41. Place label below the arrow.

**Bidirectional example:**

```svg
<!-- Forward: In Progress → Awaiting Parts -->
<line x1="250" y1="385" x2="140" y2="385"
  class="arr" marker-end="url(#arrow)"/>
<text class="ts" x="195" y="377" text-anchor="middle">Request Parts</text>

<!-- Return: Awaiting Parts → In Progress (dashed) -->
<path d="M140 411 L250 411" fill="none"
  class="arr" marker-end="url(#arrow)" stroke-dasharray="4 3"/>
<text class="ts" x="195" y="430" text-anchor="middle">Parts Received</text>
```

### 18.5 Spacing Summary

| Dimension | Value |
|---|---|
| Main-flow box width | 180px (x=250 to x=430) |
| Box height (two-line) | 56px |
| Vertical gap between boxes | 54–70px minimum |
| Horizontal gap (box edge to box edge) | 100px minimum |
| Side-branch box width | 120–140px |
| Forward arrow y-offset from box top | +15px |
| Return arrow y-offset from box top | +41px |
| Label offset above arrow | −8px from arrow y |
| Label offset below arrow | +19px from arrow y |

### 18.6 Arrow Types

| Type | Style | Usage |
|---|---|---|
| Forward transitions | Solid line with `marker-end="url(#arrow)"` | Normal state progression |
| Return transitions | Dashed line with `stroke-dasharray="4 3"` | Reopening, de-escalation, returning from blockers |

**Every arrow must have an activity name label.** No arrow should exist without a visible activity name nearby.

### 18.7 Legend

Always include a legend at the bottom of the diagram showing each color used and its meaning. Separate terminal success (`#1E6B45`) from terminal failure (`#8B2D2D`). Note that solid arrows = forward transitions and dashed arrows = return transitions.

### 18.8 Interactivity

Wrap each state box in a clickable group that triggers `sendPrompt()` so the user can ask about any state:

```svg
<g class="node" onclick="sendPrompt('Tell me about the Pending Approval state')">
  <!-- rect and text elements -->
</g>
```

### 18.9 Diagram Checklist

Before delivering a workflow diagram, verify:

- [ ] Every state box uses the exact hex color from the FACTSOps palette
- [ ] All text inside state boxes is white (`fill="#FFFFFF"`)
- [ ] Every arrow has an activity name label
- [ ] Horizontal gaps between boxes are at least 100px to fit labels
- [ ] Bidirectional horizontal arrows are split into two y-positions (top and bottom)
- [ ] Labels do not overlap with boxes or other labels
- [ ] Forward arrows are solid, return arrows are dashed (`stroke-dasharray="4 3"`)
- [ ] A legend at the bottom shows all colors used
- [ ] Legend separates terminal success from terminal failure
- [ ] All state boxes are clickable via `sendPrompt()`

---

## 19. Appendix: Complete Design Example — Aircon Service Issues

This appendix shows a complete design-mode scenario with a real-world service management module. Use this as a reference pattern when designing modules for any domain.

### 19.1 Domain

An aircon service company handling maintenance, repair, and installation issues. Technicians are dispatched to customer sites, parts may need to be ordered, and SLA compliance is tracked.

### 19.2 States and Transitions

| State | Color | Purpose |
|---|---|---|
| **New** | `#5A6070` | Issue just reported, no action taken |
| **Triaged** | `#2968A8` | Priority assigned, awaiting technician assignment |
| **Assigned** | `#2968A8` | Technician assigned and scheduled, awaiting dispatch |
| **In Progress** | `#2A7B50` | Technician actively working on-site |
| **Awaiting Parts** | `#6B4D91` | Blocked — parts need to be ordered |
| **Escalated** | `#C0392B` | SLA breached or senior intervention needed |
| **Pending Verification** | `#2968A8` | Repair done, waiting for customer confirmation |
| **Completed** | `#1E6B45` | Customer verified, issue resolved (terminal) |
| **Cancelled** | `#8B2D2D` | Customer withdrew or duplicate (terminal) |

### 19.3 Flow Transitions

| From | To | Activity |
|---|---|---|
| New | Triaged | Triage |
| Triaged | Assigned | Assign Technician |
| Assigned | In Progress | Start Work |
| In Progress | Awaiting Parts | Request Parts |
| Awaiting Parts | In Progress | Parts Received |
| In Progress | Escalated | Escalate |
| Escalated | In Progress | De-escalate |
| In Progress | Pending Verification | Resolve |
| Pending Verification | Completed | Verify |
| Pending Verification | In Progress | Reopen |
| Triaged | Cancelled | Cancel |
| Assigned | Cancelled | Cancel |

### 19.4 Information Fields

```json
{
  "information": [
    { "name": "Issue Type", "type": "Selection", "options": ["Installation", "Maintenance", "Repair", "Warranty Claim"], "ai_hint": "Category of the service issue — determines SLA and pricing" },
    { "name": "Customer Name", "type": "Text", "ai_hint": "Full name of the customer who reported the issue" },
    { "name": "Customer Phone", "type": "Phone" },
    { "name": "Customer Email", "type": "Email" },
    { "name": "Site Address", "type": "MultiText", "ai_hint": "Full address of the service location" },
    { "name": "Equipment Model", "type": "Text", "ai_hint": "Aircon model number or description" },
    { "name": "Priority", "type": "Selection", "options": ["Low", "Medium", "High", "Critical"], "ai_hint": "Set during triage based on issue severity and SLA" },
    { "name": "Assigned Technician", "type": "Text", "ai_hint": "Name of the technician dispatched to the site" },
    { "name": "Scheduled Date", "type": "Date", "ai_hint": "Date the technician is scheduled to visit" },
    { "name": "Issue Description", "type": "MultiText", "ai_hint": "Detailed description of the reported problem" },
    { "name": "Diagnosis", "type": "MultiText", "ai_hint": "Technician's findings after initial inspection" },
    { "name": "Parts Required", "type": "MultiText", "ai_hint": "List of parts needed for the repair" },
    { "name": "Resolution Notes", "type": "MultiText", "ai_hint": "What was done to resolve the issue" },
    { "name": "Customer Feedback", "type": "MultiText", "ai_hint": "Customer's comments during verification" },
    { "name": "Photos", "type": "Images", "ai_hint": "Before/after photos of the equipment" },
    { "name": "Estimated Cost", "type": "Currency", "ai_hint": "Estimated cost of parts and labor" },
    { "name": "Actual Cost", "type": "Currency", "ai_hint": "Final cost after completion" },
    { "name": "Under Warranty", "type": "YesNo", "ai_hint": "Set to true if the equipment is under active warranty" }
  ]
}
```

### 19.5 Activities

```json
{
  "activities": [
    {
      "name": "Triage",
      "actor": "hybrid",
      "confidence_threshold": 0.7,
      "fields": [
        { "name": "Issue Type", "required": true },
        { "name": "Priority", "required": true },
        { "name": "Issue Description", "readOnly": true }
      ],
      "ai_hint": "Assess the reported issue, assign priority based on severity and SLA. Critical = safety risk or total failure. High = major discomfort. Medium = reduced performance. Low = cosmetic or minor."
    },
    {
      "name": "Assign Technician",
      "actor": "human",
      "fields": [
        { "name": "Assigned Technician", "required": true },
        { "name": "Scheduled Date", "required": true },
        { "name": "Priority", "readOnly": true },
        { "name": "Site Address", "readOnly": true }
      ],
      "ai_hint": "Assign an available technician and schedule a visit date based on priority and location"
    },
    {
      "name": "Start Work",
      "actor": "human",
      "fields": [
        { "name": "Diagnosis", "required": true }
      ],
      "ai_hint": "Technician arrives on-site and records initial diagnosis"
    },
    {
      "name": "Request Parts",
      "actor": "human",
      "fields": [
        { "name": "Parts Required", "required": true },
        { "name": "Estimated Cost", "required": true }
      ],
      "ai_hint": "Technician identifies parts needed that are not on hand"
    },
    {
      "name": "Parts Received",
      "actor": "human",
      "ai_hint": "Parts have arrived and technician can resume work"
    },
    {
      "name": "Escalate",
      "actor": "human",
      "fields": [
        { "name": "Issue Description", "readOnly": true },
        { "name": "Diagnosis", "readOnly": true }
      ],
      "ai_hint": "SLA is at risk or the issue requires senior technician intervention"
    },
    {
      "name": "De-escalate",
      "actor": "human",
      "ai_hint": "Senior intervention resolved the blocker — return to normal work"
    },
    {
      "name": "Resolve",
      "actor": "human",
      "fields": [
        { "name": "Resolution Notes", "required": true },
        { "name": "Actual Cost", "required": true },
        { "name": "Photos" }
      ],
      "ai_hint": "Technician completes the repair and documents what was done"
    },
    {
      "name": "Verify",
      "actor": "human",
      "fields": [
        { "name": "Customer Feedback", "required": true },
        { "name": "Resolution Notes", "readOnly": true }
      ],
      "ai_hint": "Customer confirms the issue is resolved to their satisfaction"
    },
    {
      "name": "Reopen",
      "actor": "human",
      "fields": [
        { "name": "Customer Feedback", "required": true }
      ],
      "ai_hint": "Customer reports the issue is not resolved — technician must return"
    },
    {
      "name": "Cancel",
      "actor": "human",
      "fields": [
        { "name": "Resolution Notes", "required": true }
      ],
      "ai_hint": "Issue is cancelled — duplicate, customer withdrew, or not applicable"
    }
  ]
}
```

### 19.6 Flows

```json
{
  "flows": [
    { "from": "New", "to": "Triaged", "activity": "Triage" },
    { "from": "Triaged", "to": "Assigned", "activity": "Assign Technician" },
    { "from": "Assigned", "to": "In Progress", "activity": "Start Work" },
    { "from": "In Progress", "to": "Awaiting Parts", "activity": "Request Parts" },
    { "from": "Awaiting Parts", "to": "In Progress", "activity": "Parts Received" },
    { "from": "In Progress", "to": "Escalated", "activity": "Escalate" },
    { "from": "Escalated", "to": "In Progress", "activity": "De-escalate" },
    { "from": "In Progress", "to": "Pending Verification", "activity": "Resolve" },
    { "from": "Pending Verification", "to": "Completed", "activity": "Verify" },
    { "from": "Pending Verification", "to": "In Progress", "activity": "Reopen" },
    { "from": "Triaged", "to": "Cancelled", "activity": "Cancel" },
    { "from": "Assigned", "to": "Cancelled", "activity": "Cancel" }
  ]
}
```

### 19.7 Design Pattern Notes

This module demonstrates several FACTSOps patterns that agents should follow when designing similar modules:

| Pattern | How It's Applied |
|---|---|
| **Linear happy path** | New → Triaged → Assigned → In Progress → Pending Verification → Completed |
| **External blocker branch** | In Progress ↔ Awaiting Parts (bidirectional — blocked then unblocked) |
| **Escalation branch** | In Progress ↔ Escalated (bidirectional — escalate then de-escalate) |
| **Verification gate** | Pending Verification before terminal Completed — with Reopen path back |
| **Early cancellation** | Cancel available from Triaged and Assigned (not from In Progress — work has started) |
| **Context fields as readOnly** | Escalate shows Issue Description and Diagnosis as readOnly so the escalation reviewer has context |
| **Decision fields as required** | Resolve requires Resolution Notes and Actual Cost — the critical outputs |
| **AI triage with confidence gate** | Triage has `actor: "hybrid"` and `confidence_threshold: 0.7` — AI can triage but gets gated if unsure |
| **Color correctness** | Two blue states (Triaged, Assigned, Pending Verification) — all waiting. One green (In Progress) — active work. Purple (Awaiting Parts) — external blocker. Red (Escalated) — SLA risk. |

---

> **"AI without FACTS is fiction. Build the facts."**

---

*Version 1.0 · March 2026 · Patent US20230266946A1 · Platform: Inistate (inistate.com)*
