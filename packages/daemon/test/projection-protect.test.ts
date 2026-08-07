import { describe, it, expect } from "vitest";
import {
  filterProtectedProjections,
  projectionConflictWarnings,
  type ProjectionEntry,
} from "../src/domain/projection-planner.js";
import type { ResolvedStartupFile } from "../src/domain/runtime-adapter.js";

// P20 atom-4 — PROTECT + honest warnings. atom-2 classifies operator_conflict
// (target diverged from BOTH our last write and the source), atom-3 records the
// last write. This atom makes the "not overwriting" the warning already claims
// actually TRUE: operator_conflict skill files are held back from delivery, so
// the adapter never overwrites an operator's edit — unless --force. hash_conflict
// (no manifest yet) stays the P17 overwrite-with-warning fallback (can't tell
// operator-vs-stale apart without a recorded last hash).

function skillEntry(over: Partial<ProjectionEntry> = {}): ProjectionEntry {
  return {
    category: "skill",
    effectiveId: "my-skill",
    sourceSpec: "spec",
    sourcePath: "/src",
    resourcePath: "skills/my-skill",
    absolutePath: "/src/skills/my-skill",
    classification: "operator_conflict",
    conflictDetail: {
      reason:
        'skill "my-skill" was modified after OpenRig last projected it (operator edit?) — not overwriting; move it aside or fold it into the spec, then re-project',
    },
    ...over,
  };
}

function skillFile(dir = "/src/skills/my-skill"): ResolvedStartupFile {
  return {
    path: "SKILL.md",
    absolutePath: `${dir}/SKILL.md`,
    ownerRoot: "/src",
    deliveryHint: "skill_install",
    required: true,
    appliesOn: ["fresh_start"],
    kind: "file",
  };
}

describe("P20 atom-4 protect — operator_conflict skills held back from delivery", () => {
  it("holds back the skill file whose dir is an operator_conflict (force=false)", () => {
    const plan = { conflicts: [skillEntry()] };
    const files = [skillFile("/src/skills/my-skill"), skillFile("/src/skills/other")];
    const { delivered, protected: held } = filterProtectedProjections(files, plan, { force: false });
    expect(held.map((f) => f.absolutePath)).toEqual(["/src/skills/my-skill/SKILL.md"]);
    expect(delivered.map((f) => f.absolutePath)).toEqual(["/src/skills/other/SKILL.md"]);
  });

  it("force=true overrides protect — everything delivered, nothing held", () => {
    const plan = { conflicts: [skillEntry()] };
    const files = [skillFile("/src/skills/my-skill")];
    const { delivered, protected: held } = filterProtectedProjections(files, plan, { force: true });
    expect(held).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  it("hash_conflict (no-manifest fallback) does NOT protect — stays overwrite-with-warning", () => {
    const plan = { conflicts: [skillEntry({ classification: "hash_conflict" })] };
    const files = [skillFile("/src/skills/my-skill")];
    const { delivered, protected: held } = filterProtectedProjections(files, plan, { force: false });
    expect(held).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  it("no conflicts → all delivered, none held", () => {
    const { delivered, protected: held } = filterProtectedProjections([skillFile()], { conflicts: [] }, {});
    expect(held).toEqual([]);
    expect(delivered).toHaveLength(1);
  });
});

describe("P20 atom-4 warning branch — protect vs softened-overwrite tail by classification", () => {
  it("operator_conflict warning states PROTECTED + --force, not 'will be overwritten'", () => {
    const [w] = projectionConflictWarnings({ conflicts: [skillEntry({ classification: "operator_conflict" })] });
    expect(w).toMatch(/not overwrit|protected/i);
    expect(w).toMatch(/--force/);
    expect(w).not.toMatch(/will be overwritten by re-projection/);
  });

  it("hash_conflict warning is the softened no-manifest overwrite notice, not a protect/--force claim", () => {
    const [w] = projectionConflictWarnings({
      conflicts: [
        skillEntry({
          classification: "hash_conflict",
          conflictDetail: { reason: 'skill "my-skill" exists at target with different content' },
        }),
      ],
    });
    expect(w).toMatch(/manifest/i);
    expect(w).not.toMatch(/--force/);
  });
});
