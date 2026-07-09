import { describe, it, expect, vi, afterEach } from "vitest";
import {
  renderTraceTree,
  renderInstanceList,
  renderInstanceShow,
  humanDuration,
  statusGlyph,
} from "../src/commands/workflow-render.js";
import type { WorkflowDeps } from "../src/commands/workflow.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

/**
 * OPR.0.4.6.WF3 FR-2 — renderer pins (commit 2). Render-side only:
 * the BYTE-STABILITY of --json is additionally pinned here at the
 * unit level (raw body verbatim through the json branch); the
 * before/after diff harness (commit 8) is the binding proof.
 */

const NOW = "2026-07-06T21:10:00.000Z";

const INSTANCE = {
  instanceId: "WF01ABC",
  workflowName: "conveyor",
  workflowVersion: "2",
  status: "active",
  createdBySession: "orch@rig",
  createdAt: "2026-07-06T21:00:00.000Z",
  currentStepId: "review",
  currentFrontier: ["Q3"],
  hopCount: 2,
};

const TRAIL = [
  {
    stepId: "plan",
    closedAt: "2026-07-06T21:02:00.000Z",
    closureReason: "handoff",
    actorSession: "planner@rig",
    nextQitemId: "Q2",
    priorQitemId: "Q1",
  },
  {
    stepId: "build",
    closedAt: "2026-07-06T21:08:00.000Z",
    closureReason: "handoff",
    closureEvidence: { branch_taken: "remediate" },
    actorSession: "builder@rig",
    nextQitemId: "Q3",
    priorQitemId: "Q2",
  },
];

describe("workflow-render (WF3 FR-2)", () => {
  it("trace tree: one screen with step, actor, exit, duration, and the current frontier", () => {
    const lines = renderTraceTree(INSTANCE, TRAIL, NOW);
    const text = lines.join("\n");
    expect(text).toContain("WF01ABC");
    expect(text).toContain("conveyor v2");
    expect(text).toContain("STEP");
    expect(text).toContain("ACTOR");
    expect(text).toContain("plan");
    expect(text).toContain("planner@rig");
    expect(text).toContain("2m"); // plan duration from createdAt→closedAt
    expect(text).toContain("6m"); // build duration from prior close
    expect(text).toContain("▸ review"); // where it is now
    expect(text).toContain("frontier=[Q3]");
    // No raw JSON leakage — the whole point of FR-2.
    expect(text).not.toContain("{");
  });

  it("branch-taken renders when the trail carries it, leaves no residue when absent (present-tolerant)", () => {
    const withBranch = renderTraceTree(INSTANCE, TRAIL, NOW).join("\n");
    expect(withBranch).toContain("↳ branch: remediate");
    const noBranch = renderTraceTree(INSTANCE, [TRAIL[0]], NOW).join("\n");
    expect(noBranch).not.toContain("branch:");
  });

  it("failed steps carry the ✖ glyph", () => {
    const lines = renderTraceTree(
      { ...INSTANCE, status: "failed", currentStepId: null },
      [{ ...TRAIL[0], closureReason: "failed" }],
      NOW,
    );
    expect(lines.join("\n")).toContain("✖");
    expect(statusGlyph("failed")).toBe("✖");
  });

  it("list table: columns + one row per instance + age", () => {
    const lines = renderInstanceList([INSTANCE, { ...INSTANCE, instanceId: "WF02", status: "waiting", currentStepId: null }], NOW);
    expect(lines[0]).toMatch(/INSTANCE\s+WORKFLOW\s+STATUS\s+STEP\s+AGE\s+ATTN/);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("WF01ABC");
    expect(lines[1]).toContain("10m");
    expect(lines[2]).toContain("◐");
  });

  it("FR-3a attention markers: failed and waiting rows marked; active/completed unmarked", () => {
    const lines = renderInstanceList(
      [
        INSTANCE,
        { ...INSTANCE, instanceId: "WF-F", status: "failed" },
        { ...INSTANCE, instanceId: "WF-W", status: "waiting" },
        { ...INSTANCE, instanceId: "WF-C", status: "completed" },
      ],
      NOW,
    );
    expect(lines.find((l) => l.includes("WF-F"))).toContain("▲ failed");
    expect(lines.find((l) => l.includes("WF-W"))).toContain("▲ waiting");
    expect(lines.find((l) => l.includes("WF01ABC"))).not.toContain("▲");
    expect(lines.find((l) => l.includes("WF-C"))).not.toContain("▲");
  });

  it("empty list renders the explicit empty statement, never a blank", () => {
    expect(renderInstanceList([], NOW)).toEqual(["No workflow instances."]);
  });

  it("show: status-line-headed summary with a next pointer at trace", () => {
    const lines = renderInstanceShow(INSTANCE, NOW);
    expect(lines[0]).toBe("● WF01ABC  status=active");
    expect(lines.join("\n")).toContain("rig workflow trace WF01ABC");
  });

  it("humanDuration compacts sanely", () => {
    expect(humanDuration("2026-07-06T21:00:00Z", "2026-07-06T21:00:30Z")).toBe("30s");
    expect(humanDuration("2026-07-06T21:00:00Z", "2026-07-06T22:30:00Z")).toBe("90m");
    expect(humanDuration(undefined, NOW)).toBe("");
  });
});

describe("BR-2 byte-stability of --json (unit pin; commit-8 harness is the binding proof)", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeDeps(routes: Record<string, { status: number; data: unknown }>): WorkflowDeps {
    return {
      lifecycleDeps: {} as WorkflowDeps["lifecycleDeps"],
      clientFactory: () =>
        ({
          get: async (path: string) => routes[`GET ${path}`] ?? { status: 200, data: {} },
          post: async (path: string) => routes[`POST ${path}`] ?? { status: 200, data: {} },
        }) as never,
    };
  }

  it("trace --json emits the raw daemon body verbatim (no renderer involvement)", async () => {
    const body = { instance: { instanceId: "i1", status: "active" }, trail: [{ stepId: "s", extra: 1 }] };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({ "GET /api/workflow/i1/trace": { status: 200, data: body } }),
    });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "trace", "i1", "--json"]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(body));
  });

  it("list --json emits the raw daemon body verbatim", async () => {
    const body = [{ instanceId: "i1", status: "active" }];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({ "GET /api/workflow/list": { status: 200, data: body } }),
    });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "list", "--json"]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(body));
  });
});
