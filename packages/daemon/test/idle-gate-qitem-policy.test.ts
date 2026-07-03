import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
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
  let store: AgentActivityStore;

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
    const res = store.recordHookEvent({ runtime: "claude-code", sessionName: SEAT, hookEvent, occurredAt });
    expect(res.ok).toBe(true);
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
    migrate(db, [watchdogJobsSchema, watchdogHistorySchema]); // idempotent; adds watchdog tables
    eventBus = new EventBus(db);
    store = new AgentActivityStore({ db, eventBus, now: () => NOW });
    seedSeat();
  });

  afterEach(() => db.close());

  it("pending gate:guard qitem + FRESH idle → ONE send; notes record the qitem + activity signal", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH); // → idle
    const policy = makeIdleGateQitemPolicy({ db, agentActivityStore: store });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target.session).toBe(SEAT);
    expect(out.message).toContain("q-gate-1");
    expect(out.notes?.qitemId).toBe("q-gate-1");
    expect(out.notes?.gateRoles).toEqual(["guard"]);
    expect(out.notes?.activityState).toBe("idle");
    expect(out.notes?.activityEvidenceSource).toBe("runtime_hook");
  });

  it("human-gate tier (no gate:* tag) + FRESH idle → send (secondary predicate, gate:human)", async () => {
    seedGateQitem("q-human-1", { tags: null, tier: "human-gate" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, agentActivityStore: store });
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
    const policy = makeIdleGateQitemPolicy({ db, agentActivityStore: store });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("no_pending_gate");
  });

  it("seat running → skip seat_active (no idle-wake)", async () => {
    seedGateQitem("q-gate-2");
    seedActivity("UserPromptSubmit", FRESH); // → running
    const policy = makeIdleGateQitemPolicy({ db, agentActivityStore: store });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("seat_active");
  });

  it("seat needs_input → skip seat_needs_input (never drive a live picker)", async () => {
    seedGateQitem("q-gate-3");
    seedActivity("PermissionRequest", FRESH); // → needs_input
    const policy = makeIdleGateQitemPolicy({ db, agentActivityStore: store });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("seat_needs_input");
  });

  it("STALE idle activity → honest skip activity_stale_unknown (never fake-idle)", async () => {
    seedGateQitem("q-gate-4");
    seedActivity("Stop", STALE); // idle but 10 min old → store degrades to unknown/stale
    const policy = makeIdleGateQitemPolicy({ db, agentActivityStore: store });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("activity_stale_unknown");
  });

  it("no activity signal at all → honest skip activity_stale_unknown", async () => {
    seedGateQitem("q-gate-5");
    // no seedActivity
    const policy = makeIdleGateQitemPolicy({ db, agentActivityStore: store });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("activity_stale_unknown");
  });

  it("gate qitem already claimed (in-progress) → does NOT fire (not-claimable → skip)", async () => {
    seedGateQitem("q-claimed", { state: "in-progress" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, agentActivityStore: store });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("no_pending_gate");
  });

  it("blocked gate qitem is claimable → fires when idle", async () => {
    seedGateQitem("q-blocked", { state: "blocked" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, agentActivityStore: store });
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
        additionalPolicies: [makeIdleGateQitemPolicy({ db, agentActivityStore: store })],
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

      // Second immediate evaluation → engine active-wake throttle quiet-skips
      // (cooldown is FREE; no duplicate wake).
      const r2 = await engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
      expect(r2.outcome.action).toBe("skip");
      expect((r2.outcome as { reason: string }).reason).toBe("active_wake_not_due");
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
        additionalPolicies: [makeIdleGateQitemPolicy({ db, agentActivityStore: store })],
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
      seedActivity("Stop", STALE); // idle but 10 min old → degrades to stale/unknown
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
