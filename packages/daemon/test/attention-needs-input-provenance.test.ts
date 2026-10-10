import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { PsProjectionService, arbitratedNeedsInputSignal } from "../src/domain/ps-projection.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { evidenceFromHookActivity } from "../src/routes/activity.js";
import { CLAUDE_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import type { ActivityEvidence, RungHealthEvent } from "../src/domain/activity-taxonomy.js";

// The rig attention total against a Claude seat's hook-reported approval prompt. Real
// SeatActivityService, AgentActivityStore and PsProjectionService over one test DB and one
// controlled clock. A hook enters as routes/activity.ts feeds it: the store records the raw
// hook, and the store's normalized activity becomes lifecycle-hooks evidence.

const T0 = Date.parse("2026-10-06T12:00:00.000Z");
const RIG = "attn-provenance";
const SESSION = `dev@${RIG}`;

describe("attention total: a declared needs-input rung is not an observed clear", () => {
  let db: Database.Database;
  let store: AgentActivityStore;
  let svc: SeatActivityService;
  let ps: PsProjectionService;
  let rigId: string;
  let nodeId: string;
  let health: RungHealthEvent[];
  let seq = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    db = createFullTestDb();
    rigId = `rig-${RIG}`;
    nodeId = `node-${RIG}-dev`;
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(rigId, RIG);
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)").run(nodeId, rigId, "dev", "claude-code");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
      .run("s-attn-provenance", nodeId, SESSION, "running", "ready");
    const eventBus = new EventBus(db);
    store = new AgentActivityStore({ db, eventBus });
    svc = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date() });
    health = [];
    svc.onRungHealth((e) => health.push(e));
    // Production auto-declares the runtime's inventory on the first sampler tick or hook.
    svc.declareRungInventory({ seatNodeId: nodeId, sessionName: SESSION }, CLAUDE_ACTIVITY_RUNG_INVENTORY);
    ps = new PsProjectionService({ db, agentActivity: store, seatActivity: svc });
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

  function record(hookEvent: string, subtype: string | null) {
    const r = store.recordHookEvent({ runtime: "claude-code", sessionName: SESSION, nodeId, hookEvent, subtype, occurredAt: new Date().toISOString() });
    if (!r.ok) throw new Error(`hook not recorded: ${r.code}`);
    return r.activity;
  }
  /** A hook as production delivers it: recorded, then fed to the oracle. */
  function hook(hookEvent: string, subtype: string | null = null) {
    const evd = evidenceFromHookActivity({ seatNodeId: nodeId, sessionName: SESSION, runtime: "claude-code", activity: record(hookEvent, subtype), seq: ++seq });
    if (evd) svc.reportEvidence(evd);
  }
  /** A hook the store holds and the oracle never received: after a daemon restart the store
   *  (in the DB) still has it while the oracle's ladder (in memory) starts empty. */
  function storeOnly(hookEvent: string, subtype: string | null = null) {
    record(hookEvent, subtype);
  }
  function evidence(e: Omit<ActivityEvidence, "seatNodeId" | "sessionName" | "seq" | "observedAt">) {
    svc.reportEvidence({ seatNodeId: nodeId, sessionName: SESSION, seq: ++seq, observedAt: new Date().toISOString(), ...e });
  }
  const sample = (activity: "working" | "idle-at-prompt") => evidence({ rung: "window-sampling", sourceId: "tmux:window-activity", activity });
  const stillWindow = (seconds: number) => { for (let i = 0; i < seconds; i++) { advance(1_000); sample("idle-at-prompt"); } };

  function observe() {
    const state = svc.getSeatStateBySession(SESSION);
    return {
      hookStore: store.getLatestForNode({ sessionName: SESSION, now: new Date() })?.state ?? null,
      needsInput: state?.needsInput ?? null,
      signal: arbitratedNeedsInputSignal(state),
      attention: ps.getEntries().find((e) => e.rigId === rigId)!.attentionCount,
      downgraded: health.some((h) => h.rung === "lifecycle-hooks" && h.to === "identity-only"),
    };
  }

  it("declared needs-input rungs that have not reported are not a clear: an unanswered prompt in the hook store counts", () => {
    sample("working");
    storeOnly("Notification", "permission_prompt");
    const o = observe();
    expect(o.hookStore).toBe("needs_input");
    expect(o.needsInput).toEqual({ count: 0, reason: null });
    expect(o.signal).toBeNull();
    expect(o.attention).toBe(1);
  });

  it("a permission prompt after the hook rung is downgraded still counts", () => {
    hook("UserPromptSubmit");
    stillWindow(12); // AM-1: the hook says working while sampling sees idle-at-prompt
    expect(observe().downgraded).toBe(true);
    advance(8_000);
    hook("PreToolUse");
    hook("Notification", "permission_prompt");
    const o = observe();
    expect(o.hookStore).toBe("needs_input");
    expect(o.attention).toBe(1);
  });

  it("a still permission dialog that itself trips the downgrade keeps the seat counted", () => {
    hook("PreToolUse");
    advance(500);
    hook("Notification", "permission_prompt");
    expect(observe().attention).toBe(1);
    stillWindow(12);
    const o = observe();
    expect(o.downgraded).toBe(true);
    expect(o.hookStore).toBe("needs_input");
    expect(o.attention).toBe(1);
  });

  it("an observed clear on an authoritative needs-input rung still supersedes an older prompt hook", () => {
    hook("Notification", "permission_prompt");
    advance(2_000);
    evidence({ rung: "needs-input-chrome", sourceId: "claude:chrome", needsInput: { count: 0, reason: null } });
    const o = observe();
    expect(o.hookStore).toBe("needs_input");
    expect(o.signal).toBe(false);
    expect(o.attention).toBe(0);
  });

  it("the next hook turn boundary still clears a prompt", () => {
    hook("Notification", "permission_prompt");
    advance(2_000);
    hook("Stop");
    const o = observe();
    expect(o.signal).toBe(false);
    expect(o.attention).toBe(0);
  });

  it("a positive arbitrated count still counts, with no hook store at all", () => {
    hook("Notification", "permission_prompt");
    expect(observe().signal).toBe(true);
    const oracleOnly = new PsProjectionService({ db, seatActivity: svc });
    expect(oracleOnly.getEntries().find((e) => e.rigId === rigId)!.attentionCount).toBe(1);
  });

  it("working/idle-only evidence is not evidence that clears needs-input", () => {
    evidence({ rung: "self-report", sourceId: "claude:pid-json", activity: "working" });
    sample("working");
    storeOnly("Notification", "permission_prompt");
    const state = svc.getSeatStateBySession(SESSION)!;
    // The self-report rung has evidence, so "the rung has reported something" is not the test.
    expect(state.rungs.find((r) => r.rung === "self-report")?.lastEvidenceAt).not.toBeNull();
    expect(state.needsInputEvidence).toBeNull();
    const o = observe();
    expect(o.signal).toBeNull();
    expect(o.attention).toBe(1);
  });
});

describe("needs-input provenance goes through the change notification", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("default zero → observed zero, with no activity or count change, advances seq and pushes seat.activity_changed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const pushed: Array<{ type: string; seq: number }> = [];
    const svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => null },
      defaultWindowSeconds: 3,
      now: () => new Date(),
      eventBus: { emit: (e: { type: string; seq: number }) => { pushed.push(e); return e; } } as never,
    });
    const seat = { seatNodeId: "node-1", sessionName: "dev@fixture" };
    svc.declareRungInventory(seat, CLAUDE_ACTIVITY_RUNG_INVENTORY);
    svc.reportEvidence({ ...seat, rung: "window-sampling", sourceId: "tmux:window-activity", seq: 1, observedAt: new Date().toISOString(), activity: "working" });
    const before = svc.getSeatState(seat.seatNodeId)!;
    expect(before.needsInputEvidence).toBeNull();
    expect(arbitratedNeedsInputSignal(before)).toBeNull();

    vi.setSystemTime(T0 + 1_000);
    svc.reportEvidence({ ...seat, rung: "lifecycle-hooks", sourceId: "claude-code:hooks", seq: 1, observedAt: new Date().toISOString(),
      activity: "working", needsInput: { count: 0, reason: null } });
    const after = svc.getSeatState(seat.seatNodeId)!;
    expect(after.activity).toBe(before.activity);
    expect(after.needsInput).toEqual(before.needsInput);
    expect(after.needsInputEvidence).toEqual({ rung: "lifecycle-hooks", observedAt: new Date(T0 + 1_000).toISOString() });
    expect(arbitratedNeedsInputSignal(after)).toBe(false);
    expect(after.seq).toBe(before.seq + 1);
    expect(pushed.filter((e) => e.type === "seat.activity_changed").map((e) => e.seq)).toContain(after.seq);
  });
});
