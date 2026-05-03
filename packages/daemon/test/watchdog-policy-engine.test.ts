import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import {
  type DeliveryFn,
  WatchdogPolicyEngine,
} from "../src/domain/watchdog-policy-engine.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("WatchdogPolicyEngine (PL-004 Phase C R1)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let jobsRepo: WatchdogJobsRepository;
  let log: WatchdogHistoryLog;
  let captured: PersistedEvent[];
  let deliveryCalls: Array<{ targetSession: string; message: string }>;
  let deliver: DeliveryFn;

  function makeEngine(opts?: { deliver?: DeliveryFn; now?: () => Date }): WatchdogPolicyEngine {
    return new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: log,
      eventBus: bus,
      deliver: opts?.deliver ?? deliver,
      now: opts?.now,
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]);
    bus = new EventBus(db);
    jobsRepo = new WatchdogJobsRepository(db);
    log = new WatchdogHistoryLog(db);
    captured = [];
    bus.subscribe((e) => captured.push(e));
    deliveryCalls = [];
    deliver = async (req) => {
      deliveryCalls.push(req);
      return { status: "ok" };
    };
  });

  afterEach(() => db.close());

  it("evaluate(periodic-reminder) routes through delivery + records sent + emits evaluation_fired + sets actionable=true", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget:\n  session: alice@rig\ninterval_seconds: 60\nmessage: ping\n",
      targetSession: "alice@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    expect(deliveryCalls).toEqual([{ targetSession: "alice@rig", message: "ping" }]);
    expect(log.countForJob(job.jobId)).toBe(1);
    const list = log.listForJob(job.jobId);
    expect(list[0]?.outcome).toBe("sent");
    expect(captured.some((e) => e.type === "watchdog.evaluation_fired")).toBe(true);
    const after = jobsRepo.getByIdOrThrow(job.jobId);
    expect(after.lastEvaluationAt).not.toBeNull();
    expect(after.lastFireAt).not.toBeNull();
    expect(after.actionable).toBe(true);
    expect(after.lastActionableAt).not.toBeNull();
  });

  it("evaluate(quiet skip — no_actionable_artifacts) does NOT record history nor emit event (POC parity)", async () => {
    const engine = makeEngine({
      deliver: async () => {
        throw new Error("delivery should NOT be called for skip");
      },
    });
    const tmp = join(tmpdir(), `wd-eng-empty-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const job = jobsRepo.register({
        policy: "artifact-pool-ready",
        specYaml:
          `policy: artifact-pool-ready\ntarget:\n  session: alice@rig\ninterval_seconds: 60\ncontext:\n  pools:\n    - path: ${tmp}\n      include_statuses: [ready]\n`,
        targetSession: "alice@rig",
        intervalSeconds: 60,
        registeredBySession: "ops@kernel",
      });
      const result = await engine.evaluate(job);
      expect(result.outcome.action).toBe("skip");
      if (result.outcome.action !== "skip") return;
      expect(result.outcome.reason).toBe("no_actionable_artifacts");
      expect(result.meaningful).toBe(false);
      expect(deliveryCalls).toEqual([]);
      expect(log.countForJob(job.jobId)).toBe(0);
      expect(captured.some((e) => e.type === "watchdog.evaluation_skipped")).toBe(false);
      const after = jobsRepo.getByIdOrThrow(job.jobId);
      expect(after.lastEvaluationAt).not.toBeNull();
      expect(after.lastFireAt).toBeNull();
      expect(after.actionable).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("delivery failure recorded as sent with delivery_status=failed (still meaningful)", async () => {
    const failingDeliver: DeliveryFn = async () => ({ status: "failed", error: "transport denied" });
    const engine = makeEngine({ deliver: failingDeliver });
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget:\n  session: alice@rig\ninterval_seconds: 60\nmessage: ping\n",
      targetSession: "alice@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    const list = log.listForJob(job.jobId);
    expect(list[0]?.outcome).toBe("sent");
    expect(list[0]?.deliveryStatus).toBe("failed");
  });

  it("unknown policy at evaluate-time marks job terminal + records + emits evaluation_terminal", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget:\n  session: a@rig\nmessage: x\n",
      targetSession: "a@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    const synthetic = { ...job, policy: "totally-bogus" as never };
    const result = await engine.evaluate(synthetic);
    expect(result.outcome.action).toBe("terminal");
    const after = jobsRepo.getByIdOrThrow(job.jobId);
    expect(after.state).toBe("terminal");
    expect(captured.some((e) => e.type === "watchdog.evaluation_terminal")).toBe(true);
  });

  it("policy registry resolves the three v1 policies (workflow-keepalive absent)", () => {
    const engine = makeEngine();
    expect(engine.resolvePolicy("periodic-reminder")?.name).toBe("periodic-reminder");
    expect(engine.resolvePolicy("artifact-pool-ready")?.name).toBe("artifact-pool-ready");
    expect(engine.resolvePolicy("edge-artifact-required")?.name).toBe("edge-artifact-required");
    expect(engine.resolvePolicy("workflow-keepalive")).toBeUndefined();
  });

  it("default spec parser extracts top-level target + context + message", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget:\n  session: parsed-session@rig\nmessage: parsed-message\ninterval_seconds: 60\n",
      targetSession: "registered-fallback@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    expect(deliveryCalls).toEqual([
      { targetSession: "parsed-session@rig", message: "parsed-message" },
    ]);
  });

  it("falls back to registered targetSession when spec lacks top-level target", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      // No top-level target. Engine should synthesize {session: targetSession}.
      specYaml: "policy: periodic-reminder\nmessage: ping\ninterval_seconds: 60\n",
      targetSession: "fallback@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    expect(deliveryCalls).toEqual([{ targetSession: "fallback@rig", message: "ping" }]);
  });

  // R1 fix (guard blocker 1): port the POC active-wake regression.
  // POC source: tests/watchdog-active-wake-interval.test.sh
  it("active-wake throttle: re-delivery suppressed during wake window; fires when window elapses", async () => {
    const tmp = join(tmpdir(), `wd-actwake-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const job = jobsRepo.register({
        policy: "artifact-pool-ready",
        specYaml:
          `policy: artifact-pool-ready\ntarget:\n  session: loop-head@example\ninterval_seconds: 30\nscan_interval_seconds: 30\nactive_wake_interval_seconds: 600\ncontext:\n  pools:\n    - path: ${tmp}\n      include_statuses: [ready]\n`,
        targetSession: "loop-head@example",
        intervalSeconds: 30,
        scanIntervalSeconds: 30,
        activeWakeIntervalSeconds: 600,
        registeredBySession: "ops@kernel",
      });

      // Tick 1: empty pool → quiet skip(no_actionable_artifacts), actionable=false.
      let nowMs = 0;
      let engine = makeEngine({ now: () => new Date(nowMs) });
      let r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
      expect(deliveryCalls.length).toBe(0);

      // Make pool actionable.
      writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");

      // Tick 2: newly actionable → fires (no throttle on transition).
      nowMs = 30_000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome.action).toBe("send");
      expect(deliveryCalls.length).toBe(1);
      const afterFire = jobsRepo.getByIdOrThrow(job.jobId);
      expect(afterFire.actionable).toBe(true);
      expect(afterFire.lastFireAt).toBe("1970-01-01T00:00:30.000Z");

      // Tick 3 at +30s after fire (60s mark): pool still actionable but
      // wake window (600s) not elapsed → quiet skip(active_wake_not_due).
      nowMs = 60_000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome).toEqual({ action: "skip", reason: "active_wake_not_due" });
      expect(deliveryCalls.length).toBe(1);
      // last_fire_at preserved.
      expect(jobsRepo.getByIdOrThrow(job.jobId).lastFireAt).toBe("1970-01-01T00:00:30.000Z");
      // actionable still true.
      expect(jobsRepo.getByIdOrThrow(job.jobId).actionable).toBe(true);

      // Tick 4 at 630_000ms (>= last_fire + 600_000ms): wake window
      // elapsed → fires again.
      nowMs = 630_000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome.action).toBe("send");
      expect(deliveryCalls.length).toBe(2);
      const after2ndFire = jobsRepo.getByIdOrThrow(job.jobId);
      expect(after2ndFire.lastFireAt).toBe("1970-01-01T00:10:30.000Z");

      // Tick 5: pool empties → quiet skip resets actionable.
      rmSync(join(tmp, "ready.md"));
      nowMs = 660_000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
      expect(jobsRepo.getByIdOrThrow(job.jobId).actionable).toBe(false);

      // Tick 6: pool actionable again → fires immediately (newly actionable).
      writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");
      nowMs = 690_000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome.action).toBe("send");
      expect(deliveryCalls.length).toBe(3);

      // History reflects only the 3 meaningful events.
      expect(log.countForJob(job.jobId)).toBe(3);
      const entries = log.listForJob(job.jobId);
      // All sent (no quiet skip rows).
      for (const e of entries) expect(e.outcome).toBe("sent");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("active-wake throttle does NOT apply when active_wake_interval_seconds is null (every fire goes through)", async () => {
    const tmp = join(tmpdir(), `wd-actwake-null-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");
    try {
      const job = jobsRepo.register({
        policy: "artifact-pool-ready",
        specYaml:
          `policy: artifact-pool-ready\ntarget:\n  session: x@rig\ninterval_seconds: 30\ncontext:\n  pools:\n    - path: ${tmp}\n      include_statuses: [ready]\n`,
        targetSession: "x@rig",
        intervalSeconds: 30,
        registeredBySession: "ops@kernel",
      });
      let nowMs = 0;
      let engine = makeEngine({ now: () => new Date(nowMs) });
      await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(deliveryCalls.length).toBe(1);
      nowMs = 1000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      // Without wake throttle, every send fires.
      expect(deliveryCalls.length).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
