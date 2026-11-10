// #2761: on the default flow a team records each slice's `status:` word (`rig scope slice ship` writes
// `shipped-to-<mission>`, `close` writes `closed-<reason>`) and no build records. The mission view must read every word
// in the done bucket as declared done, not "planned", and say once that the ladder's build records weren't kept.
import { describe, expect, it } from "vitest";
import { executionContentLines, executionSliceStripLines } from "../src/execution/execution-model.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot } from "../src/types.js";

const WORDS = ["shipped-to-release-1", "closed", "promoted"];
const RECORDS = "no slice in this mission has a candidate:<sha> row, so built, reviewed and merged read INDETERMINATE: not recorded, which is not the same as not done";
const UNRECORDED = "no candidate:* tag on any row bound to this slice (unbuilt and unrecorded are indistinguishable here)";

/** A finished default-flow mission. `served` is a daemon that serves recorded_status and q4_records; without it, an older one. */
function finished(served: boolean) {
  const ids = WORDS.map((_, i) => `SF.${i + 1}`);
  const dir = (i: number) => `0${i + 1}-slice`;
  const execution = {
    view: "execution",
    mission: "simple-flow",
    derived_at: "2026-11-10T00:00:00.000Z",
    sources: { git: { basis: "no reachable repo context" }, build_info: { commit: null } },
    q1_lanes: [],
    q2_sequencing: ids.map((id, i) => ({ slice_id: id, dir: dir(i), depends_on: [], blocked_on_rows: [], next_up: "INDETERMINATE",
      next_up_basis: "own completion rung INDETERMINATE (no candidate sha to test)", next_up_rank: null })),
    q3_care: ids.map((id) => ({ slice_id: id, build_wave: "w1" })),
    q4_ladder: ids.map((id, i) => ({
      slice_id: id,
      dir: dir(i),
      ...(served ? { recorded_status: { word: WORDS[i], bucket: "done", basis: "slice frontmatter status:, recorded by the team, not verified; it never sets a rung" } } : {}),
      locked: { value: false, basis: "no approved-spec-at in frontmatter" },
      built: { candidate_sha: "INDETERMINATE", basis: UNRECORDED },
      reviewed: { value: "INDETERMINATE", basis: "no built candidate token to scope review legs to", legs: [] },
      folded: { value: "INDETERMINATE", basis: "no candidate sha to test" },
      adopted: { value: "INDETERMINATE", basis: "no candidate sha to test" },
    })),
    ...(served ? { q4_records: { slices: 3, with_candidate: 0, with_merge_report: 0, repo_context: "INDETERMINATE", basis: RECORDS } } : {}),
    q5_park: [],
  } as NonNullable<FleetSnapshot["execution"]>;
  const template = demoSnapshot().scopes![0]!.slices[0]!;
  const scopes = [{ mission: "simple-flow", slices: ids.map((id, i) => ({ ...template, id, dirName: dir(i), displayName: `Slice ${i + 1}`, status: WORDS[i], proof: { paired: 0, total: 0 } })) }];
  return { execution, scopes };
}
const text = (lines: ReturnType<typeof executionContentLines>) => lines.map((line) => line.text).join("\n");

describe("#2761 execution view on the default flow", () => {
  it("reads every done-bucket word as declared done, not planned", () => {
    const { execution, scopes } = finished(true);
    const body = text(executionContentLines(execution, scopes, [], null, 160));
    expect(body).toContain("WAVE w1 · 3 slices · 3 declared done");
    expect(body).not.toContain("planned");
  });

  it("the slice strip has nothing next for a slice declared shipped", () => {
    const { execution } = finished(true);
    const strip = text(executionSliceStripLines(execution, "SF.1", "01-slice", 200, "shipped-to-release-1"));
    expect(strip).toContain("next        none — declared shipped-to-release-1");
  });

  it("the evidence page says once that the mission records no builds", () => {
    const { execution, scopes } = finished(true);
    const page = text(executionContentLines(execution, scopes, [], "evidence", 400));
    expect(page).toContain(`records:     ${RECORDS}`);
  });

  it("an older daemon that serves no bucket keeps reading only the word done as declared done", () => {
    const { execution, scopes } = finished(false);
    const body = text(executionContentLines(execution, scopes, [], null, 160));
    expect(body).toContain("WAVE w1 · 3 slices · 3 planned");
    expect(text(executionContentLines(execution, scopes, [], "evidence", 400))).not.toContain("records:");
  });
});
