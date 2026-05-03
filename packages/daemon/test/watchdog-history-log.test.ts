import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";

describe("WatchdogHistoryLog (PL-004 Phase C; append-only audit)", () => {
  let db: Database.Database;
  let jobsRepo: WatchdogJobsRepository;
  let log: WatchdogHistoryLog;
  let jobId: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]);
    jobsRepo = new WatchdogJobsRepository(db);
    log = new WatchdogHistoryLog(db);
    jobId = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder",
      targetSession: "a@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    }).jobId;
  });

  afterEach(() => db.close());

  it("record(sent) persists delivery target/status/message + ULID id", () => {
    const e = log.record({
      jobId,
      evaluatedAt: "2026-05-03T07:00:00.000Z",
      outcome: "sent",
      deliveryTargetSession: "a@rig",
      deliveryStatus: "ok",
      deliveryMessage: "hello",
    });
    expect(e.historyId).toMatch(/^[0-9A-Z]{26}$/);
    expect(e.outcome).toBe("sent");
    expect(e.deliveryTargetSession).toBe("a@rig");
    expect(e.deliveryStatus).toBe("ok");
    expect(e.deliveryMessage).toBe("hello");
  });

  it("record(skipped) persists reason + null delivery fields", () => {
    const e = log.record({
      jobId,
      evaluatedAt: "2026-05-03T07:00:00.000Z",
      outcome: "skipped",
      skipReason: "no_actionable_artifacts",
    });
    expect(e.outcome).toBe("skipped");
    expect(e.skipReason).toBe("no_actionable_artifacts");
    expect(e.deliveryTargetSession).toBeNull();
  });

  it("record(terminal) persists reason", () => {
    const e = log.record({
      jobId,
      evaluatedAt: "2026-05-03T07:00:00.000Z",
      outcome: "terminal",
      skipReason: "policy_done",
    });
    expect(e.outcome).toBe("terminal");
    expect(e.skipReason).toBe("policy_done");
  });

  it("record JSON-encodes evaluation_notes and decodes on read", () => {
    log.record({
      jobId,
      evaluatedAt: "2026-05-03T07:00:00.000Z",
      outcome: "sent",
      deliveryTargetSession: "a@rig",
      deliveryStatus: "ok",
      deliveryMessage: "x",
      evaluationNotes: { artifact_count: 7, label: "foo" },
    });
    const list = log.listForJob(jobId);
    expect(list[0]?.evaluationNotes).toEqual({ artifact_count: 7, label: "foo" });
  });

  it("listForJob returns DESC by evaluated_at", () => {
    log.record({ jobId, evaluatedAt: "2026-05-03T07:00:00.000Z", outcome: "sent", deliveryTargetSession: "a@rig", deliveryStatus: "ok", deliveryMessage: "first" });
    log.record({ jobId, evaluatedAt: "2026-05-03T07:01:00.000Z", outcome: "sent", deliveryTargetSession: "a@rig", deliveryStatus: "ok", deliveryMessage: "second" });
    const list = log.listForJob(jobId);
    expect(list[0]?.deliveryMessage).toBe("second");
    expect(list[1]?.deliveryMessage).toBe("first");
  });

  it("countForJob returns the number of recorded entries", () => {
    expect(log.countForJob(jobId)).toBe(0);
    log.record({ jobId, evaluatedAt: "2026-05-03T07:00:00.000Z", outcome: "skipped", skipReason: "x" });
    log.record({ jobId, evaluatedAt: "2026-05-03T07:00:00.000Z", outcome: "skipped", skipReason: "x" });
    expect(log.countForJob(jobId)).toBe(2);
  });

  it("FK violation: record() against unknown job_id throws SQLite FK error", () => {
    expect(() =>
      log.record({
        jobId: "unknown-job-id",
        evaluatedAt: "2026-05-03T07:00:00.000Z",
        outcome: "skipped",
        skipReason: "x",
      }),
    ).toThrow();
  });

  it("API surface does NOT expose update or delete (append-only contract)", () => {
    const proto = Object.getPrototypeOf(log) as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(proto);
    expect(names).not.toContain("update");
    expect(names).not.toContain("delete");
    expect(names).not.toContain("remove");
    expect(names).not.toContain("modify");
  });
});
