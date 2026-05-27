import { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import * as api from "./api.js";
import {
  clearFlagged,
  evaluateActivity,
  getModuleFieldTypes,
  getPriorFlag,
  recordFlagged,
  validateInputShapes,
  validateInputShapesWith,
} from "./activity-guard.js";
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
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function err(e: unknown) {
  if (e && typeof e === "object" && "structured" in e) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify((e as any).structured),
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

// ---------- Shared module-schema shapes (used by create_module + update_module) ----------
// `id` is optional on both: ignored on create, used to match items on update (enables renaming).
// `type` is optional so update can rename without re-sending it; create still requires it server-side.

const subFieldShape = z.object({
  id: z.string().optional(),
  name: z.string(),
  type: z.string().optional(),
  options: z.array(z.string()).optional(),
});

const fieldShape = z.object({
  id: z.string().optional(),
  name: z.string(),
  type: z.string().optional(),
  options: z.array(z.string()).optional(),
  fields: z.array(subFieldShape).optional().describe("Sub-fields for Table type"),
  ai_hint: z.string().optional(),
});

const stateShape = z.object({
  id: z.string().optional(),
  name: z.string(),
  color: z.string().optional(),
  initial: z.boolean().optional(),
  ai_hint: z.string().optional(),
  ai_instruction: z.string().optional(),
});

const activityFieldRefShape = z.object({
  name: z.string(),
  required: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

const activityShape = z.object({
  id: z.string().optional(),
  name: z.string(),
  actor: z.enum(["human", "ai", "hybrid"]).optional(),
  fields: z.array(z.union([z.string(), activityFieldRefShape])).optional(),
  ai_hint: z.string().optional(),
  ai_instruction: z.string().optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
});

const flowShape = z.object({
  from: z.string(),
  to: z.string(),
  activity: z.string(),
  ai_hint: z.string().optional(),
});

const moduleSectionsShape = {
  icon: z.string().optional().describe("Emoji identifier"),
  description: z.string().optional(),
  information: z.array(fieldShape).optional().describe("Field definitions. Items matched by id on update enable renaming."),
  states: z.array(stateShape).optional().describe("Workflow states. Omit for record list modules."),
  activities: z.array(activityShape).optional().describe("Custom activities. Omit for record list modules."),
  flows: z.array(flowShape).optional().describe("State transition rules. Omit for record list modules."),
};

// ---------- Tool registration ----------

export function registerTools(server: McpServer): { configureTools: RegisteredTool[] } {
  const configureTools: RegisteredTool[] = [];
  // ═══════════════════════════════════════════
  // 1. list_workspaces
  // ═══════════════════════════════════════════
  server.registerTool(
    "list_workspaces",
    {
      title: "List Workspaces",
      description:
        "List workspaces the current user has access to. Call set_workspace to select one before any module or entry tools. This is typically the first tool to call in any session.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Optional name filter (case-insensitive)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
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
      title: "Set Active Workspace",
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
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
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
      title: "List Modules",
      description:
        "List all discoverable modules in the current workspace. Call this to find module names for execute, modify, and query operations.",
      inputSchema: {
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
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
  // 4. get_module_schema (configure mode)
  // ═══════════════════════════════════════════
  configureTools.push(server.registerTool(
    "get_module_schema",
    {
      title: "Get Module Schema",
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
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
  ));

  // ═══════════════════════════════════════════
  // 5. get_module_canvas (configure mode)
  // ═══════════════════════════════════════════
  configureTools.push(server.registerTool(
    "get_module_canvas",
    {
      title: "Get Module Canvas",
      description: `Get the full module definition with stable IDs. The output is round-trippable — modify and send back via update_module. Use this when modifying a module to preserve IDs for renaming.

Modify workflow: list_modules → get_module_canvas → (apply changes) → validate_design → update_module.
Load resource inistate://schema before modifying to know valid field types, colors, and actors.`,
      inputSchema: {
        module: z.string().describe("Module name or numeric ID"),
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
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
  ));

  // ═══════════════════════════════════════════
  // 6. list_entries
  // ═══════════════════════════════════════════
  server.registerTool(
    "list_entries",
    {
      title: "List Entries",
      description:
        "Query entries with filters, sorting, pagination. Filter keys are field display names; values are equality (simple) or operator objects (contains/startsWith/endsWith/min/max/above/below/between/after/before/empty/exists/yes/no/is/not/excludes). Use {or:[…]} for OR; multiple keys are AND-ed. Use 'me' for User-field self-match. See FilterOperators in inistate://schema/runtime for the full set.\n\nToken control: use `fields` to restrict the returned `data` to just the columns you need. For modules with many fields this can shrink the response by an order of magnitude. System fields (id, state, audit metadata, etc.) are always returned regardless.",
      inputSchema: {
        module: z.string().describe("Module name from list_modules"),
        state: z.string().optional(),
        search: z.string().optional().describe("Free-text against document ID and indexed text fields"),
        filters: z.record(z.unknown()).optional(),
        sortBy: z.string().optional(),
        sortDirection: z.enum(["asc", "desc"]).default("asc").optional(),
        currentPage: z.number().int().default(0).optional(),
        pageSize: z.number().int().default(50).optional().describe("Default 50, max 500"),
        fields: z
          .array(z.string())
          .optional()
          .describe(
            "Field display names (or raw field names) to include in each entry's `data`. Strongly preferred over returning everything when the module has many or large fields — prunes both DB I/O and response tokens. Omit only when you actually need the full row. System fields are always returned.",
          ),
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ module: moduleName, state, search, filters, sortBy, sortDirection, currentPage, pageSize, fields, workspaceId }) => {
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
        if (fields && fields.length > 0) body.fields = fields;
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
      title: "Get Entry",
      description:
        "Read a single entry by its ID. Returns current field values, state, audit metadata, and available activities.",
      inputSchema: {
        module: z.string().describe("Module name from list_modules"),
        entryId: z
          .union([z.string(), z.number()])
          .describe("Entry ID"),
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
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
      title: "Get Activity Form",
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
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
      title: "Submit Activity",
      description:
        "Perform an activity on a module entry: standard (create [no entryId], edit, delete, changeStatus, comment, duplicate, manage) or any custom activity from get_module_schema. ALWAYS call get_form first. The `ai` object is REQUIRED (reasoning + model + confidence). If confidence < the activity's threshold, the transition is suppressed and the entry is flagged. Server-side guard rules (human/hybrid actor, state-change confirm, confidence-inflation) may block — see inistate://guardrails. Input shapes: ActivitySubmission in inistate://schema/runtime.",
      inputSchema: {
        module: z.string(),
        activity: z.string().default("create"),
        entryId: z.union([z.string(), z.number()]).optional().describe("Omit for create"),
        entryIds: z.array(z.union([z.string(), z.number()])).optional().describe("For bulk ops"),
        input: z
          .record(z.unknown())
          .optional()
          .describe("Field values keyed by display name. File/Image: {name,path}. Module: {id,value} (both required). User: {id,value,username} (all three required). Plural variants (Users/Modules/Files/Images): arrays of those objects. User/Module shapes are validated pre-flight — bare ids, bare strings, or objects missing any required key will be rejected."),
        state: z.string().optional().describe("Target state name"),
        comment: z.string().optional().describe("Optional. Add only when it carries information not already in the field values or reasoning. Keep short and precise."),
        assignees: z.array(z.string()).optional().describe("Usernames"),
        due: z.string().optional().describe("ISO 8601"),
        ai: z
          .object({
            reasoning: z.string().describe("Why the AI chose this action — recorded for audit. Keep short and precise; one or two sentences."),
            model: z.string().describe("e.g. claude-haiku-4-5, claude-opus-4-7"),
            confidence: z.number().min(0).max(1).describe("0-1; gated against the activity's confidence_threshold"),
            sources: z
              .array(
                z.object({
                  type: z.string().optional(),
                  reference: z.string().optional(),
                  excerpt: z.string().optional(),
                }),
              )
              .optional(),
            model_version: z.string().optional(),
            prompt_hash: z.string().optional(),
          })
          .describe("REQUIRED — AI agent traceability"),
        confirmed: z
          .boolean()
          .optional()
          .describe(
            "Set true only after explicit user authorization. Required for: changeStatus, state override, hybrid actor, retry after flag. Does not unlock human-actor activities. See inistate://guardrails.",
          ),
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
      confirmed,
      workspaceId,
    }) => {
      try {
        applyWorkspace(workspaceId);
        const guard = await evaluateActivity({
          module: moduleName,
          activity,
          entryId,
          entryIds,
          state,
          confidence: ai?.confidence ?? 0,
          confirmed,
        });
        if (!guard.ok) {
          const target = entryId ?? (entryIds ? `bulk(${entryIds.length})` : "new");
          log(
            "submit_activity",
            `module=${moduleName} activity=${activity} entry=${target} → BLOCKED: ${guard.structured.error}`,
          );
          return err({ structured: guard.structured });
        }
        // Reference-shape pre-flight: User/Module fields must be { id, value }.
        if (input) {
          const shapeErrors = await validateInputShapes(moduleName, input);
          if (shapeErrors.length > 0) {
            const target = entryId ?? (entryIds ? `bulk(${entryIds.length})` : "new");
            const structured = {
              error: "invalid_reference_field_shape",
              message:
                "One or more User/Module fields were submitted with the wrong shape. They require { id, value } objects (plural variants take arrays of them).",
              activity,
              fields: shapeErrors,
              agent_action:
                "Re-read the entry or call get_form, copy the User/Module values back unchanged (they round-trip), and resubmit. Do not pass bare ids or display strings.",
            };
            log(
              "submit_activity",
              `module=${moduleName} activity=${activity} entry=${target} → BLOCKED: invalid_reference_field_shape (${shapeErrors.length} field${shapeErrors.length === 1 ? "" : "s"})`,
            );
            return err({ structured });
          }
        }
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
        const flagged =
          data && typeof data === "object" && (data as Record<string, unknown>).flagged === true;
        const flagTargets: Array<string | number | undefined> =
          entryIds && entryIds.length > 0 ? entryIds : [entryId];
        for (const t of flagTargets) {
          if (flagged) {
            recordFlagged(moduleName, t, activity, ai?.confidence ?? 0);
          } else {
            clearFlagged(moduleName, t, activity);
          }
        }
        log("submit_activity", `module=${moduleName} activity=${activity} entry=${target} → ${flagged ? "flagged" : "ok"}`);
        return ok(data);
      } catch (e) {
        const target = entryId ?? (entryIds ? `bulk(${entryIds.length})` : "new");
        log("submit_activity", `module=${moduleName} activity=${activity} entry=${target} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 9b. submit_activities (bulk)
  // ═══════════════════════════════════════════
  server.registerTool(
    "submit_activities",
    {
      title: "Submit Activities (Bulk)",
      description:
        "Bulk variant of submit_activity: same module + same activity applied to multiple entries, each with its own input payload. Use this instead of N sequential submit_activity calls when creating/editing many rows at once — saves substantial agent tokens by collapsing N tool turns into one.\n\nShape: top-level `module`, `activity`, and a default `ai` block; per-item `input` (and optional `entryId`, `state`, `comment`, `assignees`, `due`, `ai`, `clientRef`). When an item supplies its own `ai`, it wholly replaces the top-level `ai` for that item — no partial merge.\n\nExecution: items run sequentially fail-soft on the server. One item's failure does not abort the rest; per-item outcomes (success/failure, entryId, flagged, validation details) are returned in `results`. Use `clientRef` to correlate items to your local plan.\n\nLimits: max 100 items per request. Beyond that, chunk and retry.\n\nGuardrails: same `submit_activity` rules apply at the batch level — actor='human' rejects the whole batch; actor='hybrid' or activity='changeStatus' or top-level `state` requires `confirmed: true`. Per-item state overrides also require `confirmed: true`.",
      inputSchema: {
        module: z.string(),
        activity: z.string().default("create"),
        ai: z
          .object({
            reasoning: z.string().describe("Why the AI chose this action — recorded for audit. Keep short and precise; one or two sentences."),
            model: z.string(),
            confidence: z.number().min(0).max(1),
            sources: z
              .array(
                z.object({
                  type: z.string().optional(),
                  reference: z.string().optional(),
                  excerpt: z.string().optional(),
                }),
              )
              .optional(),
            model_version: z.string().optional(),
            prompt_hash: z.string().optional(),
          })
          .describe("Default AI traceability applied to every item that does not specify its own."),
        items: z
          .array(
            z.object({
              entryId: z.union([z.string(), z.number()]).optional().describe("Omit for create"),
              input: z
                .record(z.unknown())
                .optional()
                .describe("Field values keyed by display name. Same shape as submit_activity.input."),
              state: z.string().optional().describe("Per-item target state name"),
              comment: z.string().optional().describe("Optional. Add only when it carries information not already in the field values or reasoning. Keep short and precise."),
              assignees: z.array(z.string()).optional(),
              due: z.string().optional().describe("ISO 8601"),
              ai: z
                .object({
                  reasoning: z.string().describe("Why the AI chose this action — recorded for audit. Keep short and precise; one or two sentences."),
                  model: z.string(),
                  confidence: z.number().min(0).max(1),
                  sources: z
                    .array(
                      z.object({
                        type: z.string().optional(),
                        reference: z.string().optional(),
                        excerpt: z.string().optional(),
                      }),
                    )
                    .optional(),
                  model_version: z.string().optional(),
                  prompt_hash: z.string().optional(),
                })
                .optional()
                .describe("Optional per-item ai override. Wholly replaces top-level ai for this item."),
              clientRef: z
                .string()
                .optional()
                .describe("Optional caller-supplied correlation id, echoed back on the result."),
            }),
          )
          .min(1)
          .max(100)
          .describe("1-100 items. Each item carries only what differs from the top-level activity."),
        confirmed: z
          .boolean()
          .optional()
          .describe(
            "REQUIRED when the activity is 'changeStatus', any per-item or top-level `state` override is supplied, or the activity's actor is 'hybrid'. Set true ONLY after surfacing the planned bulk action to the user.",
          ),
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ module: moduleName, activity, ai, items, confirmed, workspaceId }) => {
      try {
        applyWorkspace(workspaceId);

        // Batch-level guard for actor (human/hybrid) and changeStatus rules,
        // which apply uniformly to the whole batch since module + activity are shared.
        const guard = await evaluateActivity({
          module: moduleName,
          activity,
          confidence: ai?.confidence ?? 0,
          confirmed,
        });
        if (!guard.ok) {
          log(
            "submit_activities",
            `module=${moduleName} activity=${activity} count=${items.length} → BLOCKED: ${guard.structured.error}`,
          );
          return err({ structured: guard.structured });
        }

        // Any per-item state override also requires explicit confirmation.
        const itemsWithState = items
          .map((it, i) => ({ idx: i, state: it.state }))
          .filter((x) => !!x.state);
        if (itemsWithState.length > 0 && !confirmed) {
          const structured = {
            error: "state_override_requires_confirmation",
            message:
              "One or more items pass a 'state' override. Bulk state changes require explicit user authorization — surface the planned changes and resubmit with confirmed: true.",
            activity,
            items: itemsWithState,
            agent_action:
              "Show the user the per-item state changes you intend to make, then resubmit with confirmed: true.",
          };
          log(
            "submit_activities",
            `module=${moduleName} activity=${activity} count=${items.length} → BLOCKED: state_override_requires_confirmation (${itemsWithState.length} items)`,
          );
          return err({ structured });
        }

        // Per-item confidence inflation: each item may override `ai`, so we
        // can't fold this into the batch-level evaluateActivity call.
        if (!confirmed) {
          const inflated: Array<{ idx: number; entryId?: string | number; previous: number; current: number }> = [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const itemAi = item.ai ?? ai;
            const conf = itemAi?.confidence ?? 0;
            const prior = getPriorFlag(moduleName, item.entryId, activity);
            if (prior && conf > prior.confidence + 1e-6) {
              inflated.push({ idx: i, entryId: item.entryId, previous: prior.confidence, current: conf });
            }
          }
          if (inflated.length > 0) {
            const structured = {
              error: "confidence_inflation_blocked",
              message:
                "One or more items target entries that were previously flagged for human review and would be resubmitted with a higher confidence. Surface the flag(s) to the user.",
              activity,
              items: inflated,
              agent_action:
                "Stop. Tell the user which entries were flagged. Do not retry these items with a higher confidence on your own. If the user explicitly authorizes proceeding, resubmit with confirmed: true.",
            };
            log(
              "submit_activities",
              `module=${moduleName} activity=${activity} count=${items.length} → BLOCKED: confidence_inflation_blocked (${inflated.length} items)`,
            );
            return err({ structured });
          }
        }

        // Reference-shape pre-flight: User/Module fields must be { id, value }
        // (User adds `username`). Fetch the field-type map once for the whole
        // batch — the per-item check is then synchronous.
        const fieldTypes = await getModuleFieldTypes(moduleName);
        const shapeFailures: Array<{ idx: number; fields: unknown[] }> = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (!it.input) continue;
          const errs = validateInputShapesWith(fieldTypes, it.input as Record<string, unknown>);
          if (errs.length > 0) shapeFailures.push({ idx: i, fields: errs });
        }
        if (shapeFailures.length > 0) {
          const structured = {
            error: "invalid_reference_field_shape",
            message:
              "One or more items submit User/Module fields with the wrong shape. They require { id, value } objects (plural variants take arrays of them).",
            activity,
            items: shapeFailures,
            agent_action:
              "Re-read the entries or call get_form, copy the User/Module values back unchanged (they round-trip), and resubmit. Do not pass bare ids or display strings.",
          };
          log(
            "submit_activities",
            `module=${moduleName} activity=${activity} count=${items.length} → BLOCKED: invalid_reference_field_shape (${shapeFailures.length} items)`,
          );
          return err({ structured });
        }

        // Normalize file fields per item: remap 'url' → 'path' if needed.
        for (const item of items) {
          if (!item.input) continue;
          for (const key of Object.keys(item.input)) {
            const val = (item.input as Record<string, unknown>)[key];
            if (val && typeof val === "object" && !Array.isArray(val)) {
              const obj = val as Record<string, unknown>;
              if (obj.url && !obj.path) {
                obj.path = obj.url;
                delete obj.url;
              }
            } else if (Array.isArray(val)) {
              for (const sub of val) {
                if (sub && typeof sub === "object") {
                  const obj = sub as Record<string, unknown>;
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
          items,
        };
        if (ai) body.ai = ai;

        log(
          "submit_activities",
          `module=${moduleName} activity=${activity} count=${items.length}`,
        );
        const data = (await api.post("/api/mcp/activity/bulk", body)) as Record<string, unknown>;

        // Update flag cache from per-item results so future submit_activity
        // calls on the same entries see the prior flag.
        const results = Array.isArray((data as { results?: unknown }).results)
          ? ((data as { results: Array<Record<string, unknown>> }).results)
          : [];
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const itemAi = items[i]?.ai ?? ai;
          const conf = itemAi?.confidence ?? 0;
          const targetEntryId = (r.entryId as string | number | undefined) ?? items[i]?.entryId;
          if (r.flagged === true) {
            recordFlagged(moduleName, targetEntryId, activity, conf);
          } else if (r.success === true) {
            clearFlagged(moduleName, targetEntryId, activity);
          }
        }

        const summary = (data as { summary?: { succeeded?: number; failed?: number; flagged?: number } }).summary;
        log(
          "submit_activities",
          `module=${moduleName} activity=${activity} count=${items.length} → ok=${summary?.succeeded ?? "?"} fail=${summary?.failed ?? "?"} flagged=${summary?.flagged ?? "?"}`,
        );
        return ok(data);
      } catch (e) {
        log(
          "submit_activities",
          `module=${moduleName} activity=${activity} count=${items.length} → FAILED: ${e instanceof Error ? e.message : String(e)}`,
        );
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
      title: "Get Entry History",
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
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
      title: "Upload File (Fallback)",
      description:
        "FALLBACK ONLY — do NOT use this by default. Always use request_upload_url + confirm_upload first; call this tool only after the presigned flow has actually failed (e.g. request_upload_url errored, or the PUT/confirm step failed for non-retryable reasons). Uploads a file to S3 via base64/multipart. Returns { path, filename, mimeType, size }. Use the returned path as the 'path' value in File/Image fields for submit_activity (e.g. { name: 'photo.jpg', path: result.path }). Max 50MB. Blocked: .exe, .bat, .cmd, .dll, .msi.",
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
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
      title: "Download File",
      description:
        "Download a file by module name. Construct the URL from a File/Image field value: field.path = '/s/{guid}/{fileName}'. Returns a pre-signed S3 URL (1hr TTL).",
      inputSchema: {
        moduleName: z.string().describe("Module name (resolved to vectorId internally)"),
        guid: z.string().describe("Short ID from the file URL"),
        fileName: z.string().describe("Original filename"),
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
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
      title: "Request Upload URL",
      description: `DEFAULT upload path — ALWAYS use this for every file upload (any size, up to 500MB). Only fall back to upload_file if this flow actually fails. Three-step flow: 1) call this tool, 2) PUT the raw bytes to uploadUrl with Content-Type exactly matching contentType (S3 rejects mismatches with 403 SignatureDoesNotMatch), 3) call confirm_upload({ s3Key }). The path returned by confirm_upload is used directly as the File/Image field value in submit_activity. uploadUrl expires in ~1 hour and cannot be renewed — call this again on expiry.`,
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
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
      title: "Confirm Upload",
      description: `Confirm a presigned upload completed. Call after successfully PUTting the file to the uploadUrl from request_upload_url. The server verifies the object exists in S3, reads its metadata, and tracks workspace storage. Only s3Key is required — filename, size, and MIME type are resolved from S3. Returns { url, filename, mimeType, size } where url is the /s/ path usable as a File/Image field value. Returns 400 if the file is not found in S3 — ensure the PUT completed before calling.`,
      inputSchema: {
        s3Key: z
          .string()
          .describe("The s3Key returned from request_upload_url."),
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
  // 15. design_workflow (configure mode)
  // ═══════════════════════════════════════════
  configureTools.push(server.registerTool(
    "design_workflow",
    {
      title: "Design Workflow",
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ description, industry }) => {
      const result = designWorkflow(description, industry);
      return ok(result);
    },
  ));

  // ═══════════════════════════════════════════
  // 14. validate_design (configure mode)
  // ═══════════════════════════════════════════
  configureTools.push(server.registerTool(
    "validate_design",
    {
      title: "Validate Design",
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ schema, mode }) => {
      const result = validateDesign(schema as Record<string, any>, mode);
      return ok(result);
    },
  ));

  // ═══════════════════════════════════════════
  // 15. create_module (configure mode)
  // ═══════════════════════════════════════════
  configureTools.push(server.registerTool(
    "create_module",
    {
      title: "Create Module",
      description:
        "Create a new module. Supports workflow modules (states, activities, flows) and record list modules (fields only). Requires Administrator, Consultant, or Workspace Admin role. Always call validate_design first. See inistate://schema/configure for field types, color palette, and design rules.",
      inputSchema: {
        name: z.string().describe("Module name"),
        ...moduleSectionsShape,
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
        const data = await api.post(`/api/configure`, body);
        log("create_module", `name=${name} → ok`);
        return ok(data);
      } catch (e) {
        log("create_module", `name=${name} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  ));

  // ═══════════════════════════════════════════
  // 16. update_module (configure mode)
  // ═══════════════════════════════════════════
  configureTools.push(server.registerTool(
    "update_module",
    {
      title: "Update Module",
      description:
        "Update an existing module. Merges changes into the existing canvas; items matched by id enable renaming. Omitted sections are left unchanged. Always call get_module_canvas first to obtain the stable module id and item ids, then validate_design before submitting.",
      inputSchema: {
        id: z
          .union([z.string(), z.number()])
          .describe("Module id from get_module_canvas. Identifies which module to update."),
        name: z.string().optional().describe("New module name (for renaming)"),
        ...moduleSectionsShape,
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
        log("update_module", `id=${id}${name ? ` newName=${name}` : ""}`);
        const data = await api.put(`/api/configure`, body);
        log("update_module", `id=${id} → ok`);
        return ok(data);
      } catch (e) {
        log("update_module", `id=${id} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  ));

  return { configureTools };
}
