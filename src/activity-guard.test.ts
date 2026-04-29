import { describe, it, expect, beforeEach, vi } from "vitest";
import * as api from "./api.js";
import {
  __resetGuardCaches,
  clearFlagged,
  evaluateActivity,
  getPriorFlag,
  recordFlagged,
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
