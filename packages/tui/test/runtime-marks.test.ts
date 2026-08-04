// S19 MR2 — the marks are DERIVED from the web identity of record
// (RuntimeMark.tsx), never invented: the grid math is pinned against the
// transcribed rect list, the row marks against their exact cell strings.
import { describe, it, expect } from "vitest";
import { clawdGrid, clawdFaithfulRows, clawdMiniA, clawdMiniB, codexMark, terminalMark, runtimeMarkSegs, markText } from "../src/topology/runtime-marks.js";

describe("clawd grid = the RuntimeMark.tsx rect list", () => {
  it("body, arms, legs, and eyes land exactly where the SVG rects put them", () => {
    const g = clawdGrid();
    expect(g[2]!.slice(3, 13).every((p) => p === 1)).toBe(true); // body top row
    expect(g[6]![1]).toBe(1); // left arm
    expect(g[6]![14]).toBe(1); // right arm
    expect(g[11]![4]).toBe(1); // leg 1
    expect(g[11]![7]).toBe(1); // leg 2
    expect(g[11]![10]).toBe(1); // leg 3
    expect(g[4]![5]).toBe(2); // left eye (dark, over body)
    expect(g[5]![10]).toBe(2); // right eye
    expect(g[0]!.every((p) => p === 0)).toBe(true); // empty margin
    expect(g[15]!.every((p) => p === 0)).toBe(true);
  });

  it("the faithful half-block form is 8 rows x 16 cells with eye cells carrying the eye token", () => {
    const rows = clawdFaithfulRows();
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.reduce((n, s) => n + s.text.length, 0)).toBe(16);
    const flat = rows.flat();
    expect(flat.some((s) => s.token === "clawdEye")).toBe(true);
    expect(flat.some((s) => s.token === "clawd")).toBe(true);
  });
});

describe("row-scale mark family", () => {
  it("runtime → mark mapping: claude family = clawd cells, codex = ❯_, terminal = dark ❯_, unknown = honest ?", () => {
    expect(markText(runtimeMarkSegs("claude-code"))).toBe(markText(clawdMiniA()));
    expect(markText(runtimeMarkSegs("codex"))).toBe("❯_");
    expect(markText(runtimeMarkSegs("terminal"))).toBe("❯_");
    expect(runtimeMarkSegs("terminal").every((s) => s.bg === "markBg")).toBe(true); // the dark-cell variant
    expect(markText(runtimeMarkSegs("something-else"))).toBe("?");
    expect(runtimeMarkSegs(null)[0]!.token).toBe("dim"); // honest, never fabricated
  });

  it("both downscale candidates are 2-3 single-cell clawd-token glyphs (the mr7 pick set)", () => {
    for (const mini of [clawdMiniA(), clawdMiniB()]) {
      expect(mini.length).toBeGreaterThanOrEqual(2);
      expect(mini.length).toBeLessThanOrEqual(3);
      expect(mini.every((s) => s.token === "clawd" && s.text.length === 1)).toBe(true);
    }
  });
});
