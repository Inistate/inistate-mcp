import { describe, it, expect } from "vitest";
import {
  isValidFieldType,
  isValidColor,
  isValidActor,
  suggestColorForState,
  validateDesign,
  designWorkflow,
  normalizeFieldType,
  normalizeStateColor,
  normalizeIndustry,
  parseStatesFromDescription,
  parseFieldsFromDescription,
  VALID_FIELD_TYPES,
  VALID_COLORS,
  VALID_ACTOR_TYPES,
} from "./schema.js";

// ──────────────────────────────────────────────
// Helper functions
// ──────────────────────────────────────────────

describe("isValidFieldType", () => {
  it("accepts all canonical field types", () => {
    for (const t of VALID_FIELD_TYPES) {
      expect(isValidFieldType(t)).toBe(true);
    }
  });

  it("accepts Selection(...) shorthand", () => {
    expect(isValidFieldType("Selection(High/Medium/Low)")).toBe(true);
    expect(isValidFieldType("Selection(A)")).toBe(true);
  });

  it("rejects unknown types", () => {
    expect(isValidFieldType("Bogus")).toBe(false);
    expect(isValidFieldType("")).toBe(false);
  });
});

describe("isValidColor", () => {
  it("accepts palette colors", () => {
    for (const c of VALID_COLORS) {
      expect(isValidColor(c)).toBe(true);
    }
  });

  it("rejects arbitrary hex", () => {
    expect(isValidColor("#FF0000")).toBe(false);
    expect(isValidColor("red")).toBe(false);
  });
});

describe("isValidActor", () => {
  it("accepts valid actors", () => {
    for (const a of VALID_ACTOR_TYPES) {
      expect(isValidActor(a)).toBe(true);
    }
  });

  it("rejects unknown actors", () => {
    expect(isValidActor("robot")).toBe(false);
  });
});

describe("suggestColorForState", () => {
  it("returns dark green for terminal success keywords", () => {
    expect(suggestColorForState("Approved")).toBe("#1E6B45");
    expect(suggestColorForState("Completed")).toBe("#1E6B45");
    expect(suggestColorForState("resolved")).toBe("#1E6B45");
  });

  it("returns dark red for terminal failure keywords", () => {
    expect(suggestColorForState("Rejected")).toBe("#8B2D2D");
    expect(suggestColorForState("cancelled")).toBe("#8B2D2D");
  });

  it("returns grey for idle/draft keywords", () => {
    expect(suggestColorForState("Draft")).toBe("#5A6070");
    expect(suggestColorForState("Not Started")).toBe("#5A6070");
  });

  it("returns default blue for unknown state names", () => {
    expect(suggestColorForState("xyzzy123")).toBe("#2968A8");
  });
});

// ──────────────────────────────────────────────
// validateDesign
// ──────────────────────────────────────────────

describe("validateDesign", () => {
  const minimalWorkflow = {
    name: "Test Module",
    information: [
      { name: "Title", type: "Text" },
      { name: "Priority", type: "Selection", options: ["High", "Low"] },
    ],
    states: [
      { name: "Open", color: "#5A6070", initial: true },
      { name: "Closed", color: "#1E6B45" },
    ],
    activities: [
      { name: "Close", actor: "human", fields: ["Title"] },
    ],
    flows: [
      { from: "Open", to: "Closed", activity: "Close" },
    ],
  };

  it("passes a valid workflow schema", () => {
    const result = validateDesign(minimalWorkflow);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.summary).not.toBeNull();
    expect(result.summary!.state_count).toBe(2);
    expect(result.summary!.activity_count).toBe(1);
    expect(result.summary!.flow_count).toBe(1);
  });

  it("requires a module name in create mode", () => {
    const result = validateDesign({ ...minimalWorkflow, name: "" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Module name is required.");
  });

  it("allows missing name in update mode", () => {
    const result = validateDesign({ ...minimalWorkflow, name: "" }, "update");
    expect(result.valid).toBe(true);
  });

  it("catches duplicate field names", () => {
    const schema = {
      ...minimalWorkflow,
      information: [
        { name: "Title", type: "Text" },
        { name: "Title", type: "Text" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("Duplicate field name"))).toBe(true);
  });

  it("catches invalid field types", () => {
    const schema = {
      ...minimalWorkflow,
      information: [{ name: "Foo", type: "Bogus" }],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("invalid type 'Bogus'"))).toBe(true);
  });

  it("catches Table fields without sub-fields", () => {
    const schema = {
      ...minimalWorkflow,
      information: [{ name: "Details", type: "Table" }],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("no sub-fields"))).toBe(true);
  });

  it("catches invalid sub-field types in Table", () => {
    const schema = {
      ...minimalWorkflow,
      information: [
        { name: "Details", type: "Table", fields: [{ name: "Col1", type: "Nope" }] },
      ],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("sub-field 'Col1'") && e.includes("invalid type"))).toBe(true);
  });

  it("catches missing initial state", () => {
    const schema = {
      ...minimalWorkflow,
      states: [
        { name: "Open", color: "#5A6070" },
        { name: "Closed", color: "#1E6B45" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("No initial state"))).toBe(true);
  });

  it("catches multiple initial states", () => {
    const schema = {
      ...minimalWorkflow,
      states: [
        { name: "Open", color: "#5A6070", initial: true },
        { name: "Closed", color: "#1E6B45", initial: true },
      ],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("Multiple initial states"))).toBe(true);
  });

  it("catches duplicate state names", () => {
    const schema = {
      ...minimalWorkflow,
      states: [
        { name: "Open", color: "#5A6070", initial: true },
        { name: "Open", color: "#1E6B45" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("Duplicate state name"))).toBe(true);
  });

  it("normalizes off-palette state colors with a warning instead of erroring", () => {
    const schema = {
      ...minimalWorkflow,
      states: [
        { name: "Open", color: "#FF0000", initial: true },
        { name: "Closed", color: "#1E6B45" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("'Open'") && w.includes("normalized to '#C0392B'"))).toBe(true);
  });

  it("catches duplicate activity names", () => {
    const schema = {
      ...minimalWorkflow,
      activities: [
        { name: "Close", actor: "human" },
        { name: "Close", actor: "ai" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("Duplicate activity name"))).toBe(true);
  });

  it("catches invalid actor type", () => {
    const schema = {
      ...minimalWorkflow,
      activities: [{ name: "Close", actor: "robot" }],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("invalid actor"))).toBe(true);
  });

  it("catches activity referencing undefined field", () => {
    const schema = {
      ...minimalWorkflow,
      activities: [{ name: "Close", actor: "human", fields: ["NonExistent"] }],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("'NonExistent'") && e.includes("not defined"))).toBe(true);
  });

  it("catches flow referencing undefined state", () => {
    const schema = {
      ...minimalWorkflow,
      flows: [{ from: "Open", to: "Ghost", activity: "Close" }],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("'Ghost'"))).toBe(true);
  });

  it("catches flow referencing undefined activity", () => {
    const schema = {
      ...minimalWorkflow,
      flows: [{ from: "Open", to: "Closed", activity: "Ghost" }],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("'Ghost'"))).toBe(true);
  });

  it("resolves flows that reference state/activity ids to names", () => {
    const schema = {
      ...minimalWorkflow,
      states: [
        { id: "s1", name: "Open", color: "#5A6070", initial: true },
        { id: "s2", name: "Closed", color: "#1E6B45" },
      ],
      activities: [{ id: "a1", name: "Close", actor: "human", fields: ["Title"] }],
      flows: [{ from: "s1", to: "s2", activity: "a1" }],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("'s1'") && w.includes("'Open'"))).toBe(true);
  });

  it("never resolves an id when it collides with a declared name", () => {
    const schema = {
      ...minimalWorkflow,
      states: [
        { id: "s1", name: "Open", color: "#5A6070", initial: true },
        { name: "s1", color: "#1E6B45" },
      ],
      flows: [{ from: "Open", to: "s1", activity: "Close" }],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(true);
    expect(result.warnings.every((w) => !w.includes("resolved"))).toBe(true);
  });

  it("resolves activity field refs that reference field ids", () => {
    const schema = {
      ...minimalWorkflow,
      information: [{ id: "f1", name: "Title", type: "Text" }],
      activities: [{ name: "Close", actor: "human", fields: ["f1"] }],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("reads confidence_threshold above 1 as a percentage", () => {
    const schema = {
      ...minimalWorkflow,
      activities: [
        { name: "Close", actor: "ai", ai_hint: "close it", fields: ["Title"], confidence_threshold: 80 },
      ],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("normalized to 0.8"))).toBe(true);
  });

  it("rejects confidence_threshold above 100", () => {
    const schema = {
      ...minimalWorkflow,
      activities: [{ name: "Close", actor: "human", confidence_threshold: 101 }],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("confidence_threshold"))).toBe(true);
  });

  it("warns about unreachable states", () => {
    const schema = {
      ...minimalWorkflow,
      states: [
        { name: "Open", color: "#5A6070", initial: true },
        { name: "Closed", color: "#1E6B45" },
        { name: "Orphan", color: "#2968A8" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.warnings.some((w) => w.includes("'Orphan'") && w.includes("unreachable"))).toBe(true);
  });

  it("warns about unused activities", () => {
    const schema = {
      ...minimalWorkflow,
      activities: [
        { name: "Close", actor: "human", fields: ["Title"] },
        { name: "Orphan", actor: "human" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.warnings.some((w) => w.includes("'Orphan'") && w.includes("not used"))).toBe(true);
  });

  it("warns about AI activities without confidence threshold", () => {
    const schema = {
      ...minimalWorkflow,
      activities: [{ name: "Close", actor: "ai", fields: ["Title"] }],
    };
    const result = validateDesign(schema);
    expect(result.warnings.some((w) => w.includes("no confidence_threshold"))).toBe(true);
  });

  it("warns about missing state colors", () => {
    const schema = {
      ...minimalWorkflow,
      states: [
        { name: "Open", initial: true },
        { name: "Closed", color: "#1E6B45" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.warnings.some((w) => w.includes("'Open'") && w.includes("no color"))).toBe(true);
  });

  // Record list module
  it("passes a valid record list module (no states)", () => {
    const schema = {
      name: "Contacts",
      information: [
        { name: "Name", type: "Text" },
        { name: "Email", type: "Email" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(true);
    expect(result.summary).toMatchObject({ module_type: "record_list", field_count: 2 });
  });
});

// ──────────────────────────────────────────────
// validateDesign — platform parity
// (mirrors FETIAS InistateSchema.Validator so validate→create cannot 422)
// ──────────────────────────────────────────────

describe("validateDesign — platform parity", () => {
  const base = { name: "Projects" };

  it("requires connection on User fields", () => {
    const result = validateDesign({
      ...base,
      information: [{ name: "Owner", type: "User" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("'Owner'") && e.includes("missing 'connection'"))).toBe(true);
  });

  it("requires connection on Modules fields", () => {
    const result = validateDesign({
      ...base,
      information: [{ name: "Linked", type: "Modules" }],
    });
    expect(result.errors.some((e) => e.includes("missing 'connection'"))).toBe(true);
  });

  it("accepts reference fields that carry connection", () => {
    const result = validateDesign({
      ...base,
      information: [
        { name: "Owner", type: "User", connection: "Members" },
        { name: "Client", type: "Module", connection: "Clients" },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects connection on non-reference types", () => {
    const result = validateDesign({
      ...base,
      information: [{ name: "Title", type: "Text", connection: "Clients" }],
    });
    expect(result.errors.some((e) => e.includes("not a reference type"))).toBe(true);
  });

  it("requires a type on every field", () => {
    const result = validateDesign({
      ...base,
      information: [{ name: "Untyped" }],
    });
    expect(result.errors.some((e) => e.includes("'Untyped'") && e.includes("missing a 'type'"))).toBe(true);
  });

  it("requires a name on every field", () => {
    const result = validateDesign({
      ...base,
      information: [{ type: "Text" }],
    });
    expect(result.errors.some((e) => e.includes("index 0") && e.includes("missing a 'name'"))).toBe(true);
  });

  it("requires options on Selection/Tag fields", () => {
    const result = validateDesign({
      ...base,
      information: [{ name: "Priority", type: "Selection" }],
    });
    expect(result.errors.some((e) => e.includes("'Priority'") && e.includes("no options"))).toBe(true);
  });

  it("accepts inline Selection(...) shorthand without options", () => {
    const result = validateDesign({
      ...base,
      information: [{ name: "Priority", type: "Selection(High/Low)" }],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects reference types inside Table sub-fields", () => {
    const result = validateDesign({
      ...base,
      information: [
        {
          name: "Rows",
          type: "Table",
          fields: [{ name: "Assignee", type: "User" }],
        },
      ],
    });
    expect(result.errors.some((e) => e.includes("'Assignee'") && e.includes("not supported inside Table sub-fields"))).toBe(true);
  });

  it("warns that 'required' is ignored on information fields", () => {
    const result = validateDesign({
      ...base,
      information: [{ name: "Title", type: "Text", required: true }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("'Title'") && w.includes("'required'"))).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Input normalization
// ──────────────────────────────────────────────

describe("normalizeFieldType", () => {
  it("passes canonical types through unchanged", () => {
    expect(normalizeFieldType("Text")).toEqual({ type: "Text", changed: false });
    expect(normalizeFieldType("MultiText")).toEqual({ type: "MultiText", changed: false });
  });

  it("maps common aliases to canonical types", () => {
    expect(normalizeFieldType("Select")).toEqual({ type: "Selection", changed: true });
    expect(normalizeFieldType("TextArea")).toEqual({ type: "MultiText", changed: true });
    expect(normalizeFieldType("LongText")).toEqual({ type: "MultiText", changed: true });
    expect(normalizeFieldType("Paragraph")).toEqual({ type: "MultiText", changed: true });
    expect(normalizeFieldType("MultilineText")).toEqual({ type: "MultiText", changed: true });
  });

  it("fixes casing and internal spaces", () => {
    expect(normalizeFieldType("text")).toEqual({ type: "Text", changed: true });
    expect(normalizeFieldType("Long Text")).toEqual({ type: "MultiText", changed: true });
    expect(normalizeFieldType("Date Time")).toEqual({ type: "DateTime", changed: true });
    expect(normalizeFieldType("user")).toEqual({ type: "User", changed: true });
  });

  it("preserves inline option syntax", () => {
    expect(normalizeFieldType("Select(High/Low)")).toEqual({ type: "Selection(High/Low)", changed: true });
    expect(normalizeFieldType("Selection(High/Low)")).toEqual({ type: "Selection(High/Low)", changed: false });
  });

  it("passes unknown types through for validation to report", () => {
    expect(normalizeFieldType("Bogus")).toEqual({ type: "Bogus", changed: false });
    expect(normalizeFieldType(undefined)).toEqual({ type: undefined, changed: false });
  });
});

describe("normalizeStateColor", () => {
  it("passes palette colors through unchanged", () => {
    expect(normalizeStateColor("#A07828", "On Hold")).toEqual({ color: "#A07828", changed: false });
  });

  it("maps color names to the palette", () => {
    expect(normalizeStateColor("gray", "Draft")).toEqual({ color: "#5A6070", changed: true });
    expect(normalizeStateColor("dark red", "Escalated")).toEqual({ color: "#8B2D2D", changed: true });
    expect(normalizeStateColor("amber", "On Hold")).toEqual({ color: "#A07828", changed: true });
  });

  it("snaps off-palette hex to the nearest palette color", () => {
    expect(normalizeStateColor("#D4A017", "On Hold")).toEqual({ color: "#A07828", changed: true });
    expect(normalizeStateColor("#FF0000", "Failed")).toEqual({ color: "#C0392B", changed: true });
  });

  it("treats case-different palette hex as unchanged", () => {
    expect(normalizeStateColor("#a07828", "On Hold")).toEqual({ color: "#A07828", changed: false });
  });

  it("falls back to the state-name suggestion for unrecognizable values", () => {
    expect(normalizeStateColor("banana", "Completed")).toEqual({ color: "#1E6B45", changed: true });
  });

  it("leaves missing colors alone", () => {
    expect(normalizeStateColor(undefined, "Open")).toEqual({ color: undefined, changed: false });
  });
});

describe("normalizeIndustry", () => {
  it("passes known keys through", () => {
    expect(normalizeIndustry("healthcare")).toBe("healthcare");
    expect(normalizeIndustry("financial_services")).toBe("financial_services");
  });

  it("maps free text to known keys", () => {
    expect(normalizeIndustry("Medical clinic")).toBe("healthcare");
    expect(normalizeIndustry("Banking")).toBe("financial_services");
    expect(normalizeIndustry("IT")).toBe("it_service");
    expect(normalizeIndustry("Human Resources")).toBe("hr");
  });

  it("falls back to general for unknown or missing text", () => {
    expect(normalizeIndustry("Professional Services")).toBe("general");
    expect(normalizeIndustry(undefined)).toBe("general");
  });
});

describe("parseStatesFromDescription", () => {
  it("parses an explicit lifecycle state list", () => {
    const states = parseStatesFromDescription(
      "Track client projects. Lifecycle states: Proposed, Active, On Hold, Completed, Cancelled. Activities: create and edit.",
    );
    expect(states).toEqual(["Proposed", "Active", "On Hold", "Completed", "Cancelled"]);
  });

  it("parses 'states like …' phrasing and stops at a closing paren", () => {
    const states = parseStatesFromDescription(
      "status (state-based workflow with states like Planning, In Progress, On Hold, Completed, Cancelled), start date (date)",
    );
    expect(states).toEqual(["Planning", "In Progress", "On Hold", "Completed", "Cancelled"]);
  });

  it("parses a parenthesized status list", () => {
    const states = parseStatesFromDescription(
      "Each project has a status (Not Started, In Progress, Done) and an owner.",
    );
    expect(states).toEqual(["Not Started", "In Progress", "Done"]);
  });

  it("returns [] when no state list is present", () => {
    expect(parseStatesFromDescription("an approval process for purchase requests")).toEqual([]);
    expect(parseStatesFromDescription("status (state field)")).toEqual([]);
  });
});

describe("parseFieldsFromDescription", () => {
  it("parses a typed field enumeration, defaulting unsafe types to Text", () => {
    const fields = parseFieldsFromDescription(
      "Track client projects with the following fields: project name (text), client (text - the client company name), status (workflow state), start date (date), deadline (date), owner (user responsible for the project), and budget (currency/number).",
    );
    expect(fields).toEqual([
      { name: "Project Name", type: "Text" },
      { name: "Client", type: "Text" },
      { name: "Status", type: "Text" }, // "workflow" is not a type → Text
      { name: "Start Date", type: "Date" },
      { name: "Deadline", type: "Date" },
      { name: "Owner", type: "Text" }, // User needs a connection → collapsed to Text
      { name: "Budget", type: "Currency" }, // "currency/number" → leading token
    ]);
  });

  it("parses an untyped 'fields like …' list as Text", () => {
    const fields = parseFieldsFromDescription("a tracker with fields like Title, Owner, Due Date");
    expect(fields).toEqual([
      { name: "Title", type: "Text" },
      { name: "Owner", type: "Text" },
      { name: "Due Date", type: "Text" },
    ]);
  });

  it("never emits a reference or option-requiring type a scaffold can't satisfy", () => {
    const fields = parseFieldsFromDescription(
      "fields: priority (selection), assignee (user), parent (module), amount (currency)",
    );
    expect(fields.map((f) => f.type)).toEqual(["Text", "Text", "Text", "Currency"]);
  });

  it("returns [] when no field enumeration is present", () => {
    expect(parseFieldsFromDescription("an approval process for purchase requests")).toEqual([]);
    expect(parseFieldsFromDescription("a single field: just a name")).toEqual([]); // needs ≥2
  });
});

describe("validateDesign — input normalization", () => {
  const base = { name: "Projects" };

  it("accepts alias types with a normalization warning", () => {
    const result = validateDesign({
      ...base,
      information: [
        { name: "Priority", type: "Select", options: ["High", "Low"] },
        { name: "Notes", type: "LongText" },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("'Priority'") && w.includes("normalized to 'Selection'"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("'Notes'") && w.includes("normalized to 'MultiText'"))).toBe(true);
  });

  it("still requires options for a normalized Select", () => {
    const result = validateDesign({
      ...base,
      information: [{ name: "Priority", type: "Select" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("'Priority'") && e.includes("no options"))).toBe(true);
  });

  it("normalizes {value,label} option objects to strings with a warning", () => {
    const schema = {
      ...base,
      information: [
        {
          name: "Priority",
          type: "Selection",
          options: [{ value: "low", label: "Low" }, { value: "High" }, "Medium"],
        },
      ],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(true);
    expect(schema.information[0].options).toEqual(["Low", "High", "Medium"]);
    expect(result.warnings.some((w) => w.includes("'Priority'") && w.includes("normalized to plain strings"))).toBe(true);
  });

  it("aliases fromState/toState flow keys instead of erroring on 'undefined'", () => {
    const schema = {
      ...base,
      information: [{ name: "Title", type: "Text" }],
      states: [
        { name: "Open", color: "#5A6070", initial: true },
        { name: "Closed", color: "#1E6B45" },
      ],
      activities: [{ name: "Close", actor: "human" }],
      flows: [{ fromState: "Open", toState: "Closed", activity: "Close" }],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("'fromState'/'toState'"))).toBe(true);
    expect(result.errors.some((e) => e.includes("undefined"))).toBe(false);
  });

  it("reads a flow's plural 'activities' as 'activity' instead of erroring on 'undefined'", () => {
    const schema = {
      ...base,
      information: [{ name: "Title", type: "Text" }],
      states: [
        { name: "Open", color: "#5A6070", initial: true },
        { name: "Closed", color: "#1E6B45" },
      ],
      activities: [{ name: "Close", actor: "human" }],
      flows: [{ name: "Resolve", from: "Open", to: "Closed", activities: ["Close"] }],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("a flow takes a single 'activity'"))).toBe(true);
    expect(result.errors.some((e) => e.includes("undefined"))).toBe(false);
  });

  it("reports flows missing from/to/activity once, not as 'undefined' states", () => {
    const schema = {
      ...base,
      information: [{ name: "Title", type: "Text" }],
      states: [
        { name: "Open", color: "#5A6070", initial: true },
        { name: "Closed", color: "#1E6B45" },
      ],
      activities: [{ name: "Close", actor: "human" }],
      flows: [{ source: "Open", target: "Closed" }],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(false);
    const missing = result.errors.filter((e) => e.includes("is missing"));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("'from', 'to', 'activity'");
    expect(result.errors.some((e) => e.includes("'undefined'"))).toBe(false);
  });

  it("uses displayName/label as the name when name is missing", () => {
    const schema = {
      ...base,
      information: [
        { displayName: "Project Name", type: "Text" },
        { label: "Notes", type: "MultiText" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.valid).toBe(true);
    expect(schema.information[0]).toMatchObject({ name: "Project Name" });
    expect(schema.information[1]).toMatchObject({ name: "Notes" });
    expect(result.warnings.some((w) => w.includes("'displayName' is not a schema key"))).toBe(true);
  });

  it("warns that label is ignored when name is also present", () => {
    const result = validateDesign({
      ...base,
      information: [{ name: "projectName", label: "Project Name", type: "Text" }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("'projectName'") && w.includes("'label' is ignored"))).toBe(true);
  });
});

// ──────────────────────────────────────────────
// designWorkflow
// ──────────────────────────────────────────────

describe("designWorkflow", () => {
  it("detects approval_workflow pattern", () => {
    const result = designWorkflow("I need an approval process for purchase requests");
    expect(result.suggestions.detected_pattern).toBe("approval_workflow");
    expect(result.template.states).toBeDefined();
    expect(result.template.states.length).toBeGreaterThan(0);
    expect(result.template.flows.length).toBeGreaterThan(0);
  });

  it("detects ticket_management pattern", () => {
    const result = designWorkflow("support ticket system for customer issues");
    expect(result.suggestions.detected_pattern).toBe("ticket_management");
  });

  it("detects multi_stage_pipeline pattern", () => {
    const result = designWorkflow("employee onboarding pipeline with multiple stages");
    expect(result.suggestions.detected_pattern).toBe("multi_stage_pipeline");
  });

  it("detects record_list pattern", () => {
    const result = designWorkflow("a directory of all our vendors");
    expect(result.suggestions.detected_pattern).toBe("record_list");
    expect(result.template.states).toBeUndefined();
  });

  it("applies industry defaults for financial_services", () => {
    const result = designWorkflow("approval workflow", "financial_services");
    expect(result.suggestions.industry_defaults.confidence_threshold).toBe(0.9);
    expect(result.suggestions.industry_defaults.audit_fields).toContain("Compliance Note");
  });

  it("applies industry defaults for healthcare", () => {
    const result = designWorkflow("approval workflow", "healthcare");
    expect(result.suggestions.industry_defaults.confidence_threshold).toBe(0.9);
    expect(result.suggestions.industry_defaults.audit_fields).toContain("HIPAA Flag");
  });

  it("falls back to general defaults for unknown industry", () => {
    const result = designWorkflow("approval workflow", "unknown_industry");
    expect(result.suggestions.industry_defaults.confidence_threshold).toBe(0.8);
  });

  it("returns a next_step instruction", () => {
    const result = designWorkflow("approval workflow");
    expect(result.next_step).toBeTruthy();
  });

  it("lifts enumerated fields from the description into the template", () => {
    const result = designWorkflow(
      "Track client projects. Lifecycle: Draft, Active, Completed. Fields: project name (text), client (text), deadline (date), budget (currency).",
    );
    expect(result.template.information).toEqual([
      { name: "Project Name", type: "Text", ai_hint: "" },
      { name: "Client", type: "Text", ai_hint: "" },
      { name: "Deadline", type: "Date", ai_hint: "" },
      { name: "Budget", type: "Currency", ai_hint: "" },
    ]);
    expect(result.suggestions.fields_source).toBe("parsed_from_description");
    // The parsed fields carry no reference/option landmines: once the agent
    // supplies the (intentionally blank) module name, the scaffold validates.
    expect(validateDesign({ ...result.template, name: "Client Projects" }).valid).toBe(true);
  });

  it("keeps the single-Title placeholder when no fields are enumerated", () => {
    const result = designWorkflow("an approval process for purchase requests");
    expect(result.template.information).toEqual([{ name: "Title", type: "Text", ai_hint: "" }]);
    expect(result.suggestions.fields_source).toBeUndefined();
  });

  it("templates have consistent structure", () => {
    const result = designWorkflow("approval workflow");
    // Every activity referenced in flows exists in activities
    const activityNames = new Set(result.template.activities.map((a: any) => a.name));
    for (const flow of result.template.flows) {
      expect(activityNames.has(flow.activity)).toBe(true);
    }
    // Every state referenced in flows exists in states
    const stateNames = new Set(result.template.states.map((s: any) => s.name));
    for (const flow of result.template.flows) {
      expect(stateNames.has(flow.from)).toBe(true);
      expect(stateNames.has(flow.to)).toBe(true);
    }
  });

  it("ships the design constraints with every response", () => {
    for (const result of [designWorkflow("approval workflow"), designWorkflow("a directory of vendors")]) {
      expect(result.constraints.field_types).toContain("Selection");
      expect(result.constraints.state_colors).toContain("#5A6070");
      expect(result.constraints.reference_fields).toContain("connection");
      expect(result.constraints.actors).toContain("hybrid");
    }
  });

  it("contains no placeholder rows in templates", () => {
    for (const result of [designWorkflow("approval workflow"), designWorkflow("a directory of vendors")]) {
      for (const f of result.template.information) {
        expect(f.name).toBeTruthy();
        expect(f.type).toBeTruthy();
      }
    }
  });

  it("uses states enumerated in the description over the pattern template", () => {
    const result = designWorkflow(
      "Track client projects. Lifecycle states: Proposed, Active, On Hold, Completed, Cancelled. Each project has an owner and budget.",
    );
    expect(result.template.states.map((s: any) => s.name)).toEqual([
      "Proposed", "Active", "On Hold", "Completed", "Cancelled",
    ]);
    expect(result.template.states[0].initial).toBe(true);
    for (const s of result.template.states) {
      expect(VALID_COLORS).toContain(s.color);
    }
    // No invented flows — the agent defines them.
    expect(result.template.activities).toEqual([]);
    expect(result.template.flows).toEqual([]);
    expect(result.suggestions.states_source).toBe("parsed_from_description");
    expect(result.suggestions.recommended_states).toEqual(result.template.states.map((s: any) => s.name));
  });

  it("never detects record_list when lifecycle language is present", () => {
    const result = designWorkflow(
      "Module to track client projects with lifecycle states: Proposed, Active, Completed. Include list view fields.",
    );
    expect(result.suggestions.detected_pattern).not.toBe("record_list");
  });

  it("maps free-text industry and reports the resolution", () => {
    const medical = designWorkflow("approval workflow", "Medical Clinic");
    expect(medical.suggestions.industry).toBe("healthcare");
    expect(medical.suggestions.industry_defaults.confidence_threshold).toBe(0.9);

    const consulting = designWorkflow("approval workflow", "Professional Services");
    expect(consulting.suggestions.industry).toBe("general");
    expect(consulting.suggestions.industry_defaults.confidence_threshold).toBe(0.8);
  });
});

