import { describe, it, expect } from "vitest";
import { grade, type EvalCase } from "./helpers/eval-grader.js";

// slice-07 R6 — RED-first pins for the deterministic DOOR grader.
// Against the RED-first stub (unconditional pass) the FAIL cases below fail; that is the
// intended RED. GREEN lands when grade() actually discriminates.

const SEL: EvalCase = {
  id: "sel-01",
  name: "selects core/rig-lifecycle for a fleet bring-back",
  category: "selection",
  prompt: "the box rebooted and everything's gone — bring the whole fleet back",
  expectedPatterns: ["rig context get\\s+core/rig-lifecycle"],
};

const LOAD: EvalCase = {
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

describe("eval-grader — deterministic door", () => {
  it("selection PASS when the correct ref is pulled", () => {
    expect(grade(SEL, "…thinking… rig context get core/rig-lifecycle\nrig start").pass).toBe(true);
  });

  it("selection FAIL when the wrong ref is pulled", () => {
    expect(grade(SEL, "rig context get core/attention-queue\nrig start").pass).toBe(false);
  });

  it("selection FAIL on a forbidden pattern", () => {
    const c: EvalCase = { ...SEL, forbiddenPatterns: ["rig destroy"] };
    expect(grade(c, "rig context get core/rig-lifecycle\nrig destroy").pass).toBe(false);
  });

  it("loading PASS when the get precedes the action", () => {
    expect(grade(LOAD, "rig context get core/rig-lifecycle\n…\nrig start").pass).toBe(true);
  });

  it("loading FAIL when the action runs with no preceding get", () => {
    expect(grade(LOAD, "rig start   # acted without loading").pass).toBe(false);
  });

  it("loading FAIL when the action precedes the get", () => {
    expect(grade(LOAD, "rig start\nthen rig context get core/rig-lifecycle").pass).toBe(false);
  });
});
