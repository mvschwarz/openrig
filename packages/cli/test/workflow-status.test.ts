import { describe, it, expect, vi, afterEach } from "vitest";
import {
  composeAttentionRollup,
  attentionMarker,
  renderStatus,
  renderInstanceList,
  humanSeconds,
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
 * OPR.0.4.6.WF3 FR-3 part B — the `status` rollup pins (commit 5).
 *
 * RAIL 1 is structurally pinned here: every fixture provides ONLY the
 * API-carried deadline.state/evidence — no timestamps the CLI could
 * do threshold math on — and classification still works, proving the
 * composer consumes and never recomputes.
 */

const HEALTHY = {
  instanceId: "WF-H",
  workflowName: "conveyor",
  status: "active",
  deadline: { state: "healthy", evidence: null },
};

const FAILED = {
  instanceId: "WF-F",
  workflowName: "conveyor",
  status: "failed",
  deadline: { state: "healthy", evidence: null },
};

const STUCK = {
  instanceId: "WF-S",
  workflowName: "pipeline",
  status: "active",
  deadline: {
    state: "overdue-unclaimed",
    evidence: { stepId: "review", ownerSession: "rev@rig", overdueBySeconds: 7200 },
  },
};

const WAITING = {
  instanceId: "WF-W",
  workflowName: "pipeline",
  status: "waiting",
  deadline: { state: "healthy", evidence: null },
  lastContinuationDecision: { blockedOn: "founder-gate-2" },
};

// The dedup fixture: waiting AND overdue at once (waiting keeps its
// frontier packet per WF-1, so both classes are simultaneously real).
const WAITING_AND_STUCK = {
  instanceId: "WF-WS",
  workflowName: "pipeline",
  status: "waiting",
  deadline: {
    state: "overdue-unclaimed",
    evidence: { stepId: "gate", ownerSession: "human@rig", overdueBySeconds: 60 },
  },
  lastContinuationDecision: { blockedOn: "external-gate" },
};

const COMPLETED = { instanceId: "WF-C", workflowName: "conveyor", status: "completed" };

describe("composeAttentionRollup (WF3 FR-3b)", () => {
  it("mixed fixture: every attention-worthy instance appears exactly once with class + reason + affordance; healthy only in counts", () => {
    const rollup = composeAttentionRollup([HEALTHY, FAILED, STUCK, WAITING, COMPLETED]);
    expect(rollup.counts).toEqual({ total: 5, active: 2, waiting: 1, completed: 1, failed: 1 });
    expect(rollup.attention).toHaveLength(3);
    const ids = rollup.attention.map((r) => r.instanceId);
    expect(ids).toEqual(expect.arrayContaining(["WF-F", "WF-S", "WF-W"]));
    expect(ids).not.toContain("WF-H");
    expect(ids).not.toContain("WF-C");
    const stuck = rollup.attention.find((r) => r.instanceId === "WF-S");
    expect(stuck?.classes).toEqual(["stuck"]);
    expect(stuck?.reasons[0]).toContain("overdue-unclaimed at step review (owner rev@rig)");
    expect(stuck?.reasons[0]).toContain("120m"); // 7200s consumed, not computed
    expect(stuck?.affordance).toContain("rig workflow route WF-S");
    const failed = rollup.attention.find((r) => r.instanceId === "WF-F");
    expect(failed?.affordance).toContain("rig workflow trace WF-F");
    const waiting = rollup.attention.find((r) => r.instanceId === "WF-W");
    expect(waiting?.reasons[0]).toBe("waiting on founder-gate-2");
  });

  it("RAIL 2 dedup: waiting+stuck instance renders ONCE with BOTH classes and reasons", () => {
    const rollup = composeAttentionRollup([WAITING_AND_STUCK]);
    expect(rollup.attention).toHaveLength(1);
    const row = rollup.attention[0];
    expect(row?.classes).toEqual(["stuck", "waiting"]);
    expect(row?.reasons).toHaveLength(2);
  });

  it("RAIL 1 structural pin: classification works from deadline.state ALONE — no timestamps provided, none needed", () => {
    const bare = { instanceId: "X", status: "active", deadline: { state: "overdue-claimed" } };
    const rollup = composeAttentionRollup([bare]);
    expect(rollup.attention[0]?.classes).toEqual(["stuck"]);
    // And absent deadline (pre-fixback payloads) degrades to not-stuck, never a crash.
    const legacy = { instanceId: "Y", status: "active" };
    expect(composeAttentionRollup([legacy]).attention).toHaveLength(0);
  });

  it("proven-empty: clean fleet renders counts + the explicit empty statement, never blank", () => {
    const lines = renderStatus(composeAttentionRollup([HEALTHY, COMPLETED]));
    expect(lines[0]).toBe("2 instances: 1 active · 0 waiting · 1 completed · 0 failed");
    expect(lines[1]).toContain("No instances need attention");
  });

  it("human render: table with CLASS column and per-row affordance line", () => {
    const lines = renderStatus(composeAttentionRollup([WAITING_AND_STUCK, FAILED]));
    const text = lines.join("\n");
    expect(text).toMatch(/INSTANCE\s+WORKFLOW\s+CLASS\s+REASON/);
    expect(text).toContain("stuck+waiting");
    expect(text).toContain("└ ");
  });
});

describe("attentionMarker stuck upgrade (list column)", () => {
  it("stuck marker consumed from the API field; priority failed > stuck > waiting", () => {
    expect(attentionMarker(STUCK)).toBe("▲ stuck");
    expect(attentionMarker({ ...STUCK, status: "failed" })).toBe("▲ failed");
    expect(attentionMarker(WAITING)).toBe("▲ waiting");
    expect(attentionMarker(WAITING_AND_STUCK)).toBe("▲ stuck");
    expect(attentionMarker(HEALTHY)).toBe("");
  });

  it("list rows render the stuck marker", () => {
    const lines = renderInstanceList([STUCK], "2026-07-07T00:00:00Z");
    expect(lines[1]).toContain("▲ stuck");
  });
});

describe("humanSeconds", () => {
  it("compacts plain seconds on the shared scale", () => {
    expect(humanSeconds(30)).toBe("30s");
    expect(humanSeconds(7200)).toBe("120m");
  });
});

describe("status verb wire behavior", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeDeps(routes: Record<string, { status: number; data: unknown }>): WorkflowDeps {
    return {
      lifecycleDeps: {} as WorkflowDeps["lifecycleDeps"],
      clientFactory: () =>
        ({
          get: async (path: string) => routes[`GET ${path}`] ?? { status: 200, data: [] },
          post: async () => ({ status: 200, data: {} }),
        }) as never,
    };
  }

  it("status --json emits the rollup structurally (counts + attention)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({ "GET /api/workflow/list": { status: 200, data: [FAILED, HEALTHY] } }),
    });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "status", "--json"]);
    const out = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(out.counts.failed).toBe(1);
    expect(out.attention).toHaveLength(1);
    expect(out.attention[0].instanceId).toBe("WF-F");
  });

  it("status reads ONLY the shipped list surface (no new daemon route)", async () => {
    const calls: string[] = [];
    const deps: WorkflowDeps = {
      lifecycleDeps: {} as WorkflowDeps["lifecycleDeps"],
      clientFactory: () =>
        ({
          get: async (path: string) => {
            calls.push(path);
            return { status: 200, data: [] };
          },
          post: async () => ({ status: 200, data: {} }),
        }) as never,
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "status"]);
    logSpy.mockRestore();
    expect(calls).toEqual(["/api/workflow/list"]);
  });
});
