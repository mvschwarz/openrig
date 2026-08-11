import { describe, it, expect } from "vitest";
import { compactNodeProjection, padCompactNodeRow, padNodeRow, formatDeclaredModel } from "../src/commands/ps.js";

// 0.5.1 — rig ps must surface RUNTIME and the DECLARED model.
//
// Founder-directed telemetry: an orchestrator diagnosing a silent seat could not
// see what model it was on, and a Fable rate-limit read as a stall for three hours.
//
// PM's binding constraints, each pinned below:
//   (i)  a blank model must read as NOT DECLARED, never an em-dash a reader parses
//        as "this seat has no model" — 13 of 15 claude-code seats are blank today.
//   (ii) the surface says DECLARED in plain words.
//   (iii) this does NOT expose the RUNNING model; that is the ACTIVITY-umbrella rider.
describe("rig ps — runtime + declared model", () => {
  const node = (over: Record<string, unknown> = {}) => ({
    rigName: "v-openrig-build",
    canonicalSessionName: "dev-driver@v-openrig-build",
    lifecycleState: "run",
    agentActivity: { state: "idle" },
    hasAssignedWork: false,
    pendingWorkCount: 0,
    runtime: "claude-code",
    model: null,
    ...over,
  });

  it("RED (i): a null model renders NOT-DECLARED, never an em-dash", () => {
    expect(formatDeclaredModel(null)).toBe("not-declared");
    expect(formatDeclaredModel("")).toBe("not-declared");
    expect(formatDeclaredModel("   ")).toBe("not-declared");
    // the em-dash is what every other blank cell in this table uses; the model
    // column must NOT join them, because blank-as-em-dash reads as "no model".
    expect(formatDeclaredModel(null)).not.toBe("—");
  });

  it("RED (i): a declared model renders verbatim", () => {
    expect(formatDeclaredModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  // The COMPACT view stays token-lean by design (OPR.0.4.0.25: RUNTIME is a
  // full-only header, alongside CTX/RESTORE/STARTUP/TERMINAL/POD/MEMBER). So the
  // human columns land on --full, and the JSON projection carries both for tools.
  it("RED (ii): the FULL header marks the model DECLARED in plain words", () => {
    const header = padNodeRow("RIG", "POD", "MEMBER", "SESSION", "RUNTIME", "MODEL(DECLARED)", "STATUS",
      "STARTUP", "ORIENTED", "LIFECYCLE", "TERMINAL", "WORK", "ACTIVITY", "CTX", "RESTORE", "ERROR");
    expect(header).toContain("RUNTIME");
    expect(header).toContain("MODEL(DECLARED)");
  });

  it("RED (ii): the COMPACT view stays lean — the token-safe pin is preserved", () => {
    const header = padCompactNodeRow("RIG", "SESSION", "LIFECYCLE", "ACTIVITY", "WORK", "REASON");
    expect(header).not.toContain("RUNTIME");
    expect(header).not.toContain("MODEL");
  });

  it("RED: the compact PROJECTION carries runtime and model (node-inventory has both; ps dropped them)", () => {
    const [compact] = compactNodeProjection([node({ runtime: "codex", model: "gpt-5.6-sol" })] as never);
    expect(compact.runtime).toBe("codex");
    expect(compact.model).toBe("gpt-5.6-sol");
  });

  it("RED: a claude-code seat with no declared model still projects its runtime", () => {
    const [compact] = compactNodeProjection([node()] as never);
    expect(compact.runtime).toBe("claude-code");
    expect(compact.model).toBeNull();
  });
});
