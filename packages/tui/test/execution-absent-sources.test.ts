// #3616: a view line whose source is simply absent here reads as not applicable (no text), never as a failure; a source
// that couldn't be read is never shown as not applicable.
import { describe, expect, it } from "vitest";
import { executionContentLines, executionSliceStripLines, type ExecutionViewSnap } from "../src/execution/execution-model.js";

const text = (lines: Array<{ text: string }>) => lines.map(line => line.text).join("\n");
const slice = (id: string) => ({ slice_id: id, dir: id, depends_on: [], work_rows: [], planned_owners: [] as Array<{ component: string; owner: string; source: string }> });
const readinessOf = (activeDirs: string[]) => ({ revision: "r", state: "not-ready", activeSlices: activeDirs.length,
  slices: activeDirs.map(scope => ({ scope, readiness: { configured: false, state: "legacy", revision: "r", items: [] } })) }) as unknown as ExecutionViewSnap["readiness"];

function execution(sources: Record<string, unknown>, activeDirs: string[] | null, extra: Partial<ExecutionViewSnap> = {}): ExecutionViewSnap {
  return { view: "execution", mission: "trial", sources, q1_lanes: [], q5_park: [],
    q2_sequencing: [slice("one")], q4_ladder: [{ slice_id: "one", dir: "one" }],
    ...(activeDirs ? { readiness: readinessOf(activeDirs) } : {}), ...extra };
}
const valid = { arrangement: { manifest: "/missions/trial/mission.yaml", asof: "2026-11-20T00:00:00Z", basis: "mission.yaml composition order" } };
const malformed = { arrangement: { value: "INDETERMINATE", manifest: "/missions/trial/mission.yaml", asof: "2026-11-20T00:00:00Z", basis: "mission.yaml arrangement malformed" } };
const overview = (e: ExecutionViewSnap) => text(executionContentLines(e, undefined, [], null, 120));

describe("the slice box's Planned line", () => {
  it("says none declared when the arrangement was read and declares no owner for an active slice", () => {
    expect(overview(execution(valid, ["one"]))).toContain("Planned: none declared");
  });

  it("says unknown only when the arrangement couldn't be read", () => {
    const shown = overview(execution(malformed, ["one"]));
    expect(shown).toContain("Planned: unknown");
    expect(shown).not.toContain("Planned: none declared");
  });

  it("shows nothing when the mission has no mission.yaml, and keeps the box whole", () => {
    const lines = executionContentLines(execution({}, null), undefined, [], null, 120).map(line => line.text);
    expect(lines.join("\n")).not.toContain("Planned:");
    const top = lines.findIndex(line => line.trimStart().startsWith("┌─ one"));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(lines.slice(top, top + 6).map(line => line.trim()[0])).toEqual(["┌", "│", "│", "│", "│", "└"]);
  });

  it("shows nothing for a slice outside the active composition, whose owners the view doesn't read", () => {
    expect(overview(execution(valid, ["two"]))).not.toContain("Planned:");
  });

  it("says unknown for a slice a partial readiness list never reached, not that it's outside the composition", () => {
    // readMissionReadiness counts every active member, then can stop part-way (a repeated metadata.id).
    const e = execution(valid, ["two"]);
    (e.readiness as unknown as { activeSlices: number }).activeSlices = 2;
    expect(overview(e)).toContain("Planned: unknown");
  });

  it("still names a declared planned owner", () => {
    const e = execution(valid, ["one"]);
    e.q2_sequencing[0]!["planned_owners"] = [{ component: "build.minimal-gap", owner: "builder", source: "slice.yaml#sdlc.components[0].owner" }];
    expect(overview(e)).toContain("Planned: builder");
  });
});

describe("the slice page's Workflows line", () => {
  it("shows nothing when no workflow is bound to the mission", () => {
    expect(text(executionSliceStripLines(execution(valid, ["one"], { lifecycle_instances: [] }), "one", "one", 120))).not.toContain("Workflows:");
  });

  it("still says the projection is unavailable when it wasn't read", () => {
    expect(text(executionSliceStripLines(execution(valid, ["one"]), "one", "one", 120))).toContain("Workflows: projection unavailable");
  });
});
