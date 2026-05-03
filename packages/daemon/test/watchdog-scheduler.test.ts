import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler, isDue } from "../src/domain/watchdog-scheduler.js";

describe("WatchdogScheduler (PL-004 Phase C)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let jobsRepo: WatchdogJobsRepository;
  let log: WatchdogHistoryLog;
  let deliveries: Array<{ targetSession: string; message: string }>;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]);
    bus = new EventBus(db);
    jobsRepo = new WatchdogJobsRepository(db);
    log = new WatchdogHistoryLog(db);
    deliveries = [];
  });

  afterEach(() => db.close());

  function makeEngine() {
    return new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: log,
      eventBus: bus,
      deliver: async (req) => {
        deliveries.push(req);
        return { status: "ok" };
      },
    });
  }

  it("isDue returns true for never-evaluated jobs", () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: x\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    expect(isDue(job, Date.now())).toBe(true);
  });

  it("isDue returns false when interval not yet elapsed", () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: x\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    jobsRepo.recordEvaluation(job.jobId, tenSecondsAgo, true);
    const updated = jobsRepo.getByIdOrThrow(job.jobId);
    expect(isDue(updated, Date.now())).toBe(false);
  });

  it("isDue returns true when interval elapsed", () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: x\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const longAgo = new Date(Date.now() - 60_000).toISOString();
    jobsRepo.recordEvaluation(job.jobId, longAgo, true);
    const updated = jobsRepo.getByIdOrThrow(job.jobId);
    expect(isDue(updated, Date.now())).toBe(true);
  });

  it("runTickNow only evaluates due active jobs", async () => {
    const j1 = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: m1\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const j2 = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: b@rig\n  message: m2\n",
      targetSession: "b@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    jobsRepo.recordEvaluation(j1.jobId, new Date(Date.now() - 5_000).toISOString(), true);

    const engine = makeEngine();
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine });
    await sched.runTickNow();
    expect(deliveries).toEqual([{ targetSession: "b@rig", message: "m2" }]);
  });

  it("runTickNow evaluates a due job at every subsequent due tick", async () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: m\n",
      targetSession: "a@rig",
      intervalSeconds: 1,
      registeredBySession: "ops@kernel",
    });
    const engine = makeEngine();
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine });
    await sched.runTickNow();
    expect(deliveries.length).toBe(1);
    // Re-mark as if evaluation was 5s ago to make the next tick due again.
    jobsRepo.recordEvaluation(job.jobId, new Date(Date.now() - 5_000).toISOString(), true);
    await sched.runTickNow();
    expect(deliveries.length).toBe(2);
  });

  it("stopped jobs are excluded from evaluation", async () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: m\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    jobsRepo.stop(job.jobId);
    const engine = makeEngine();
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine });
    await sched.runTickNow();
    expect(deliveries).toEqual([]);
  });

  it("terminal jobs are excluded from evaluation", async () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: m\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    jobsRepo.markTerminal(job.jobId, "done");
    const engine = makeEngine();
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine });
    await sched.runTickNow();
    expect(deliveries).toEqual([]);
  });

  it("policy evaluation errors are caught and tick continues for siblings", async () => {
    jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  message: only-message-no-target\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const ok = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: ok@rig\n  message: ok\n",
      targetSession: "ok@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const engine = makeEngine();
    const errors: unknown[] = [];
    const sched = new WatchdogScheduler({
      jobsRepo,
      policyEngine: engine,
      onTickError: (err) => errors.push(err),
    });
    await sched.runTickNow();
    expect(errors.length).toBe(1);
    expect(deliveries).toEqual([{ targetSession: "ok@rig", message: "ok" }]);
    // After successful eval the second job's last_evaluation_at should be set.
    const after = jobsRepo.getByIdOrThrow(ok.jobId);
    expect(after.lastEvaluationAt).not.toBeNull();
  });

  it("start + stop are idempotent and do not throw", async () => {
    const engine = makeEngine();
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine, tickIntervalMs: 60_000 });
    sched.start();
    sched.start();
    expect(sched.isRunning()).toBe(true);
    await sched.stop();
    await sched.stop();
    expect(sched.isRunning()).toBe(false);
  });

  it("recovers schedule across restart via SQLite (new repo + new scheduler picks up active jobs)", async () => {
    jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: persist@rig\n  message: persisted\n",
      targetSession: "persist@rig",
      intervalSeconds: 1,
      registeredBySession: "ops@kernel",
    });
    // Simulate restart: new repo + new history-log + new engine + new scheduler
    // sharing the same DB handle. Phase A/B pattern; SQLite is canonical.
    const repo2 = new WatchdogJobsRepository(db);
    const log2 = new WatchdogHistoryLog(db);
    const engine2 = new WatchdogPolicyEngine({
      jobsRepo: repo2,
      historyLog: log2,
      eventBus: bus,
      deliver: async (req) => {
        deliveries.push(req);
        return { status: "ok" };
      },
    });
    const sched2 = new WatchdogScheduler({ jobsRepo: repo2, policyEngine: engine2 });
    await sched2.runTickNow();
    expect(deliveries).toEqual([{ targetSession: "persist@rig", message: "persisted" }]);
  });
});
