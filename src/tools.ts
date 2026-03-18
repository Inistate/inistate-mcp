import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "./api.js";
import {
  designWorkflow,
  validateDesign,
} from "./schema.js";

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

// ---------- Tool registration ----------

export function registerTools(server: McpServer) {
  // ═══════════════════════════════════════════
  // 1. list_workspaces
  // ═══════════════════════════════════════════
  server.registerTool(
    "list_workspaces",
    {
      description:
        "List workspaces the current user has access to. Call set_workspace to select one before any module or entry tools. This is typically the first tool to call in any session.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await api.get("/api/workspace");
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
      description: `Set the active workspace. Retrieves workspace details for the agent to store. Must be called before any module or entry tools.

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
        "List all discoverable modules in the current workspace. Prerequisite: set_workspace. Call this to find module names for execute, modify, and query operations.",
      inputSchema: {},
    },
    async () => {
      try {
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
      },
    },
    async ({ module: moduleName, tier }) => {
      try {
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
      },
    },
    async ({ module: moduleName }) => {
      try {
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
      },
    },
    async ({ module: moduleName, state, search, filters, sortBy, sortDirection, currentPage, pageSize }) => {
      try {
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
      },
    },
    async ({ module: moduleName, entryId }) => {
      try {
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
      },
    },
    async ({ module: moduleName, activity, entryId }) => {
      try {
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
File/Image fields: use { name, bytes } for base64 inline or { name, path } for pre-uploaded via upload_file.
Files/Images (plural): use arrays of file objects.
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
          .describe("Field values keyed by display name"),
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
    }) => {
      try {
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
        const data = await api.post("/api/mcp/activity", body);
        return ok(data);
      } catch (e) {
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
      },
    },
    async ({ module: moduleName, entryId, page }) => {
      try {
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
        "Upload a file to S3 storage. Returns a /s/ URL that can be used as a File/Image field value in submit_activity. Max 50MB. Blocked: .exe, .bat, .cmd, .dll, .msi. The agent provides file content as base64 which the server converts to multipart/form-data for the API.",
      inputSchema: {
        module: z
          .string()
          .optional()
          .describe("Module name (optional, for scoping the file to a module)"),
        name: z.string().describe("Original filename (e.g. 'report.pdf')"),
        file: z.string().describe("Base64-encoded file content"),
        mimeType: z
          .string()
          .default("application/octet-stream")
          .describe("MIME type of the file"),
      },
    },
    async ({ module: moduleName, name: fileName, file: fileContent, mimeType }) => {
      try {
        const buffer = Buffer.from(fileContent, "base64");
        const blob = new Blob([buffer], { type: mimeType });
        const formData = new FormData();
        formData.append("file", blob, fileName);
        if (moduleName) formData.append("module", moduleName);
        const data = await api.uploadFormData("/api/mcp/upload", formData);
        return ok(data);
      } catch (e) {
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
      },
    },
    async ({ moduleName, guid, fileName }) => {
      try {
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
  // 13. design_workflow
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
        published: z.boolean().default(true).optional(),
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
      },
    },
    async ({
      name,
      icon,
      description: desc,
      published,
      information,
      states,
      activities,
      flows,
    }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (icon) body.icon = icon;
        if (desc) body.description = desc;
        if (published !== undefined) body.published = published;
        if (information) body.information = information;
        if (states) body.states = states;
        if (activities) body.activities = activities;
        if (flows) body.flows = flows;
        const data = await api.post(
          `/api/configure/${api.enc(name)}`,
          body,
        );
        return ok(data);
      } catch (e) {
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
        module: z
          .string()
          .describe("Current module name (used in URL path)"),
        moduleId: z
          .string()
          .optional()
          .describe("Module ID for identification (use if renaming)"),
        name: z.string().optional().describe("New module name (for renaming)"),
        icon: z.string().optional(),
        description: z.string().optional(),
        published: z.boolean().optional(),
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
      },
    },
    async ({
      module: moduleName,
      moduleId,
      name,
      icon,
      description: desc,
      published,
      information,
      states,
      activities,
      flows,
    }) => {
      try {
        const body: Record<string, unknown> = {};
        if (moduleId) body.moduleId = moduleId;
        if (name) body.name = name;
        if (icon) body.icon = icon;
        if (desc) body.description = desc;
        if (published !== undefined) body.published = published;
        if (information) body.information = information;
        if (states) body.states = states;
        if (activities) body.activities = activities;
        if (flows) body.flows = flows;
        const data = await api.put(
          `/api/configure/${api.enc(moduleName)}`,
          body,
        );
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );
}
