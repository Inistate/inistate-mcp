import * as api from "./api.js";
import { requestContext } from "./context.js";

/**
 * Pre-submission gate for `submit_activity`. Enforces four rules the platform
 * does not enforce server-side:
 *
 *  1. Confidence inflation: once an activity has been flagged for human review
 *     (`flagged: true`), refuse subsequent submissions on the same target with
 *     a higher confidence unless the caller passes `confirmed: true`.
 *  2. Explicit state changes (`changeStatus` activity, or an overriding `state`
 *     parameter) require `confirmed: true`.
 *  3. Activities whose `actor` is `human` are never executable by an AI agent.
 *  4. Activities whose `actor` is `hybrid` require `confirmed: true`.
 */

interface ActivityDef {
  name: string;
  actor?: string;
}

interface FieldInfo {
  name: string;
  type: string;
}

// The extended schema tier returns activities as plain strings (names only) —
// the canvas is the source of actor data. Tolerate both shapes.
interface ExtendedSchema {
  activities?: Array<ActivityDef | string>;
  information?: FieldInfo[];
  states?: Array<string | { name?: string }>;
  flows?: Record<string, { activities?: Record<string, string> }>;
}

interface CanvasSchema {
  activities?: ActivityDef[];
}

const REF_FIELD_TYPES = new Set(["User", "Users", "Module", "Modules"]);

// Standard activities are inherent platform operations and have no actor in the
// module schema. They bypass the actor check (but state-change checks still run).
// The platform uses both names for the direct state change — availableActivities
// lists "changeState" while forms and history say "changeStatus".
const STANDARD_ACTIVITIES = new Set([
  "create",
  "edit",
  "delete",
  "comment",
  "duplicate",
  "manage",
  "view",
  "changeStatus",
  "changeState",
]);

interface SchemaCacheEntry {
  schema: ExtendedSchema;
  at: number;
}
const SCHEMA_TTL_MS = 5 * 60 * 1000;
const schemaCache = new Map<string, SchemaCacheEntry>();

function cacheKey(prefix: string, parts: Array<string | number | undefined>): string {
  const ctx = requestContext.getStore();
  const wsid = ctx?.workspaceId || api.getWorkspaceId() || "_";
  const user = ctx?.userId || "_";
  return [prefix, user, wsid, ...parts.map((p) => String(p ?? "_"))].join("::");
}

/**
 * Source of a module's extended schema. Defaults to the cloud API; the MCP tool
 * handlers pass a backend-routed fetcher so the same guard runs against whatever
 * backend is injected (cloud or local) instead of always hitting api.ts.
 */
export type SchemaFetcher = (moduleName: string) => Promise<ExtendedSchema | null>;

const defaultSchemaFetcher: SchemaFetcher = async (moduleName) => {
  try {
    return (await api.get(`/api/mcp/${api.enc(moduleName)}?tier=extended`)) as ExtendedSchema;
  } catch {
    return null;
  }
};

async function getExtendedSchema(
  moduleName: string,
  fetchSchema: SchemaFetcher = defaultSchemaFetcher,
): Promise<ExtendedSchema | null> {
  const key = cacheKey("schema", [moduleName]);
  const now = Date.now();
  const cached = schemaCache.get(key);
  if (cached && now - cached.at < SCHEMA_TTL_MS) return cached.schema;
  const schema = await fetchSchema(moduleName);
  if (schema) schemaCache.set(key, { schema, at: now });
  return schema;
}

/**
 * Warm the schema cache in the background (fire-and-forget). Called from
 * get_form so the guard/shape lookups on the submit_activity that typically
 * follows hit cache instead of paying an extra round trip ahead of the write.
 */
export function primeSchemaCache(
  moduleName: string,
  fetchSchema: SchemaFetcher = defaultSchemaFetcher,
): void {
  void getExtendedSchema(moduleName, fetchSchema).catch(() => {});
}

/**
 * Seed the schema cache with an extended schema the caller already fetched
 * (e.g. the get_module_schema tool's own tier=extended response), so the
 * guard does not re-fetch what just passed through this process.
 */
export function seedSchemaCache(moduleName: string, schema: unknown): void {
  if (!schema || typeof schema !== "object") return;
  schemaCache.set(cacheKey("schema", [moduleName]), {
    schema: schema as ExtendedSchema,
    at: Date.now(),
  });
}

interface CanvasCacheEntry {
  canvas: CanvasSchema | null;
  at: number;
}
const canvasCache = new Map<string, CanvasCacheEntry>();

/**
 * Source of a module's canvas (actor data). Like SchemaFetcher, the tool
 * handlers pass a backend-routed fetcher so the actor fallback works against
 * whatever backend is injected; the default hits the cloud API.
 */
export type CanvasFetcher = (moduleName: string) => Promise<CanvasSchema | null>;

const defaultCanvasFetcher: CanvasFetcher = async (moduleName) => {
  try {
    return (await api.get(`/api/configure/${api.enc(moduleName)}`)) as CanvasSchema;
  } catch {
    return null;
  }
};

async function getCanvasSchema(
  moduleName: string,
  fetchCanvas: CanvasFetcher = defaultCanvasFetcher,
): Promise<CanvasSchema | null> {
  const key = cacheKey("canvas", [moduleName]);
  const now = Date.now();
  const cached = canvasCache.get(key);
  if (cached && now - cached.at < SCHEMA_TTL_MS) return cached.canvas;
  // Cache the miss too — a caller without configure access would otherwise
  // pay a failing round trip on every submit.
  const canvas = await fetchCanvas(moduleName);
  canvasCache.set(key, { canvas, at: now });
  return canvas;
}

async function getActivityDef(
  moduleName: string,
  activity: string,
  fetchSchema: SchemaFetcher = defaultSchemaFetcher,
  fetchCanvas: CanvasFetcher = defaultCanvasFetcher,
): Promise<ActivityDef | null> {
  const schema = await getExtendedSchema(moduleName, fetchSchema);
  for (const a of schema?.activities ?? []) {
    if (a && typeof a === "object" && a.name === activity) {
      if (a.actor) return a;
      break; // listed without actor info — consult the canvas
    }
  }
  const canvas = await getCanvasSchema(moduleName, fetchCanvas);
  return canvas?.activities?.find(
    (a) => a && typeof a === "object" && a.name === activity,
  ) ?? null;
}

interface FlaggedRecord {
  confidence: number;
  at: number;
}
const FLAG_TTL_MS = 60 * 60 * 1000;
const flaggedCache = new Map<string, FlaggedRecord>();

function flagKey(moduleName: string, entryId: unknown, activity: string): string {
  return cacheKey("flag", [moduleName, entryId === undefined ? "_new" : String(entryId), activity]);
}

export function recordFlagged(
  moduleName: string,
  entryId: unknown,
  activity: string,
  confidence: number,
): void {
  flaggedCache.set(flagKey(moduleName, entryId, activity), { confidence, at: Date.now() });
}

export function clearFlagged(
  moduleName: string,
  entryId: unknown,
  activity: string,
): void {
  flaggedCache.delete(flagKey(moduleName, entryId, activity));
}

export function getPriorFlag(
  moduleName: string,
  entryId: unknown,
  activity: string,
): FlaggedRecord | undefined {
  const k = flagKey(moduleName, entryId, activity);
  const rec = flaggedCache.get(k);
  if (!rec) return undefined;
  if (Date.now() - rec.at > FLAG_TTL_MS) {
    flaggedCache.delete(k);
    return undefined;
  }
  return rec;
}

// ---------- Human-actor bypass detection ----------
//
// Observed gaming pattern: an AI is blocked on a human-only activity, then
// immediately reaches the same target state via `changeState` + a
// self-attested `confirmed: true`. Blocking a human-only activity records its
// flow target states for that entry; an explicit state change to one of those
// states is then refused outright — `confirmed` does not unlock human-only
// transitions, so it must not unlock their state-override equivalent either.

interface HumanBlockRecord {
  activity: string;
  states: Set<string>;
  at: number;
}
const HUMAN_BLOCK_TTL_MS = 30 * 60 * 1000;
const humanBlockCache = new Map<string, HumanBlockRecord>();

function humanBlockKey(moduleName: string, entryId: unknown): string {
  return cacheKey("humanblock", [moduleName, String(entryId)]);
}

/** Target states an activity can transition to, per the module's flows. */
async function activityTargetStates(
  moduleName: string,
  activity: string,
  fetchSchema: SchemaFetcher,
): Promise<string[]> {
  const schema = await getExtendedSchema(moduleName, fetchSchema);
  const out: string[] = [];
  for (const from of Object.values(schema?.flows ?? {})) {
    const target = from?.activities?.[activity];
    if (typeof target === "string" && !out.includes(target)) out.push(target);
  }
  return out;
}

/** The human-actor block recorded for an entry, if still fresh. */
export function getHumanBlockedStates(
  moduleName: string,
  entryId: unknown,
): { activity: string; states: Set<string> } | undefined {
  if (entryId === undefined || entryId === null) return undefined;
  const k = humanBlockKey(moduleName, entryId);
  const rec = humanBlockCache.get(k);
  if (!rec) return undefined;
  if (Date.now() - rec.at > HUMAN_BLOCK_TTL_MS) {
    humanBlockCache.delete(k);
    return undefined;
  }
  return rec;
}

export interface GuardInput {
  module: string;
  activity: string;
  entryId?: string | number;
  entryIds?: Array<string | number>;
  state?: string;
  confidence: number;
  confirmed?: boolean;
}

export type GuardOutcome =
  | { ok: true }
  | { ok: false; structured: Record<string, unknown> };

export async function evaluateActivity(
  input: GuardInput,
  fetchSchema: SchemaFetcher = defaultSchemaFetcher,
  fetchCanvas: CanvasFetcher = defaultCanvasFetcher,
): Promise<GuardOutcome> {
  const { module: moduleName, activity, entryId, entryIds, state, confidence, confirmed } = input;

  // Rule 1 — confidence inflation after a prior flag.
  const targets: Array<string | number | undefined> = entryIds && entryIds.length > 0 ? entryIds : [entryId];
  for (const target of targets) {
    const prior = getPriorFlag(moduleName, target, activity);
    if (prior && confidence > prior.confidence + 1e-6 && !confirmed) {
      return {
        ok: false,
        structured: {
          error: "confidence_inflation_blocked",
          message:
            "This activity was previously flagged for human review (confidence below threshold). Resubmitting with a higher confidence score is not permitted — surface the flag to the user.",
          activity,
          entryId: target,
          previous_flagged_confidence: prior.confidence,
          current_confidence: confidence,
          agent_action:
            "Stop. Tell the user the activity was flagged. Do not retry with a higher confidence on your own. If the user explicitly authorizes proceeding, resubmit with confirmed: true.",
        },
      };
    }
  }

  // Rule 2 pre-flight — a target state must exist before any confirmation
  // dance. The platform returns an opaque error for unknown states.
  if (state) {
    const states = await getModuleStates(moduleName, fetchSchema);
    if (states && !states.includes(state)) {
      return {
        ok: false,
        structured: {
          error: "unknown_state",
          message: `State '${state}' does not exist on module '${moduleName}'. Available states: ${states.join(", ")}.`,
          activity,
          state,
          agent_action:
            "Use one of the listed states, or omit 'state' to follow the activity's normal flow.",
        },
      };
    }
  }

  // Rule 2c — bypass detection. Once a human-only activity was blocked for an
  // entry, an explicit state change that reaches the same target state is the
  // same transition wearing different clothes. Runs before the `confirmed`
  // shortcuts: confirmed does not unlock human-only transitions.
  if (state) {
    for (const target of targets) {
      const blocked = getHumanBlockedStates(moduleName, target);
      if (blocked?.states.has(state)) {
        return {
          ok: false,
          structured: {
            error: "human_actor_bypass_blocked",
            message: `Activity '${blocked.activity}' (actor='human') was blocked for this entry, and this state change reaches its target state '${state}'. confirmed: true does not unlock human-only transitions.`,
            activity,
            state,
            entryId: target,
            blocked_activity: blocked.activity,
            agent_action:
              "Stop and do not work around this. A human must perform the transition in Inistate — report it to the user.",
          },
        };
      }
    }
  }

  // Rule 2a — `changeStatus` (alias `changeState`) is the explicit
  // state-change override.
  if ((activity === "changeStatus" || activity === "changeState") && !confirmed) {
    return {
      ok: false,
      structured: {
        error: "state_change_requires_confirmation",
        message:
          `The '${activity}' activity bypasses the workflow to change an entry's state directly. AI agents must not call it on their own initiative.`,
        activity,
        agent_action:
          "Ask the user explicitly whether to change the entry's state. After they confirm, resubmit with confirmed: true.",
      },
    };
  }

  // Rule 2b — explicit `state` parameter overrides the activity's target state.
  if (state && !confirmed) {
    return {
      ok: false,
      structured: {
        error: "state_override_requires_confirmation",
        message:
          "Passing 'state' overrides the target state of the activity. This is a state change and requires explicit user authorization.",
        activity,
        state,
        agent_action:
          "Confirm with the user that you may set the target state explicitly, then resubmit with confirmed: true.",
      },
    };
  }

  // Rules 3 & 4 apply to custom (workflow-defined) activities only.
  if (STANDARD_ACTIVITIES.has(activity)) return { ok: true };

  const def = await getActivityDef(moduleName, activity, fetchSchema, fetchCanvas);
  if (!def) return { ok: true }; // unknown activity — let the API decide.

  const actor = (def.actor || "").toLowerCase();

  if (actor === "human") {
    // Remember which states this activity would have reached, so a follow-up
    // changeState/state-override to the same state is caught (Rule 2c).
    const targetStates = await activityTargetStates(moduleName, activity, fetchSchema);
    if (targetStates.length > 0) {
      for (const target of targets) {
        if (target === undefined || target === null) continue;
        humanBlockCache.set(humanBlockKey(moduleName, target), {
          activity,
          states: new Set(targetStates),
          at: Date.now(),
        });
      }
    }
    return {
      ok: false,
      structured: {
        error: "human_actor_blocked",
        message: `Activity '${activity}' is marked actor='human'. AI agents are not permitted to execute human-only activities.`,
        activity,
        actor: "human",
        agent_action:
          "Do not retry — confirmed: true does NOT unlock this, and neither does changeState. Tell the user the activity must be performed by a human, then stop.",
      },
    };
  }

  if (actor === "hybrid" && !confirmed) {
    return {
      ok: false,
      structured: {
        error: "hybrid_requires_confirmation",
        message: `Activity '${activity}' is marked actor='hybrid'. Show the planned submission to the user and obtain explicit confirmation before proceeding.`,
        activity,
        actor: "hybrid",
        agent_action:
          "Present the planned action (module, activity, input fields) to the user. After explicit user approval, resubmit with confirmed: true.",
      },
    };
  }

  return { ok: true };
}

// ---------- Reference-shape pre-flight (User/Module fields) ----------
//
// User/Module fields require `{ id, value }` objects (plural variants take
// arrays of them). The server enforces this too, but failing on the client
// gives the agent a structured error it can self-correct on without a
// network round trip. Strict: bare strings/numbers, missing `value`, or
// missing `id` all reject.

export interface RefShapeError {
  field: string;
  type: string;
  message: string;
  received: unknown;
}

function checkSingleRef(
  field: string,
  type: string,
  value: unknown,
  index?: number,
): RefShapeError | null {
  const locator = index !== undefined ? `${field}[${index}]` : field;
  const isUserType = type === "User" || type === "Users";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const shape = isUserType
      ? `{ id, value, username } (e.g. { id: 42, value: "John Doe", username: "jdoe" })`
      : `{ id, value } (e.g. { id: 42, value: "Acme Corp" })`;
    return {
      field,
      type,
      received: value,
      message: `${type} field '${locator}' must be an object with ${shape}.`,
    };
  }
  const obj = value as Record<string, unknown>;
  const idOk =
    (typeof obj.id === "string" && obj.id.length > 0) ||
    (typeof obj.id === "number" && Number.isFinite(obj.id));
  const valueOk = typeof obj.value === "string";
  const usernameOk =
    !isUserType ||
    (typeof obj.username === "string" && obj.username.length > 0);
  if (idOk && valueOk && usernameOk) {
    // A display name standing in for the id ({ id: "carol" }) passes the key
    // checks but the platform stores it as-is — a silently dangling reference.
    // Real ids are numeric or document ids ("CLN00001"); a string id with
    // whitespace or no digit at all is a name, not an id.
    if (typeof obj.id === "string" && (/\s/.test(obj.id) || !/\d/.test(obj.id))) {
      return {
        field,
        type,
        received: value,
        message: `${type} field '${locator}' id '${obj.id}' looks like a display name, not an entry id. Look up the entry with list_entries on the connected module and round-trip its reference object unchanged.`,
      };
    }
    return null;
  }
  const missing: string[] = [];
  if (!idOk) missing.push("id (string|number)");
  if (!valueOk) missing.push("value (string)");
  if (!usernameOk) missing.push("username (string)");
  const required = isUserType ? "'id', 'value', and 'username'" : "both 'id' and 'value'";
  return {
    field,
    type,
    received: value,
    message: `${type} field '${locator}' must include ${required}. Missing/invalid: ${missing.join(", ")}.`,
  };
}

function checkRefValue(
  field: string,
  type: string,
  value: unknown,
): RefShapeError | null {
  // null/undefined clears the field — allowed.
  if (value === null || value === undefined) return null;

  const isPlural = type === "Users" || type === "Modules";
  if (isPlural) {
    if (!Array.isArray(value)) {
      const itemShape = type === "Users" ? "{ id, value, username }" : "{ id, value }";
      return {
        field,
        type,
        received: value,
        message: `${type} field '${field}' must be an array of ${itemShape} objects.`,
      };
    }
    for (let i = 0; i < value.length; i++) {
      const e = checkSingleRef(field, type, value[i], i);
      if (e) return e;
    }
    return null;
  }
  return checkSingleRef(field, type, value);
}

/**
 * State names for a module, from the cached extended schema. Tolerates both
 * string[] and [{name}] shapes; null when unavailable (let the API decide).
 */
export async function getModuleStates(
  moduleName: string,
  fetchSchema: SchemaFetcher = defaultSchemaFetcher,
): Promise<string[] | null> {
  const schema = await getExtendedSchema(moduleName, fetchSchema);
  const raw = schema?.states;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const names = raw
    .map((s) => (typeof s === "string" ? s : s?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  return names.length > 0 ? names : null;
}

/**
 * Build a field-name → field-type map for a module. Returns null when the
 * schema cannot be loaded (callers should let the server decide). The
 * underlying schema is cached by getExtendedSchema, so repeat calls are cheap.
 *
 * Split out so bulk callers (submit_activities) can fetch once and reuse the
 * map across items via validateInputShapesWith.
 */
export async function getModuleFieldTypes(
  moduleName: string,
  fetchSchema: SchemaFetcher = defaultSchemaFetcher,
): Promise<Map<string, string> | null> {
  const schema = await getExtendedSchema(moduleName, fetchSchema);
  const info = schema?.information;
  if (!info || info.length === 0) return null;
  const types = new Map<string, string>();
  for (const f of info) {
    if (f?.name && f?.type) types.set(f.name, f.type);
  }
  return types;
}

/**
 * Synchronous shape check against a pre-built field-type map. Use this in
 * bulk loops to avoid rebuilding the map per item. When `types` is null
 * (schema unavailable), returns [] so the server makes the final call.
 */
export function validateInputShapesWith(
  types: Map<string, string> | null,
  input: Record<string, unknown> | undefined | null,
): RefShapeError[] {
  if (!input || !types) return [];
  const errors: RefShapeError[] = [];
  for (const [key, val] of Object.entries(input)) {
    const type = types.get(key);
    if (!type || !REF_FIELD_TYPES.has(type)) continue;
    const e = checkRefValue(key, type, val);
    if (e) errors.push(e);
  }
  return errors;
}

// ---------- Input key resolution ----------

/** Case/space/underscore-insensitive key for field-name matching. */
function fieldKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]/g, "");
}

export interface InputKeyResolution {
  /** Near-miss keys (casing/spacing/underscores) rewritten in place to the exact field name. */
  remapped: Array<{ from: string; to: string }>;
  /** Keys matching no field at all — the platform silently drops these, losing the data. */
  unknown: string[];
}

/**
 * Match input keys against the module's field names, in place. Exact names
 * pass; a key that differs only in case/spacing/underscores is rewritten to
 * the exact field name; anything else is reported so the caller can reject
 * it — the platform discards unmatched keys without any signal, which turns
 * a key typo into silent data loss. Fail-open on a null map (schema
 * unavailable): the server makes the final call.
 */
export function resolveInputKeys(
  types: Map<string, string> | null,
  input: Record<string, unknown> | undefined | null,
): InputKeyResolution {
  const result: InputKeyResolution = { remapped: [], unknown: [] };
  if (!input || !types) return result;
  // null marks a collision — two fields fold to the same key; never remap those.
  const byKey = new Map<string, string | null>();
  for (const name of types.keys()) {
    const k = fieldKey(name);
    byKey.set(k, byKey.has(k) ? null : name);
  }
  for (const key of Object.keys(input)) {
    if (types.has(key)) continue;
    const match = byKey.get(fieldKey(key));
    if (match && !Object.prototype.hasOwnProperty.call(input, match)) {
      input[match] = input[key];
      delete input[key];
      result.remapped.push({ from: key, to: match });
    } else {
      result.unknown.push(key);
    }
  }
  return result;
}

/**
 * Validate that User/Module/Users/Modules fields in `input` carry the
 * correct shape. Convenience wrapper around getModuleFieldTypes +
 * validateInputShapesWith — use this for one-shot calls (submit_activity).
 * Bulk callers should fetch the map once and use validateInputShapesWith
 * directly.
 */
export async function validateInputShapes(
  moduleName: string,
  input: Record<string, unknown> | undefined | null,
  fetchSchema: SchemaFetcher = defaultSchemaFetcher,
): Promise<RefShapeError[]> {
  if (!input) return [];
  const types = await getModuleFieldTypes(moduleName, fetchSchema);
  return validateInputShapesWith(types, input);
}

/**
 * Annotation merged into platform responses that carry `flagged: true`. The
 * platform itself returns the bare flag with no explanation — without this,
 * agents loop retrying with higher confidence or `confirmed: true`.
 */
export const FLAGGED_ANNOTATION = {
  flag_reason:
    "Flagged submissions are recorded as intentions pending human review — the state transition did NOT occur. Causes: ai.confidence below the activity's confidence_threshold, or the activity's actor does not permit AI execution.",
  agent_action:
    "Do not retry with a higher confidence. Report the flag to the user; a human can complete the activity in Inistate.",
} as const;

// Test-only helpers.
export function __resetGuardCaches(): void {
  schemaCache.clear();
  canvasCache.clear();
  flaggedCache.clear();
  humanBlockCache.clear();
}
