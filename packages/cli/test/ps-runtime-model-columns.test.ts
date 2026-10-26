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

  it("padCompactNodeRow leaves padding between count suffix and WORK", () => {
    const row = padCompactNodeRow("my-rig", "dev-driver@my-rig", "running", "needs-input x1", "yes", "—");
    expect(row).not.toContain("needs-input x1yes");
    expect(row.slice(22 + 38 + 11 + 3, 22 + 38 + 11 + 3 + 17)).toBe("needs-input x1   ");
    expect(row.slice(22 + 38 + 11 + 17 + 4, 22 + 38 + 11 + 17 + 4 + 6)).toBe("yes   ");
  });

  // A cell filled to its width, or cut to it, ends one space before the next column, so no two columns run together.
  const filledCells = (widths: number[]) => widths.map((width, i) => String.fromCharCode(97 + i).repeat(width));

  it("padCompactNodeRow keeps every column apart when each cell fills its width", () => {
    const cells = filledCells([22, 38, 11, 17, 6, 4]);
    const row = (padCompactNodeRow as (...cells: string[]) => string)(...cells.slice(0, 5), "reason", cells[5]!);
    expect(row.split(" ")).toEqual([...cells, "reason"]);
  });

  it("padNodeRow keeps every column apart when each cell fills its width", () => {
    const cells = filledCells([30, 10, 14, 34, 12, 17, 10, 10, 9, 11, 9, 6, 17, 6, 10]);
    const row = (padNodeRow as (...cells: string[]) => string)(...cells, "error");
    expect(row.split(" ")).toEqual([...cells, "error"]);
  });

  it("a 38-character session, needs-input (screen) and the --full count each stay apart from the next column", () => {
    const session = "release-notes-historian@example-rig-01";
    expect(session).toHaveLength(38);
    expect(padCompactNodeRow("example-rig-01", session, "running", "idle", "no", "—")).toContain(`${session} running`);
    expect(padCompactNodeRow("my-rig", "dev-driver@my-rig", "running", "needs-input (screen)", "yes", "—"))
      .toContain("needs-input (scr… yes");
    const full = padNodeRow("my-rig#1", "dev", "driver", "dev-driver@my-rig", "codex", "—", "running", "ready", "yes",
      "running", "active", "yes", "needs-input x1", "40%", "n-a", "—");
    expect(full).toMatch(/needs-input x1 +40%/);
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

it("r2: preserves last model observation and provenance in a labelled compact tuple", () => {
  const observation = { status: "observed", model: "model-response", source: "claude-assistant-response", observedAt: "2026-10-18T23:00:00Z", generation: "current", reason: null };
  const [row] = compactNodeProjection([{ model: "model-configured", sessionStatus: "running", modelObservation: observation }] as never);
  expect(row?.model).toBe("model-configured");
  expect(row?.modelObservation).toEqual([observation.model, observation.source, observation.observedAt]);
});

it("r2: keeps explicit UNKNOWN reasons compact without fabricating an observed model", () => {
  const [row] = compactNodeProjection([{ sessionStatus: "running", modelObservation: { status: "unknown", model: null, source: null, observedAt: null, generation: "current", reason: "model-record-unavailable" } }] as never);
  expect(row?.modelObservation).toEqual({ status: "unknown", reason: "model-record-unavailable" });
});
