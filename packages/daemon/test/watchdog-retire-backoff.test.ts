// #3479: a delivered park wake whose one-shot retirement keeps failing (SQLITE_CANTOPEN in a sandbox) backs off, is
// reported once, never wakes its owner twice, and retires once the write works. The real queue park, watchdog receipts,
// engine and scheduler; only the terminal send and the failing write are stand-ins.
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import type { SendResult } from "../src/domain/session-transport.js";
import { deriveCanonicalSessionName } from "../src/domain/session-name.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";

const stores: Database.Database[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => { for (const db of stores.splice(0)) if (db.open) db.close(); vi.useRealTimers(); vi.restoreAllMocks(); });
const later = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);

async function parkedRowWithTimer() {
  const db = new Database(":memory:"); stores.push(db);
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db), outbox = new OutboxHandler(db), jobs = new WatchdogJobsRepository(db), history = new WatchdogHistoryLog(db);
  const repo = new QueueRepository(db, bus);
  repo.attachOutbox(outbox);
  repo.attachWatchdogJobsRepository(jobs);
  repo.attachTransport({ async send() { return { ok: true, verified: true }; } });
  // Watchdog targets are canonical seat names, made the way the product makes them.
  const owner = deriveCanonicalSessionName("dev", "owner", "trial");
  const row = await repo.create({ sourceSession: deriveCanonicalSessionName("orch", "desk", "trial"), destinationSession: owner, body: "work", nudge: false });
  repo.update({ qitemId: row.qitemId, actorSession: owner, state: "blocked", blockedOn: "external:review",
    transitionNote: "waiting on review", wakeAfterSeconds: 30 });
  const jobId = repo.getParkWakeStatus(row.qitemId)!.ref;
  const send = vi.fn(async (session: string): Promise<SendResult> => ({ ok: true, sessionName: session, sent: true }));
  const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: bus, now: () => new Date(),
    deliver: makeWatchdogDeliver({ sessionTransport: { send }, outbox, now: () => new Date(), retryIntervalSeconds: 300, retryCap: 3 }),
    resolveQueueWait: input => repo.evaluateWaitReminder(input),
    resolvePreDeliveryTerminalReason: ({ jobId }) => repo.resolveWatchdogPreDeliveryTerminalReason(jobId),
    onWakeAttempt: ({ jobId, deliveryStatus, retryAt, queuedQitemId, targetSession }) =>
      repo.recordWatchdogWakeAttempt(jobId, deliveryStatus, retryAt, { queuedQitemId, targetSession }),
    accountingRetryIntervalSeconds: () => 300 });
  const errors: unknown[] = [];
  const scheduler = new WatchdogScheduler({ jobsRepo: jobs, policyEngine: engine, now: () => new Date(), onTickError: e => errors.push(e) });
  return { repo, jobs, history, row, jobId, owner, send, scheduler, errors };
}

it("backs off a delivered wake whose retirement keeps failing, reports it once, and retires it when the write works", async () => {
  const f = await parkedRowWithTimer();
  const cantopen = Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
  const retire = vi.spyOn(f.jobs, "markTerminal").mockImplementation(() => { throw cantopen; });
  const reports = () => f.history.listForJob(f.jobId).filter(h => h.evaluationNotes?.["wakeAccountingFailed"] === true);

  later(30); await f.scheduler.runTickNow();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.errors).toHaveLength(1);
  expect((f.errors[0] as Error).message).toContain("recording it failed");
  expect((f.errors[0] as Error).cause).toBe(cantopen);
  expect(reports()).toHaveLength(1);
  expect(reports()[0]).toMatchObject({ outcome: "failed", deliveryStatus: "ok",
    evaluationNotes: { code: "SQLITE_CANTOPEN", error: "unable to open database file" } });
  expect(f.jobs.getByIdOrThrow(f.jobId).state).toBe("active");
  const rows = f.history.listForJob(f.jobId).length;

  // The issue measured about a pass a second. One failure is retried at the next tick, as before; once it fails again,
  // nothing runs inside the retry interval: no try, history row or error.
  for (let i = 0; i < 120; i++) { later(1); await f.scheduler.runTickNow(); }
  expect(retire).toHaveBeenCalledTimes(2);
  expect(f.history.listForJob(f.jobId)).toHaveLength(rows + 1);
  expect(f.errors).toHaveLength(1);

  // At the retry the receipt reconciles, so nothing is typed again; the retirement fails again, quietly.
  later(300); await f.scheduler.runTickNow();
  expect(retire).toHaveBeenCalledTimes(3);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.errors).toHaveLength(1);
  expect(reports()).toHaveLength(1);

  // The write works again: the next try retires the timer and records the fire on the parked row.
  retire.mockRestore();
  later(300); await f.scheduler.runTickNow();
  expect(f.jobs.getByIdOrThrow(f.jobId)).toMatchObject({ state: "terminal", terminalReason: "park_timer_fired_once" });
  expect(f.repo.getParkWakeStatus(f.row.qitemId)).toMatchObject({ phase: "fired" });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.errors).toHaveLength(1);
  later(300); await f.scheduler.runTickNow();
  expect(f.send).toHaveBeenCalledTimes(1);
});

it("keeps a failure before any wake was delivered on its existing path", async () => {
  const f = await parkedRowWithTimer();
  f.send.mockResolvedValue({ ok: false, sessionName: f.owner, sent: false, inputPhase: "not_reached",
    reason: "tmux_unavailable", error: "The terminal service is not listening yet." });
  later(30); await f.scheduler.runTickNow();
  expect(f.errors).toHaveLength(0);
  expect(f.history.listForJob(f.jobId).some(h => h.evaluationNotes?.["wakeAccountingFailed"] === true)).toBe(false);
  expect(f.history.listForJob(f.jobId)[0]).toMatchObject({ deliveryStatus: "failed" });
});
