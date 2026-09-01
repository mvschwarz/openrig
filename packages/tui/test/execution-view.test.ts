import { describe, expect, it } from "vitest";
import { executionContentLines } from "../src/execution/execution-model.js";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import type { FleetSnapshot } from "../src/types.js";

function executionFixture(count = 2): NonNullable<FleetSnapshot["execution"]> {
  const ids = Array.from({ length: count }, (_, index) => `OPR.0.5.8.${index + 1}`);
  return {
    view: "execution",
    mission: "release-0.5.8",
    derived_at: "2026-09-01T21:00:00.000Z",
    sources: {
      arrangement: { basis: "mission.yaml + slice.yaml", asof: "2026-09-01T21:00:00.000Z" },
    },
    q1_lanes: ids.map((slice, index) => ({
      qitem_id: `qitem-${index + 1}`,
      slice,
      seat: `dev-${index + 1}@rig`,
      fragile_join: index === 1,
      join_basis: index === 1 ? "row/branch naming only" : "EC-3 worktree_path field",
      activity: {
        activity: index === 0 ? "working" : "idle-at-prompt",
        needs_input: { count: index === 1 ? 1 : 0, reason: index === 1 ? "permission prompt" : null },
        decided_by: index === 0 ? "self-report" : "window-sampling",
      },
      source: { qitem_id: `qitem-${index + 1}` },
    })),
    q2_sequencing: ids.map((slice, index) => ({
      slice_id: slice,
      dir: `${String(index + 1).padStart(2, "0")}-slice`,
      depends_on: [],
      blocked_on_rows: [],
      next_up: true,
      next_up_basis: "unblocked, unclaimed",
      next_up_rank: index + 1,
      source: { spec_path: `/work/${slice}/SPEC.md`, arrangement_path: `/work/${slice}/slice.yaml` },
    })),
    q4_ladder: ids.map((slice, index) => ({
      slice_id: slice,
      dir: `${String(index + 1).padStart(2, "0")}-slice`,
      locked: { value: true, basis: "approved-spec-at" },
      built: { candidate_sha: index === 0 ? "abc123456" : "INDETERMINATE", basis: `candidate row qitem-${index + 1}` },
      reviewed: { value: index === 0, basis: "/proof/review.md", legs: index === 0 ? [{ path: "/proof/review.md", verdict: "CLEAR" }] : [] },
      folded: { value: index === 0, basis: "git merge-base" },
      adopted: { value: "INDETERMINATE", basis: "daemon build stamp absent" },
    })),
    q5_park: [{
      qitem_id: "qitem-2",
      pickup_state: "parked",
      park_kind: "indeterminate",
      park_kind_basis: "no armed wake row",
      source: { qitem_id: "qitem-2" },
    }],
  };
}

describe("execution section — derived DONE / NOW / NEXT / ATTENTION", () => {
  it("maps the shipped projection into four bounded groups and every row drills to a named source", () => {
    const snap = demoSnapshot();
    const lines = executionContentLines(executionFixture(), snap.scopes, [], null);
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("DONE");
    expect(text).toContain("NOW");
    expect(text).toContain("NEXT");
    expect(text).toContain("ATTENTION");
    expect(text).toContain("self-report");
    expect(text).not.toContain("qitem body");
    const rowActions = lines.filter((line) => line.action);
    expect(rowActions.length).toBeGreaterThan(0);
    expect(rowActions.every((line) => line.action?.type === "execution-source")).toBe(true);
  });

  it("caps a 40-slice projection to one glance with explicit plus-N overflow rows", () => {
    const lines = executionContentLines(executionFixture(40), [], [], null);
    expect(lines.length).toBeLessThanOrEqual(28);
    expect(lines.some((line) => /\+\d+ more/.test(line.text))).toBe(true);
  });

  it("renders through the public :execution section and opens the selected row's source", () => {
    const snap = { ...demoSnapshot(), execution: executionFixture() };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    expect(view.dispatch(parseCommand(":execution")).lastError).toBeNull();
    let screen = renderScreen(view.get(), snap, { cols: 160, rows: 34 });
    expect(screen.lines.join("\n")).toContain("ATTENTION");
    const target = screen.contentTargets[0]!;
    view.dispatch(target.action);
    screen = renderScreen(view.get(), snap, { cols: 160, rows: 34 });
    expect(screen.lines.join("\n")).toContain("SOURCE");
  });

  it("degrades a failed execution fetch to one warning instead of blanking the section", () => {
    const lines = executionContentLines(null, [], ["execution: daemon read failed: GET /api/views/execution → 500"], null);
    expect(lines.map((line) => line.text).join("\n")).toContain("execution projection unavailable");
  });
});
