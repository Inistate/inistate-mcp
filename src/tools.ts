import { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendFile } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Backend } from "./backend.js";
import { capabilityMessage } from "./capability.js";
import {
  clearFlagged,
  evaluateActivity,
  FLAGGED_ANNOTATION,
  getModuleFieldTypes,
  getModuleStates,
  getPriorFlag,
  primeSchemaCache,
  recordFlagged,
  seedSchemaCache,
  validateInputShapes,
  validateInputShapesWith,
  type CanvasFetcher,
  type SchemaFetcher,
} from "./activity-guard.js";
import {
  designWorkflow,
  normalizeFieldType,
  normalizeStateColor,
  validateDesign,
} from "./schema.js";

// ---------- Logging ----------
//
// Opt-in file log of write-path tool calls. Set INISTATE_DEBUG_FILE=1 to log
// to ./debug.log, or to a path to log there. Off by default: the writes are
// fire-and-forget (never block the event loop) and log identifiers/outcomes
// only — never field values.

const DEBUG_FILE = process.env.INISTATE_DEBUG_FILE;
const LOG_PATH = DEBUG_FILE && DEBUG_FILE !== "1"
  ? resolve(DEBUG_FILE)
  : resolve(process.cwd(), "debug.log");

function log(tool: string, detail: string) {
  if (!DEBUG_FILE) return;
  const line = `[${new Date().toISOString()}] ${tool}: ${detail}\n`;
  appendFile(LOG_PATH, line, () => { /* ignore */ });
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

// Serialized into every tool that takes workspaceId — keep it one short line.
const wsParam = z
  .string()
  .optional()
  .describe("Workspace ID. Omit if set via env or set_workspace; required in stateless/remote mode.");

/**
 * Tool description for capability-gated tools. When the backend reports the
 * capability unavailable at registration time, the tool stays listed (per the
 * capability-message contract — never silently absent) but with a one-line
 * stub instead of the full operating manual, cutting its standing token cost
 * to a fraction. The handler still returns the structured capability message.
 */
const gatedDesc = (available: boolean, full: string, hint = ""): string =>
  available
    ? full
    : `Not available on this backend — calls return a structured capability_unavailable message.${hint ? ` ${hint}` : ""}`;

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
  connection: z.string().optional().describe("Module to link to (e.g. \"Members\"). Required for User/Users/Module/Modules types."),
  options: z.array(z.string()).optional(),
  fields: z.array(subFieldShape).optional().describe("Sub-fields for Table type"),
  ai_hint: z.string().optional(),
});

const stateShape = z.object({
  id: z.string().optional(),
  name: z.string(),
  color: z.string().optional().describe("Palette: #5A6070 #2968A8 #2A7B50 #A07828 #C0392B #6B4D91 #1E6B45 #8B2D2D. Names ('red', 'amber') and other hex are normalized to the nearest."),
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

/**
 * Apply the same type/color normalization validate_design reports, so the
 * platform always receives canonical vocabulary regardless of what the agent
 * sent ("Select" → "Selection", "gray" → "#5A6070", …).
 */
function normalizeModuleSections(body: Record<string, unknown>): void {
  if (Array.isArray(body.information)) {
    body.information = (body.information as Array<Record<string, unknown>>).map((f) => ({
      ...f,
      type: normalizeFieldType(f.type as string | undefined).type,
      ...(Array.isArray(f.fields)
        ? {
            fields: (f.fields as Array<Record<string, unknown>>).map((sf) => ({
              ...sf,
              type: normalizeFieldType(sf.type as string | undefined).type,
            })),
          }
        : {}),
    }));
  }
  if (Array.isArray(body.states)) {
    body.states = (body.states as Array<Record<string, unknown>>).map((s) => ({
      ...s,
      color: normalizeStateColor(s.color as string | undefined, (s.name as string) || "").color,
    }));
  }
}

// ---------- Tool registration ----------

export function registerTools(server: McpServer, backend: Backend): { configureTools: RegisteredTool[] } {
  const configureTools: RegisteredTool[] = [];
  // Capability gating (MCP spec §1.6). Read once. Platform-only tools below
  // return a capability message when the active backend cannot serve them.
  // CloudBackend reports every capability true, so the gates are never hit and
  // behavior is identical to before — this is the contract a reduced backend needs.
  const caps = backend.capabilities();

  // Route the guard's schema lookups through the active backend rather than
  // api.ts directly, so shape validation (and, under governance, the actor
  // checks) run against whatever backend is injected — cloud or local.
  const fetchSchema: SchemaFetcher = async (moduleName) => {
    try {
      return (await backend.getModuleSchema(moduleName, "extended")) as Awaited<
        ReturnType<SchemaFetcher>
      >;
    } catch {
      return null;
    }
  };

  // Same routing for the guard's actor-data fallback (the extended tier may
  // list activities as bare names; the canvas carries the actor field).
  const fetchCanvas: CanvasFetcher = async (moduleName) => {
    try {
      return (await backend.getModuleCanvas(moduleName)) as Awaited<
        ReturnType<CanvasFetcher>
      >;
    } catch {
      return null;
    }
  };

  /** Apply workspaceId if provided (stateless mode), else rely on env/prior set_workspace. */
  const applyWorkspace = (workspaceId?: string): void => {
    if (workspaceId) backend.setActiveWorkspace(workspaceId);
  };

  // ── Governance-conditional schema pieces ──
  // On a governed backend (the hosted Platform) these resolve to EXACTLY the
  // prior shapes/text, so the cloud tool schema is byte-identical. On a local
  // runtime — no confidence/actor gating — `ai` becomes optional, the wording
  // adjusts, and the reliability controls (idempotencyKey / expectedVersion)
  // are exposed.
  const gov = caps.governance;

  const aiSourcesShape = z
    .array(z.object({ type: z.string().optional(), reference: z.string().optional(), excerpt: z.string().optional() }))
    .optional();

  const submitAiShape = z.object({
    reasoning: z.string().describe("Why the AI chose this action — recorded for audit. Keep short and precise; one or two sentences."),
    model: z.string().describe("e.g. claude-haiku-4-5, claude-opus-4-7"),
    confidence: z.number().min(0).max(1).describe("0-1; gated against the activity's confidence_threshold"),
    sources: aiSourcesShape,
    model_version: z.string().optional(),
    prompt_hash: z.string().optional(),
  });
  const submitAiParam = gov
    ? submitAiShape.describe("REQUIRED — AI agent traceability")
    : submitAiShape.optional().describe("Optional on the local runtime — no confidence/actor gating is applied.");

  // Field semantics are documented once, on submit_activity's ai param — the
  // bulk variants only restate the shape.
  const bulkAiShape = z.object({
    reasoning: z.string(),
    model: z.string(),
    confidence: z.number().min(0).max(1),
    sources: aiSourcesShape,
    model_version: z.string().optional(),
    prompt_hash: z.string().optional(),
  });
  const bulkAiParam = gov
    ? bulkAiShape.describe("Default AI traceability applied to every item that does not specify its own. Same field semantics as submit_activity.ai.")
    : bulkAiShape.optional().describe("Default AI traceability for items without their own. Optional on the local runtime.");

  // Reliability controls — local-runtime only (the Platform governs via history).
  const reliabilityParams: z.ZodRawShape = gov
    ? {}
    : {
        idempotencyKey: z
          .string()
          .optional()
          .describe("Replaying a submission with the same key applies the change at most once."),
        expectedVersion: z
          .number()
          .int()
          .optional()
          .describe("Optimistic concurrency: the `version` from get_entry. The write fails with CONFLICT if the stored version differs."),
      };

  const submitActivityDescription = gov
    ? "Perform an activity on a module entry: standard (create [no entryId], edit, delete, changeStatus, comment, duplicate, manage) or any custom activity from get_module_schema. ALWAYS call get_form first. The `ai` object is REQUIRED (reasoning + model + confidence). If confidence < the activity's threshold, the transition is suppressed and the entry is flagged. Server-side guard rules (human/hybrid actor, state-change confirm, confidence-inflation) may block — see inistate://guardrails. Input shapes: ActivitySubmission in inistate://schema/runtime."
    : "Perform an activity on a module entry: create (no entryId), edit, delete, or a custom activity that drives a state transition. ALWAYS call get_form first. A custom activity is accepted only if a flow permits it from the entry's current state — otherwise it is rejected (Illegal transition) and nothing is written. The local runtime applies no confidence/actor gating: `ai` is optional and there is no flagged outcome. Use idempotencyKey for safe retries and expectedVersion for optimistic concurrency.";

  const submitActivitiesDescription = gov
    ? "Bulk variant of submit_activity: one module + one activity applied to many entries, each item with its own input. Use instead of N sequential submit_activity calls when creating/editing many rows — one tool turn instead of N. A per-item `ai` wholly replaces the top-level default (no partial merge). Items run sequentially fail-soft on the server: one failure does not abort the rest; per-item outcomes (success, entryId, flagged, validation details) return in `results` — use `clientRef` to correlate. Max 100 items; chunk beyond that. Guardrails match submit_activity at batch level: actor='human' rejects the whole batch; actor='hybrid', activity='changeStatus', or any state override (top-level or per-item) requires `confirmed: true`."
    : "Bulk variant of submit_activity: one module + one activity applied to many entries, each item with its own input. Use instead of N sequential submit_activity calls when creating/editing many rows. A per-item `ai` wholly replaces the top-level default. Items run sequentially fail-soft: one failure does not abort the rest; per-item outcomes return in `results` — use `clientRef` to correlate. Max 100 items per request. The local runtime applies no confidence/actor gating.";
  // ═══════════════════════════════════════════
  // 1. list_workspaces
  // ═══════════════════════════════════════════
  server.registerTool(
    "list_workspaces",
    {
      title: "List Workspaces",
      description: gatedDesc(
        caps.workspaces,
        "List workspaces the current user has access to. Call set_workspace to select one before any module or entry tools. This is typically the first tool to call in any session.",
      ),
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Optional name filter (case-insensitive)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ search }) => {
      if (!caps.workspaces) return ok(capabilityMessage("workspaces", backend.kind));
      try {
        const data = await backend.listWorkspaces(search);
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
      description: gatedDesc(
        caps.workspaces,
        `Set the active workspace for the current session. In stateless/remote mode, prefer passing workspaceId directly to each tool instead.

Workflow sequences after workspace is set:
- Design: design_workflow → validate_design → create_module
- Execute: list_modules → list_entries → get_form → submit_activity
- Modify: list_modules → get_module_canvas → validate_design → update_module
- Query: list_modules → list_entries → get_entry / get_entry_history`,
      ),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace ID from list_workspaces"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ workspaceId }) => {
      if (!caps.workspaces) return ok(capabilityMessage("workspaces", backend.kind));
      try {
        backend.setActiveWorkspace(workspaceId);
        const data = await backend.getWorkspace(workspaceId);
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
        const data = await backend.listModules();
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 4. get_module_schema (always available — read-only;
  //    runtime agents need it to plan submissions)
  // ═══════════════════════════════════════════
  server.registerTool(
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
        const data = await backend.getModuleSchema(moduleName, tier);
        // The guard needs exactly this document — don't make it re-fetch.
        if (tier === "extended") seedSchemaCache(moduleName, data);
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // ═══════════════════════════════════════════
  // 5. get_module_canvas (configure mode — admin view for modifying modules)
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
        const data = await backend.getModuleCanvas(moduleName);
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
        const data = await backend.listEntries({
          module: moduleName,
          state,
          search,
          filters,
          sortBy,
          sortDirection,
          currentPage,
          pageSize,
          fields,
        });
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
        const data = await backend.getEntry({ module: moduleName, entryId });
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
        // Warm the guard's schema cache while the agent reads the form, so the
        // submit_activity that typically follows skips its pre-write schema fetch.
        primeSchemaCache(moduleName, fetchSchema);
        const data = await backend.getForm({ module: moduleName, activity, entryId });
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
      description: submitActivityDescription,
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
        ai: submitAiParam,
        confirmed: z
          .boolean()
          .optional()
          .describe(
            "Set true only after explicit user authorization. Required for: changeStatus, state override, hybrid actor, retry after flag. Does not unlock human-actor activities. See inistate://guardrails.",
          ),
        ...reliabilityParams,
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
      ...extra
    }) => {
      // Local-runtime-only reliability controls (absent from the cloud schema).
      const idempotencyKey = (extra as Record<string, unknown>).idempotencyKey as string | undefined;
      const expectedVersion = (extra as Record<string, unknown>).expectedVersion as number | undefined;
      try {
        applyWorkspace(workspaceId);
        // Actor/confidence/flag governance runs only on backends that declare it
        // (the hosted Platform). A local runtime does no such gating — it either
        // commits a legal transition or rejects it.
        if (caps.governance) {
          if (!ai) {
            return err({
              structured: {
                error: "ai_required",
                message:
                  "This backend enforces AI traceability. Supply an `ai` block with reasoning, model, and confidence.",
                activity,
                agent_action:
                  "Add ai: { reasoning, model, confidence } and resubmit.",
              },
            });
          }
          const guard = await evaluateActivity(
            {
              module: moduleName,
              activity,
              entryId,
              entryIds,
              state,
              confidence: ai?.confidence ?? 0,
              confirmed,
            },
            fetchSchema,
            fetchCanvas,
          );
          if (!guard.ok) {
            const target = entryId ?? (entryIds ? `bulk(${entryIds.length})` : "new");
            log(
              "submit_activity",
              `module=${moduleName} activity=${activity} entry=${target} → BLOCKED: ${guard.structured.error}`,
            );
            return err({ structured: guard.structured });
          }
        }
        // Reference-shape pre-flight: User/Module fields must be { id, value }.
        if (input) {
          const shapeErrors = await validateInputShapes(moduleName, input, fetchSchema);
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
        if (idempotencyKey) body.idempotencyKey = idempotencyKey;
        if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;
        const target = entryId ?? (entryIds ? `bulk(${entryIds.length})` : "new");
        // Log identifiers only — field values stay out of the log file.
        log("submit_activity", `module=${moduleName} activity=${activity} entry=${target} inputKeys=${input ? Object.keys(input).join("|") : "-"}${state ? ` state=${state}` : ""}`);
        const data = await backend.submitActivity(body);
        const flagged =
          data && typeof data === "object" && (data as Record<string, unknown>).flagged === true;
        const flagTargets: Array<string | number | undefined> =
          entryIds && entryIds.length > 0 ? entryIds : [entryId];
        if (caps.governance) {
          for (const t of flagTargets) {
            if (flagged) {
              recordFlagged(moduleName, t, activity, ai?.confidence ?? 0);
            } else {
              clearFlagged(moduleName, t, activity);
            }
          }
        }
        if (flagged) {
          // The platform returns the bare flag — explain it so agents stop retrying.
          Object.assign(data as Record<string, unknown>, FLAGGED_ANNOTATION);
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
      description: submitActivitiesDescription,
      inputSchema: {
        module: z.string(),
        activity: z.string().default("create"),
        ai: bulkAiParam,
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
              ai: bulkAiShape
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

        // Actor/confidence/flag governance — only on backends that declare it
        // (the hosted Platform). A local runtime skips the whole guard.
        if (caps.governance) {
        // Batch-level guard for actor (human/hybrid) and changeStatus rules,
        // which apply uniformly to the whole batch since module + activity are shared.
        const guard = await evaluateActivity({
          module: moduleName,
          activity,
          confidence: ai?.confidence ?? 0,
          confirmed,
        }, fetchSchema, fetchCanvas);
        if (!guard.ok) {
          log(
            "submit_activities",
            `module=${moduleName} activity=${activity} count=${items.length} → BLOCKED: ${guard.structured.error}`,
          );
          return err({ structured: guard.structured });
        }

        // Any per-item state override must name a real state…
        const itemsWithState = items
          .map((it, i) => ({ idx: i, state: it.state }))
          .filter((x) => !!x.state);
        if (itemsWithState.length > 0) {
          const knownStates = await getModuleStates(moduleName, fetchSchema);
          if (knownStates) {
            const unknown = itemsWithState.filter((x) => !knownStates.includes(x.state as string));
            if (unknown.length > 0) {
              const structured = {
                error: "unknown_state",
                message: `One or more items target states that do not exist on module '${moduleName}'. Available states: ${knownStates.join(", ")}.`,
                activity,
                items: unknown,
                agent_action:
                  "Use one of the listed states, or omit 'state' to follow the activity's normal flow.",
              };
              log(
                "submit_activities",
                `module=${moduleName} activity=${activity} count=${items.length} → BLOCKED: unknown_state (${unknown.length} items)`,
              );
              return err({ structured });
            }
          }
        }
        // …and requires explicit confirmation.
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
        } // end governance gate

        // Reference-shape pre-flight: User/Module fields must be { id, value }
        // (User adds `username`). Fetch the field-type map once for the whole
        // batch — the per-item check is then synchronous.
        const fieldTypes = await getModuleFieldTypes(moduleName, fetchSchema);
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
        const data = (await backend.submitActivities(body)) as Record<string, unknown>;
        const results = Array.isArray((data as { results?: unknown }).results)
          ? ((data as { results: Array<Record<string, unknown>> }).results)
          : [];

        // Update flag cache from per-item results so future submit_activity
        // calls on the same entries see the prior flag. Governance-only.
        if (caps.governance) {
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
        }

        const summary = (data as { summary?: { succeeded?: number; failed?: number; flagged?: number } }).summary;
        if ((summary?.flagged ?? 0) > 0 || results.some((r) => r.flagged === true)) {
          // The platform returns bare per-item flags — explain them so agents stop retrying.
          Object.assign(data, FLAGGED_ANNOTATION);
        }
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
      description: gatedDesc(
        caps.governedHistory,
        "Get the audit trail and comments for an entry. Returns chronological list of actions (create, edit, state changes, comments) with field-level change details and AI traceability context.",
      ),
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
      if (!caps.governedHistory) return ok(capabilityMessage("governed_history", backend.kind));
      try {
        applyWorkspace(workspaceId);
        const data = await backend.getEntryHistory({ module: moduleName, entryId, page });
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
      description: gatedDesc(
        caps.files,
        "FALLBACK ONLY — use request_upload_url + confirm_upload first; call this only after that presigned flow has actually failed. Uploads via base64. Returns { path, filename, mimeType, size } — use path as the File/Image field value in submit_activity. Max 50MB. Blocked: .exe, .bat, .cmd, .dll, .msi.",
      ),
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
      if (!caps.files) return ok(capabilityMessage("files", backend.kind));
      try {
        applyWorkspace(workspaceId);
        log("upload_file", `module=${moduleName} file=${fileName} mime=${mimeType}`);
        const raw = (await backend.uploadFile({
          module: moduleName,
          name: fileName,
          fileBase64: fileContent,
          mimeType,
        })) as Record<string, unknown>;
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
      description: gatedDesc(
        caps.files,
        "Download a file by module name. Construct the URL from a File/Image field value: field.path = '/s/{guid}/{fileName}'. Returns a pre-signed S3 URL (1hr TTL).",
      ),
      inputSchema: {
        moduleName: z.string().describe("Module name (resolved to vectorId internally)"),
        guid: z.string().describe("Short ID from the file URL"),
        fileName: z.string().describe("Original filename"),
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ moduleName, guid, fileName, workspaceId }) => {
      if (!caps.files) return ok(capabilityMessage("files", backend.kind));
      try {
        applyWorkspace(workspaceId);
        const result = await backend.downloadFile({ moduleName, guid, fileName });
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
      description: gatedDesc(
        caps.files,
        "DEFAULT upload path for every file (up to 500MB); upload_file is only the fallback if this flow fails. Flow: 1) call this tool, 2) PUT the raw bytes to uploadUrl with Content-Type exactly matching contentType (S3 rejects mismatches with 403), 3) call confirm_upload({ s3Key }) — its returned path is the File/Image field value for submit_activity. uploadUrl expires in ~1 hour; call again on expiry.",
      ),
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
      if (!caps.files) return ok(capabilityMessage("files", backend.kind));
      try {
        applyWorkspace(workspaceId);
        log("request_upload_url", `module=${moduleName} file=${fileName} size=${fileSize} mime=${contentType}`);
        const data = await backend.requestUploadUrl({
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
      description: gatedDesc(
        caps.files,
        "Confirm a presigned upload after the PUT to uploadUrl succeeded. The server verifies the object in S3 and returns { url, filename, mimeType, size } — url is the /s/ path usable as a File/Image field value. Returns 400 if the file is not in S3 (ensure the PUT completed first).",
      ),
      inputSchema: {
        s3Key: z
          .string()
          .describe("The s3Key returned from request_upload_url."),
        workspaceId: wsParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ s3Key, workspaceId }) => {
      if (!caps.files) return ok(capabilityMessage("files", backend.kind));
      try {
        applyWorkspace(workspaceId);
        log("confirm_upload", `s3Key=${s3Key}`);
        const data = await backend.confirmUpload({ s3Key });
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
          .string()
          .optional()
          .describe(
            "Industry context, free text — mapped to financial_services, healthcare, legal, hr, procurement, it_service, or general (default). Affects audit fields, confidence thresholds, actor suggestions.",
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
        normalizeModuleSections(body);
        log("create_module", `name=${name}`);
        const data = await backend.createModule(body);
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
        normalizeModuleSections(body);
        log("update_module", `id=${id}${name ? ` newName=${name}` : ""}`);
        const data = await backend.updateModule(body);
        log("update_module", `id=${id} → ok`);
        return ok(data);
      } catch (e) {
        log("update_module", `id=${id} → FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  ));

  // ═══════════════════════════════════════════
  // 17. scaffold_module (configure mode) — local-runtime introspection
  // ═══════════════════════════════════════════
  // The inverse on-ramp: the user already has data in a Notion database, an
  // Airtable table, or a local SQLite table. Capability-gated — only a backend
  // that declares `scaffold` (the local runtime) serves it; the hosted Platform
  // returns a capability message. The introspection itself lives behind the
  // Backend so the closed-source engine owns it.
  // Param descriptions follow the same gating as the tool description: a
  // backend that cannot serve the tool registers the same shape (so the
  // structural contract is stable) without the operating manual attached.
  const scaffoldInput = caps.scaffold
    ? {
        source: z
          .string()
          .describe(
            "The data source: `notion://<databaseId>`, `airtable://<baseId>/<tableIdOrName>`, or a local SQLite path (e.g. `./core.db` or `sqlite://./core.db?table=tasks`).",
          ),
        table: z
          .string()
          .optional()
          .describe("Which table to model. Omit on a SQLite source to DISCOVER the available tables first; provide it to draft the schema. Optional for Airtable if already in the URI."),
        name: z.string().optional().describe("Override the generated module name (defaults to the source table name)."),
        state: z
          .string()
          .optional()
          .describe("Promote a specific column to the workflow's state column (overrides auto-detection of a status/state/stage/phase column)."),
      }
    : {
        source: z.string(),
        table: z.string().optional(),
        name: z.string().optional(),
        state: z.string().optional(),
      };

  configureTools.push(server.registerTool(
    "scaffold_module",
    {
      title: "Scaffold Module from Existing Data",
      description: gatedDesc(
        caps.scaffold,
        "Design a module schema together with the user from data they ALREADY have — a Notion database, an Airtable table, or a local SQLite table. This is the inverse on-ramp: instead of designing from scratch, read the existing shape and refine it with the user. One container (a SQLite database, an Airtable base, a Notion workspace) can yield several modules — discover the tables, then model the chosen ones.\n\nFlow (use it conversationally):\n1. DISCOVER — call with just `source` pointed at the container: a SQLite database path, an `airtable://<baseId>` (no table), or a bare `notion://`. Returns { discovery: true, tables: [{ name, id?, columns, rows?, hasState, scaffold_source }] }. Show these to the user and ask which one(s) to model; each becomes its own module.\n2. DRAFT — call again with a chosen table's `scaffold_source` as `source` (or a SQLite `table`). Returns { schema, validation, suggestions } — columns become typed fields, a detected status/state/stage/phase column becomes states.\n3. REFINE together — confirm the inferred field types with the user, then define activities + flows (the governed transitions; design_workflow can scaffold a pattern).\n4. CREATE — validate_design → create_module, then point the runtime at the same data.\n\nTargets: notion://<databaseId> or bare notion:// (needs INISTATE_NOTION_TOKEN), airtable://<baseId>/<tableIdOrName> or airtable://<baseId> (needs INISTATE_AIRTABLE_TOKEN; listing a base's tables needs schema.bases:read), or a local SQLite path. Credentials are read from the environment — never pass tokens as arguments.",
        "Local-runtime only; use design_workflow to draft a module here.",
      ),
      inputSchema: scaffoldInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    async ({ source, table, name, state }) => {
      if (!caps.scaffold) return ok(capabilityMessage("scaffold", backend.kind));
      try {
        const data = await backend.scaffoldModule({ source, table, name, state });
        return ok(data);
      } catch (e) {
        return err(e);
      }
    },
  ));

  return { configureTools };
}
