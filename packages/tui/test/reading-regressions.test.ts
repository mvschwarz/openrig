import { describe, expect, it } from "vitest";
import { fieldLine, wrapDetailLines } from "../src/detail.js";
import { createViewState, emptySnapshot } from "../src/state.js";

describe("installed Specs reading regressions", () => {
  it("keeps multiline YAML summaries in explicit terminal rows at both widths", () => {
    for (const width of [54, 106]) {
      const lines = wrapDetailLines([fieldLine({ label: "purpose", value: "A useful purpose.\nA second paragraph.\n" })], width);
      expect(lines.every((line) => !/[\r\n]/.test(line.text))).toBe(true);
      expect(lines.map((line) => line.text).join(" ")).toContain("A second paragraph.");
    }
  });
  it("keeps emoji intact when an unbroken detail value crosses a row boundary", () => {
    const text = "12345678😀abcdefgh😀ijklmnop";
    const rows = wrapDetailLines([{ text }], 9);
    expect(rows.every((row) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(row.text))).toBe(true);
    expect(rows.map((row, index) => index ? row.text.slice(4) : row.text).join("")).toBe(text);
    expect(rows.every((row) => row.text.length <= 9)).toBe(true);
  });
  it("can enter a named spec from a view whose snapshot did not load Specs", () => {
    const view = createViewState({ instanceId: "reading", getSnapshot: emptySnapshot });
    view.dispatch({ type: "jump", section: "config" });
    view.dispatch({ type: "drill", resource: "spec", name: "first-project" });
    expect(view.get()).toMatchObject({ section: "specs", drill: [{ kind: "spec", name: "first-project" }], lastError: null });
  });
});
