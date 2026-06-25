import { describe, it, expect, beforeEach, vi } from "vitest";
import * as api from "./api.js";
import {
  __resetGuardCaches,
  clearFlagged,
  evaluateActivity,
  getModuleFieldTypes,
  getPriorFlag,
  recordFlagged,
  resolveInputKeys,
  validateInputShapes,
  validateInputShapesWith,
} from "./activity-guard.js";

const SCHEMA = {
  activities: [
    { name: "Approve", actor: "human" },
    { name: "Reject", actor: "human" },
    { name: "Submit", actor: "hybrid" },
    { name: "AutoTriage", actor: "ai" },
  ],
};

beforeEach(() => {
  __resetGuardCaches();
  vi.spyOn(api, "get").mockImplementation(async () => SCHEMA);
});

describe("evaluateActivity — actor enforcement", () => {
  it("blocks activities with actor='human'", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "Approve",
      entryId: 1,
      confidence: 0.99,
      confirmed: true, // even with confirmed
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.structured.error).toBe("human_actor_blocked");
    }
  });

  it("blocks hybrid activities without confirmed", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "Submit",
      entryId: 1,
      confidence: 0.9,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.structured.error).toBe("hybrid_requires_confirmation");
    }
  });

  it("allows hybrid activities when confirmed=true", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "Submit",
      entryId: 1,
      confidence: 0.9,
      confirmed: true,
    });
    expect(result.ok).toBe(true);
  });

  it("allows actor='ai' activities without confirmation", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "AutoTriage",
      entryId: 1,
      confidence: 0.9,
    });
    expect(result.ok).toBe(true);
  });

  it("allows unknown activities (lets API decide)", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "DoesNotExist",
      entryId: 1,
      confidence: 0.9,
    });
    expect(result.ok).toBe(true);
  });
});

// The production extended tier returns activities as plain strings (names
// only) — actor data lives in the canvas. The guard must resolve actors
// through the canvas or rules 3 & 4 never fire.
describe("evaluateActivity — actor resolution via canvas fallback", () => {
  const STRING_TIER = {
    activities: ["create", "edit", "Approve", "Submit", "AutoTriage"],
  };
  const CANVAS = {
    activities: [
      { name: "Approve", actor: "human" },
      { name: "Submit", actor: "hybrid" },
      { name: "AutoTriage", actor: "ai" },
    ],
  };

  beforeEach(() => {
    vi.spyOn(api, "get").mockImplementation(async (path: string) =>
      path.startsWith("/api/configure/") ? CANVAS : STRING_TIER,
    );
  });

  it("blocks human-actor activities when the extended tier has names only", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "Approve",
      entryId: 1,
      confidence: 0.99,
      confirmed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.structured.error).toBe("human_actor_blocked");
    }
  });

  it("requires confirmation for hybrid activities resolved via canvas", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "Submit",
      entryId: 1,
      confidence: 0.9,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.structured.error).toBe("hybrid_requires_confirmation");
    }
  });

  it("allows ai-actor activities resolved via canvas", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "AutoTriage",
      entryId: 1,
      confidence: 0.9,
    });
    expect(result.ok).toBe(true);
  });

  it("lets the API decide when the canvas is unavailable", async () => {
    vi.spyOn(api, "get").mockImplementation(async (path: string) => {
      if (path.startsWith("/api/configure/")) throw new Error("403 Forbidden");
      return STRING_TIER;
    });
    const result = await evaluateActivity({
      module: "Leave",
      activity: "Approve",
      entryId: 1,
      confidence: 0.9,
    });
    expect(result.ok).toBe(true);
  });
});

describe("evaluateActivity — target-state pre-flight", () => {
  const SCHEMA_WITH_STATES = {
    activities: [{ name: "Approve", actor: "human" }],
    states: ["Draft", "Active", "Done"],
  };

  beforeEach(() => {
    vi.spyOn(api, "get").mockImplementation(async () => SCHEMA_WITH_STATES);
  });

  it("rejects unknown target states before the confirmation dance", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "edit",
      entryId: 1,
      state: "On Hold",
      confidence: 0.9,
      confirmed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.structured.error).toBe("unknown_state");
      expect(String(result.structured.message)).toContain("Draft, Active, Done");
    }
  });

  it("allows known target states when confirmed", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "edit",
      entryId: 1,
      state: "Active",
      confidence: 0.9,
      confirmed: true,
    });
    expect(result.ok).toBe(true);
  });

  it("blocks the 'changeState' alias without confirmation", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "changeState",
      entryId: 1,
      state: "Active",
      confidence: 0.9,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.structured.error).toBe("state_change_requires_confirmation");
    }
  });
});

describe("evaluateActivity — state-change enforcement", () => {
  it("blocks 'changeStatus' without confirmation", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "changeStatus",
      entryId: 1,
      confidence: 0.9,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.structured.error).toBe("state_change_requires_confirmation");
    }
  });

  it("allows 'changeStatus' when confirmed", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "changeStatus",
      entryId: 1,
      confidence: 0.9,
      confirmed: true,
    });
    expect(result.ok).toBe(true);
  });

  it("blocks state override on standard activities without confirmation", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "edit",
      entryId: 1,
      state: "Approved",
      confidence: 0.9,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.structured.error).toBe("state_override_requires_confirmation");
    }
  });

  it("allows standard activities (e.g. 'edit') without confirmation when no state override", async () => {
    const result = await evaluateActivity({
      module: "Leave",
      activity: "edit",
      entryId: 1,
      confidence: 0.9,
    });
    expect(result.ok).toBe(true);
  });
});

describe("evaluateActivity — confidence inflation", () => {
  it("blocks higher-confidence retry after a flag", async () => {
    recordFlagged("Leave", 1, "AutoTriage", 0.5);
    const result = await evaluateActivity({
      module: "Leave",
      activity: "AutoTriage",
      entryId: 1,
      confidence: 0.9,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.structured.error).toBe("confidence_inflation_blocked");
      expect(result.structured.previous_flagged_confidence).toBe(0.5);
      expect(result.structured.current_confidence).toBe(0.9);
    }
  });

  it("allows same-or-lower confidence after a flag (transition still suppressed by API)", async () => {
    recordFlagged("Leave", 1, "AutoTriage", 0.5);
    const result = await evaluateActivity({
      module: "Leave",
      activity: "AutoTriage",
      entryId: 1,
      confidence: 0.5,
    });
    expect(result.ok).toBe(true);
  });

  it("allows confidence inflation when user explicitly confirms", async () => {
    recordFlagged("Leave", 1, "AutoTriage", 0.5);
    const result = await evaluateActivity({
      module: "Leave",
      activity: "AutoTriage",
      entryId: 1,
      confidence: 0.9,
      confirmed: true,
    });
    expect(result.ok).toBe(true);
  });

  it("clears the flag after a successful submission", async () => {
    recordFlagged("Leave", 1, "AutoTriage", 0.5);
    clearFlagged("Leave", 1, "AutoTriage");
    const result = await evaluateActivity({
      module: "Leave",
      activity: "AutoTriage",
      entryId: 1,
      confidence: 0.9,
    });
    expect(result.ok).toBe(true);
  });

  it("blocks bulk inflation when any target was previously flagged", async () => {
    recordFlagged("Leave", 7, "AutoTriage", 0.4);
    const result = await evaluateActivity({
      module: "Leave",
      activity: "AutoTriage",
      entryIds: [5, 7, 9],
      confidence: 0.85,
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateInputShapes — User/Module pre-flight", () => {
  const SCHEMA_WITH_REFS = {
    activities: [],
    information: [
      { name: "Title", type: "Text" },
      { name: "Assignee", type: "User" },
      { name: "Reviewers", type: "Users" },
      { name: "Linked Ticket", type: "Module" },
      { name: "Related Tickets", type: "Modules" },
    ],
  };

  beforeEach(() => {
    __resetGuardCaches();
    vi.spyOn(api, "get").mockImplementation(async () => SCHEMA_WITH_REFS);
  });

  it("accepts well-shaped User and Module values", async () => {
    const errs = await validateInputShapes("Ticket", {
      Title: "hello",
      Assignee: { id: 42, value: "Jane Doe", username: "jdoe" },
      Reviewers: [
        { id: 1, value: "Alice", username: "alice" },
        { id: 2, value: "Bob", username: "bob" },
      ],
      "Linked Ticket": { id: "T-1", value: "Parent" },
      "Related Tickets": [{ id: 7, value: "Sibling" }],
    });
    expect(errs).toEqual([]);
  });

  it("rejects a bare id for User", async () => {
    const errs = await validateInputShapes("Ticket", { Assignee: 42 });
    expect(errs.length).toBe(1);
    expect(errs[0].field).toBe("Assignee");
    expect(errs[0].type).toBe("User");
  });

  it("rejects a bare string for Module", async () => {
    const errs = await validateInputShapes("Ticket", { "Linked Ticket": "T-1" });
    expect(errs.length).toBe(1);
    expect(errs[0].type).toBe("Module");
  });

  it("rejects an object missing 'value'", async () => {
    const errs = await validateInputShapes("Ticket", {
      Assignee: { id: 42, username: "jdoe" },
    });
    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/value/);
  });

  it("rejects an object missing 'id'", async () => {
    const errs = await validateInputShapes("Ticket", {
      Assignee: { value: "Jane Doe", username: "jdoe" },
    });
    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/id/);
  });

  it("rejects a User missing 'username'", async () => {
    const errs = await validateInputShapes("Ticket", {
      Assignee: { id: 42, value: "Jane Doe" },
    });
    expect(errs.length).toBe(1);
    expect(errs[0].type).toBe("User");
    expect(errs[0].message).toMatch(/username/);
  });

  it("rejects a Users element missing 'username'", async () => {
    const errs = await validateInputShapes("Ticket", {
      Reviewers: [
        { id: 1, value: "Alice", username: "alice" },
        { id: 2, value: "Bob" },
      ],
    });
    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/username/);
  });

  it("does NOT require username on Module fields", async () => {
    const errs = await validateInputShapes("Ticket", {
      "Linked Ticket": { id: "T-1", value: "Parent" },
    });
    expect(errs).toEqual([]);
  });

  it("rejects display names standing in as ids", async () => {
    const errs = await validateInputShapes("Ticket", {
      Assignee: { id: "carol", value: "Carol", username: "carol" },
      "Linked Ticket": { id: "Gamma Inc", value: "Gamma Inc" },
    });
    expect(errs.length).toBe(2);
    expect(errs[0].message).toMatch(/display name/);
    expect(errs[1].message).toMatch(/display name/);
  });

  it("accepts numeric-string and document-style ids", async () => {
    const errs = await validateInputShapes("Ticket", {
      Assignee: { id: "803224", value: "Carol", username: "carol" },
      "Linked Ticket": { id: "CLN00001", value: "Parent" },
    });
    expect(errs).toEqual([]);
  });

  it("rejects a non-array for Users (plural)", async () => {
    const errs = await validateInputShapes("Ticket", {
      Reviewers: { id: 1, value: "Alice", username: "alice" },
    });
    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/array/);
  });

  it("rejects a malformed element in a Users array", async () => {
    const errs = await validateInputShapes("Ticket", {
      Reviewers: [
        { id: 1, value: "Alice", username: "alice" },
        { id: 2 },
      ],
    });
    expect(errs.length).toBe(1);
    expect(errs[0].field).toBe("Reviewers");
  });

  it("allows null to clear a User field", async () => {
    const errs = await validateInputShapes("Ticket", { Assignee: null });
    expect(errs).toEqual([]);
  });

  it("allows empty array for Users", async () => {
    const errs = await validateInputShapes("Ticket", { Reviewers: [] });
    expect(errs).toEqual([]);
  });

  it("ignores non-reference field types", async () => {
    const errs = await validateInputShapes("Ticket", { Title: "anything" });
    expect(errs).toEqual([]);
  });

  it("returns [] when the schema cannot be loaded (lets server decide)", async () => {
    vi.spyOn(api, "get").mockImplementation(async () => {
      throw new Error("schema fetch failed");
    });
    const errs = await validateInputShapes("Ticket", {
      Assignee: "definitely-wrong",
    });
    expect(errs).toEqual([]);
  });
});

describe("getModuleFieldTypes + validateInputShapesWith — bulk reuse", () => {
  const SCHEMA_WITH_REFS = {
    activities: [],
    information: [
      { name: "Title", type: "Text" },
      { name: "Assignee", type: "User" },
      { name: "Reviewers", type: "Users" },
      { name: "Linked Ticket", type: "Module" },
    ],
  };

  beforeEach(() => {
    __resetGuardCaches();
  });

  it("returns a populated map for a known module", async () => {
    vi.spyOn(api, "get").mockImplementation(async () => SCHEMA_WITH_REFS);
    const types = await getModuleFieldTypes("Ticket");
    expect(types).not.toBeNull();
    expect(types!.get("Assignee")).toBe("User");
    expect(types!.get("Reviewers")).toBe("Users");
    expect(types!.get("Linked Ticket")).toBe("Module");
    expect(types!.get("Title")).toBe("Text");
  });

  it("returns null when the schema cannot be loaded", async () => {
    vi.spyOn(api, "get").mockImplementation(async () => {
      throw new Error("nope");
    });
    expect(await getModuleFieldTypes("Ticket")).toBeNull();
  });

  it("validateInputShapesWith short-circuits to [] on null types", () => {
    const errs = validateInputShapesWith(null, { Assignee: "wrong" });
    expect(errs).toEqual([]);
  });

  it("bulk path fetches the schema only once across many items", async () => {
    const apiGet = vi
      .spyOn(api, "get")
      .mockImplementation(async () => SCHEMA_WITH_REFS);

    // Simulate submit_activities: fetch once, reuse per item.
    const fieldTypes = await getModuleFieldTypes("Ticket");
    const items = Array.from({ length: 50 }, (_, i) => ({
      Title: `Row ${i}`,
      // Half well-shaped, half malformed — exercise both paths.
      Assignee:
        i % 2 === 0
          ? { id: i, value: `User ${i}`, username: `u${i}` }
          : { id: i }, // missing value + username
    }));
    const failures: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const errs = validateInputShapesWith(fieldTypes, items[i]);
      if (errs.length > 0) failures.push(i);
    }

    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(failures.length).toBe(25);
  });
});

describe("human-actor bypass detection", () => {
  const SCHEMA_HUMAN_FLOWS = {
    activities: [
      { name: "Start", actor: "human" },
      { name: "AutoGo", actor: "ai" },
    ],
    information: [{ name: "Title", type: "Text" }],
    states: ["Planned", "In Progress", "Done"],
    flows: {
      Planned: { activities: { Start: "In Progress" } },
      "In Progress": { activities: { AutoGo: "Done" } },
    },
  };

  beforeEach(() => {
    __resetGuardCaches();
    vi.spyOn(api, "get").mockImplementation(async () => SCHEMA_HUMAN_FLOWS);
  });

  it("blocks changeState to the blocked activity's target state, even with confirmed", async () => {
    const first = await evaluateActivity({
      module: "Projects",
      activity: "Start",
      entryId: 5,
      confidence: 0.9,
    });
    expect(first.ok).toBe(false);
    expect((first as any).structured.error).toBe("human_actor_blocked");

    const bypass = await evaluateActivity({
      module: "Projects",
      activity: "changeState",
      entryId: 5,
      state: "In Progress",
      confidence: 0.9,
      confirmed: true,
    });
    expect(bypass.ok).toBe(false);
    expect((bypass as any).structured.error).toBe("human_actor_bypass_blocked");
    expect((bypass as any).structured.blocked_activity).toBe("Start");
  });

  it("blocks a state override on any activity reaching the same state", async () => {
    await evaluateActivity({ module: "Projects", activity: "Start", entryId: 5, confidence: 0.9 });
    const override = await evaluateActivity({
      module: "Projects",
      activity: "edit",
      entryId: 5,
      state: "In Progress",
      confidence: 0.9,
      confirmed: true,
    });
    expect(override.ok).toBe(false);
    expect((override as any).structured.error).toBe("human_actor_bypass_blocked");
  });

  it("does not block other entries or other target states", async () => {
    await evaluateActivity({ module: "Projects", activity: "Start", entryId: 5, confidence: 0.9 });

    const otherEntry = await evaluateActivity({
      module: "Projects",
      activity: "changeState",
      entryId: 6,
      state: "In Progress",
      confidence: 0.9,
      confirmed: true,
    });
    expect(otherEntry.ok).toBe(true);

    const otherState = await evaluateActivity({
      module: "Projects",
      activity: "changeState",
      entryId: 5,
      state: "Done",
      confidence: 0.9,
      confirmed: true,
    });
    expect(otherState.ok).toBe(true);
  });
});

describe("resolveInputKeys — unknown-key guard", () => {
  const types = new Map([
    ["project_name", "Text"],
    ["Due Date", "Date"],
    ["Title", "Text"],
  ]);

  it("leaves exact keys untouched", () => {
    const input: Record<string, unknown> = { Title: "x", "Due Date": "2026-01-01" };
    const res = resolveInputKeys(types, input);
    expect(res.remapped).toEqual([]);
    expect(res.unknown).toEqual([]);
    expect(input).toEqual({ Title: "x", "Due Date": "2026-01-01" });
  });

  it("remaps near-miss keys (case/spacing/underscores) in place", () => {
    const input: Record<string, unknown> = { "Project Name": "CRM", "due date": "2026-01-01" };
    const res = resolveInputKeys(types, input);
    expect(res.remapped).toEqual([
      { from: "Project Name", to: "project_name" },
      { from: "due date", to: "Due Date" },
    ]);
    expect(res.unknown).toEqual([]);
    expect(input).toEqual({ project_name: "CRM", "Due Date": "2026-01-01" });
  });

  it("reports keys that match no field", () => {
    const input: Record<string, unknown> = { Title: "x", State: "Active" };
    const res = resolveInputKeys(types, input);
    expect(res.unknown).toEqual(["State"]);
    expect(input.State).toBe("Active");
  });

  it("never remaps onto a colliding or already-present key", () => {
    const colliding = new Map([
      ["Due Date", "Date"],
      ["due_date", "Date"],
    ]);
    const res1 = resolveInputKeys(colliding, { "DUE DATE": "x" });
    expect(res1.remapped).toEqual([]);
    expect(res1.unknown).toEqual(["DUE DATE"]);

    const input: Record<string, unknown> = { Title: "keep", title: "dupe" };
    const res2 = resolveInputKeys(types, input);
    expect(res2.remapped).toEqual([]);
    expect(res2.unknown).toEqual(["title"]);
    expect(input.Title).toBe("keep");
  });

  it("fails open on a null type map or empty input", () => {
    expect(resolveInputKeys(null, { Anything: 1 })).toEqual({ remapped: [], unknown: [] });
    expect(resolveInputKeys(types, undefined)).toEqual({ remapped: [], unknown: [] });
  });
});

describe("getPriorFlag (used by submit_activities per-item check)", () => {
  it("returns the recorded confidence for a flagged entry", () => {
    recordFlagged("Leave", 42, "AutoTriage", 0.45);
    const rec = getPriorFlag("Leave", 42, "AutoTriage");
    expect(rec?.confidence).toBe(0.45);
  });

  it("returns undefined when no flag was recorded", () => {
    expect(getPriorFlag("Leave", 999, "AutoTriage")).toBeUndefined();
  });

  it("returns undefined after clearFlagged", () => {
    recordFlagged("Leave", 42, "AutoTriage", 0.45);
    clearFlagged("Leave", 42, "AutoTriage");
    expect(getPriorFlag("Leave", 42, "AutoTriage")).toBeUndefined();
  });
});
