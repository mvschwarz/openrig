import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { activityRoutes, evidenceFromHookActivity } from "../src/routes/activity.js";
import { SeatActivityService, HOOK_AUTHORITY_WINDOW_MS } from "../src/domain/seat-activity-service.js";
import type { AgentActivity } from "../src/domain/types.js";
import type { AdapterRungInventory } from "../src/domain/activity-taxonomy.js";

// OPR.0.5.5.19 A4 — ingest unification: hook events reach the ONE oracle through the
// adapter seam; AgentActivityStore is reduced to the raw-event recorder. The store's
// normalization stays the single event-name parser (no twin) — these pins consume its
// OUTPUT shape via a fake store, and prove the route feeds SeatActivityService.

const TOKEN = "test-token";
const SEAT = "node-ing-1";
const SESSION = "dev50-qa@v-openrig-build";

const CLAUDE_INVENTORY: AdapterRungInventory = {
  adapterId: "claude-code-adapter",
  runtime: "claude-code",
  rungs: [
    { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" },
  ],
};

function activity(state: AgentActivity["state"], atMs: number, reason = "turn boundary"): AgentActivity {
  return {
    state,
    reason,
    evidenceSource: "hook" as AgentActivity["evidenceSource"],
    sampledAt: new Date(atMs).toISOString(),
    evidence: null,
    runtime: "claude-code",
  };
}

function makeApp(clock: { now: number }) {
  const svc = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3,
    now: () => new Date(clock.now),
  });
  svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
  let cannedState: AgentActivity["state"] = "idle";
  const fakeStore = {
    recordHookEvent: () => ({
      ok: true as const,
      activity: activity(cannedState, clock.now),
      event: { nodeId: SEAT, sessionName: SESSION, runtime: "claude-code" },
    }),
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, fakeStore as never);
    c.set("activityHookToken" as never, TOKEN as never);
    c.set("seatActivityService" as never, svc as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const post = (hookEvent: string, state: AgentActivity["state"]) => {
    cannedState = state;
    return app.request("/api/activity/hooks", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runtime: "claude-code", sessionName: SESSION, nodeId: SEAT, hookEvent }),
    });
  };
  return { svc, post };
}

describe("S19 A4 — the mapping: store-normalized state → oracle evidence (one parser, no twin)", () => {
  const base = { seatNodeId: SEAT, sessionName: SESSION, runtime: "claude-code", seq: 1 };
  const AT = 2_000_000;

  it("running → working on the lifecycle-hooks rung", () => {
    const ev = evidenceFromHookActivity({ ...base, activity: activity("running", AT) })!;
    expect(ev.rung).toBe("lifecycle-hooks");
    expect(ev.activity).toBe("working");
    expect(ev.sourceId).toBe("claude-code:hooks");
  });

  it("idle → idle-at-prompt (a turn boundary, exactly-once semantics live at the source)", () => {
    expect(evidenceFromHookActivity({ ...base, activity: activity("idle", AT) })!.activity).toBe("idle-at-prompt");
  });

  it("needs_input → needs-input COUNT+reason on the hooks rung, never an activity value", () => {
    const ev = evidenceFromHookActivity({ ...base, activity: activity("needs_input", AT, "permission prompt") })!;
    expect(ev.activity).toBeUndefined();
    expect(ev.needsInput).toEqual({ count: 1, reason: "permission prompt" });
  });

  it("unknown → null: noise is never fed to the oracle as evidence", () => {
    expect(evidenceFromHookActivity({ ...base, activity: activity("unknown", AT) })).toBeNull();
  });
});

describe("S19 A4 — the route feeds the ONE oracle (trace: one arbitration point)", () => {
  it("a Stop-shaped hook drives the arbitrated state to idle through the seam", async () => {
    const clock = { now: 2_000_000 };
    const { svc, post } = makeApp(clock);
    const res = await post("UserPromptSubmit", "running");
    expect(res.status).toBe(200);
    expect(svc.getSeatState(SEAT)!.activity).toBe("working");
    expect(svc.getSeatState(SEAT)!.decidedBy).toBe("lifecycle-hooks");
    await post("Stop", "idle");
    expect(svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt"); // turn boundary — instant, no debounce
  });

  it("a PermissionRequest-shaped hook surfaces needs-input beside the activity (authoritative rung)", async () => {
    const clock = { now: 2_000_000 };
    const { svc, post } = makeApp(clock);
    await post("UserPromptSubmit", "running");
    await post("Notification", "needs_input");
    const s = svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("working"); // the turn is still in flight
    expect(s.needsInput.count).toBe(1);
    // A later turn boundary clears it:
    await post("Stop", "idle");
    expect(svc.getSeatState(SEAT)!.needsInput.count).toBe(0);
  });

  it("KILLED RELAY (the supplement's risk specimen): hook silence goes rung-stale and sampling decides — never idle-forever", async () => {
    const clock = { now: 2_000_000 };
    const { svc, post } = makeApp(clock);
    await post("Stop", "idle"); // the relay's last words before dying
    expect(svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt");
    // The seat starts a new turn; the dead relay reports nothing. Sampling sees output.
    clock.now += HOOK_AUTHORITY_WINDOW_MS + 1_000;
    svc.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "window-sampling",
      sourceId: "tmux:window-activity", seq: 999, observedAt: new Date(clock.now).toISOString(),
      activity: "working",
    });
    const s = svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("working");
    expect(s.decidedBy).toBe("window-sampling"); // rung-stale = fell through; the relay's death never freezes state
  });

  it("chrome outranks hooks-carried needs-input when both exist", async () => {
    const clock = { now: 2_000_000 };
    const { svc, post } = makeApp(clock);
    svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, {
      ...CLAUDE_INVENTORY,
      rungs: [...CLAUDE_INVENTORY.rungs, { rung: "needs-input-chrome", lifecycleCoverage: "full", initialTrust: "authoritative" }],
    });
    await post("Notification", "needs_input"); // hooks: count 1, "turn boundary" reason from fixture
    svc.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "needs-input-chrome",
      sourceId: "tmux:chrome", seq: 500, observedAt: new Date(clock.now).toISOString(),
      needsInput: { count: 2, reason: "usage limit" },
    });
    expect(svc.getSeatState(SEAT)!.needsInput).toEqual({ count: 2, reason: "usage limit" });
  });
});
