import { describe, it, expect } from "vitest";
import {
  structuralSubsetMatch,
  containsMatch,
  pollUntilMatch,
  formatDiff,
} from "./helpers/scenario-expect.js";

// Slice 51-02 — the runner's judgment-free `expect` core: poll a shipped surface
// until a match holds or `within` elapses; on timeout emit an expected-vs-last-
// observed DIFF and FAIL (proof item 3, failure honesty). No heuristics.

describe("structuralSubsetMatch (the `match` mode)", () => {
  it("matches when expected is a deep subset of actual", () => {
    expect(structuralSubsetMatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(structuralSubsetMatch({ a: 1 }, {})).toBe(true);
  });
  it("fails on a value mismatch or a missing key", () => {
    expect(structuralSubsetMatch({ a: 1 }, { a: 2 })).toBe(false);
    expect(structuralSubsetMatch({ a: 1 }, { b: 1 })).toBe(false);
  });
  it("array-of-expected matches when EACH expected element subset-matches SOME actual element", () => {
    // queue list is a bare array; "expect an item with state in-progress" = contains semantics
    const actual = [{ id: "q1", state: "pending" }, { id: "q2", state: "in-progress", owner: "dev" }];
    expect(structuralSubsetMatch(actual, [{ state: "in-progress" }])).toBe(true);
    expect(structuralSubsetMatch(actual, [{ state: "done" }])).toBe(false);
    expect(structuralSubsetMatch(actual, [{ state: "in-progress", owner: "dev" }])).toBe(true);
  });
});

describe("containsMatch (the `contains` mode)", () => {
  it("substring match over a string surface (pane/transcript)", () => {
    expect(containsMatch("...seat restored and reprimed...", "restored")).toBe(true);
    expect(containsMatch("nothing here", "restored")).toBe(false);
  });
});

describe("pollUntilMatch", () => {
  const immediateSleep = async () => {};

  it("resolves ok on the first observation that matches", async () => {
    let calls = 0;
    const r = await pollUntilMatch({
      observe: async () => { calls++; return { state: "in-progress" }; },
      predicate: (o) => structuralSubsetMatch(o, { state: "in-progress" }),
      withinMs: 1000,
      pollIntervalMs: 100,
      now: () => 0,
      sleep: immediateSleep,
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("polls until a later observation matches, within the bound", async () => {
    const seq = [{ state: "pending" }, { state: "pending" }, { state: "in-progress" }];
    let i = 0;
    let t = 0;
    const r = await pollUntilMatch({
      observe: async () => seq[Math.min(i++, seq.length - 1)],
      predicate: (o) => structuralSubsetMatch(o, { state: "in-progress" }),
      withinMs: 1000,
      pollIntervalMs: 100,
      now: () => (t += 100),
      sleep: immediateSleep,
    });
    expect(r.ok).toBe(true);
    expect(i).toBe(3);
  });

  it("FAILS with the last observed + a DIFF when `within` elapses", async () => {
    let t = 0;
    const r = await pollUntilMatch({
      observe: async () => ({ state: "pending" }),
      predicate: (o) => structuralSubsetMatch(o, { state: "in-progress" }),
      expected: { state: "in-progress" }, // carried only to render the DIFF on timeout
      withinMs: 300,
      pollIntervalMs: 100,
      now: () => (t += 150), // elapses after ~2 polls
      sleep: immediateSleep,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.lastObserved).toEqual({ state: "pending" });
      expect(r.diff).toContain("expected");
      expect(r.diff).toContain("in-progress"); // the unmet expectation
      expect(r.diff).toContain("pending"); // the last observed
    }
  });

  it("always polls at least once even with a zero bound (honest last-observed)", async () => {
    let calls = 0;
    const r = await pollUntilMatch({
      observe: async () => { calls++; return { state: "x" }; },
      predicate: () => false,
      withinMs: 0,
      pollIntervalMs: 100,
      now: () => 0,
      sleep: immediateSleep,
    });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(r.ok).toBe(false);
  });
});

describe("formatDiff", () => {
  it("renders expected vs last-observed both readably", () => {
    const d = formatDiff({ state: "in-progress" }, { state: "pending" });
    expect(d).toContain("expected");
    expect(d).toContain("observed");
    expect(d).toContain("in-progress");
    expect(d).toContain("pending");
  });
});

describe("D11 — contains matches the SHIPPED text-surface shape, not just a bare string", () => {
  it("matches inside a capture payload {ok, sessionName, content, lines}", () => {
    const capture = {
      ok: true,
      sessionName: "dev-alpha@scn-scripts",
      content: "[stub-runner] READY\n[alpha-script] per-seat delivery reached alpha\n",
      lines: 20,
    };
    expect(containsMatch(capture, "[alpha-script]")).toBe(true);
    expect(containsMatch(capture, "[beta-script]")).toBe(false);
  });

  it("matches inside a transcript payload {session, lines, content, ingestHealth}", () => {
    const transcript = { session: "dev-alpha@r", lines: 3, content: "restored\n", ingestHealth: "ok" };
    expect(containsMatch(transcript, "restored")).toBe(true);
  });

  it("still matches a bare string, and never matches a shape with no text field", () => {
    expect(containsMatch("plain text here", "text")).toBe(true);
    expect(containsMatch({ sessionName: "needle-in-the-name" }, "needle")).toBe(false);
    expect(containsMatch(null, "x")).toBe(false);
    expect(containsMatch({ content: 42 }, "42")).toBe(false);
  });
});
