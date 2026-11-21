import { describe, it, expect, beforeEach } from "vitest";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { CLAUDE_ACTIVITY_RUNG_INVENTORY, deriveDisplayActivity } from "../src/domain/activity-taxonomy.js";
import { evidenceFromHookActivity } from "../src/routes/activity.js";
import { readClaudeSelfReportEvidence } from "../src/adapters/claude-code-adapter.js";
import type { AgentActivity } from "../src/domain/types.js";
import { diagnoseRigParked } from "../src/domain/parked-query.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME } from "../src/domain/policies/parked-owner-consumer.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

// A Claude seat at its usage-limit notice must read a typed usage limit or unknown, never working (the honest-state
// rule). These replay the real sequences through the real hook mapping and the real self-report reader:
// - hq-lead (HQ, 11-18): UserPromptSubmit, then StopFailure/rate_limit with "resets Nov 23, 12pm (UTC)", then Claude's own
//   status file moves from busy to waiting (its /rate-limit-options menu), and nothing more for hours;
// - quality-lead (Build, 11-18): the same limit, then Claude's 60 s idle_prompt notification.
const SEAT = "node-hq-lead";
const SESSION = "hq-lead@hq";
const T0 = Date.parse("2026-11-18T16:26:40.000Z");
const RESET = "2026-11-23T12:00:00.000Z";

let clock: { now: number };
let svc: SeatActivityService;
let hookSeq = 0;

beforeEach(() => {
  clock = { now: T0 };
  svc = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date(clock.now) });
  svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_ACTIVITY_RUNG_INVENTORY);
});

/** A hook row as the store records it, through the route's own translation into oracle evidence. */
function hook(at: number, fields: Partial<AgentActivity>): void {
  const activity = { state: "unknown", reason: null, evidenceSource: "runtime_hook", runtime: "claude-code", fallback: false, stale: false,
    sampledAt: new Date(at).toISOString(), eventAt: new Date(at).toISOString(), ...fields } as AgentActivity;
  const evidence = evidenceFromHookActivity({ seatNodeId: SEAT, sessionName: SESSION, runtime: "claude-code", activity, seq: ++hookSeq });
  if (evidence) svc.reportEvidence(evidence);
}
const promptSubmitted = (at: number) => hook(at, { state: "running", reason: "user_prompt_submit", rawEvent: "UserPromptSubmit" });
const usageLimit = (at: number) => hook(at, { state: "unknown", reason: "usage_limit", rawEvent: "StopFailure", rawSubtype: "rate_limit", resetsAt: RESET });
const idlePrompt = (at: number) => hook(at, { state: "idle", reason: "idle_prompt", rawEvent: "Notification", rawSubtype: "idle_prompt" });

/** Claude's own status file (sessions/<pid>.json), read by the real self-report reader. */
function claudeStatus(status: "busy" | "idle" | "waiting", at: number): void {
  const file = JSON.stringify({ name: SESSION, status, statusUpdatedAt: at });
  const evidence = readClaudeSelfReportEvidence({ sessionsDir: "/sessions", sessionName: SESSION, seatNodeId: SEAT,
    read: { listFiles: () => ["1.json"], readFile: () => file } });
  if (evidence) svc.reportEvidence(evidence);
}
function idleSample(at: number): void {
  svc.reportEvidence({ seatNodeId: SEAT, sessionName: SESSION, rung: "window-sampling", sourceId: "tmux:window-activity",
    seq: at, observedAt: new Date(at).toISOString(), activity: "idle-at-prompt" });
}
function seat() {
  const state = svc.getSeatState(SEAT)!;
  return { ...state, display: deriveDisplayActivity(state.activity, state.needsInput) };
}

describe("a Claude seat at its usage-limit notice", () => {
  it("reads unknown with the typed limit and its reset, not working, hours after the notice and its menu", () => {
    claudeStatus("busy", T0);
    promptSubmitted(T0);
    usageLimit(T0 + 1_000);
    claudeStatus("waiting", T0 + 1_553); // the /rate-limit-options menu, left untouched
    clock.now = T0 + 4 * 3600_000;
    idleSample(clock.now);

    const state = seat();
    expect(state.display).toBe("unknown");
    expect(state.activity).toBe("unknown");
    expect(state.decidedBy).toBe("lifecycle-hooks");
    expect(state.needsInput.count).toBe(0); // a limit never counts as waiting on a person
    expect(state.usageLimit).toEqual({ rung: "lifecycle-hooks", observedAt: new Date(T0 + 1_000).toISOString(), resetsAt: RESET });
  });

  it("keeps the limit through Claude's later idle_prompt notification: an idle prompt is not a new turn", () => {
    promptSubmitted(T0);
    usageLimit(T0 + 1_000);
    idlePrompt(T0 + 61_000);
    clock.now = T0 + 61_000;

    expect(seat().display).toBe("unknown");
    expect(seat().usageLimit?.resetsAt).toBe(RESET);
  });

  it("clears on a strictly newer turn, from the hooks or from Claude's own status", () => {
    usageLimit(T0 + 1_000);
    clock.now = T0 + 3600_000;
    promptSubmitted(clock.now); // a new turn started: the limit no longer holds
    expect(seat().display).toBe("working");
    expect(seat().usageLimit).toBeNull();

    usageLimit(clock.now + 1_000);
    expect(seat().display).toBe("unknown");
    clock.now += 7200_000;
    claudeStatus("busy", clock.now);
    expect(seat().display).toBe("working");
    expect(seat().usageLimit).toBeNull();
  });

  it("isn't cleared by an older working post that arrives after the limit", () => {
    usageLimit(T0 + 1_000);
    promptSubmitted(T0); // posted before the limit, delivered after it
    expect(seat().display).toBe("unknown");
    expect(seat().usageLimit?.resetsAt).toBe(RESET);
  });

  it("isn't inherited by a new occupant", () => {
    promptSubmitted(T0);
    usageLimit(T0 + 1_000);
    svc.declareOccupantSwap(SEAT, "gen-2");
    expect(seat().usageLimit).toBeNull();
    svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_ACTIVITY_RUNG_INVENTORY);
    claudeStatus("idle", T0 + 5_000);
    expect(seat().display).toBe("idle");
    expect(seat().usageLimit).toBeNull();
  });

  it("is parked with its open work, so the parked-owner reminder goes to it rather than skipping it as unknown, until a newer turn", async () => {
    promptSubmitted(T0);
    usageLimit(T0 + 1_000);
    idlePrompt(T0 + 61_000);
    clock.now = T0 + 3_600_000; // well past the waiting grace, still before the stated reset
    const rows = [{ qitemId: "qitem-limited-work", state: "in-progress", summary: null }];
    const diagnose = () => diagnoseRigParked({ getSeatState: (id) => svc.getSeatState(id), listOpenObligations: (_dest, limit) => ({ rows, limit }) },
      [{ seatNodeId: SEAT, sessionName: SESSION }]);
    const policy = makeParkedOwnerConsumerPolicy({ diagnoseRig: () => diagnose() as never, now: () => clock.now,
      history: { listForJob: () => [], countForJob: () => 0 },
      rows: { listTransitions: () => [], appendNote: () => ({ ok: true }), recordNudgeResult: () => {}, listOpenIds: () => rows.map((r) => r.qitemId) } });
    const job = { jobId: "job-limited", policy: PARKED_OWNER_POLICY_NAME, target: { session: makeRigAnchor("hq") }, intervalSeconds: 120,
      activeWakeIntervalSeconds: null, scanIntervalSeconds: null, context: {}, lastEvaluationAt: null, lastFireAt: null,
      registeredAt: new Date(T0).toISOString() } as PolicyJob;

    expect(seat().display).toBe("unknown");
    expect(diagnose().seats[0]).toMatchObject({ parked: true, reason: expect.stringContaining(`at its usage limit (resets ${RESET})`) });
    expect(await policy.evaluate(job)).toMatchObject({ action: "send", target: { session: SESSION } });
    // A newer turn ends the hold, and a working seat isn't parked.
    promptSubmitted(T0 + 3_600_000);
    expect(diagnose().seats[0]?.parked).toBe(false);
  });
});
