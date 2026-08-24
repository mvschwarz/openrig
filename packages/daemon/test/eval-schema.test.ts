import { describe, it, expect } from "vitest";
import { validateEvalCase } from "./helpers/eval-schema.js";

// slice-07 R6 — RED-first pins for the eval-case validator. Against the accept-everything stub the
// rejection cases fail; that is the intended RED. GREEN lands when validateEvalCase discriminates.

const VALID_SELECTION = {
  id: "sel-01",
  name: "selects core/rig-lifecycle for a fleet bring-back",
  category: "selection",
  prompt: "the box rebooted and everything's gone — bring the whole fleet back",
  expectedPatterns: ["rig context get\\s+core/rig-lifecycle"],
};

const VALID_LOADING = {
  id: "load-01",
  name: "pulls core/rig-lifecycle before any bring-back action",
  category: "loading",
  prompt: "the box rebooted and everything's gone — bring the whole fleet back",
  expectedPatterns: ["rig context get\\s+core/rig-lifecycle"],
  order: {
    getPattern: "rig context get\\s+core/rig-lifecycle",
    actionPattern: "rig (up|start|restore)",
  },
};

function codes(doc: unknown): string[] {
  const r = validateEvalCase(doc);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe("eval-schema — case validator", () => {
  it("accepts a well-formed selection case", () => {
    expect(validateEvalCase(VALID_SELECTION).ok).toBe(true);
  });

  it("accepts a well-formed loading case", () => {
    expect(validateEvalCase(VALID_LOADING).ok).toBe(true);
  });

  it("rejects an unknown category", () => {
    expect(codes({ ...VALID_SELECTION, category: "sideways" })).toContain("UNKNOWN_CATEGORY");
  });

  it("rejects a non-compilable expected pattern", () => {
    expect(codes({ ...VALID_SELECTION, expectedPatterns: ["rig context get ("] })).toContain(
      "PATTERN_NOT_REGEX",
    );
  });

  it("rejects a loading case with no order block", () => {
    const { order: _omit, ...noOrder } = VALID_LOADING;
    expect(codes(noOrder)).toContain("ORDER_MISSING_FOR_LOADING");
  });

  it("rejects a selection case that carries an order block", () => {
    expect(codes({ ...VALID_SELECTION, order: VALID_LOADING.order })).toContain("ORDER_ON_SELECTION");
  });

  it("rejects a case missing its prompt", () => {
    const { prompt: _omit, ...noPrompt } = VALID_SELECTION;
    expect(codes(noPrompt)).toContain("PROMPT_MISSING");
  });
});
