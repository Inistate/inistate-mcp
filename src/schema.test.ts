import { describe, it, expect } from "vitest";
import {
  isValidFieldType,
  isValidColor,
  isValidActor,
  suggestColorForState,
  validateDesign,
  designWorkflow,
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

  it("catches invalid state colors", () => {
    const schema = {
      ...minimalWorkflow,
      states: [
        { name: "Open", color: "#FF0000", initial: true },
        { name: "Closed", color: "#1E6B45" },
      ],
    };
    const result = validateDesign(schema);
    expect(result.errors.some((e) => e.includes("invalid color"))).toBe(true);
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
});

