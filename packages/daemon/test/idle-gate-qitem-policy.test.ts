import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { idleGateFiredConditionSchema } from "../src/db/migrations/078_idle_gate_fired_condition.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine, type DeliveryFn } from "../src/domain/watchdog-policy-engine.js";
import { makeIdleGateQitemPolicy } from "../src/domain/policies/idle-gate-qitem.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

const NOW = new Date("2026-07-03T12:00:00.000Z");
const FRESH = "2026-07-03T11:59:00.000Z"; // 1 min ago — within 5 min freshness
const STALE = "2026-07-03T11:50:00.000Z"; // 10 min ago — past freshness
const SEAT = "dev-guard@test-rig";

function makeJob(overrides: Partial<PolicyJob> = {}): PolicyJob {
  return {
    jobId: "job-1",
    policy: "idle-gate-qitem",
    target: { session: SEAT },
    intervalSeconds: 30,
    activeWakeIntervalSeconds: 300,
    scanIntervalSeconds: null,
    context: {},
    lastEvaluationAt: null,
    lastFireAt: null,
    registeredBySession: "ops@kernel",
    registeredAt: "2026-07-03T07:00:00.000Z",
    ...overrides,
  };
}

describe("idle-gate-qitem policy (OPR.0.4.3.16)", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let oracleState: ArbitratedSeatState | null;
  const seatActivity = {
    getSeatStateBySession: () => oracleState,
  };

  function setOracleState(
    activity: ArbitratedSeatState["activity"],
    needsInput: ArbitratedSeatState["needsInput"] = { count: 0, reason: null },
  ): void {
    oracleState = {
      seatNodeId: "node-oracle",
      activity,
      needsInput,
      decidedBy: "lifecycle-hooks",
      seq: 1,
      changedAt: NOW.toISOString(),
      rungs: [],
      lastSwap: null,
    };
  }

  function seedSeat(): void {
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.guard", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, attachmentType: "tmux" });
  }

  function seedActivity(hookEvent: string, occurredAt: string): void {
    if (occurredAt === STALE) setOracleState("unknown");
    else if (hookEvent === "PermissionRequest") {
      setOracleState("idle-at-prompt", { count: 1, reason: "permission prompt" });
    } else if (hookEvent === "Stop") setOracleState("idle-at-prompt");
    else setOracleState("working");
  }

  function seedGateQitem(
    id: string,
    opts: { destination?: string; state?: string; tags?: string[] | null; tier?: string | null } = {},
  ): void {
    const destination = opts.destination ?? SEAT;
    const state = opts.state ?? "pending";
    const tags = opts.tags === undefined ? ["gate:guard"] : opts.tags;
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
       VALUES (?, '2026-07-03T07:00:00Z', '2026-07-03T07:00:00Z', 'src@r', ?, ?, 'routine', ?, ?, 'review this diff')`,
    ).run(id, destination, state, opts.tier ?? null, tags ? JSON.stringify(tags) : null);
  }

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [watchdogJobsSchema, watchdogHistorySchema, idleGateFiredConditionSchema]); // idempotent; adds watchdog tables
    eventBus = new EventBus(db);
    oracleState = null;
    seedSeat();
  });

  afterEach(() => db.close());

  it("uses the arbitrated oracle when raw hook activity disagrees", async () => {
    seedGateQitem("q-opposed-activity");
    const rawStore = new AgentActivityStore({ db, eventBus, now: () => NOW });
    expect(rawStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: SEAT,
      hookEvent: "Stop",
      occurredAt: FRESH,
    }).ok).toBe(true); // raw hook store says idle
    setOracleState("working");
    const policy = makeIdleGateQitemPolicy({
      db,
      seatActivity,
    });

    const out = await policy.evaluate(makeJob());

    expect(out).toEqual({
      action: "skip",
      reason: "seat_active",
      notes: { seat: SEAT, activityState: "working" },
    });
  });

  it("pending gate:guard qitem + FRESH idle → ONE send; notes record the qitem + activity signal", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH); // → idle
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target.session).toBe(SEAT);
    expect(out.message).toContain("q-gate-1");
    expect(out.notes?.qitemId).toBe("q-gate-1");
    expect(out.notes?.gateRoles).toEqual(["guard"]);
    expect(out.notes?.activityState).toBe("idle-at-prompt");
    expect(out.notes?.activityDecidedBy).toBe("lifecycle-hooks");
  });

  // --- OPR.0.5.8.1 S2: fire once per MATERIAL STATE of the gated set ---
  //
  // Reproduced on a real daemon before any of this was written: an unchanged
  // gate-shaped blocked row re-woke the seat at +0s and +120.3s (window expiry),
  // and a brief seat-active flicker cleared `actionable` and produced a re-fire
  // 60.1s into a 120s window. The window was never a cooldown.

  // Engine-path S2 pins. These must run through the ENGINE, not the policy
  // alone: the condition receipt is proposed by the policy and banked by the
  // engine only on a delivery that returned ok. Testing the policy in isolation
  // would assert a decision while the defect QA found lives in the join.
  function engineFor(deliveryStatus: () => "ok" | "failed") {
    let clock = NOW;
    const advance = (seconds: number) => { clock = new Date(clock.getTime() + seconds * 1000); };
    const jobsRepo = new WatchdogJobsRepository(db);
    const historyLog = new WatchdogHistoryLog(db);
    const attempts: Array<{ targetSession: string; message: string }> = [];
    const deliver: DeliveryFn = async (req) => {
      attempts.push(req);
      return { status: deliveryStatus() };
    };
    const engine = new WatchdogPolicyEngine({
      jobsRepo, historyLog, eventBus, deliver, now: () => clock,
      additionalPolicies: [makeIdleGateQitemPolicy({ db, seatActivity })],
    });
    const registered = jobsRepo.register({
      policy: "idle-gate-qitem",
      specYaml: `policy: idle-gate-qitem\ntarget:\n  session: ${SEAT}\ninterval_seconds: 30\n`,
      targetSession: SEAT,
      intervalSeconds: 30,
      activeWakeIntervalSeconds: 300,
      registeredBySession: "ops@kernel",
    });
    const evaluate = () => engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
    const receipt = () =>
      (db.prepare("SELECT last_fired_condition AS c FROM watchdog_jobs WHERE job_id = ?")
        .get(registered.jobId) as { c: string | null } | undefined)?.c ?? null;
    return { attempts, evaluate, receipt, advance };
  }
  function appendTransition(qitemId: string, note: string, id: number): void {
    db.prepare(
      `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session, transition_note)
       VALUES (?, ?, '2026-07-03T08:00:00Z', 'blocked', 'someone@rig', ?)`,
    ).run(id, qitemId, note);
  }

  it("S2 R-1 — an UNCHANGED gated set does not re-wake, however many windows pass", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    advance(301);
    await evaluate();
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(1);   // three windows, one wake
  });

  it("S2 R-2 — a seat_active FLICKER cannot manufacture a second wake", async () => {
    // The engine clears `actionable` on every skip, which is what let a brief
    // busy moment bypass the active-wake window entirely. The condition receipt
    // is not touched by an activity skip, so the flicker buys nothing.
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    expect(attempts).toHaveLength(1);

    seedActivity("UserPromptSubmit", FRESH); // seat busy
    await evaluate();
    seedActivity("Stop", FRESH); // idle again
    advance(301);                // past the window: only the condition gate can hold
    await evaluate();
    expect(attempts).toHaveLength(1);
  });

  it("S2 F1 — a FAILED delivery banks no receipt, so the next scan RETRIES", async () => {
    // dev50-qa NOT-CLEAR at f610eec7d. The first cut wrote the receipt inside
    // evaluate(), before delivery was attempted, so one transport failure
    // suppressed the wake until the gated set changed — silence, which is worse
    // than the noise being fixed. Suppression must rest on evidence the wake
    // ARRIVED.
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    let status: "ok" | "failed" = "failed";
    const { attempts, evaluate, receipt, advance } = engineFor(() => status);

    await evaluate();
    expect(attempts).toHaveLength(1);
    expect(receipt()).toBeNull();          // nothing banked for a failed send

    // The engine still stamps last_fire_at on a failed send, so its active-wake
    // window remains a FLOOR beneath the condition gate — exactly as ruled. The
    // retry is therefore bounded by that window, not blocked until the row
    // changes. Bounded and self-healing is the whole difference from the defect.
    await evaluate();
    expect(attempts).toHaveLength(1);      // inside the window: floor holds
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(2);      // window elapsed -> retried, row unchanged

    status = "ok";
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(3);
    expect(receipt()).not.toBeNull();      // banked only now

    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(3);      // condition gate holds past the window
  });

  it("S2 preserve — a MATERIAL transition re-wakes promptly", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    await evaluate();
    expect(attempts).toHaveLength(1);

    appendTransition("q-gate-1", "reviewer asked a question", 9001);
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(2);
  });

  it("S2 preserve — a SUBSTANTIVE BLOCKER transition re-wakes, even at unchanged blocker state", async () => {
    // review50-r2 NOT-CLEAR at 0bbb9d9e2. The contract names TWO blocker axes:
    // a substantive transition on the blocker, OR the blocker reaching terminal.
    // The digest carried only the blocker's STATE, so a content-bearing note on a
    // still-in-progress blocker produced an identical digest and was suppressed.
    // My earlier "MATERIAL transition" pin only ever changed the gated ROW — a
    // quantifier satisfied by one of its two routes.
    seedGateQitem("q-gate-1");
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
       VALUES ('q-blocker', '2026-07-03T07:00:00Z', '2026-07-03T07:00:00Z', 'src@r', 'other@rig', 'in-progress', 'routine', null, 'the blocker')`,
    ).run();
    db.prepare("UPDATE queue_items SET state = 'blocked', blocked_on = 'q-blocker' WHERE qitem_id = 'q-gate-1'").run();
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    expect(attempts).toHaveLength(1);

    // Blocker gains a substantive transition; its STATE is deliberately unchanged.
    appendTransition("q-blocker", "decision context materially amended", 91001);
    expect(
      (db.prepare("SELECT state FROM queue_items WHERE qitem_id = 'q-blocker'").get() as { state: string }).state,
    ).toBe("in-progress");
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(2);
  });

  it("S2 — a wake-machinery marker on the BLOCKER is still not material", async () => {
    // The exclusion has to hold on the blocker axis too, or a wake recorded there
    // would justify the next wake — the same trap, one table over.
    seedGateQitem("q-gate-1");
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
       VALUES ('q-blocker', '2026-07-03T07:00:00Z', '2026-07-03T07:00:00Z', 'src@r', 'other@rig', 'in-progress', 'routine', null, 'the blocker')`,
    ).run();
    db.prepare("UPDATE queue_items SET state = 'blocked', blocked_on = 'q-blocker' WHERE qitem_id = 'q-gate-1'").run();
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    appendTransition("q-blocker", "wake-attempt: 2/3 outcome=failed", 91002);
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(1);
  });

  it("S2 preserve — a NEW gate qitem arriving wakes", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    seedGateQitem("q-gate-2");
    // MEASURED, not assumed — I got this wrong twice before instrumenting the
    // engine. After a send, EVERY evaluation returns active_wake_not_due until
    // the window elapses: the throttle branch preserves `actionable`, unlike the
    // generic skip branch which clears it. So the window is a real floor here,
    // and genuinely new work waits it out on a seat that stays idle.
    await evaluate();
    expect(attempts).toHaveLength(1);   // floor holds inside the window
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(2);   // window elapsed, condition changed -> wakes
  });

  it("S2 — wake-machinery markers are NEVER material (else every wake justifies the next)", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    appendTransition("q-gate-1", "wake-attempt: 1/3 outcome=delivered", 9002);
    appendTransition("q-gate-1", "escalation-rung: orchestrator -> orch@rig", 9003);
    // Past the window, so a skip here can only be the CONDITION gate — otherwise
    // this pin would pass on the throttle and prove nothing.
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(1);
  });

  it("S2 — a suppressed wake stays derivable, and the row is never touched", async () => {
    // Suppressing the WAKE, never the record.
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { evaluate, receipt, advance } = engineFor(() => "ok");
    expect(receipt()).toBeNull();
    await evaluate();
    const banked = receipt();
    expect(banked).toMatch(/^[0-9a-f]{32}$/);
    advance(301);
    await evaluate();
    expect(receipt()).toBe(banked);        // one overwritten value, not a ledger
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE qitem_id = 'q-gate-1'").get() as { n: number }).n,
    ).toBe(1);
  });

  it("human-gate tier (no gate:* tag) + FRESH idle → send (secondary predicate, gate:human)", async () => {
    seedGateQitem("q-human-1", { tags: null, tier: "human-gate" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.notes?.gateRoles).toEqual(["human"]);
  });

  it("no pending gate qitem for the seat → skip no_pending_gate", async () => {
    // A non-gate pending qitem + a gate qitem for a DIFFERENT seat.
    seedGateQitem("q-plain", { tags: ["mission:x"] });
    seedGateQitem("q-other", { destination: "someone-else@test-rig" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("no_pending_gate");
  });

  it("seat running → skip seat_active (no idle-wake)", async () => {
    seedGateQitem("q-gate-2");
    seedActivity("UserPromptSubmit", FRESH); // → running
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("seat_active");
  });

  it("seat needs_input → skip seat_needs_input (never drive a live picker)", async () => {
    seedGateQitem("q-gate-3");
    seedActivity("PermissionRequest", FRESH); // → needs_input
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("seat_needs_input");
  });

  it("STALE idle activity → honest skip activity_stale_unknown (never fake-idle)", async () => {
    seedGateQitem("q-gate-4");
    seedActivity("Stop", STALE); // stale evidence leaves the oracle honestly unknown
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("activity_stale_unknown");
  });

  it("no activity signal at all → honest skip activity_stale_unknown", async () => {
    seedGateQitem("q-gate-5");
    // no seedActivity
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("activity_stale_unknown");
  });

  it("gate qitem already claimed (in-progress) → does NOT fire (not-claimable → skip)", async () => {
    seedGateQitem("q-claimed", { state: "in-progress" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("no_pending_gate");
  });

  it("blocked gate qitem is claimable → fires when idle", async () => {
    seedGateQitem("q-blocked", { state: "blocked" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("send");
  });

  describe("ACTIVE REGISTERED watchdog job (guard note 2 — real registration + engine dispatch + cooldown)", () => {
    it("registered idle-gate-qitem job actively evaluates through the engine: fires once, then cooldown", async () => {
      const jobsRepo = new WatchdogJobsRepository(db);
      const historyLog = new WatchdogHistoryLog(db);
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const deliver: DeliveryFn = async (req) => {
        deliveries.push(req);
        return { status: "ok" };
      };
      const engine = new WatchdogPolicyEngine({
        jobsRepo,
        historyLog,
        eventBus,
        deliver,
        now: () => NOW,
        additionalPolicies: [makeIdleGateQitemPolicy({ db, seatActivity })],
      });

      // Register a REAL job — proves PHASE_D_POLICIES accepts idle-gate-qitem
      // and the engine resolves it from the registry.
      const registered = jobsRepo.register({
        policy: "idle-gate-qitem",
        specYaml: `policy: idle-gate-qitem\ntarget:\n  session: ${SEAT}\ninterval_seconds: 30\n`,
        targetSession: SEAT,
        intervalSeconds: 30,
        activeWakeIntervalSeconds: 300,
        registeredBySession: "ops@kernel",
      });
      expect(jobsRepo.listActive().map((j) => j.jobId)).toContain(registered.jobId);
      expect(engine.resolvePolicy("idle-gate-qitem")).toBeDefined();

      seedGateQitem("q-registered");
      seedActivity("Stop", FRESH);

      // First evaluation → fires (delivery + sent history + evaluation_fired).
      const r1 = await engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
      expect(r1.outcome.action).toBe("send");
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.targetSession).toBe(SEAT);
      expect(historyLog.listForJob(registered.jobId)[0]?.outcome).toBe("sent");

      // Second immediate evaluation → quiet skip, no duplicate wake.
      //
      // AMENDED by OPR.0.5.8.1 S2. This test's subject — fires once, then no
      // duplicate wake — is unchanged and still asserted by the delivery count,
      // which is what the user actually experiences. Only the REASON moved:
      // the condition gate now decides before the engine's active-wake window
      // is consulted, so the skip is `gate_condition_unchanged` rather than
      // `active_wake_not_due`.
      //
      // Asserting the new reason rather than loosening to "any skip" on
      // purpose: the two reasons are not interchangeable. `active_wake_not_due`
      // expires with the window and is bypassed entirely once a skip has
      // cleared `actionable`; `gate_condition_unchanged` holds until the gated
      // set materially changes. Which one fired is the whole repair.
      const r2 = await engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
      expect(r2.outcome.action).toBe("skip");
      expect((r2.outcome as { reason: string }).reason).toBe("gate_condition_unchanged");
      expect(deliveries).toHaveLength(1);
    });
  });

  // OPR.0.4.3.16 rev1-r1 fixback (advisor ruling 2026-07-03): the stuck-seat
  // skips (seat_needs_input / activity_stale_unknown) are the COMMON recurring
  // states for this policy's own target scenario — a gate pending on a seat that
  // never becomes fresh-idle. Left LOUD they emitted one history row + one SSE
  // PER SCAN, unbounded. They are now QUIET, so a gate that stays pending on a
  // stuck seat across MANY scans produces ZERO per-scan records — only the WAKE
  // (send) path stays loud/audited.
  describe("stuck-seat skips are QUIET across multiple scans (no per-scan history/SSE spam)", () => {
    function makeEngineWithCapture() {
      const jobsRepo = new WatchdogJobsRepository(db);
      const historyLog = new WatchdogHistoryLog(db);
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const deliver: DeliveryFn = async (req) => {
        deliveries.push(req);
        return { status: "ok" };
      };
      const engine = new WatchdogPolicyEngine({
        jobsRepo,
        historyLog,
        eventBus,
        deliver,
        now: () => NOW,
        additionalPolicies: [makeIdleGateQitemPolicy({ db, seatActivity })],
      });
      const registered = jobsRepo.register({
        policy: "idle-gate-qitem",
        specYaml: `policy: idle-gate-qitem\ntarget:\n  session: ${SEAT}\ninterval_seconds: 30\n`,
        targetSession: SEAT,
        intervalSeconds: 30,
        activeWakeIntervalSeconds: 300,
        registeredBySession: "ops@kernel",
      });
      return { jobsRepo, historyLog, engine, registered, deliveries };
    }

    it("gate pending on a NEEDS_INPUT seat across 5 scans → 0 history rows + 0 SSE + 0 deliveries", async () => {
      seedGateQitem("q-stuck-needs-input");
      seedActivity("PermissionRequest", FRESH); // → needs_input, never idle
      const { jobsRepo, historyLog, engine, registered, deliveries } = makeEngineWithCapture();
      const skippedEvents: unknown[] = [];
      eventBus.subscribe((e) => {
        if (e.type === "watchdog.evaluation_skipped") skippedEvents.push(e);
      });

      for (let scan = 0; scan < 5; scan++) {
        const r = await engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
        expect(r.outcome.action).toBe("skip");
        expect((r.outcome as { reason: string }).reason).toBe("seat_needs_input");
        expect(r.meaningful).toBe(false);
      }

      // The whole point: unbounded per-scan recording is gone.
      expect(historyLog.listForJob(registered.jobId)).toHaveLength(0);
      expect(skippedEvents).toHaveLength(0);
      expect(deliveries).toHaveLength(0);
    });

    it("gate pending on a STALE seat across 5 scans → 0 history rows + 0 SSE + 0 deliveries", async () => {
      seedGateQitem("q-stuck-stale");
      seedActivity("Stop", STALE); // stale evidence leaves the oracle honestly unknown
      const { jobsRepo, historyLog, engine, registered, deliveries } = makeEngineWithCapture();
      const skippedEvents: unknown[] = [];
      eventBus.subscribe((e) => {
        if (e.type === "watchdog.evaluation_skipped") skippedEvents.push(e);
      });

      for (let scan = 0; scan < 5; scan++) {
        const r = await engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
        expect(r.outcome.action).toBe("skip");
        expect((r.outcome as { reason: string }).reason).toBe("activity_stale_unknown");
        expect(r.meaningful).toBe(false);
      }

      expect(historyLog.listForJob(registered.jobId)).toHaveLength(0);
      expect(skippedEvents).toHaveLength(0);
      expect(deliveries).toHaveLength(0);
    });
  });
});
