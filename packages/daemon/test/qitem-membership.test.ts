// Canonical scope-membership matcher (VM-003 + VM-004) — C1 pure unit matrix.
//
// Pins parseScopeTags: typed-tag authority, per-JSON-element comma-legacy
// awareness, element-level-trim-only (the P1 precision pin), and the
// exact-name (no substring, no suffix, no post-prefix trim) semantics that
// keep the parser aligned with the unquoted SQL prefilter.

import { describe, it, expect } from "vitest";
import { parseScopeTags } from "../src/domain/slices/qitem-membership.js";

describe("parseScopeTags — canonical scope membership", () => {
  it("clean array: separate slice + mission elements", () => {
    const { slices, missions } = parseScopeTags(JSON.stringify(["mission:M", "slice:X"]));
    expect([...slices]).toEqual(["X"]);
    expect([...missions]).toEqual(["M"]);
  });

  it("comma-embedded legacy: one element carrying mission + slice", () => {
    const { slices, missions } = parseScopeTags(JSON.stringify(["mission:M,slice:X"]));
    expect(slices.has("X")).toBe(true);
    expect(missions.has("M")).toBe(true);
  });

  it("element-boundary whitespace is trimmed (` slice:X ` -> X)", () => {
    const { slices } = parseScopeTags(JSON.stringify([" slice:X "]));
    expect([...slices]).toEqual(["X"]);
  });

  it("comma-with-spaces legacy element (`mission:M , slice:X`)", () => {
    const { slices, missions } = parseScopeTags(JSON.stringify(["mission:M , slice:X"]));
    expect(slices.has("X")).toBe(true);
    expect(missions.has("M")).toBe(true);
  });

  it("P1 NEGATIVE: `slice: X` (space AFTER the colon) is NOT membership of X", () => {
    const { slices } = parseScopeTags(JSON.stringify(["slice: X"]));
    expect(slices.has("X")).toBe(false); // name is ` X`, never post-prefix trimmed
    expect(slices.has(" X")).toBe(true); // the honest, prefilter-aligned parse
  });

  it("NEGATIVE: `slice:X-suffix` yields `X-suffix`, never `X`", () => {
    const { slices } = parseScopeTags(JSON.stringify(["slice:X-suffix"]));
    expect(slices.has("X")).toBe(false);
    expect(slices.has("X-suffix")).toBe(true);
  });

  it("multi-slice single element (`slice:X,slice:Y`) -> both", () => {
    const { slices } = parseScopeTags(JSON.stringify(["slice:X,slice:Y"]));
    expect([...slices].sort()).toEqual(["X", "Y"]);
  });

  it("malformed JSON -> empty sets", () => {
    const { slices, missions } = parseScopeTags("{not json");
    expect(slices.size).toBe(0);
    expect(missions.size).toBe(0);
  });

  it("null / undefined -> empty sets", () => {
    for (const raw of [null, undefined]) {
      const { slices, missions } = parseScopeTags(raw);
      expect(slices.size).toBe(0);
      expect(missions.size).toBe(0);
    }
  });

  it("non-array JSON (object) -> empty sets", () => {
    const { slices, missions } = parseScopeTags(JSON.stringify({ slice: "X" }));
    expect(slices.size).toBe(0);
    expect(missions.size).toBe(0);
  });

  it("non-string array elements are skipped", () => {
    const { slices } = parseScopeTags(JSON.stringify([42, { a: 1 }, "slice:X"]));
    expect([...slices]).toEqual(["X"]);
  });
});
