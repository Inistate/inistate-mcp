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

interface ExtendedSchema {
  activities?: ActivityDef[];
  information?: FieldInfo[];
}

const REF_FIELD_TYPES = new Set(["User", "Users", "Module", "Modules"]);

// Standard activities are inherent platform operations and have no actor in the
// module schema. They bypass the actor check (but state-change checks still run).
const STANDARD_ACTIVITIES = new Set([
  "create",
  "edit",
  "delete",
  "comment",
  "duplicate",
  "manage",
  "view",
  "changeStatus",
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

async function getExtendedSchema(moduleName: string): Promise<ExtendedSchema | null> {
  const key = cacheKey("schema", [moduleName]);
  const now = Date.now();
  const cached = schemaCache.get(key);
  if (cached && now - cached.at < SCHEMA_TTL_MS) return cached.schema;
  try {
    const schema = (await api.get(`/api/mcp/${api.enc(moduleName)}?tier=extended`)) as ExtendedSchema;
    schemaCache.set(key, { schema, at: now });
    return schema;
  } catch {
    return null;
  }
}

async function getActivityDef(
  moduleName: string,
  activity: string,
): Promise<ActivityDef | null> {
  const schema = await getExtendedSchema(moduleName);
  return schema?.activities?.find((a) => a.name === activity) ?? null;
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

export async function evaluateActivity(input: GuardInput): Promise<GuardOutcome> {
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

  // Rule 2a — `changeStatus` is the explicit state-change override.
  if (activity === "changeStatus" && !confirmed) {
    return {
      ok: false,
      structured: {
        error: "state_change_requires_confirmation",
        message:
          "The 'changeStatus' activity bypasses the workflow to change an entry's state directly. AI agents must not call it on their own initiative.",
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

  const def = await getActivityDef(moduleName, activity);
  if (!def) return { ok: true }; // unknown activity — let the API decide.

  const actor = (def.actor || "").toLowerCase();

  if (actor === "human") {
    return {
      ok: false,
      structured: {
        error: "human_actor_blocked",
        message: `Activity '${activity}' is marked actor='human'. AI agents are not permitted to execute human-only activities.`,
        activity,
        actor: "human",
        agent_action:
          "Do not retry — confirmed: true does NOT unlock this. Tell the user the activity must be performed by a human, then stop.",
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      field,
      type,
      received: value,
      message: `${type} field '${locator}' must be an object with both 'id' and 'value' (e.g. { id: 42, value: "John Doe" }).`,
    };
  }
  const obj = value as Record<string, unknown>;
  const idOk =
    (typeof obj.id === "string" && obj.id.length > 0) ||
    (typeof obj.id === "number" && Number.isFinite(obj.id));
  const valueOk = typeof obj.value === "string";
  if (idOk && valueOk) return null;
  const missing: string[] = [];
  if (!idOk) missing.push("id (string|number)");
  if (!valueOk) missing.push("value (string)");
  return {
    field,
    type,
    received: value,
    message: `${type} field '${locator}' must include both 'id' and 'value'. Missing/invalid: ${missing.join(", ")}.`,
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
      return {
        field,
        type,
        received: value,
        message: `${type} field '${field}' must be an array of { id, value } objects.`,
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
 * Validate that User/Module/Users/Modules fields in `input` carry
 * { id, value } objects. Returns [] when shapes are correct, or when the
 * module schema can't be loaded (let the server decide in that case).
 */
export async function validateInputShapes(
  moduleName: string,
  input: Record<string, unknown> | undefined | null,
): Promise<RefShapeError[]> {
  if (!input) return [];
  const schema = await getExtendedSchema(moduleName);
  const info = schema?.information;
  if (!info || info.length === 0) return [];
  const types = new Map<string, string>();
  for (const f of info) {
    if (f?.name && f?.type) types.set(f.name, f.type);
  }
  const errors: RefShapeError[] = [];
  for (const [key, val] of Object.entries(input)) {
    const type = types.get(key);
    if (!type || !REF_FIELD_TYPES.has(type)) continue;
    const e = checkRefValue(key, type, val);
    if (e) errors.push(e);
  }
  return errors;
}

// Test-only helpers.
export function __resetGuardCaches(): void {
  schemaCache.clear();
  flaggedCache.clear();
}
