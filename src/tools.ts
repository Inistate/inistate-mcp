import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import * as api from "./api.js";
import {
  designWorkflow,
  validateDesign,
} from "./schema.js";

// ---------- Logging ----------

const LOG_PATH = resolve(process.cwd(), "debug.log");

function log(tool: string, detail: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${tool}: ${detail}\n`;
  try { appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
}

// ---------- Response helpers ----------

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(e: unknown) {
  if (e && typeof e === "object" && "structured" in e) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify((e as any).structured, null, 2),
        },
      ],
    };
  }
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: e instanceof Error ? e.message : String(e) },
    ],
  };
}

// ---------- Workspace helper ----------

/** Apply workspaceId if provided (stateless mode), else rely on env/prior set_workspace. */
function applyWorkspace(workspaceId?: string): void {
  if (workspaceId) api.setWorkspaceId(workspaceId);
}

const wsParam = z
  .string()
  .optional()
  .describe("Workspace ID. Required in stateless/remote mode. If set via env INISTATE_WORKSPACE_ID or prior set_workspace call, can be omitted.");

// ---------- Tool registration ----------

export function registerTools(server: McpServer) {
  // ═══════════════════════════════════════════
  // 0. login
  // ═══════════════════════════════════════════
  server.registerTool(
    "login",
    {
      description:
        "Authenticate with username and password to obtain a session token. Use this when no API key is configured and the user provides credentials. Subsequent API calls will use the obtained token automatically.",
      inputSchema: {
        username: z.string().describe("Inistate account username or email"),
        password: z.string().describe("Account password"),
      },
    },
    async ({ username, password }) => {
      try {
        await api.loginWithCredentials(username, password);
        return ok({ message: "Login successful" });
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 1. list_workspaces
  // ═══════════════════════════════════════════
  server.registerTool(
    "list_workspaces",
    {
      description:
        "List workspaces the current user has access to. Call set_workspace to select one before any module or entry tools. This is typically the first tool to call in any session.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Optional name filter (case-insensitive)"),
      },
    },
    async ({ search }) => {
      try {
        const query = search ? `?search=${encodeURIComponent(search)}` : "";
        const data = await api.get(`/api/workspace${query}`);
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 2. set_workspace
  // ═══════════════════════════════════════════
  server.registerTool(
    "set_workspace",
    {
      description: `Set the active workspace for the current session. In stateless/remote mode, prefer passing workspaceId directly to each tool instead.

Workflow sequences after workspace is set:
- Design: design_workflow → validate_design → create_module
- Execute: list_modules → list_entries → get_form → submit_activity
- Modify: list_modules → get_module_canvas → validate_design → update_module
- Query: list_modules → list_entries → get_entry / get_entry_history`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace ID from list_workspaces"),
      },
    },
    async ({ workspaceId }) => {
      try {
        api.setWorkspaceId(workspaceId);
        const data = await api.get(`/api/workspace/${api.enc(workspaceId)}`);
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 3. list_modules
  // ═══════════════════════════════════════════
  server.registerTool(
    "list_modules",
    {
      description:
        "List all discoverable modules in the current workspace. Call this to find module names for execute, modify, and query operations.",
      inputSchema: {
        workspaceId: wsParam,
      },
    },
    async ({ workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        const data = await api.get("/api/mcp/");
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 4. get_module_schema
  // ═══════════════════════════════════════════
  server.registerTool(
    "get_module_schema",
    {
      description:
        "Get the canvas schema for a module. Use tier=basic (default) for fields and states only. Use tier=extended to also include activities and flows. Use basic for query operations. Use extended when you need to understand available activities and state transitions.",
      inputSchema: {
        module: z.string().describe("Module name from list_modules"),
        tier: z
          .enum(["basic", "extended"])
          .default("basic")
          .describe(
            "basic = fields + states. extended = + activities and flows.",
          ),
        workspaceId: wsParam,
      },
    },
    async ({ module: moduleName, tier, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        const data = await api.get(
          `/api/mcp/${api.enc(moduleName)}?tier=${tier}`,
        );
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 5. get_module_canvas
  // ═══════════════════════════════════════════
  server.registerTool(
    "get_module_canvas",
    {
      description: `Get the full module definition with stable IDs. The output is round-trippable — modify and send back via update_module. Use this when modifying a module to preserve IDs for renaming.

Modify workflow: list_modules → get_module_canvas → (apply changes) → validate_design → update_module.
Load resource inistate://schema before modifying to know valid field types, colors, and actors.`,
      inputSchema: {
        module: z.string().describe("Module name or numeric ID"),
        workspaceId: wsParam,
      },
    },
    async ({ module: moduleName, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        const data = await api.get(
          `/api/configure/${api.enc(moduleName)}`,
        );
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 6. list_entries
  // ═══════════════════════════════════════════
  server.registerTool(
    "list_entries",
    {
      description: `Query entries from a module with filtering, sorting, and pagination. Prerequisite: set_workspace. Use display names for field references.

Filters are keyed by display name. Values can be:
- Simple equality: { "Priority": "High" }
- Text operators: { "Title": { "contains": "report" } } — is, not, contains, startsWith, endsWith, excludes
- Number operators: { "Amount": { "min": 1000, "max": 5000 } } — min, max, above, below, between
- Date operators: { "DueDate": { "after": "2026-01-01" } } — after, before, upcoming, past, within
- YesNo: { "Active": { "yes": true } }
- Existence: { "Notes": { "empty": true } }, { "Assignee": { "exists": true } }
- User: { "assignee": "me" }
- Logical: { "and": [...] }, { "or": [...] }

Multiple filters are AND-ed. Use state parameter for state filtering.`,
      inputSchema: {
        module: z.string().describe("Module name from list_modules"),
        state: z.string().optional().describe("Filter by state name"),
        search: z.string().optional().describe("Search by document ID"),
        filters: z
          .record(z.unknown())
          .optional()
          .describe("Field filters keyed by display name. See description for operators."),
        sortBy: z.string().optional().describe("Field display name to sort by"),
        sortDirection: z.enum(["asc", "desc"]).default("asc").optional(),
        currentPage: z.number().int().default(0).optional().describe("Zero-based page index"),
        pageSize: z.number().int().default(50).optional().describe("Items per page (max 500)"),
        workspaceId: wsParam,
      },
    },
    async ({ module: moduleName, state, search, filters, sortBy, sortDirection, currentPage, pageSize, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        const body: Record<string, unknown> = { module: moduleName };
        if (state) body.state = state;
        if (search) body.search = search;
        if (filters) body.filters = filters;
        if (sortBy) body.sortBy = sortBy;
        if (sortDirection) body.sortDirection = sortDirection;
        if (currentPage !== undefined) body.currentPage = currentPage;
        if (pageSize !== undefined) body.pageSize = pageSize;
        const data = await api.post("/api/mcp/list", body);
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 7. get_entry
  // ═══════════════════════════════════════════
  server.registerTool(
    "get_entry",
    {
      description:
        "Read a single entry by its ID. Returns current field values, state, audit metadata, and available activities.",
      inputSchema: {
        module: z.string().describe("Module name from list_modules"),
        entryId: z
          .union([z.string(), z.number()])
          .describe("Entry ID"),
        workspaceId: wsParam,
      },
    },
    async ({ module: moduleName, entryId, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        const data = await api.post("/api/mcp/entry", {
          module: moduleName,
          entryId,
        });
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 8. get_form
  // ═══════════════════════════════════════════
  server.registerTool(
    "get_form",
    {
      description:
        "Get the form fields, current values, and options for a module activity. ALWAYS call this before submit_activity to discover required fields, their types, valid options, default values, and the confidence threshold. Never fabricate form data — if required fields cannot be confidently populated, ask the user.",
      inputSchema: {
        module: z.string().describe("Module name from list_modules"),
        activity: z
          .string()
          .default("create")
          .describe(
            "Activity name: create, edit, view, or any custom activity name from get_module_schema",
          ),
        entryId: z
          .union([z.string(), z.number(), z.null()])
          .optional()
          .describe("Entry ID for edit/view/custom activities. Omit for create."),
        workspaceId: wsParam,
      },
    },
    async ({ module: moduleName, activity, entryId, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        const body: Record<string, unknown> = {
          module: moduleName,
          activity,
        };
        if (entryId !== undefined && entryId !== null) body.entryId = entryId;
        const data = await api.post("/api/mcp/form", body);
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 9. submit_activity
  // ═══════════════════════════════════════════
  server.registerTool(
    "submit_activity",
    {
      description: `Perform an activity on a module entry. Always call get_form first to discover fields and confidence_threshold.

Standard activities: create (no entryId), edit, delete, changeStatus, comment, duplicate, manage.
Custom activities: use the activity name from get_module_schema.
Bulk operations: use entryIds array instead of entryId.
File/Image fields: use { name, path } where path is from upload_file() or an external URL.
Module fields: use { value, id } — id is the referenced entry's ID.
User fields: use { value, id, username }.
Plural variants (Files/Images/Modules/Users): use arrays of the objects above.
AI audit: always include the ai object with reasoning, sources, model, and confidence for traceability.`,
      inputSchema: {
        module: z.string().describe("Module name"),
        activity: z
          .string()
          .default("create")
          .describe("create, edit, delete, changeStatus, comment, duplicate, manage, or custom activity name"),
        entryId: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Required for edit/delete/custom. Omit for create."),
        entryIds: z
          .array(z.union([z.string(), z.number()]))
          .optional()
          .describe("Multiple entry IDs for bulk operations"),
        input: z
          .record(z.unknown())
          .optional()
          .describe("Field values keyed by display name. For File/Image fields, use { name, path } objects. For Module fields, use { value, id }. For User fields, use { value, id, username }. Plural variants (Files/Images/Modules/Users) use arrays of these objects."),
        state: z
          .string()
          .optional()
          .describe("Target state name (resolved to internal ID automatically)"),
        comment: z
          .string()
          .optional()
          .describe("Comment to attach to the activity"),
        assignees: z
          .array(z.string())
          .optional()
          .describe("Usernames to assign"),
        due: z
          .string()
          .optional()
          .describe("Due date for assignment (ISO 8601)"),
        ai: z
          .object({
            reasoning: z.string().optional().describe("Natural language explanation of the AI's decision"),
            sources: z
              .array(
                z.object({
                  type: z.string().optional(),
                  reference: z.string().optional(),
                  excerpt: z.string().optional(),
                }),
              )
              .optional()
              .describe("What data the AI used and from where"),
            model: z.string().optional().describe("Which model made this decision"),
            model_version: z.string().optional().describe("Model version / checkpoint"),
            prompt_hash: z.string().optional().describe("Hash of the system prompt used"),
            confidence: z
              .number()
              .min(0)
              .max(1)
              .optional()
              .describe("Confidence score. If below confidence_threshold, state transition is suppressed."),
          })
          .optional()
          .describe("AI agent traceability context"),
        workspaceId: wsParam,
      },
    },
    async ({
      module: moduleName,
      activity,
      entryId,
      entryIds,
      input,
      state,
      comment,
      assignees,
      due,
      ai,
      workspaceId,
    }) => {
      try {
        applyWorkspace(workspaceId);
        // Normalize file field inputs: remap 'url' → 'path' if client sent { name, url } instead of { name, path }
        if (input) {
          for (const key of Object.keys(input)) {
            const val = input[key];
            if (val && typeof val === "object" && !Array.isArray(val)) {
              const obj = val as Record<string, unknown>;
              if (obj.url && !obj.path) {
                obj.path = obj.url;
                delete obj.url;
              }
            } else if (Array.isArray(val)) {
              for (const item of val) {
                if (item && typeof item === "object") {
                  const obj = item as Record<string, unknown>;
                  if (obj.url && !obj.path) {
                    obj.path = obj.url;
                    delete obj.url;
                  }
                }
              }
            }
          }
        }
        const body: Record<string, unknown> = {
          module: moduleName,
          activity,
        };
        if (entryId !== undefined) body.entryId = entryId;
        if (entryIds) body.entryIds = entryIds;
        if (input) body.input = input;
        if (state) body.state = state;
        if (comment) body.comment = comment;
        if (assignees) body.assignees = assignees;
        if (due) body.due = due;
        if (ai) body.ai = ai;
        const target = entryId ?? (entryIds ? `bulk(${entryIds.length})` : "new");
        log("submit_activity", `module=${moduleName} activity=${activity} entry=${target} payload=${JSON.stringify(body)}`);
        const data = await api.post("/api/mcp/activity", body);
        log("submit_activity", `module=${moduleName} activity=${activity} entry=${target} → ok`);
        return ok(data);
      } catch (e) {
        const target = entryId ?? (entryIds ? `bulk(${entryIds.length})` : "new");
        log("submit_activity", `module=${moduleName} activity=${activity} entry=${target} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 10. get_entry_history
  // ═══════════════════════════════════════════
  server.registerTool(
    "get_entry_history",
    {
      description:
        "Get the audit trail and comments for an entry. Returns chronological list of actions (create, edit, state changes, comments) with field-level change details and AI traceability context.",
      inputSchema: {
        module: z.string().describe("Module name from list_modules"),
        entryId: z
          .union([z.string(), z.number()])
          .describe("Entry ID to get history for"),
        page: z
          .number()
          .int()
          .default(0)
          .optional()
          .describe("Page number (0-based, 50 items per page)"),
        workspaceId: wsParam,
      },
    },
    async ({ module: moduleName, entryId, page, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        const body: Record<string, unknown> = {
          module: moduleName,
          entryId,
        };
        if (page !== undefined) body.page = page;
        const data = await api.post("/api/mcp/history", body);
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 11. upload_file
  // ═══════════════════════════════════════════
  server.registerTool(
    "upload_file",
    {
      description:
        "Upload a file to S3 storage. Returns { path, filename, mimeType, size }. Use the returned path directly as the 'path' value in File/Image fields for submit_activity (e.g. { name: 'photo.jpg', path: result.path }). Max 50MB. Blocked: .exe, .bat, .cmd, .dll, .msi. The agent provides file content as base64 which the server converts to multipart/form-data for the API.",
      inputSchema: {
        module: z
          .string()
          .describe("Module name. Required — scopes the file to the module's storage folder."),
        name: z.string().describe("Original filename (e.g. 'report.pdf')"),
        file: z.string().describe("Base64-encoded file content"),
        mimeType: z
          .string()
          .default("application/octet-stream")
          .describe("MIME type of the file"),
        workspaceId: wsParam,
      },
    },
    async ({ module: moduleName, name: fileName, file: fileContent, mimeType, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        log("upload_file", `module=${moduleName} file=${fileName} mime=${mimeType}`);
        const buffer = Buffer.from(fileContent, "base64");
        const blob = new Blob([buffer], { type: mimeType });
        const formData = new FormData();
        formData.append("file", blob, fileName);
        formData.append("module", moduleName);
        const raw = await api.uploadFormData("/api/mcp/upload", formData) as Record<string, unknown>;
        log("upload_file", `module=${moduleName} file=${fileName} → ok`);
        return ok(raw);
      } catch (e) {
        log("upload_file", `module=${moduleName} file=${fileName} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 12. download_file
  // ═══════════════════════════════════════════
  server.registerTool(
    "download_file",
    {
      description:
        "Download a file by module name. Construct the URL from a File/Image field value: field.path = '/s/{guid}/{fileName}'. Returns a pre-signed S3 URL (1hr TTL).",
      inputSchema: {
        moduleName: z.string().describe("Module name (resolved to vectorId internally)"),
        guid: z.string().describe("Short ID from the file URL"),
        fileName: z.string().describe("Original filename"),
        workspaceId: wsParam,
      },
    },
    async ({ moduleName, guid, fileName, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        const result = await api.getRaw(
          `/api/mcp/download/${api.enc(moduleName)}/s/${api.enc(guid)}/${api.enc(fileName)}`,
        );
        if (result.redirectUrl) {
          return ok({ downloadUrl: result.redirectUrl, fileName });
        }
        return ok(result.body);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 13. request_upload_url
  // ═══════════════════════════════════════════
  server.registerTool(
    "request_upload_url",
    {
      description: `Request a presigned S3 PUT URL for direct large-file upload (up to 500MB). Use this instead of upload_file when the file exceeds 50MB or when you want to avoid base64/JSON overhead. Three-step flow: 1) call this tool, 2) PUT the raw bytes to uploadUrl with Content-Type exactly matching contentType (S3 rejects mismatches with 403 SignatureDoesNotMatch), 3) call confirm_upload({ s3Key }). The returned path is used directly as the File/Image field value in submit_activity. uploadUrl expires in ~1 hour and cannot be renewed — call this again on expiry.`,
      inputSchema: {
        module: z
          .string()
          .describe("Module name. Required — scopes the file to the module's storage folder."),
        fileName: z.string().describe("Original filename including extension (e.g. 'report.pdf')"),
        contentType: z
          .string()
          .default("application/octet-stream")
          .describe("MIME type. Must match the Content-Type header used in the PUT request."),
        fileSize: z
          .number()
          .int()
          .positive()
          .describe("File size in bytes. Must be > 0 and ≤ 500MB (524288000)."),
        workspaceId: wsParam,
      },
    },
    async ({ module: moduleName, fileName, contentType, fileSize, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        log("request_upload_url", `module=${moduleName} file=${fileName} size=${fileSize} mime=${contentType}`);
        const data = await api.post("/api/mcp/request-upload-url", {
          module: moduleName,
          fileName,
          contentType,
          fileSize,
        });
        log("request_upload_url", `module=${moduleName} file=${fileName} → ok`);
        return ok(data);
      } catch (e) {
        log("request_upload_url", `module=${moduleName} file=${fileName} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 14. confirm_upload
  // ═══════════════════════════════════════════
  server.registerTool(
    "confirm_upload",
    {
      description: `Confirm a presigned upload completed. Call after successfully PUTting the file to the uploadUrl from request_upload_url. The server verifies the object exists in S3, reads its metadata, and tracks workspace storage. Only s3Key is required — filename, size, and MIME type are resolved from S3. Returns { url, filename, mimeType, size } where url is the /s/ path usable as a File/Image field value. Returns 400 if the file is not found in S3 — ensure the PUT completed before calling.`,
      inputSchema: {
        s3Key: z
          .string()
          .describe("The s3Key returned from request_upload_url."),
        workspaceId: wsParam,
      },
    },
    async ({ s3Key, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);
        log("confirm_upload", `s3Key=${s3Key}`);
        const data = await api.post("/api/mcp/confirm-upload", { s3Key });
        log("confirm_upload", `s3Key=${s3Key} → ok`);
        return ok(data);
      } catch (e) {
        log("confirm_upload", `s3Key=${s3Key} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 15. design_workflow
  // ═══════════════════════════════════════════
  server.registerTool(
    "design_workflow",
    {
      description: `Generate a scaffolded ModuleSchema template from a natural language description. Use when the user wants to create a new module or workflow.

Design workflow: design_workflow → (complete template) → validate_design → create_module → get_module_schema(tier=extended).
Load resources inistate://schema and inistate://design-guide before designing for valid field types, colors, and design rules.`,
      inputSchema: {
        description: z
          .string()
          .describe(
            "Natural language description of the desired workflow. Include: entity type, lifecycle states, activities, who performs each, what data is collected.",
          ),
        industry: z
          .enum([
            "financial_services",
            "healthcare",
            "legal",
            "hr",
            "procurement",
            "it_service",
            "general",
          ])
          .default("general")
          .describe(
            "Industry context for compliance-aware defaults. Affects: default audit fields, confidence thresholds, actor type suggestions.",
          ),
      },
    },
    async ({ description, industry }) => {
      const result = designWorkflow(description, industry);
      return ok(result);
    },
  );

  // ═══════════════════════════════════════════
  // 14. validate_design
  // ═══════════════════════════════════════════
  server.registerTool(
    "validate_design",
    {
      description:
        "Validate a module schema before creating or updating. Checks structural integrity against all FACTSOps rules without submitting to the API. Passing validate_design guarantees the subsequent create_module/update_module call will not fail with 422. Always call this before create_module or update_module.",
      inputSchema: {
        schema: z
          .record(z.unknown())
          .describe("A complete or partial ModuleSchema object"),
        mode: z
          .enum(["create", "update"])
          .default("create")
          .describe(
            "create = new module (all rules). update = merge (omitted sections acceptable).",
          ),
      },
    },
    async ({ schema, mode }) => {
      const result = validateDesign(schema as Record<string, any>, mode);
      return ok(result);
    },
  );

  // ═══════════════════════════════════════════
  // 15. create_module
  // ═══════════════════════════════════════════
  server.registerTool(
    "create_module",
    {
      description: `Create a new module in the current workspace. Supports both workflow modules (with states, activities, flows) and record list modules (fields only). Requires Administrator, Consultant, or Workspace Admin role.

Design workflow: design_workflow → validate_design → create_module.
Always call validate_design before this tool.`,
      inputSchema: {
        name: z.string().describe("Module name"),
        icon: z.string().optional().describe("Emoji identifier"),
        description: z.string().optional().describe("Human-readable module description"),
        information: z
          .array(
            z.object({
              name: z.string(),
              type: z.string(),
              options: z.array(z.string()).optional(),
              fields: z
                .array(
                  z.object({
                    name: z.string(),
                    type: z.string(),
                    options: z.array(z.string()).optional(),
                  }),
                )
                .optional()
                .describe("Sub-fields for Table type"),
              ai_hint: z.string().optional(),
            }),
          )
          .optional()
          .describe("Field definitions"),
        states: z
          .array(
            z.object({
              name: z.string(),
              color: z.string().optional(),
              initial: z.boolean().optional(),
              ai_hint: z.string().optional(),
              ai_instruction: z.string().optional().describe("Instruction for AI agents to execute when an entry reaches this state"),
            }),
          )
          .optional()
          .describe("Workflow states. Omit for record list modules."),
        activities: z
          .array(
            z.object({
              name: z.string(),
              actor: z.enum(["human", "ai", "hybrid"]).optional(),
              fields: z
                .array(
                  z.union([
                    z.string(),
                    z.object({
                      name: z.string(),
                      required: z.boolean().optional(),
                      readOnly: z.boolean().optional(),
                      options: z.array(z.string()).optional(),
                    }),
                  ]),
                )
                .optional(),
              ai_hint: z.string().optional(),
              ai_instruction: z.string().optional().describe("Instruction for AI agents to execute when this activity is performed"),
              confidence_threshold: z.number().min(0).max(1).optional(),
            }),
          )
          .optional()
          .describe("Custom activities. Omit for record list modules."),
        flows: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              activity: z.string(),
              ai_hint: z.string().optional(),
            }),
          )
          .optional()
          .describe("State transition rules. Omit for record list modules."),
        workspaceId: wsParam,
      },
    },
    async ({
      name,
      icon,
      description: desc,
      information,
      states,
      activities,
      flows,
      workspaceId,
    }) => {
      try {
        applyWorkspace(workspaceId);
        const body: Record<string, unknown> = { name };
        if (icon) body.icon = icon;
        if (desc) body.description = desc;
        if (information) body.information = information;
        if (states) body.states = states;
        if (activities) body.activities = activities;
        if (flows) body.flows = flows;
        log("create_module", `name=${name}`);
        const data = await api.post(
          `/api/configure/`,
          body,
        );
        log("create_module", `name=${name} → ok`);
        return ok(data);
      } catch (e) {
        log("create_module", `name=${name} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 16. update_module
  // ═══════════════════════════════════════════
  server.registerTool(
    "update_module",
    {
      description: `Update an existing module's schema. Merges changes into the existing canvas. Items matched by id enable renaming without losing data. Omitted sections are left unchanged.

Modify workflow: list_modules → get_module_canvas → (apply changes) → validate_design → update_module.
Always call get_module_canvas first (not get_module_schema) to get stable IDs. Always call validate_design before this tool.`,
      inputSchema: {
        id: z
          .string()
          .describe("Module ID from get_module_canvas (identifies which module to update)"),
        name: z.string().optional().describe("New module name (for renaming)"),
        icon: z.string().optional(),
        description: z.string().optional(),
        information: z
          .array(
            z.object({
              id: z.string().optional().describe("Stable ID for matching (enables renaming)"),
              name: z.string(),
              type: z.string().optional(),
              options: z.array(z.string()).optional(),
              fields: z
                .array(
                  z.object({
                    id: z.string().optional(),
                    name: z.string(),
                    type: z.string().optional(),
                    options: z.array(z.string()).optional(),
                  }),
                )
                .optional(),
              ai_hint: z.string().optional(),
            }),
          )
          .optional(),
        states: z
          .array(
            z.object({
              id: z.string().optional().describe("Stable ID for matching"),
              name: z.string(),
              color: z.string().optional(),
              initial: z.boolean().optional(),
              ai_hint: z.string().optional(),
              ai_instruction: z.string().optional().describe("Instruction for AI agents to execute when an entry reaches this state"),
            }),
          )
          .optional(),
        activities: z
          .array(
            z.object({
              id: z.string().optional().describe("Stable ID for matching"),
              name: z.string(),
              actor: z.enum(["human", "ai", "hybrid"]).optional(),
              fields: z
                .array(
                  z.union([
                    z.string(),
                    z.object({
                      name: z.string(),
                      required: z.boolean().optional(),
                      readOnly: z.boolean().optional(),
                      options: z.array(z.string()).optional(),
                    }),
                  ]),
                )
                .optional(),
              ai_hint: z.string().optional(),
              ai_instruction: z.string().optional().describe("Instruction for AI agents to execute when this activity is performed"),
              confidence_threshold: z.number().min(0).max(1).optional(),
            }),
          )
          .optional(),
        flows: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              activity: z.string(),
              ai_hint: z.string().optional(),
            }),
          )
          .optional(),
        workspaceId: wsParam,
      },
    },
    async ({
      id,
      name,
      icon,
      description: desc,
      information,
      states,
      activities,
      flows,
      workspaceId,
    }) => {
      try {
        applyWorkspace(workspaceId);
        const body: Record<string, unknown> = { id };
        if (name) body.name = name;
        if (icon) body.icon = icon;
        if (desc) body.description = desc;
        if (information) body.information = information;
        if (states) body.states = states;
        if (activities) body.activities = activities;
        if (flows) body.flows = flows;
        log("update_module", `id=${id}${name ? ` name=${name}` : ""}`);
        const data = await api.put(
          `/api/configure/`,
          body,
        );
        log("update_module", `id=${id} → ok`);
        return ok(data);
      } catch (e) {
        log("update_module", `id=${id} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  );
}
