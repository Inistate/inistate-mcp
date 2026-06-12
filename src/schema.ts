import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ---------- Load schema at startup ----------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = resolve(__dirname, "../inistate-schema.json");
const DESIGN_GUIDE_PATH = resolve(__dirname, "../facts-module-design-guide.md");
const FRONTEND_GUIDE_PATH = resolve(__dirname, "../facts-frontend-guide.md");

export const SCHEMA: Record<string, any> = JSON.parse(
  readFileSync(SCHEMA_PATH, "utf-8"),
);

export const DESIGN_GUIDE: string = readFileSync(DESIGN_GUIDE_PATH, "utf-8");

export const FRONTEND_GUIDE: string = readFileSync(FRONTEND_GUIDE_PATH, "utf-8");

// ---------- Mode-filtered schema views ----------
//
// The full SCHEMA is large (~66KB). Most agent sessions only need runtime
// tools (list/get/submit/upload) and their types — configure-mode tools
// (create_module, update_module) and design rules (state_color_system,
// module_types) are dead weight. We expose filtered variants so agents
// can pick by mode.

const SHARED_DEFINITIONS = [
  "FieldType",
  "FieldDefinition",
  "SubFieldDefinition",
  "StateDefinition",
  "FileFieldValue",
  "FileFieldInput",
  "FileUploadResult",
  "PresignedUploadResult",
  "ModuleFieldValue",
  "UserFieldValue",
  "ErrorResponse",
];

const RUNTIME_DEFINITIONS = [
  ...SHARED_DEFINITIONS,
  "EntryData",
  "Entry",
  "EntryList",
  "ActivityForm",
  "ActivitySubmission",
  "AvailableActivities",
  "ActivityResult",
  "HistoryEvent",
  "EntryHistory",
  "FilterOperators",
];

const CONFIGURE_DEFINITIONS = [
  ...SHARED_DEFINITIONS,
  "ActivityDefinition",
  "ActivityFieldRef",
  "FlowDefinition",
  "ModuleSchema",
];

const RUNTIME_WORKFLOW_KEYS = [
  "_description",
  "steps",
  "key_rules",
  "confidence_gate",
  "ai_audit_trail",
];

const CONFIGURE_WORKFLOW_KEYS = [
  "_description",
  "steps",
  "key_rules",
  "module_types",
  "state_color_system",
];

function pickKeys(source: Record<string, any>, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) {
    if (k in source) out[k] = source[k];
  }
  return out;
}

// Tool inputs are documented authoritatively by the MCP tool schemas the agent
// already holds — the views carry only what tools/list cannot: response/type
// definitions and the workflow guide. (The JSON's `operations` section is
// intentionally NOT included; re-documenting tools here doubled the context
// cost of the resource and had drifted from the real tool surface.)
function buildSchemaView(
  definitionKeys: string[],
  workflowKeys: string[],
): Record<string, any> {
  return {
    $schema: SCHEMA.$schema,
    title: SCHEMA.title,
    description: SCHEMA.description,
    version: SCHEMA.version,
    definitions: pickKeys(SCHEMA.definitions, definitionKeys),
    workflow_guide: pickKeys(SCHEMA.workflow_guide, workflowKeys),
  };
}

export const SCHEMA_RUNTIME = buildSchemaView(
  RUNTIME_DEFINITIONS,
  RUNTIME_WORKFLOW_KEYS,
);

export const SCHEMA_CONFIGURE = buildSchemaView(
  CONFIGURE_DEFINITIONS,
  CONFIGURE_WORKFLOW_KEYS,
);

// ---------- Derived lookups ----------

export const VALID_FIELD_TYPES: string[] = SCHEMA.definitions.FieldType.enum;

export const VALID_ACTOR_TYPES: string[] =
  SCHEMA.definitions.ActivityDefinition.properties.actor.enum;

export const COLOR_PALETTE: Record<string, string> =
  SCHEMA.workflow_guide.state_color_system.palette;

export const VALID_COLORS: string[] = Object.keys(COLOR_PALETTE);

export const COLOR_KEYWORDS: Record<string, string[]> =
  SCHEMA.workflow_guide.state_color_system.keyword_hints;

// ---------- Helpers ----------

export function isValidFieldType(type: string): boolean {
  if (type.startsWith("Selection(") && type.endsWith(")")) return true;
  return VALID_FIELD_TYPES.includes(type);
}

/** Base type with any inline option syntax stripped: "Selection(A/B)" → "selection". */
function baseTypeOf(type: string): string {
  return type.split("(")[0].trim().toLowerCase();
}

// Reference types link to another module and require `connection` — the
// platform validator rejects them without it.
const REFERENCE_TYPES_LOWER = new Set(["module", "modules", "user", "users"]);

export function isReferenceFieldType(type: string): boolean {
  return REFERENCE_TYPES_LOWER.has(baseTypeOf(type));
}

// ---------- Input normalization ----------
//
// Agents guess near-miss vocabulary ("Select", "LongText", "gray", "#D4A017").
// Accept it and normalize to canonical on the way in: validate_design warns
// about each change so agents learn the canonical names, and create_module /
// update_module apply the same normalization to their payloads.

const TYPE_ALIASES: Record<string, string> = {
  select: "Selection",
  dropdown: "Selection",
  multilinetext: "MultiText",
  longtext: "MultiText",
  textarea: "MultiText",
  paragraph: "MultiText",
  boolean: "YesNo",
  checkbox: "YesNo",
  int: "Integer",
};

const CANONICAL_TYPES = new Map(VALID_FIELD_TYPES.map((t) => [t.toLowerCase(), t]));

/** Map a type to its canonical name (case/space/alias tolerant, preserves
 * inline "(...)" option syntax). Unknown types pass through unchanged so
 * validation can report them. */
export function normalizeFieldType(
  type: string | undefined | null,
): { type: string | undefined; changed: boolean } {
  if (!type) return { type: undefined, changed: false };
  const parenIdx = type.indexOf("(");
  const rawBase = parenIdx >= 0 ? type.slice(0, parenIdx) : type;
  const suffix = parenIdx >= 0 ? type.slice(parenIdx) : "";
  const key = rawBase.trim().toLowerCase().replace(/[\s_-]/g, "");
  const canonical = CANONICAL_TYPES.get(key) ?? TYPE_ALIASES[key];
  if (!canonical) return { type, changed: false };
  const normalized = canonical + suffix;
  return { type: normalized, changed: normalized !== type };
}

const NAMED_COLORS: Record<string, string> = {
  gray: "#5A6070", grey: "#5A6070", slate: "#5A6070", silver: "#5A6070",
  blue: "#2968A8", navy: "#2968A8", azure: "#2968A8",
  green: "#2A7B50", emerald: "#2A7B50",
  darkgreen: "#1E6B45", forest: "#1E6B45",
  yellow: "#A07828", amber: "#A07828", orange: "#A07828", gold: "#A07828",
  red: "#C0392B", crimson: "#C0392B", scarlet: "#C0392B",
  darkred: "#8B2D2D", maroon: "#8B2D2D", burgundy: "#8B2D2D",
  purple: "#6B4D91", violet: "#6B4D91", indigo: "#6B4D91",
};

function parseHexColor(value: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** Snap any color to the palette: exact match passes, color names map by
 * meaning, hex snaps to the nearest palette color, anything else falls back
 * to the keyword suggestion for the state name. Never fails. */
export function normalizeStateColor(
  color: string | undefined | null,
  stateName: string,
): { color: string | undefined; changed: boolean } {
  if (!color) return { color: undefined, changed: false };
  if (VALID_COLORS.includes(color)) return { color, changed: false };
  const key = color.trim().toLowerCase().replace(/[\s_-]/g, "");
  const named = NAMED_COLORS[key];
  if (named) return { color: named, changed: true };
  const rgb = parseHexColor(color);
  if (rgb) {
    let best = VALID_COLORS[0];
    let bestDist = Infinity;
    for (const candidate of VALID_COLORS) {
      const c = parseHexColor(candidate)!;
      const dist = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
    return { color: best, changed: best.toLowerCase() !== color.trim().toLowerCase() };
  }
  return { color: suggestColorForState(stateName), changed: true };
}

export function isValidColor(hex: string): boolean {
  return VALID_COLORS.includes(hex);
}

export function isValidActor(actor: string): boolean {
  return VALID_ACTOR_TYPES.includes(actor);
}

export function suggestColorForState(stateName: string): string {
  const lower = stateName.toLowerCase();
  // Check terminal keywords first (dark green / dark red)
  const terminalSuccess = COLOR_KEYWORDS["#1E6B45"] || [];
  if (terminalSuccess.some((kw) => lower.includes(kw))) return "#1E6B45";
  const terminalFailure = COLOR_KEYWORDS["#8B2D2D"] || [];
  if (terminalFailure.some((kw) => lower.includes(kw))) return "#8B2D2D";
  // Then check remaining in decision order
  const order = [
    "#2A7B50",
    "#C0392B",
    "#A07828",
    "#6B4D91",
    "#2968A8",
    "#5A6070",
  ];
  for (const hex of order) {
    const keywords = COLOR_KEYWORDS[hex] || [];
    if (keywords.some((kw) => lower.includes(kw))) return hex;
  }
  return "#2968A8"; // default when unsure
}

// ---------- validate_design ----------

/**
 * Resolve local-id references to names, in place. Agents commonly tag
 * states/activities/fields with short ids (s1, a1, f1) and then point flows or
 * activity field refs at those ids; the platform wants names. A ref is only
 * rewritten when it matches a declared id and no declared name, so names
 * always win. Returns one note per rewritten reference.
 */
export function resolveDesignRefs(schema: Record<string, any>): string[] {
  const notes: string[] = [];
  const states: any[] = Array.isArray(schema.states) ? schema.states : [];
  const activities: any[] = Array.isArray(schema.activities) ? schema.activities : [];
  const information: any[] = Array.isArray(schema.information) ? schema.information : [];
  const flows: any[] = Array.isArray(schema.flows) ? schema.flows : [];

  const resolver = (kind: string, items: any[]) => {
    const names = new Set(items.map((it) => it?.name));
    const ids = new Map<string, string>();
    for (const it of items) {
      if (it && typeof it.id === "string" && it.id !== "" && typeof it.name === "string") {
        ids.set(it.id, it.name);
      }
    }
    return (ref: unknown): string | null => {
      if (typeof ref !== "string" || names.has(ref) || !ids.has(ref)) return null;
      const name = ids.get(ref)!;
      notes.push(`Reference '${ref}' resolved to ${kind} '${name}' via its id — reference names directly.`);
      return name;
    };
  };

  const toState = resolver("state", states);
  const toActivity = resolver("activity", activities);
  const toField = resolver("field", information);

  for (const f of flows) {
    if (!f || typeof f !== "object") continue;
    f.from = toState(f.from) ?? f.from;
    f.to = toState(f.to) ?? f.to;
    f.activity = toActivity(f.activity) ?? f.activity;
  }
  for (const a of activities) {
    if (!a || !Array.isArray(a.fields)) continue;
    a.fields = a.fields.map((ref: any) => {
      if (typeof ref === "string") return toField(ref) ?? ref;
      if (ref && typeof ref === "object") {
        const name = toField(ref.name);
        if (name !== null) return { ...ref, name };
      }
      return ref;
    });
  }
  return notes;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: Record<string, unknown> | null;
}

export function validateDesign(
  schema: Record<string, any>,
  mode: "create" | "update" = "create",
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Resolve id-style references (flows pointing at state/activity ids, field
  // refs pointing at field ids) before any checks, mirroring what
  // create_module/update_module send to the platform.
  warnings.push(...resolveDesignRefs(schema));

  const name: string = schema.name || "";
  const information: any[] = schema.information || [];
  const states: any[] = schema.states || [];
  const activities: any[] = schema.activities || [];
  const flows: any[] = schema.flows || [];

  const isWorkflow = states.length > 0;

  // Rule 1: name is required
  if (!name && mode === "create") {
    errors.push("Module name is required.");
  }

  // Collect field names
  const fieldNames = new Set<string>();
  for (const f of information) {
    if (fieldNames.has(f.name)) {
      errors.push(`Duplicate field name: '${f.name}'.`);
    }
    fieldNames.add(f.name);
  }

  // Validate fields. Mirrors the platform validator rule-for-rule so a passing
  // validate_design cannot 422 on the subsequent create_module/update_module.
  // Types are normalized first (aliases, casing) — checks run on the canonical
  // form, matching what create_module/update_module will actually send.
  for (let i = 0; i < information.length; i++) {
    const f = information[i];
    if (!f.name) {
      errors.push(`Information field at index ${i} is missing a 'name'.`);
    }
    if (!f.type) {
      errors.push(
        `Field '${f.name}' is missing a 'type'. Valid types: ${VALID_FIELD_TYPES.join(", ")}.`,
      );
      continue;
    }
    const norm = normalizeFieldType(f.type);
    const ftype = norm.type as string;
    if (norm.changed) {
      warnings.push(`Field '${f.name}' type '${f.type}' normalized to '${ftype}'.`);
    }
    if (!isValidFieldType(ftype)) {
      errors.push(
        `Field '${f.name}' has invalid type '${f.type}'. Valid types: ${VALID_FIELD_TYPES.join(", ")}.`,
      );
    }

    const base = baseTypeOf(ftype);
    const hasConnection = typeof f.connection === "string" && f.connection.trim() !== "";

    if ((base === "selection" || base === "tag")
      && (!f.options || f.options.length === 0)
      && !ftype.includes("(")) {
      errors.push(`Field '${f.name}' is type '${f.type}' but has no options.`);
    }

    if (REFERENCE_TYPES_LOWER.has(base) && !hasConnection) {
      errors.push(
        `Field '${f.name}' is type '${f.type}' but is missing 'connection'. Set 'connection' to the name of the module to link to (e.g. "connection": "Members").`,
      );
    }
    if (!REFERENCE_TYPES_LOWER.has(base) && hasConnection) {
      errors.push(
        `Field '${f.name}' has 'connection' set but type '${f.type}' is not a reference type. Remove 'connection', or change type to Module/Modules/User/Users.`,
      );
    }

    if (f.required !== undefined) {
      warnings.push(
        `Field '${f.name}' sets 'required' — ignored on information fields. Mark it required per-activity instead: { name: "${f.name}", required: true } in the activity's fields.`,
      );
    }

    // Table fields must have sub-fields; reference types are not allowed inside.
    if (base === "table") {
      if (!f.fields || !Array.isArray(f.fields) || f.fields.length === 0) {
        errors.push(`Table field '${f.name}' has no sub-fields defined.`);
      } else {
        for (const sf of f.fields) {
          const subNorm = normalizeFieldType(sf.type);
          const subType = subNorm.type;
          if (subNorm.changed) {
            warnings.push(
              `Table field '${f.name}' sub-field '${sf.name}' type '${sf.type}' normalized to '${subType}'.`,
            );
          }
          if (subType && !isValidFieldType(subType)) {
            errors.push(
              `Table field '${f.name}' sub-field '${sf.name}' has invalid type '${sf.type}'.`,
            );
          }
          if (subType && REFERENCE_TYPES_LOWER.has(baseTypeOf(subType))) {
            errors.push(
              `Table field '${f.name}' sub-field '${sf.name}' has type '${sf.type}' — Module/Modules/User/Users reference types are not supported inside Table sub-fields.`,
            );
          }
        }
      }
    }
  }

  if (isWorkflow) {
    // Rule 2: At least one state
    // (already true since isWorkflow = states.length > 0)

    // Rule 3: Exactly one initial state
    const initialStates = states.filter((s: any) => s.initial === true);
    if (initialStates.length === 0) {
      errors.push(
        "No initial state defined — exactly one state must have initial: true.",
      );
    } else if (initialStates.length > 1) {
      errors.push(
        `Multiple initial states: ${initialStates.map((s: any) => `'${s.name}'`).join(", ")}. Exactly one is allowed.`,
      );
    }

    // Collect state names
    const stateNames = new Set<string>();
    for (const s of states) {
      if (stateNames.has(s.name)) {
        errors.push(`Duplicate state name: '${s.name}'.`);
      }
      stateNames.add(s.name);
    }

    // Normalize state colors — off-palette values snap to the nearest palette
    // color (create_module/update_module apply the same mapping), so colors
    // never block a design. Warn so agents learn the palette.
    for (const s of states) {
      if (s.color) {
        const norm = normalizeStateColor(s.color, s.name || "");
        if (norm.changed) {
          warnings.push(
            `State '${s.name}' color '${s.color}' is not in the palette — normalized to '${norm.color}'.`,
          );
        }
      } else {
        warnings.push(`State '${s.name}' has no color — will use default.`);
      }
    }

    // Collect activity names
    const activityNames = new Set<string>();
    for (const a of activities) {
      if (activityNames.has(a.name)) {
        errors.push(`Duplicate activity name: '${a.name}'.`);
      }
      activityNames.add(a.name);
    }

    // Validate activity properties
    for (const a of activities) {
      // Actor validation
      if (a.actor && !isValidActor(a.actor)) {
        errors.push(
          `Activity '${a.name}' has invalid actor '${a.actor}'. Valid: human, ai, hybrid.`,
        );
      }

      // Confidence threshold. Values in (1, 100] are read as percentages —
      // create_module/update_module normalize them the same way.
      if (
        a.confidence_threshold !== undefined &&
        a.confidence_threshold !== null
      ) {
        if (a.confidence_threshold < 0 || a.confidence_threshold > 100) {
          errors.push(
            `Activity '${a.name}' confidence_threshold must be between 0 and 1.`,
          );
        } else if (a.confidence_threshold > 1) {
          warnings.push(
            `Activity '${a.name}' confidence_threshold ${a.confidence_threshold} read as a percentage — normalized to ${a.confidence_threshold / 100}.`,
          );
        }
      }

      // Activity field references
      if (a.fields && Array.isArray(a.fields)) {
        for (const ref of a.fields) {
          const fieldName = typeof ref === "string" ? ref : ref.name;
          if (!fieldNames.has(fieldName)) {
            errors.push(
              `Activity '${a.name}' references field '${fieldName}' which is not defined in information. Available fields: ${[...fieldNames].join(", ")}.`,
            );
          }
        }
      }

      // Warnings for AI actors
      if (a.actor === "ai") {
        if (
          !a.confidence_threshold &&
          a.confidence_threshold !== 0
        ) {
          warnings.push(
            `Activity '${a.name}' has no confidence_threshold — AI agents will not be gated on this activity.`,
          );
        }
        if (!a.ai_hint) {
          warnings.push(
            `Activity '${a.name}' has actor 'ai' but no ai_hint — agents may struggle to execute correctly.`,
          );
        }
      }
    }

    // Validate flows
    for (const f of flows) {
      if (f.from !== "" && !stateNames.has(f.from)) {
        errors.push(
          `Flow references state '${f.from}' (from) which is not defined. Available states: ${[...stateNames].join(", ")}.`,
        );
      }
      if (!stateNames.has(f.to)) {
        errors.push(
          `Flow references state '${f.to}' (to) which is not defined. Available states: ${[...stateNames].join(", ")}.`,
        );
      }
      if (!activityNames.has(f.activity)) {
        errors.push(
          `Flow from '${f.from}' to '${f.to}' references activity '${f.activity}' which is not defined in activities. Available activities: ${[...activityNames].join(", ")}.`,
        );
      }
    }

    // Warning: unreachable states (no incoming flows, except initial)
    const initialName = initialStates.length > 0 ? initialStates[0].name : "";
    const statesWithIncoming = new Set(flows.map((f: any) => f.to));
    for (const s of states) {
      if (s.name !== initialName && !statesWithIncoming.has(s.name)) {
        warnings.push(
          `State '${s.name}' is unreachable — no flows lead to it.`,
        );
      }
    }

    // Warning: unused activities
    const activitiesInFlows = new Set(flows.map((f: any) => f.activity));
    for (const a of activities) {
      if (!activitiesInFlows.has(a.name)) {
        warnings.push(
          `Activity '${a.name}' is not used in any flow.`,
        );
      }
    }

    // Warning: no terminal states
    const statesWithOutgoing = new Set(flows.map((f: any) => f.from));
    const terminalStates = states.filter(
      (s: any) => !statesWithOutgoing.has(s.name),
    );
    if (terminalStates.length === 0) {
      warnings.push(
        "No terminal states — process may run indefinitely.",
      );
    }

    // Build summary
    const summary = {
      field_count: information.length,
      state_count: states.length,
      activity_count: activities.length,
      flow_count: flows.length,
      initial_state: initialName,
      terminal_states: terminalStates.map((s: any) => s.name),
      ai_activities: activities.filter((a: any) => a.actor === "ai").length,
      hybrid_activities: activities.filter((a: any) => a.actor === "hybrid")
        .length,
      gated_activities: activities.filter(
        (a: any) => a.confidence_threshold && a.confidence_threshold > 0,
      ).length,
    };

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      summary: errors.length === 0 ? summary : null,
    };
  }

  // Record list module — minimal validation
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: errors.length === 0
      ? { field_count: information.length, module_type: "record_list" }
      : null,
  };
}

// ---------- design_workflow ----------

interface DesignTemplate {
  template: Record<string, any>;
  suggestions: Record<string, any>;
  constraints: Record<string, any>;
  next_step: string;
}

const INDUSTRY_DEFAULTS: Record<
  string,
  { confidence_threshold: number; audit_fields: string[]; actor_suggestion: string }
> = {
  financial_services: {
    confidence_threshold: 0.9,
    audit_fields: ["Compliance Note", "Risk Score"],
    actor_suggestion: "hybrid for all approval activities",
  },
  healthcare: {
    confidence_threshold: 0.9,
    audit_fields: ["Clinical Justification", "HIPAA Flag"],
    actor_suggestion: "human for patient-affecting activities",
  },
  legal: {
    confidence_threshold: 0.85,
    audit_fields: ["Legal Review Note", "Privilege Flag"],
    actor_suggestion: "hybrid for review activities",
  },
  hr: {
    confidence_threshold: 0.8,
    audit_fields: ["HR Note"],
    actor_suggestion: "hybrid for approval activities",
  },
  procurement: {
    confidence_threshold: 0.8,
    audit_fields: ["Budget Code", "PO Reference"],
    actor_suggestion: "ai for matching/validation activities",
  },
  it_service: {
    confidence_threshold: 0.7,
    audit_fields: ["Resolution Note"],
    actor_suggestion: "ai for triage activities",
  },
  general: {
    confidence_threshold: 0.8,
    audit_fields: [],
    actor_suggestion: "human default",
  },
};

type PatternName =
  | "approval_workflow"
  | "ticket_management"
  | "multi_stage_pipeline"
  | "record_list";

function detectPattern(desc: string): PatternName {
  const d = desc.toLowerCase();
  // Stateful language disqualifies record_list even when "list" appears
  // (e.g. "include list view fields" inside a lifecycle description).
  const stateful = /\bstates?\b|\bstatus(es)?\b|lifecycle|workflow|transition|\bstage|approv/.test(d);
  if (!stateful && /(\blist\b|directory|catalog|registry|lookup)/.test(d)) {
    return "record_list";
  }
  if (/(ticket|support|incident|helpdesk|help desk|service request|\bissue)/.test(d)) {
    return "ticket_management";
  }
  if (/approv/.test(d)) {
    return "approval_workflow";
  }
  if (/(pipeline|\bstage|onboard|multi|track|project|lifecycle|progress)/.test(d)) {
    return "multi_stage_pipeline";
  }
  return "approval_workflow";
}

/**
 * Pull an explicitly enumerated state list out of a description, e.g.
 * "Lifecycle states: Proposed, Active, On Hold" / "states like Planning,
 * In Progress" / "status (Draft, Sent, Paid)". Returns [] when none found —
 * callers fall back to the pattern template.
 */
export function parseStatesFromDescription(desc: string): string[] {
  const patterns = [
    /(?:states?|stages?|status(?:es)?)\b(?:[^:.;\n)]{0,25}:|\s+(?:like|are|include[s]?))\s*([^.;\n)]+)/i,
    /(?:states?|stages?|status(?:es)?)\s*\(([^)]+)\)/i,
  ];
  let captured: string | null = null;
  for (const p of patterns) {
    const m = p.exec(desc);
    if (m) {
      captured = m[1];
      break;
    }
  }
  if (!captured) return [];
  const states: string[] = [];
  for (const raw of captured.split(/,|\/|\bor\b|\band\b/i)) {
    const name = raw.replace(/[()"']/g, "").trim();
    if (!name || name.length > 30) continue;
    if (name.split(/\s+/).length > 4) continue; // a state name, not a sentence
    if (!states.some((s) => s.toLowerCase() === name.toLowerCase())) {
      states.push(name);
    }
    if (states.length === 8) break;
  }
  return states.length >= 2 ? states : [];
}

/** Map free-text industry to a known key; unknown text falls back to general. */
export function normalizeIndustry(industry?: string | null): string {
  if (!industry) return "general";
  const k = industry.trim().toLowerCase().replace(/[\s_-]+/g, "_");
  if (INDUSTRY_DEFAULTS[k]) return k;
  if (/financ|bank|insur|account|fintech/.test(k)) return "financial_services";
  if (/health|medic|clinic|hospital|pharma|dental/.test(k)) return "healthcare";
  if (/legal|law/.test(k)) return "legal";
  if (/human_resource|recruit|talent|^hr$/.test(k)) return "hr";
  if (/procure|purchas|sourcing|vendor|supply/.test(k)) return "procurement";
  if (/(^|_)it(_|$)|tech|software|helpdesk|devops|saas/.test(k)) return "it_service";
  return "general";
}

// Returned with every design_workflow call — the design funnel's first step is
// where agents form their vocabulary, so the constraints ride along.
const DESIGN_CONSTRAINTS = {
  field_types: VALID_FIELD_TYPES,
  state_colors: VALID_COLORS,
  reference_fields:
    'User/Users/Module/Modules fields require \'connection\': the module name to link to (e.g. "Members" for workspace users). Not supported inside Table sub-fields.',
  actors: VALID_ACTOR_TYPES,
};

export function designWorkflow(
  description: string,
  industry: string = "general",
): DesignTemplate {
  const resolvedIndustry = normalizeIndustry(industry);
  const indDefaults = INDUSTRY_DEFAULTS[resolvedIndustry];
  const parsedStates = parseStatesFromDescription(description);

  // An explicit state list always means a workflow module.
  let pattern = detectPattern(description);
  if (parsedStates.length > 0 && pattern === "record_list") {
    pattern = "multi_stage_pipeline";
  }

  if (pattern === "record_list") {
    return {
      template: {
        name: "",
        icon: "",
        description: "",

        information: [
          { name: "Name", type: "Text", ai_hint: "" },
        ],
      },
      suggestions: {
        detected_pattern: "record_list",
        recommended_fields: ["Name", "Code", "Description", "Active"],
        industry: resolvedIndustry,
        industry_defaults: indDefaults,
      },
      constraints: DESIGN_CONSTRAINTS,
      next_step:
        "Fill in the field definitions. Record list modules do not need states, activities, or flows. Then call validate_design.",
    };
  }

  const baseStates: Record<PatternName, any[]> = {
    approval_workflow: [
      { name: "Draft", color: "#5A6070", initial: true, ai_hint: "", ai_instruction: "" },
      { name: "Pending Approval", color: "#2968A8", ai_hint: "", ai_instruction: "" },
      { name: "Approved", color: "#1E6B45", ai_hint: "", ai_instruction: "" },
      { name: "Rejected", color: "#8B2D2D", ai_hint: "", ai_instruction: "" },
    ],
    ticket_management: [
      { name: "New", color: "#5A6070", initial: true, ai_hint: "", ai_instruction: "" },
      { name: "Triaged", color: "#2968A8", ai_hint: "", ai_instruction: "" },
      { name: "In Progress", color: "#2A7B50", ai_hint: "", ai_instruction: "" },
      { name: "Resolved", color: "#1E6B45", ai_hint: "", ai_instruction: "" },
      { name: "Closed", color: "#1E6B45", ai_hint: "", ai_instruction: "" },
    ],
    multi_stage_pipeline: [
      { name: "Not Started", color: "#5A6070", initial: true, ai_hint: "", ai_instruction: "" },
      { name: "In Progress", color: "#2A7B50", ai_hint: "", ai_instruction: "" },
      { name: "Review", color: "#2968A8", ai_hint: "", ai_instruction: "" },
      { name: "Completed", color: "#1E6B45", ai_hint: "", ai_instruction: "" },
      { name: "Cancelled", color: "#8B2D2D", ai_hint: "", ai_instruction: "" },
    ],
    record_list: [],
  };

  const baseActivities: Record<PatternName, any[]> = {
    approval_workflow: [
      { name: "Submit", actor: "hybrid", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: 0 },
      { name: "Approve", actor: "human", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: indDefaults.confidence_threshold },
      { name: "Reject", actor: "human", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: 0 },
    ],
    ticket_management: [
      { name: "Triage", actor: "hybrid", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: 0 },
      { name: "Assign", actor: "human", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: 0 },
      { name: "Resolve", actor: "human", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: 0 },
      { name: "Close", actor: "human", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: 0 },
    ],
    multi_stage_pipeline: [
      { name: "Start", actor: "human", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: 0 },
      { name: "Submit for Review", actor: "hybrid", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: 0 },
      { name: "Complete", actor: "human", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: 0 },
      { name: "Cancel", actor: "human", fields: [], ai_hint: "", ai_instruction: "", confidence_threshold: 0 },
    ],
    record_list: [],
  };

  const baseFlows: Record<PatternName, any[]> = {
    approval_workflow: [
      { from: "Draft", to: "Pending Approval", activity: "Submit" },
      { from: "Pending Approval", to: "Approved", activity: "Approve" },
      { from: "Pending Approval", to: "Rejected", activity: "Reject" },
    ],
    ticket_management: [
      { from: "New", to: "Triaged", activity: "Triage" },
      { from: "Triaged", to: "In Progress", activity: "Assign" },
      { from: "In Progress", to: "Resolved", activity: "Resolve" },
      { from: "Resolved", to: "Closed", activity: "Close" },
    ],
    multi_stage_pipeline: [
      { from: "Not Started", to: "In Progress", activity: "Start" },
      { from: "In Progress", to: "Review", activity: "Submit for Review" },
      { from: "Review", to: "Completed", activity: "Complete" },
      { from: "In Progress", to: "Cancelled", activity: "Cancel" },
    ],
    record_list: [],
  };

  const recommendedFields: Record<PatternName, string[]> = {
    approval_workflow: ["Title", "Requested By", "Amount", "Justification", "Attachments"],
    ticket_management: ["Title", "Priority", "Category", "Assignee", "Description", "Attachments"],
    multi_stage_pipeline: ["Title", "Owner", "Due Date", "Status Notes", "Attachments"],
    record_list: [],
  };

  // States the user enumerated take precedence over the pattern template —
  // colors come from the keyword suggester, the first state is initial, and
  // activities/flows are left for the agent to define (a wrong scaffold costs
  // more than an empty one).
  const useParsed = parsedStates.length > 0;
  const states = useParsed
    ? parsedStates.map((name, i) => ({
        name,
        color: suggestColorForState(name),
        ...(i === 0 ? { initial: true } : {}),
        ai_hint: "",
        ai_instruction: "",
      }))
    : baseStates[pattern];

  return {
    template: {
      name: "",
      icon: "",
      description: "",
      published: true,
      information: [
        { name: "Title", type: "Text", ai_hint: "" },
      ],
      states,
      activities: useParsed ? [] : baseActivities[pattern],
      flows: useParsed ? [] : baseFlows[pattern],
    },
    suggestions: {
      detected_pattern: pattern,
      recommended_fields: recommendedFields[pattern],
      recommended_states: states.map((s) => s.name),
      ...(useParsed ? { states_source: "parsed_from_description" } : {}),
      industry: resolvedIndustry,
      industry_defaults: {
        confidence_threshold: indDefaults.confidence_threshold,
        audit_fields: indDefaults.audit_fields,
        actor_suggestion: indDefaults.actor_suggestion,
      },
    },
    constraints: DESIGN_CONSTRAINTS,
    next_step: useParsed
      ? "States were taken from your description. Define the activities and flows that connect them, complete the fields, then call validate_design."
      : "Complete the template fields, then call validate_design with the finished schema.",
  };
}

