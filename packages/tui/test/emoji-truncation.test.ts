import { describe, expect, it } from "vitest";
import { renderLanes } from "../src/pulse/render-pulse.js";
import { scopeIdentityLines, type SliceScopeSnap } from "../src/scopes/scopes-model.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function slice(overrides: Partial<SliceScopeSnap>): SliceScopeSnap {
  return {
    dirName: "slice-01", id: "S1", displayName: "slice", stage: "active", status: "active",
    locks: { spec: null, delivery: null }, proof: { paired: 0, total: 0 }, readiness: null,
    prdExists: false, specShaShort: null, ...overrides,
  } as SliceScopeSnap;
}

describe("TUI truncation keeps emoji whole", () => {
  it("cuts a scopes title before an emoji instead of through it", () => {
    const lines = scopeIdentityLines(slice({ displayName: "abcdefgh😀xyz long title here" }), "m", 24);
    const title = lines.find((line) => line.text.includes("title"));
    expect(title?.text.endsWith("…")).toBe(true);
    expect(lines.some((line) => LONE_SURROGATE.test(line.text))).toBe(false);
  });

  it("hard-wraps an unbroken scopes value without splitting an emoji", () => {
    const lines = scopeIdentityLines(slice({ error: `${"x".repeat(23)}😀${"y".repeat(30)}` }), "m", 24);
    expect(lines.some((line) => LONE_SURROGATE.test(line.text))).toBe(false);
    expect(lines.map((line) => line.text).join("")).toContain("😀");
  });

  it("cuts a Pulse lane label before an emoji instead of through it", () => {
    const lines = renderLanes([
      { label: "NOW", count: 1, rows: [{ glyph: "●", token: "ok", label: `${"a".repeat(26)}🚀 ship it` }] },
      { label: "JUST FINISHED", count: 0, rows: [] },
      { label: "UP NEXT", count: 0, rows: [] },
    ] as Parameters<typeof renderLanes>[0]);
    const texts = lines.map((line) => line.segs.map((seg) => seg.text).join(""));
    expect(texts.some((text) => text.includes("…"))).toBe(true);
    expect(texts.some((text) => LONE_SURROGATE.test(text))).toBe(false);
  });
});
