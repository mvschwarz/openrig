// The real watchdog loop and receipt store; terminal input is inert.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, type SendResult } from "../src/domain/session-transport.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";

const seat = "worker@test";
const unavailable: SendResult = { ok: false, sessionName: seat, sent: false, inputPhase: "not_reached",
  reason: "tmux_unavailable", error: "The terminal service is not listening yet." };
const delivered: SendResult = { ok: true, sessionName: seat, sent: true };
const stores: Database.Database[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => { for (const db of stores.splice(0)) if (db.open) db.close(); vi.useRealTimers(); });
const later = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);
function database(saved?: Buffer) {
  const db = new Database(saved ?? ":memory:"); stores.push(db);
  if (!saved) migrate(db, ALL_MIGRATIONS);
  return db;
}
function boot(db: Database.Database, send: (session: string, body: string) => Promise<SendResult>, digest = false) {
  const jobs = new WatchdogJobsRepository(db), history = new WatchdogHistoryLog(db), outbox = new OutboxHandler(db);
  const deps = { sessionTransport: { send }, outbox, now: () => new Date(), retryIntervalSeconds: 300, retryCap: 3 };
  const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(db),
    deliver: makeWatchdogDeliver(deps), now: () => new Date(),
    resolveDigestEntry: digest ? ({ jobId, message }) => ({ qitemId: jobId, summary: message }) : undefined });
  const errors: unknown[] = [];
  const scheduler = new WatchdogScheduler({ jobsRepo: jobs, policyEngine: engine, now: () => new Date(), onTickError: e => errors.push(e) });
  return { db, jobs, history, outbox, scheduler, errors };
}
function arm(f: ReturnType<typeof boot>) {
  const job = f.jobs.register({ policy: "periodic-reminder", specYaml: `target: { session: ${seat} }\nmessage: Check the work\n`,
    targetSession: seat, intervalSeconds: 3600, registeredBySession: "owner@test" });
  later(3600);
  return job;
}
function occurrence(f: ReturnType<typeof boot>, jobId: string) {
  return f.outbox.listForSender("watchdog@system").find(e => e.auditPointer === jobId)!;
}

describe("an undelivered scheduled occurrence remains owed", () => {
  it("recovers after the recipient starts, with bounded repeated passes and durable identity across restart", async () => {
    let result = unavailable;
    const send = vi.fn(async () => result);
    const first = boot(database(), send), job = arm(first);
    await first.scheduler.runTickNow();
    expect(first.history.listForJob(job.jobId)[0]?.deliveryStatus).toBe("failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.jobs.getByIdOrThrow(job.jobId).lastFireAt).toBeNull();
    const id = occurrence(first, job.jobId).outboxId;
    await first.scheduler.runTickNow(); later(299); await first.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(1);
    const saved = first.db.serialize(); first.db.close();
    const resumed = boot(database(saved), send);
    expect(occurrence(resumed, job.jobId).outboxId).toBe(id);
    result = delivered; later(1); await resumed.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(2);
    expect(resumed.outbox.getById(id)?.deliveryState).toBe("delivered");
    expect(resumed.jobs.getByIdOrThrow(job.jobId).lastFireAt).toBe(new Date().toISOString());
    await resumed.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("reconciles a confirmed delivery after accounting was interrupted, without typing it twice", async () => {
    const send = vi.fn(async () => delivered), first = boot(database(), send), job = arm(first);
    vi.spyOn(first.jobs, "recordEvaluation").mockImplementationOnce(() => { throw new Error("accounting interrupted"); });
    await first.scheduler.runTickNow();
    expect(first.errors).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.jobs.getByIdOrThrow(job.jobId).lastFireAt).toBeNull();
    const saved = first.db.serialize(); first.db.close();
    const resumed = boot(database(saved), send);
    later(1); // Distinct evaluation times: random ULIDs do not order two records at the same fake instant.
    await resumed.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(resumed.jobs.getByIdOrThrow(job.jobId).lastFireAt).not.toBeNull();
    expect(resumed.history.listForJob(job.jobId)[0]?.skipReason).toBe("delivery_receipt_reconciled");
  });

  it("ends an uncertain occurrence across restart without treating it as unsent", async () => {
    const send = vi.fn(async () => ({ ok: false, sessionName: seat, inputPhase: "attempted" as const,
      reason: "delivery_indeterminate", error: "Input acknowledgement was lost." }));
    const first = boot(database(), send), job = arm(first);
    await first.scheduler.runTickNow();
    expect(first.jobs.getByIdOrThrow(job.jobId).lastFireAt).toBe("2026-01-01T01:00:00.000Z");
    const id = occurrence(first, job.jobId).outboxId;
    expect(first.outbox.getById(id)?.deliveryState).toBe("indeterminate");
    const saved = first.db.serialize(); first.db.close();
    const resumed = boot(database(saved), send);
    later(600); await resumed.scheduler.runTickNow(); await resumed.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(resumed.outbox.getById(id)?.deliveryState).toBe("indeterminate");
    expect(resumed.jobs.getByIdOrThrow(job.jobId).lastFireAt).toBe("2026-01-01T01:00:00.000Z");
    expect(resumed.history.listForJob(job.jobId)[0]?.evaluationNotes?.nextAction).toContain("unconfirmed");
  });

  it("keeps a non-retryable failure visible with its cause and next action", async () => {
    const send = vi.fn(async () => ({ ...unavailable, reason: "transport_unavailable", error: "This external CLI target has no inbound terminal transport." }));
    const f = boot(database(), send), job = arm(f);
    await f.scheduler.runTickNow();
    expect(f.history.listForJob(job.jobId)[0]?.evaluationNotes?.deliveryReason).toContain("external CLI");
    expect(f.jobs.getByIdOrThrow(job.jobId).state).toBe("terminal");
    expect(f.jobs.getByIdOrThrow(job.jobId).lastFireAt).not.toBeNull();
    expect(f.history.listForJob(job.jobId)[0]?.evaluationNotes?.nextAction).toEqual(expect.any(String));
    later(86_400); await f.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("exhausts definite no-input retries instead of churning forever", async () => {
    const send = vi.fn(async () => unavailable), f = boot(database(), send), job = arm(f);
    await f.scheduler.runTickNow();
    for (let i = 0; i < 6; i++) { later(300); await f.scheduler.runTickNow(); }
    expect(send).toHaveBeenCalledTimes(4); // Original attempt and the existing three-retry cap.
    expect(f.jobs.getByIdOrThrow(job.jobId).state).toBe("active");
    expect(f.history.listForJob(job.jobId)[0]?.evaluationNotes?.nextAction).toContain("exhausted");
    expect(f.jobs.getByIdOrThrow(job.jobId).lastFireAt).not.toBeNull();
  });

  it("keeps a successful reminder's selected recurrence unchanged", async () => {
    const send = vi.fn(async () => delivered), f = boot(database(), send), job = arm(f);
    await f.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.jobs.getByIdOrThrow(job.jobId).lastFireAt).toBe(new Date().toISOString());
    later(3599); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
    later(1); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(2);
  });

  it("records a real terminal-service preflight failure as definitely before input", async () => {
    const db = database();
    db.exec(`INSERT INTO rigs(id,name) VALUES ('r','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('n','r','worker','claude-code');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('s','n','worker@test','running');`);
    const exec = vi.fn(async () => ""), tmux = new TmuxAdapter(exec);
    vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "transport_unavailable", cause: "terminal service has not started" });
    const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db) });
    const result = await transport.send(seat, "The reminder is owed", { actorSession: "watchdog@system", openrigNotice: true });
    expect(result.reason).toBe("tmux_unavailable");
    expect(exec).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached" });
  });

  it("accounts for every confirmed digest member after interrupted accounting without repeating the digest", async () => {
    const send = vi.fn(async () => delivered), first = boot(database(), send, true);
    const register = () => first.jobs.register({ policy: "periodic-reminder", specYaml: `message: Check the work\n`,
      targetSession: seat, intervalSeconds: 3600, registeredBySession: "owner@test" });
    const a = register(), b = register(); later(3600);
    vi.spyOn(first.jobs, "recordEvaluation").mockImplementationOnce(() => { throw new Error("digest accounting interrupted"); });
    await first.scheduler.runTickNow();
    expect(first.errors).toHaveLength(1); expect(send).toHaveBeenCalledTimes(1);
    expect(first.jobs.getByIdOrThrow(a.jobId).lastFireAt).toBeNull();
    expect(first.jobs.getByIdOrThrow(b.jobId).lastFireAt).toBeNull();
    const saved = first.db.serialize(); first.db.close();
    const resumed = boot(database(saved), send, true); await resumed.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(resumed.jobs.getByIdOrThrow(a.jobId).lastFireAt).not.toBeNull();
    expect(resumed.jobs.getByIdOrThrow(b.jobId).lastFireAt).not.toBeNull();
  });

  it("keeps each digest member's own retry budget when an older failure joins a new reminder", async () => {
    let result = unavailable;
    const send = vi.fn(async () => result), f = boot(database(), send, true), old = arm(f);
    await f.scheduler.runTickNow();
    later(300); await f.scheduler.runTickNow(); later(300); await f.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(3);
    later(299);
    const fresh = f.jobs.register({ policy: "periodic-reminder", specYaml: `message: Fresh work\n`,
      targetSession: seat, intervalSeconds: 1, registeredBySession: "owner@test" });
    later(1); await f.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(4);
    expect(f.jobs.getByIdOrThrow(old.jobId).state).toBe("active");
    expect(f.jobs.getByIdOrThrow(fresh.jobId).state).toBe("active");
    expect(f.jobs.getByIdOrThrow(fresh.jobId).lastFireAt).toBeNull();
    result = delivered; later(300); await f.scheduler.runTickNow();
    expect(send).toHaveBeenCalledTimes(5);
    expect(f.jobs.getByIdOrThrow(fresh.jobId).lastFireAt).not.toBeNull();
  });

  it("keeps deliberate input retention in its existing custody", async () => {
    const send = vi.fn(async () => ({ ok: true, sessionName: seat, outcome: "retained" as const,
      sent: false, outboxIds: ["held-original"] }));
    const f = boot(database(), send), job = arm(f); await f.scheduler.runTickNow();
    expect(f.jobs.getByIdOrThrow(job.jobId).lastFireAt).not.toBeNull();
    expect(occurrence(f, job.jobId).deliveryState).toBe("retained");
    expect(f.history.listForJob(job.jobId)[0]?.evaluationNotes?.outboxIds).toContain("held-original");
    later(300); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
  });
});
