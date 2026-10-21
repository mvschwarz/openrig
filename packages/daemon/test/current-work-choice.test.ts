import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_WORK_CHOICE_INSTRUCTION,
  deriveCurrentWork,
  deriveCurrentWorkChoice,
  type CurrentWorkDerivation,
  type WorkCandidateLookups,
} from "../src/domain/current-work.js";

// Plain `queue whoami` names every candidate and asks the agent to choose whenever the strict
// derivation settles no current work node; it never picks one. Two of these cases are the ones a
// project-aware resolver turns into "no current work": rows for two projects that share mission
// and slice names, and a project whose own root lacks the node the configured root has. On this
// resolver both still collapse or resolve under the configured root, so those tests hand the
// choice the refusal such a resolver returns and check that both candidates are named.

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function missionsTree(): string {
  root = mkdtempSync(join(tmpdir(), "current-work-choice-"));
  const missions = join(root, "missions");
  for (const [mission, slice] of [["release", "01-work"], ["release-b", "02-other"]] as const) {
    mkdirSync(join(missions, mission, "slices", slice), { recursive: true });
    writeFileSync(join(missions, mission, "SPEC.md"), `---\nintent: ${mission} intent\n---\n`, "utf8");
    writeFileSync(join(missions, mission, "slices", slice, "SPEC.md"), `---\nintent: ${slice} intent\n---\n`, "utf8");
  }
  return missions;
}

const nothingElse: WorkCandidateLookups = { getRow: () => null, continuationOf: () => null };

const row = (qitemId: string, tags: string[], state = "in-progress") => ({ qitemId, state, tags });

const refusal = (currentWorkBasis: string): CurrentWorkDerivation => ({ currentWork: null, currentWorkBasis });

describe("deriveCurrentWorkChoice — plain whoami names the candidates instead of a count", () => {
  it("offers no choice when one work node is settled (ordinary unambiguous work)", () => {
    const missions = missionsTree();
    const rows = [row("q-1", ["project:alpha", "mission:release", "slice:01-work"])];
    const derived = deriveCurrentWork(rows, missions);
    expect(derived.currentWork?.workNodePath).toBe(join(missions, "release", "slices", "01-work"));
    expect(deriveCurrentWorkChoice(derived, rows, missions, nothingElse)).toBeNull();
  });

  it("names both folders, each with its project, mission, slice and row, when two nodes refuse", () => {
    const missions = missionsTree();
    const rows = [
      row("q-1", ["project:alpha", "mission:release", "slice:01-work"]),
      row("q-2", ["project:beta", "mission:release-b", "slice:02-other"]),
    ];
    const derived = deriveCurrentWork(rows, missions);
    expect(derived).toEqual(refusal("2 distinct typed work nodes — refusing to guess"));
    const choice = deriveCurrentWorkChoice(derived, rows, missions, nothingElse);
    expect(choice?.instruction).toBe(CURRENT_WORK_CHOICE_INSTRUCTION);
    expect(choice?.candidates).toEqual([
      expect.objectContaining({ qitemId: "q-1", projects: ["alpha"], mission: "release", slice: "01-work",
        workNodePath: join(missions, "release", "slices", "01-work"), unresolved: null }),
      expect.objectContaining({ qitemId: "q-2", projects: ["beta"], mission: "release-b", slice: "02-other",
        workNodePath: join(missions, "release-b", "slices", "02-other"), unresolved: null }),
    ]);
    expect(choice?.unknown).toEqual([]);
  });

  it("names one candidate per project when two projects' rows share mission and slice names", () => {
    const missions = missionsTree();
    const rows = [
      row("q-1", ["project:alpha", "mission:release", "slice:01-work"]),
      row("q-2", ["project:beta", "mission:release", "slice:01-work"]),
    ];
    // This resolver reads one configured root, so the two rows collapse into one settled node.
    expect(deriveCurrentWork(rows, missions).currentWork?.workNodePath)
      .toBe(join(missions, "release", "slices", "01-work"));
    // A project-aware resolver refuses the same rows; the choice must still name both projects.
    const choice = deriveCurrentWorkChoice(refusal("2 distinct typed work nodes — refusing to guess"), rows, missions, nothingElse);
    expect(choice?.candidates.map((c) => [c.qitemId, c.projects, c.mission, c.slice]))
      .toEqual([["q-1", ["alpha"], "release", "01-work"], ["q-2", ["beta"], "release", "01-work"]]);
  });

  it("names the configured root's folder when a project-aware refusal says the project's root lacks the node", () => {
    const missions = missionsTree();
    const rows = [row("q-1", ["project:alpha", "mission:release", "slice:01-work"])];
    const choice = deriveCurrentWorkChoice(
      refusal("typed work did not resolve: row q-1 — mission release resolves to 0 directories"), rows, missions, nothingElse);
    expect(choice?.candidates).toEqual([expect.objectContaining({ qitemId: "q-1", projects: ["alpha"],
      workNodePath: join(missions, "release", "slices", "01-work"), unresolved: null })]);
  });

  it("offers no choice when nothing is in progress, even with held or next work", () => {
    const missions = missionsTree();
    const rows = [
      row("q-1", ["mission:release", "slice:01-work"], "blocked"),
      row("q-2", ["mission:release-b", "slice:02-other"], "pending"),
    ];
    const derived = deriveCurrentWork(rows, missions);
    expect(derived.currentWork).toBeNull();
    expect(deriveCurrentWorkChoice(derived, rows, missions, nothingElse)).toBeNull();
    expect(deriveCurrentWorkChoice(derived, [], missions, nothingElse)).toBeNull();
  });

  it("names unknown inputs instead of hiding them: no missions root, an unresolved tag, an untagged row", () => {
    const missions = missionsTree();
    const typed = row("q-1", ["mission:release", "slice:01-work"]);
    const noRoot = deriveCurrentWorkChoice(deriveCurrentWork([typed], null), [typed], null, nothingElse);
    expect(noRoot?.candidates).toEqual([expect.objectContaining({ qitemId: "q-1", projects: [], workNodePath: null,
      unresolved: "no missions root configured" })]);

    const rows = [row("q-2", ["mission:missing", "slice:01-work"]), row("q-3", ["team:t1"])];
    const choice = deriveCurrentWorkChoice(deriveCurrentWork(rows, missions), rows, missions, nothingElse);
    expect(choice?.candidates).toEqual([expect.objectContaining({ qitemId: "q-2", workNodePath: null,
      unresolved: "mission missing resolves to 0 directories on this host" })]);
    expect(choice?.unknown).toEqual([{ qitemId: "q-3", summary: null, reason: "no mission tag and no handoff ancestry" }]);
  });
});
