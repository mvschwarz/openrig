// Operator Surface Reconciliation v0 — Priority Rail Rule + lint helpers (UI side).
//
// Pure-logic tests (no React); pin classification + next-pull semantics
// + lint heuristics so the Progress workspace renders consistent
// signals without re-deriving from path strings each test.

import { describe, it, expect } from "vitest";
import {
  classifyPriorityRailLevel,
  computeLintWarnings,
  computeNextPullLine,
  getPriorityRailLevelStyle,
} from "../src/components/progress/priority-rail-rule.js";
import type { ProgressFileNode, ProgressRow } from "../src/hooks/useProgressTree.js";

function makeFile(opts: { rootName?: string; relPath: string; rows?: ProgressRow[] }): ProgressFileNode {
  return {
    rootName: opts.rootName ?? "ws",
    relPath: opts.relPath,
    absolutePath: `/abs/${opts.rootName ?? "ws"}/${opts.relPath}`,
    mtime: "2026-05-04T00:00:00.000Z",
    rows: opts.rows ?? [],
    title: null,
    counts: { total: 0, done: 0, blocked: 0, active: 0 },
  };
}

function checkbox(line: number, status: ProgressRow["status"], text: string, depth = 0): ProgressRow {
  return { line, depth, status, text, kind: "checkbox" };
}

function heading(line: number, text: string, depth = 0): ProgressRow {
  return { line, depth, status: "unknown", text, kind: "heading" };
}

describe("OSR v0 — classifyPriorityRailLevel", () => {
  it("STEERING.md → 'steering'", () => {
    expect(classifyPriorityRailLevel(makeFile({ relPath: "STEERING.md" }))).toBe("steering");
  });

  it("missions/<m>/PROGRESS.md → 'mission'", () => {
    expect(classifyPriorityRailLevel(makeFile({ relPath: "missions/recursive-self-improvement-v2/PROGRESS.md" })))
      .toBe("mission");
  });

  it("roadmap/PROGRESS.md → 'lane'", () => {
    expect(classifyPriorityRailLevel(makeFile({ relPath: "roadmap/PROGRESS.md" }))).toBe("lane");
  });

  it("delivery-ready/mode-N/PROGRESS.md → 'lane'", () => {
    expect(classifyPriorityRailLevel(makeFile({ relPath: "delivery-ready/mode-2/PROGRESS.md" }))).toBe("lane");
  });

  it("slices/<s>/PROGRESS.md → 'slice'", () => {
    expect(classifyPriorityRailLevel(makeFile({ relPath: "slices/foo-bar/PROGRESS.md" }))).toBe("slice");
  });

  it("anything else → 'intermediate'", () => {
    expect(classifyPriorityRailLevel(makeFile({ relPath: "scratch/cursor/PROGRESS.md" }))).toBe("intermediate");
  });
});

describe("OSR v0 — getPriorityRailLevelStyle", () => {
  it("returns labels + chip classes for all five levels", () => {
    for (const lvl of ["steering", "mission", "lane", "slice", "intermediate"] as const) {
      const style = getPriorityRailLevelStyle(lvl);
      expect(style.label).toBeTruthy();
      expect(style.chipClass).toContain("border-");
    }
  });

  it("steering has the most distinctive treatment (Constraint label)", () => {
    expect(getPriorityRailLevelStyle("steering").label).toBe("Constraint");
  });
});

describe("OSR v0 — computeNextPullLine", () => {
  it("returns the line of the first non-done, non-blocked checkbox row", () => {
    const file = makeFile({
      relPath: "delivery-ready/mode-2/PROGRESS.md",
      rows: [
        checkbox(1, "done", "alpha"),
        checkbox(2, "blocked", "beta"),
        checkbox(3, "active", "gamma"),
        checkbox(4, "active", "delta"),
      ],
    });
    expect(computeNextPullLine(file)).toBe(3);
  });

  it("returns null when no row qualifies (all done or all blocked)", () => {
    const allDone = makeFile({
      relPath: "delivery-ready/mode-3/PROGRESS.md",
      rows: [checkbox(1, "done", "x"), checkbox(2, "done", "y")],
    });
    expect(computeNextPullLine(allDone)).toBeNull();
  });

  it("ignores headings", () => {
    const file = makeFile({
      relPath: "delivery-ready/mode-1/PROGRESS.md",
      rows: [
        heading(1, "Section A"),
        checkbox(2, "active", "first"),
      ],
    });
    expect(computeNextPullLine(file)).toBe(2);
  });
});

describe("OSR v0 — computeLintWarnings", () => {
  it("rule 1 (long-row): flags rows over 160 chars with line citation", () => {
    const longText = "x".repeat(180);
    const file = makeFile({
      relPath: "x/PROGRESS.md",
      rows: [checkbox(5, "active", longText)],
    });
    const warnings = computeLintWarnings(file, false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.ruleId).toBe("long-row");
    expect(warnings[0]?.line).toBe(5);
    expect(warnings[0]?.message).toContain("180");
  });

  it("rule 2 (missing-tree): flags parent files without a Tree/Hierarchy/Topology heading", () => {
    const file = makeFile({
      relPath: "x/PROGRESS.md",
      rows: [
        heading(1, "Status"),
        checkbox(2, "active", "do thing"),
      ],
    });
    const warnings = computeLintWarnings(file, true);
    expect(warnings.find((w) => w.ruleId === "missing-tree")).toBeDefined();
  });

  it("rule 2 (missing-tree): NOT flagged when file has a '## Tree' heading", () => {
    const file = makeFile({
      relPath: "x/PROGRESS.md",
      rows: [heading(1, "Tree"), checkbox(2, "active", "do thing")],
    });
    const warnings = computeLintWarnings(file, true);
    expect(warnings.find((w) => w.ruleId === "missing-tree")).toBeUndefined();
  });

  it("rule 4 (qitem-no-label): flags rows whose body is a bare qitem id", () => {
    const file = makeFile({
      relPath: "x/PROGRESS.md",
      rows: [
        checkbox(1, "active", "qitem-20260504123456-abcdef"),
        checkbox(2, "active", "qitem-20260504123456-abcdef — drive PL-019 dogfood"),
      ],
    });
    const warnings = computeLintWarnings(file, false);
    const qitemFlags = warnings.filter((w) => w.ruleId === "qitem-no-label");
    expect(qitemFlags).toHaveLength(1);
    expect(qitemFlags[0]?.line).toBe(1);
  });

  it("returns no warnings on a clean file", () => {
    const file = makeFile({
      relPath: "x/PROGRESS.md",
      rows: [
        heading(1, "Tree"),
        checkbox(2, "done", "shipped"),
        checkbox(3, "active", "next item"),
      ],
    });
    expect(computeLintWarnings(file, true)).toEqual([]);
  });

  it("citation field references workstream-continuity convention rule", () => {
    const longText = "x".repeat(200);
    const file = makeFile({ relPath: "x/PROGRESS.md", rows: [checkbox(1, "active", longText)] });
    const w = computeLintWarnings(file, false)[0];
    expect(w?.citation).toContain("workstream-continuity");
  });
});
