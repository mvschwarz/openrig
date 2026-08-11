import { describe, it, expect } from "vitest";
import {
  validateScenario,
  EXPECT_SURFACES,
  RESERVED_SURFACES,
  type ValidationResult,
} from "./helpers/scenario-schema.js";

// 51-02 delta (guard-CLEAR packet rev-2/rev-3 + PM rulings) — schema increment:
//   D4  proof surface → RESERVED (PM ruling qitem-20260811092250-a80735bc)
//   D1  env.stub_scripts shape (per-seat script map; key CONTRACT vs the topology
//       is pipeline-level — see scenario-pipeline delta tests)
//   D3  env.scope_mission teaching requirement for scope expects
//   D7  env.tui opt-in + tui_socket teaching requirement

const errOf = (r: ValidationResult, code: string) =>
  (r as { ok: false; errors: { code: string; message: string; path: string }[] }).errors.find(
    (e) => e.code === code,
  );
const errCodes = (r: ValidationResult): string[] => (r.ok ? [] : r.errors.map((e) => e.code));

const BASE: Record<string, unknown> = {
  scenario: "delta-schema-pins",
  topology: "fixtures/topo.yaml",
  steps: [{ up: {} }, { down: {} }],
};

describe("D4 — proof surface is RESERVED (PM ruling a80735bc)", () => {
  it("EXPECT_SURFACES no longer contains proof; RESERVED_SURFACES names it", () => {
    expect(EXPECT_SURFACES as readonly string[]).not.toContain("proof");
    expect(RESERVED_SURFACES as readonly string[]).toContain("proof");
  });

  it("rejects surface:proof with a TEACHING error naming the reservation and the ruling", () => {
    const doc = { ...BASE, steps: [{ expect: { surface: "proof", match: {} } }] };
    const r = validateScenario(doc);
    expect(r.ok).toBe(false);
    const e = errOf(r, "RESERVED_EXPECT_SURFACE")!;
    expect(e).toBeDefined();
    expect(e.message).toContain("no shipped read verb");
    expect(e.message).toContain("reserved");
    expect(e.message).toContain("qitem-20260811092250-a80735bc");
  });

  it("a plainly unknown surface still reports UNKNOWN_EXPECT_SURFACE, not the reserved error", () => {
    const doc = { ...BASE, steps: [{ expect: { surface: "database", match: {} } }] };
    const r = validateScenario(doc);
    expect(errCodes(r)).toContain("UNKNOWN_EXPECT_SURFACE");
    expect(errCodes(r)).not.toContain("RESERVED_EXPECT_SURFACE");
  });
});

describe("D1 — env.stub_scripts shape (per-seat script map)", () => {
  it("accepts a seat→path string map", () => {
    const doc = { ...BASE, env: { stub_scripts: { worker: "./scripts/worker.json" } } };
    expect(validateScenario(doc).ok).toBe(true);
  });

  it("rejects a non-map stub_scripts with a named error", () => {
    const doc = { ...BASE, env: { stub_scripts: ["worker.json"] } };
    const r = validateScenario(doc);
    expect(errCodes(r)).toContain("STUB_SCRIPTS_NOT_A_MAP");
  });

  it("rejects a non-string / empty script path per entry, naming the seat key", () => {
    const doc = { ...BASE, env: { stub_scripts: { worker: "", qa: 7 } } };
    const r = validateScenario(doc);
    const codes = errCodes(r).filter((c) => c === "STUB_SCRIPT_PATH_INVALID");
    expect(codes).toHaveLength(2);
    const first = errOf(r, "STUB_SCRIPT_PATH_INVALID")!;
    expect(first.path).toContain("stub_scripts");
  });
});

describe("D3 — scope expects require env.scope_mission (rig scope audit --mission is required)", () => {
  const scopeStep = { expect: { surface: "scope", match: {} } };

  it("teaches when a scope expect exists and scope_mission is missing", () => {
    const doc = { ...BASE, steps: [scopeStep] };
    const r = validateScenario(doc);
    const e = errOf(r, "SCOPE_MISSION_MISSING")!;
    expect(e).toBeDefined();
    expect(e.message).toContain("--mission");
  });

  it("teaches on an empty or non-string scope_mission", () => {
    for (const bad of ["", 42] as const) {
      const doc = { ...BASE, env: { scope_mission: bad }, steps: [scopeStep] };
      expect(errCodes(validateScenario(doc))).toContain("SCOPE_MISSION_MISSING");
    }
  });

  it("accepts a scope expect with a non-empty scope_mission", () => {
    const doc = { ...BASE, env: { scope_mission: "release-0.5.1" }, steps: [scopeStep] };
    expect(validateScenario(doc).ok).toBe(true);
  });

  it("does not demand scope_mission when no scope expect exists", () => {
    expect(validateScenario(BASE).ok).toBe(true);
  });
});

describe("D7 — env.tui opt-in gates the tui_socket surface", () => {
  const tuiStep = { expect: { surface: "tui_socket", match: {} } };

  it("teaches when a tui_socket expect exists without env.tui:true", () => {
    const doc = { ...BASE, steps: [tuiStep] };
    const r = validateScenario(doc);
    const e = errOf(r, "TUI_NOT_DECLARED")!;
    expect(e).toBeDefined();
    expect(e.message).toContain("env.tui");
  });

  it("rejects a non-boolean env.tui", () => {
    const doc = { ...BASE, env: { tui: "yes" }, steps: [tuiStep] };
    expect(errCodes(validateScenario(doc))).toContain("ENV_TUI_NOT_BOOLEAN");
  });

  it("accepts tui_socket expects when env.tui is true", () => {
    const doc = { ...BASE, env: { tui: true }, steps: [tuiStep] };
    expect(validateScenario(doc).ok).toBe(true);
  });
});
