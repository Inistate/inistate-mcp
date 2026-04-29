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

const RUNTIME_OPERATIONS = [
  "list_workspaces",
  "get_workspace",
  "discover_modules",
  "get_module",
  "list_entries",
  "get_entry",
  "get_form",
  "submit_activity",
  "submit_activities",
  "get_history",
  "request_upload_url",
  "confirm_upload",
  "upload_file",
  "download_file",
];

const CONFIGURE_OPERATIONS = [
  "get_module_schema",
  "create_module",
  "update_module",
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

function buildSchemaView(
  definitionKeys: string[],
  operationKeys: string[],
  workflowKeys: string[],
): Record<string, any> {
  return {
    $schema: SCHEMA.$schema,
    title: SCHEMA.title,
    description: SCHEMA.description,
    version: SCHEMA.version,
    definitions: pickKeys(SCHEMA.definitions, definitionKeys),
    operations: {
      _description: SCHEMA.operations._description,
      ...pickKeys(SCHEMA.operations, operationKeys),
    },
    workflow_guide: pickKeys(SCHEMA.workflow_guide, workflowKeys),
  };
}

export const SCHEMA_RUNTIME = buildSchemaView(
  RUNTIME_DEFINITIONS,
  RUNTIME_OPERATIONS,
  RUNTIME_WORKFLOW_KEYS,
);

export const SCHEMA_CONFIGURE = buildSchemaView(
  CONFIGURE_DEFINITIONS,
  CONFIGURE_OPERATIONS,
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

  // Validate field types
  for (const f of information) {
    if (f.type && !isValidFieldType(f.type)) {
      errors.push(
        `Field '${f.name}' has invalid type '${f.type}'. Valid types: ${VALID_FIELD_TYPES.join(", ")}.`,
      );
    }
    // Table fields must have sub-fields
    if (f.type === "Table") {
      if (!f.fields || !Array.isArray(f.fields) || f.fields.length === 0) {
        errors.push(`Table field '${f.name}' has no sub-fields defined.`);
      } else {
        for (const sf of f.fields) {
          if (sf.type && !isValidFieldType(sf.type)) {
            errors.push(
              `Table field '${f.name}' sub-field '${sf.name}' has invalid type '${sf.type}'.`,
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

    // Validate state colors
    for (const s of states) {
      if (s.color && !isValidColor(s.color)) {
        errors.push(
          `State '${s.name}' has invalid color '${s.color}'. Valid colors: ${VALID_COLORS.join(", ")}.`,
        );
      }
      if (!s.color) {
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

      // Confidence threshold
      if (
        a.confidence_threshold !== undefined &&
        a.confidence_threshold !== null
      ) {
        if (a.confidence_threshold < 0 || a.confidence_threshold > 1) {
          errors.push(
            `Activity '${a.name}' confidence_threshold must be between 0 and 1.`,
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
  if (
    d.includes("list") ||
    d.includes("directory") ||
    d.includes("catalog") ||
    d.includes("registry") ||
    d.includes("lookup")
  ) {
    return "record_list";
  }
  if (
    d.includes("ticket") ||
    d.includes("support") ||
    d.includes("issue") ||
    d.includes("incident") ||
    d.includes("service")
  ) {
    return "ticket_management";
  }
  if (
    d.includes("pipeline") ||
    d.includes("stage") ||
    d.includes("onboard") ||
    d.includes("multi")
  ) {
    return "multi_stage_pipeline";
  }
  return "approval_workflow";
}

export function designWorkflow(
  description: string,
  industry: string = "general",
): DesignTemplate {
  const pattern = detectPattern(description);
  const indDefaults =
    INDUSTRY_DEFAULTS[industry] || INDUSTRY_DEFAULTS.general;

  if (pattern === "record_list") {
    return {
      template: {
        name: "",
        icon: "",
        description: "",

        information: [
          { name: "Name", type: "Text", ai_hint: "" },
          { name: "", type: "", ai_hint: "" },
        ],
      },
      suggestions: {
        detected_pattern: "record_list",
        recommended_fields: ["Name", "Code", "Description", "Active"],
        industry_defaults: indDefaults,
      },
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

  return {
    template: {
      name: "",
      icon: "",
      description: "",
      published: true,
      information: [
        { name: "Title", type: "Text", ai_hint: "" },
        { name: "", type: "", ai_hint: "" },
      ],
      states: baseStates[pattern],
      activities: baseActivities[pattern],
      flows: baseFlows[pattern],
    },
    suggestions: {
      detected_pattern: pattern,
      recommended_fields: recommendedFields[pattern],
      recommended_states: baseStates[pattern].map((s) => s.name),
      industry_defaults: {
        confidence_threshold: indDefaults.confidence_threshold,
        audit_fields: indDefaults.audit_fields,
        actor_suggestion: indDefaults.actor_suggestion,
      },
    },
    next_step:
      "Complete the template fields, then call validate_design with the finished schema.",
  };
}

