import { describe, it, expect } from "vitest";
import {
  STUB_BEHAVIORS,
  parseStubScript,
  DEFAULT_STUB_SCRIPT,
  StubScriptError,
} from "../src/adapters/stub-script.js";
import { EMIT_BEHAVIORS } from "./helpers/scenario-schema.js";

// Slice 51-01 items 6-8 — the PURE stub behavior-script model (the deterministic
// driver the pane-hosted runner executes: pane outputs + hook emissions + stepwise
// timing; PRD §4.2). This module is side-effect-free so it unit-tests hermetically
// and the runner/adapter can import it without dragging daemon deps into the pane.
//
// TWIN-PARITY: the stub behavior vocabulary is a SHARED CONTRACT with 51-02's scenario
// `emit` verb (scenario-schema.ts EMIT_BEHAVIORS). Production (51-01/src) owns the
// canonical repertoire; a byte-parity guard test below fails loudly if the two copies
// ever drift (touch one twin half => the cross-package parity check runs in-increment).

describe("stub-script behavior vocabulary (twin-parity)", () => {
  it("STUB_BEHAVIORS is byte-identical to 51-02's EMIT_BEHAVIORS (shared contract, no drift)", () => {
    expect([...STUB_BEHAVIORS]).toEqual([...EMIT_BEHAVIORS]);
  });

  it("carries exactly the locked four-behavior repertoire", () => {
    expect([...STUB_BEHAVIORS]).toEqual(["compaction", "slow_output", "mid_turn_death", "restore"]);
  });
});

describe("parseStubScript", () => {
  it("parses a valid script of say + emit steps", () => {
    const script = parseStubScript(JSON.stringify({
      steps: [
        { kind: "say", text: "hello from the stub" },
        { kind: "emit", behavior: "compaction" },
      ],
    }));
    expect(script.steps).toHaveLength(2);
    expect(script.steps[0]).toEqual({ kind: "say", text: "hello from the stub" });
    expect(script.steps[1]).toEqual({ kind: "emit", behavior: "compaction" });
  });

  it("accepts every behavior in the locked repertoire as an emit step", () => {
    for (const behavior of STUB_BEHAVIORS) {
      const script = parseStubScript(JSON.stringify({ steps: [{ kind: "emit", behavior }] }));
      expect(script.steps[0]).toEqual({ kind: "emit", behavior });
    }
  });

  it("rejects malformed JSON", () => {
    expect(() => parseStubScript("{not json")).toThrow(StubScriptError);
  });

  it("rejects a non-object / missing steps array", () => {
    expect(() => parseStubScript(JSON.stringify({}))).toThrow(StubScriptError);
    expect(() => parseStubScript(JSON.stringify({ steps: "nope" }))).toThrow(StubScriptError);
    expect(() => parseStubScript(JSON.stringify([]))).toThrow(StubScriptError);
  });

  it("rejects an unknown step kind", () => {
    expect(() => parseStubScript(JSON.stringify({ steps: [{ kind: "dance" }] }))).toThrow(StubScriptError);
  });

  it("rejects a say step with no text", () => {
    expect(() => parseStubScript(JSON.stringify({ steps: [{ kind: "say" }] }))).toThrow(StubScriptError);
  });

  it("rejects an unknown emit behavior, naming the repertoire", () => {
    let err: unknown;
    try {
      parseStubScript(JSON.stringify({ steps: [{ kind: "emit", behavior: "explode" }] }));
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StubScriptError);
    // The message names the locked repertoire (mirrors 51-02's UNKNOWN_EMIT_BEHAVIOR).
    expect(String((err as Error).message)).toContain("compaction");
  });

  it("rejects usage_limit as real-runtime-only (never a silent stub no-op)", () => {
    // usage_limit is a KNOWN real-runtime-only behavior 51-02 fails in a stub topology;
    // the stub's own script model must refuse it loudly, not accept-and-drop.
    expect(() => parseStubScript(JSON.stringify({ steps: [{ kind: "emit", behavior: "usage_limit" }] })))
      .toThrow(StubScriptError);
  });
});

describe("DEFAULT_STUB_SCRIPT", () => {
  it("is a valid built-in default (prompt+echo+scripted-reply) for standalone use", () => {
    // Round-trips through the parser (structurally valid) and contains at least one
    // pane-output step so a standalone stub seat produces observable output.
    const reparsed = parseStubScript(JSON.stringify(DEFAULT_STUB_SCRIPT));
    expect(reparsed.steps.length).toBeGreaterThan(0);
    expect(reparsed.steps.some((s) => s.kind === "say")).toBe(true);
  });
});
