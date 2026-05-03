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
import {
  type DeliveryFn,
  WatchdogPolicyEngine,
} from "../src/domain/watchdog-policy-engine.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("WatchdogPolicyEngine (PL-004 Phase C)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let jobsRepo: WatchdogJobsRepository;
  let log: WatchdogHistoryLog;
  let captured: PersistedEvent[];
  let deliveryCalls: Array<{ targetSession: string; message: string }>;
  let deliver: DeliveryFn;

  function makeEngine(deliverOverride?: DeliveryFn): WatchdogPolicyEngine {
    return new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: log,
      eventBus: bus,
      deliver: deliverOverride ?? deliver,
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

  it("evaluate(periodic-reminder) routes through delivery + records sent + emits evaluation_fired", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget: alice@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: alice@rig\n  message: ping\n",
      targetSession: "alice@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    const result = await engine.evaluate(job);
    expect(result.outcome.action).toBe("send");
    expect(deliveryCalls).toEqual([{ targetSession: "alice@rig", message: "ping" }]);
    expect(log.countForJob(job.jobId)).toBe(1);
    const list = log.listForJob(job.jobId);
    expect(list[0]?.outcome).toBe("sent");
    expect(list[0]?.deliveryStatus).toBe("ok");
    expect(captured.some((e) => e.type === "watchdog.evaluation_fired")).toBe(true);
    const after = jobsRepo.getByIdOrThrow(job.jobId);
    expect(after.lastEvaluationAt).not.toBeNull();
    expect(after.lastFireAt).not.toBeNull();
  });

  it("evaluate records skipped + emits evaluation_skipped + does NOT touch last_fire_at", async () => {
    const engine = makeEngine(async () => {
      throw new Error("delivery should NOT be called for skip");
    });
    // artifact-pool-ready against an empty pool returns skip(no_actionable_artifacts).
    const job = jobsRepo.register({
      policy: "artifact-pool-ready",
      specYaml:
        "policy: artifact-pool-ready\ntarget: alice@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: alice@rig\n  pools:\n    path: /nonexistent-pool-dir-for-test\n",
      targetSession: "alice@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    const result = await engine.evaluate(job);
    expect(result.outcome.action).toBe("skip");
    if (result.outcome.action !== "skip") return;
    expect(result.outcome.reason).toBe("no_actionable_artifacts");
    expect(deliveryCalls).toEqual([]);
    expect(log.countForJob(job.jobId)).toBe(1);
    expect(log.listForJob(job.jobId)[0]?.outcome).toBe("skipped");
    expect(captured.some((e) => e.type === "watchdog.evaluation_skipped")).toBe(true);
    const after = jobsRepo.getByIdOrThrow(job.jobId);
    expect(after.lastEvaluationAt).not.toBeNull();
    expect(after.lastFireAt).toBeNull();
  });

  it("delivery failure is recorded as sent outcome with delivery_status=failed", async () => {
    const failingDeliver: DeliveryFn = async () => ({ status: "failed", error: "transport denied" });
    const engine = makeEngine(failingDeliver);
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget: alice@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: alice@rig\n  message: ping\n",
      targetSession: "alice@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    const list = log.listForJob(job.jobId);
    expect(list[0]?.outcome).toBe("sent");
    expect(list[0]?.deliveryStatus).toBe("failed");
  });

  it("unknown policy at evaluate-time marks job terminal + emits evaluation_terminal", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ncontext:\n  target:\n    session: a@rig\n  message: x\n",
      targetSession: "a@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    // Hand-craft a job carrying an unknown policy name. The engine should
    // treat this defensively: terminal + history record + event.
    const synthetic = { ...job, policy: "totally-bogus" as never };
    const result = await engine.evaluate(synthetic);
    expect(result.outcome.action).toBe("terminal");
    const after = jobsRepo.getByIdOrThrow(job.jobId);
    expect(after.state).toBe("terminal");
    expect(captured.some((e) => e.type === "watchdog.evaluation_terminal")).toBe(true);
  });

  it("policy registry resolves the three v1 policies", () => {
    const engine = makeEngine();
    expect(engine.resolvePolicy("periodic-reminder")?.name).toBe("periodic-reminder");
    expect(engine.resolvePolicy("artifact-pool-ready")?.name).toBe("artifact-pool-ready");
    expect(engine.resolvePolicy("edge-artifact-required")?.name).toBe("edge-artifact-required");
    expect(engine.resolvePolicy("workflow-keepalive")).toBeUndefined();
  });

  it("default YAML parser extracts nested context block", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget: a@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: parsed-session@rig\n  message: parsed-message\n",
      targetSession: "a@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    expect(deliveryCalls).toEqual([
      { targetSession: "parsed-session@rig", message: "parsed-message" },
    ]);
  });
});
