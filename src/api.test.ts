import { describe, it, expect } from "vitest";
import { annotateModuleNotFound, setWorkspaceId } from "./api.js";

// A bare "Module 'X' not found" sent a benchmark agent hunting across 7
// workspaces with set_workspace — the annotation anchors the error to the
// active workspace and names the recovery moves.
describe("annotateModuleNotFound", () => {
  it("anchors the error to the active workspace", () => {
    setWorkspaceId("37");
    const out = annotateModuleNotFound("Module 'Client Projects' not found");
    expect(out).toContain("active workspace (id 37)");
    expect(out).toContain("set_workspace");
    expect(out).toContain("list_modules");
  });

  it("points at set_workspace when no workspace is active", () => {
    setWorkspaceId("");
    const out = annotateModuleNotFound("Module 'Client Projects' not found.");
    expect(out).toContain("No active workspace is set");
  });

  it("leaves unrelated messages untouched", () => {
    setWorkspaceId("37");
    const referenced =
      "Referenced module not found in this workspace: 'Members'. Create the missing module first.";
    expect(annotateModuleNotFound(referenced)).toBe(referenced);
    expect(annotateModuleNotFound("Entry 42 not found")).toBe("Entry 42 not found");
    expect(annotateModuleNotFound("Authorization has been denied for this request.")).toBe(
      "Authorization has been denied for this request.",
    );
  });
});
