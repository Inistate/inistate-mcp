# Inistate Frontend Integration Guide

This guide is for generating custom frontends (Vue, React, or any framework) that call the Inistate REST API directly. Look, feel, and component choice are entirely up to the user — this document covers only the API contract.

**Separation of concerns:** the generated frontend holds no long-lived secrets. The user supplies an API token at runtime (form field, env var in the host app, OAuth callback, etc.), and the frontend includes it in the `Authorization` header on every request.

---

## 1. Base URL and headers

- Production base URL: `https://api.inistate.com`
- Every request must include:
  - `Authorization: fsk <api-token>` — the user-supplied token (API key format). For JWT-based auth, use `Authorization: Bearer <jwt>` instead.
  - `wsid: <workspace-id>` — the active workspace ID.
  - `Content-Type: application/json` on POST/PUT bodies.
  - `Accept: application/json`.

**CORS:** if the browser blocks direct calls to `api.inistate.com`, route requests through a thin same-origin proxy that only forwards the `Authorization` and `wsid` headers. Do **not** proxy by wrapping the token on the server — keep the token client-supplied so each user uses their own credentials.

---

## 2. Discovering workspaces and modules

```
GET /api/workspace
GET /api/workspace/{workspaceId}
GET /api/mcp/                                # list modules (wsid header required)
GET /api/mcp/{moduleName}?tier=basic         # fields + states
GET /api/mcp/{moduleName}?tier=extended      # + activities + flows
```

Use `tier=extended` when the UI needs to render action buttons and state transitions; `tier=basic` is enough for read-only lists.

---

## 3. Querying entries (list views)

```
POST /api/mcp/list
{
  "module": "Invoices",
  "state": "Pending",            // optional: filter by state name
  "search": "acme",              // optional: free text
  "filters": { ... },            // optional: see §6
  "sortBy": "Due Date",
  "sortDirection": "asc",        // or "desc"
  "currentPage": 0,              // 0-based
  "pageSize": 50                 // default 50, max 500
}
```

Response shape:
```
{
  "list": [ { "id": "...", "state": "...", "data": { "<Field Name>": <value>, ... } }, ... ],
  "totalItems": 123,
  "currentPage": 0,
  "pageSize": 50
}
```

Filter keys are **display names** (not internal IDs). Values are either equality (`"Status": "Open"`) or operator objects (see §6).

---

## 4. Reading a single entry

```
POST /api/mcp/entry
{ "module": "Invoices", "entryId": 42 }
```

Returns current field values, state, audit metadata, and the list of activities currently available to the caller.

Audit trail:
```
POST /api/mcp/history
{ "module": "Invoices", "entryId": 42, "page": 0 }
```

---

## 5. Forms and submissions (create, edit, custom activities)

**Always** call `get_form` before rendering a form or submitting. It tells you required fields, types, valid options, defaults, and (for AI-driven flows) the confidence threshold.

```
POST /api/mcp/form
{
  "module": "Invoices",
  "activity": "create",          // or "edit", "view", or any custom activity
  "entryId": 42                  // omit or null for "create"
}
```

Submit:
```
POST /api/mcp/activity
{
  "module": "Invoices",
  "activity": "create",          // "create" (no entryId), "edit", "delete", "changeStatus", "comment", "duplicate", "manage", or custom
  "entryId": 42,                 // omit for create
  "entryIds": [1,2,3],           // for bulk ops
  "input": { "<Field Name>": <value>, ... },
  "state": "Approved",           // optional target state for changeStatus
  "comment": "...",              // optional
  "assignees": ["alice"],        // optional usernames
  "due": "2026-05-01T00:00:00Z", // optional ISO 8601
  "ai": {                        // optional for human-driven UIs; required when an AI agent originated the action
    "reasoning": "...",
    "model": "claude-opus-4-7",
    "confidence": 0.92
  }
}
```

For a purely user-driven UI (button click → form submit) the `ai` block can be omitted. If your app has an AI layer that pre-fills or auto-submits, include it so the audit trail is honest — when `confidence` falls below the activity's `confidence_threshold`, the server suppresses the state transition and flags the entry for human review.

---

## 6. Filter operators

Filters live under the `filters` key on `POST /api/mcp/list`. Value forms:

| Form | Meaning |
|---|---|
| `"Status": "Open"` | equals |
| `"Amount": { "min": 100, "max": 500 }` | range (inclusive) |
| `"Title": { "contains": "invoice" }` | substring |
| `"Title": { "startsWith": "INV-" }` | prefix |
| `"Title": { "endsWith": ".pdf" }` | suffix |
| `"Amount": { "above": 1000 }` | strictly greater |
| `"Amount": { "below": 100 }` | strictly less |
| `"Date": { "after": "2026-01-01" }` | strictly after |
| `"Date": { "before": "2026-12-31" }` | strictly before |
| `"Date": { "between": ["2026-01-01", "2026-03-31"] }` | date range |
| `"Tags": { "excludes": "archived" }` | does not contain |
| `"Approved": { "yes": true }` / `{ "no": true }` | boolean |
| `"Notes": { "empty": true }` / `{ "exists": true }` | null/present |
| `"Status": { "not": "Closed" }` / `{ "is": "Open" }` | equality variants |
| `"Owner": "me"` | current authenticated user (User fields only) |

Combine with `or`:
```
"filters": {
  "or": [
    { "Status": "Open" },
    { "Status": "In Review" }
  ],
  "Amount": { "min": 100 }         // AND with the OR group
}
```
Multiple top-level keys are AND-ed.

---

## 7. Field value shapes

When reading an entry (`data["<Field Name>"]`) or writing through `input`:

| Field type | Value shape |
|---|---|
| `Text`, `Long Text`, `Email`, `Phone`, `URL` | string |
| `Number`, `Currency`, `Percent` | number |
| `Date`, `DateTime` | ISO 8601 string |
| `Yes/No` | boolean |
| `Selection(...)` | string (one of the options) |
| `File`, `Image` | `{ "name": "report.pdf", "path": "/s/{guid}/report.pdf" }` |
| `Files`, `Images` | array of the above |
| `User` | `{ "value": "Alice Lee", "id": 17, "username": "alice" }` |
| `Users` | array of the above |
| `Module` | `{ "value": "INV-001", "id": 42 }` (reference to entry in another module) |
| `Modules` | array of the above |
| `Table` | array of row objects — each row keys by sub-field display name |

---

## 8. File uploads (two-step, presigned)

Step 1 — request a presigned URL:
```
POST /api/mcp/request-upload-url
{
  "module": "Invoices",
  "fileName": "scan.pdf",
  "contentType": "application/pdf",
  "fileSize": 512345
}
→ { "uploadUrl": "https://s3...", "s3Key": "..." }
```

Step 2 — PUT the raw bytes directly to S3 with the **exact** Content-Type you declared:
```js
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": "application/pdf" },
  body: file                   // File or Blob
});
```

Step 3 — confirm:
```
POST /api/mcp/confirm-upload
{ "s3Key": "..." }
→ { "url": "/s/{guid}/scan.pdf", "filename": "scan.pdf", "mimeType": "application/pdf", "size": 512345 }
```

Use `url` as `path` in a File/Image field value:
```
"input": { "Attachment": { "name": "scan.pdf", "path": "/s/abc/scan.pdf" } }
```

**Max size:** 500 MB. `uploadUrl` expires after ~1 hour — request again if it does. The older base64 endpoint (`POST /api/mcp/upload`) exists but should only be used as a fallback.

Download (returns a 302 to a short-lived S3 URL):
```
GET /api/mcp/download/{moduleName}/s/{guid}/{fileName}
```
In a browser, setting `<a href>` or `window.location` to the download URL is usually enough — follow the redirect.

---

## 9. Error handling

Non-2xx responses return JSON:
```
{
  "error": "ValidationError",
  "message": "Field 'Amount' is required.",
  "details": [ { "field": "Amount", "message": "..." } ],
  "agent_action": "Validation failed. Check details[].field for specifics."
}
```

Map by status:
- `400` — fix input, retry.
- `401` — token invalid/expired; prompt the user to re-enter.
- `403` — user lacks permission; show a friendly message.
- `404` — module/entry not found.
- `422` — structured validation errors in `details[]`; surface per-field in the form.

---

## 10. Minimal reference client (framework-agnostic)

```ts
// inistate.ts
export interface InistateConfig {
  baseUrl?: string;           // default https://api.inistate.com
  getToken: () => string;     // user-supplied, read at call time
  getWorkspaceId: () => string;
}

export function createInistate(cfg: InistateConfig) {
  const base = (cfg.baseUrl ?? "https://api.inistate.com").replace(/\/+$/, "");

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `fsk ${cfg.getToken()}`,
        wsid: cfg.getWorkspaceId(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw Object.assign(new Error(data?.message ?? res.statusText), { status: res.status, payload: data });
    return data as T;
  }

  return {
    listModules: () => call<any>("GET", "/api/mcp/"),
    getSchema: (module: string, tier: "basic" | "extended" = "basic") =>
      call<any>("GET", `/api/mcp/${encodeURIComponent(module)}?tier=${tier}`),
    listEntries: (body: Record<string, unknown>) => call<any>("POST", "/api/mcp/list", body),
    getEntry: (module: string, entryId: string | number) => call<any>("POST", "/api/mcp/entry", { module, entryId }),
    getForm: (module: string, activity = "create", entryId?: string | number) =>
      call<any>("POST", "/api/mcp/form", { module, activity, ...(entryId != null ? { entryId } : {}) }),
    submit: (payload: Record<string, unknown>) => call<any>("POST", "/api/mcp/activity", payload),
    history: (module: string, entryId: string | number, page = 0) =>
      call<any>("POST", "/api/mcp/history", { module, entryId, page }),
    requestUpload: (module: string, fileName: string, contentType: string, fileSize: number) =>
      call<any>("POST", "/api/mcp/request-upload-url", { module, fileName, contentType, fileSize }),
    confirmUpload: (s3Key: string) => call<any>("POST", "/api/mcp/confirm-upload", { s3Key }),
  };
}
```

---

## 11. React reference patterns (adapt to any UI library)

```tsx
// useEntries.ts
import { useEffect, useState } from "react";
import { inistate } from "./client";

export function useEntries(module: string, filters?: Record<string, unknown>) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState<Error>();
  useEffect(() => {
    inistate.listEntries({ module, filters, currentPage: 0, pageSize: 50 })
      .then(setData).catch(setError);
  }, [module, JSON.stringify(filters)]);
  return { data, error };
}
```

```tsx
// EntryForm.tsx — form driven entirely by get_form
export function EntryForm({ module, activity, entryId }: Props) {
  const [form, setForm] = useState<any>();
  const [values, setValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    inistate.getForm(module, activity, entryId).then(f => {
      setForm(f);
      setValues(f.defaults ?? {});
    });
  }, [module, activity, entryId]);

  async function submit() {
    await inistate.submit({ module, activity, entryId, input: values });
  }

  // Render fields from form.fields[] — each has { name, type, required, options, ... }.
  // Style and layout are up to you.
}
```

## 12. Vue reference patterns

```ts
// useEntries.ts
import { ref, watchEffect } from "vue";
import { inistate } from "./client";

export function useEntries(module: Ref<string>, filters?: Ref<Record<string, unknown>>) {
  const data = ref<any>();
  const error = ref<Error>();
  watchEffect(async () => {
    try {
      data.value = await inistate.listEntries({
        module: module.value,
        filters: filters?.value,
        currentPage: 0,
        pageSize: 50,
      });
    } catch (e) { error.value = e as Error; }
  });
  return { data, error };
}
```

---

## 13. Recommended generation flow

When the user asks for "a page that does X":

1. `listModules()` → confirm the module exists and pick one.
2. `getSchema(module, "extended")` → know the fields, states, activities, flows.
3. For each activity or view the UI exposes: `getForm(module, activity)` → know the fields to render.
4. Generate components in the user's chosen framework / design system, wiring them to the client from §10.
5. Keep the token input + workspace selector at the top level (localStorage, a login view, or whatever fits). Never bake a token into source code or commit it.
