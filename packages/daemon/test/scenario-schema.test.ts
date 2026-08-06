import { describe, it, expect } from "vitest";
import {
  validateScenario,
  EXPECT_SURFACES,
  EMIT_BEHAVIORS,
  type ValidationResult,
} from "./helpers/scenario-schema.js";

// Slice 51-02 — proof item 1: schema fidelity + LOUD NAMED rejection. The
// validator accepts the arch-shape step forms and rejects, with a distinctly
// named error, each of: an unknown expect surface, an unknown emit behavior, and
// emit usage_limit in a stub topology (real-runtime-only — never a silent no-op).
// Plus structural fidelity + the wall-clock-as-assertion-input guard.

const errCodes = (r: ValidationResult): string[] =>
  r.ok ? [] : r.errors.map((e) => e.code);

const VALID: Record<string, unknown> = {
  scenario: "queue-baton-survives-restart",
  topology: "fixtures/two-seat.yaml",
  steps: [
    { up: {} },
    { send: { to: "dev-impl@rig", text: "work" } },
    { expect: { surface: "queue", within: "5s", match: { state: "in-progress" } } },
    { down: {} },
  ],
};

describe("validateScenario — schema fidelity + loud rejection", () => {
  it("accepts a well-formed arch-shape scenario", () => {
    const r = validateScenario(VALID);
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown expect surface with a NAMED error listing the allowed set", () => {
    const doc = { ...VALID, steps: [{ expect: { surface: "database", match: {} } }] };
    const r = validateScenario(doc);
    expect(r.ok).toBe(false);
    expect(errCodes(r)).toContain("UNKNOWN_EXPECT_SURFACE");
    const e = (r as { ok: false; errors: { code: string; message: string }[] }).errors.find(
      (x) => x.code === "UNKNOWN_EXPECT_SURFACE",
    )!;
    expect(e.message).toContain("database");
    // names the allowed surfaces so the author can self-correct
    for (const s of EXPECT_SURFACES) expect(e.message).toContain(s);
  });

  it("rejects an unknown emit behavior with a NAMED error listing the four", () => {
    const doc = { ...VALID, steps: [{ emit: { seat: "dev-impl@rig", behavior: "explode" } }] };
    const r = validateScenario(doc);
    expect(r.ok).toBe(false);
    expect(errCodes(r)).toContain("UNKNOWN_EMIT_BEHAVIOR");
    const e = (r as { ok: false; errors: { code: string; message: string }[] }).errors.find(
      (x) => x.code === "UNKNOWN_EMIT_BEHAVIOR",
    )!;
    for (const b of EMIT_BEHAVIORS) expect(e.message).toContain(b);
  });

  it("rejects emit usage_limit in a STUB topology with a DISTINCT named error (not unknown-behavior)", () => {
    const doc = { ...VALID, steps: [{ emit: { seat: "dev-impl@rig", behavior: "usage_limit" } }] };
    const r = validateScenario(doc, { topologyKind: "stub" });
    expect(r.ok).toBe(false);
    expect(errCodes(r)).toContain("USAGE_LIMIT_IN_STUB_TOPOLOGY");
    // must NOT be misfiled as an unknown behavior — it is a KNOWN real-runtime-only behavior
    expect(errCodes(r)).not.toContain("UNKNOWN_EMIT_BEHAVIOR");
    const e = (r as { ok: false; errors: { code: string; message: string }[] }).errors.find(
      (x) => x.code === "USAGE_LIMIT_IN_STUB_TOPOLOGY",
    )!;
    expect(e.message).toContain("usage_limit");
    expect(e.message.toLowerCase()).toContain("real-runtime");
  });

  it("accepts emit usage_limit in a REAL-runtime topology", () => {
    const doc = { ...VALID, steps: [{ emit: { seat: "dev-impl@rig", behavior: "usage_limit" } }] };
    const r = validateScenario(doc, { topologyKind: "real" });
    expect(r.ok).toBe(true);
  });

  it("requires scenario name, topology, and steps", () => {
    expect(errCodes(validateScenario({ topology: "x", steps: [] }))).toContain("SCENARIO_NAME_MISSING");
    expect(errCodes(validateScenario({ scenario: "x", steps: [] }))).toContain("TOPOLOGY_MISSING");
    expect(errCodes(validateScenario({ scenario: "x", topology: "y" }))).toContain("STEPS_MISSING");
    expect(errCodes(validateScenario("not-an-object"))).toContain("SCENARIO_NOT_OBJECT");
  });

  it("rejects a step that is not a single-key object", () => {
    const doc = { ...VALID, steps: [{ up: {}, down: {} }] };
    expect(errCodes(validateScenario(doc))).toContain("STEP_NOT_SINGLE_KEY");
  });

  it("rejects an unknown step verb", () => {
    const doc = { ...VALID, steps: [{ teleport: {} }] };
    expect(errCodes(validateScenario(doc))).toContain("UNKNOWN_STEP_VERB");
  });

  it("requires an expect to name exactly one match mode", () => {
    const none = { ...VALID, steps: [{ expect: { surface: "ps" } }] };
    expect(errCodes(validateScenario(none))).toContain("EXPECT_MATCH_MODE_MISSING");
    const both = { ...VALID, steps: [{ expect: { surface: "ps", match: {}, contains: "x" } }] };
    expect(errCodes(validateScenario(both))).toContain("EXPECT_MATCH_MODE_AMBIGUOUS");
  });

  it("validates the daemon lifecycle verb op set (sigterm|restart), distinct from seat restart", () => {
    expect(validateScenario({ ...VALID, steps: [{ daemon: { op: "sigterm" } }] }).ok).toBe(true);
    expect(validateScenario({ ...VALID, steps: [{ daemon: { op: "restart" } }] }).ok).toBe(true);
    expect(errCodes(validateScenario({ ...VALID, steps: [{ daemon: { op: "reboot" } }] }))).toContain("UNKNOWN_DAEMON_OP");
    // seat-level restart is a DIFFERENT verb and stays valid on its own
    expect(validateScenario({ ...VALID, steps: [{ restart: "dev-impl@rig" }] }).ok).toBe(true);
  });

  it("rejects a wall-clock value as a within bound (within is a relative duration, never an assertion input)", () => {
    const iso = { ...VALID, steps: [{ expect: { surface: "ps", within: "2026-08-05T21:00:00Z", match: {} } }] };
    expect(errCodes(validateScenario(iso))).toContain("WITHIN_NOT_A_DURATION");
    // relative durations are fine
    for (const w of ["5s", "500ms", "2m", "1500"]) {
      const ok = { ...VALID, steps: [{ expect: { surface: "ps", within: w, match: {} } }] };
      expect(validateScenario(ok).ok).toBe(true);
    }
  });
});
