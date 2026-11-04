// Real migrated queue/watchdog accounting, with inert terminal input and a deterministic clock.
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, type SendResult } from "../src/domain/session-transport.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";

const seat = "worker@test", stores: Database.Database[] = [];
const absent: SendResult = { ok: false, sessionName: seat, sent: false, inputPhase: "not_reached", reason: "tmux_unavailable", error: "Terminal service not yet listening" };
const delivered: SendResult = { ok: true, sessionName: seat, sent: true };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => { for (const db of stores.splice(0)) if (db.open) db.close(); vi.useRealTimers(); });
const later = (s: number) => vi.setSystemTime(Date.now() + s * 1000);
function fixture(send: (session: string, body: string) => Promise<SendResult>, saved?: Buffer, digest = false) {
  const db = new Database(saved ?? ":memory:"); stores.push(db); if (!saved) migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db), outbox = new OutboxHandler(db), jobs = new WatchdogJobsRepository(db), history = new WatchdogHistoryLog(db);
  const repo = new QueueRepository(db, bus);
  repo.attachWatchdogJobsRepository(jobs);
  // The optional argument is ignored by the old callback; the test still exercises its actual old behavior.
  const account = repo.recordWatchdogWakeAttempt.bind(repo) as (id: string, status: string, retryAt?: string) => void;
  const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: bus,
    deliver: makeWatchdogDeliver({ sessionTransport: { send }, outbox, now: () => new Date(), retryIntervalSeconds: 300, retryCap: 3 }),
    resolvePreDeliveryTerminalReason: ({ jobId }) => repo.resolveWatchdogPreDeliveryTerminalReason(jobId),
    onWakeAttempt: ({ jobId, deliveryStatus, retryAt }: { jobId: string; deliveryStatus: string; retryAt?: string }) => account(jobId, deliveryStatus, retryAt),
    resolveDigestEntry: digest ? ({ jobId, message }) => ({ qitemId: jobId, summary: message }) : undefined });
  const errors: unknown[] = [], scheduler = new WatchdogScheduler({ jobsRepo: jobs, policyEngine: engine, onTickError: e => errors.push(e) });
  const park = async () => {
    const row = await repo.create({ sourceSession: "owner@test", destinationSession: seat, body: "Continue work", nudge: false });
    repo.update({ qitemId: row.qitemId, actorSession: seat, state: "blocked", blockedOn: "external:wait", transitionNote: "continuation: work", wakeAfterSeconds: 3600 } as never);
    return { qitemId: row.qitemId, jobId: repo.getParkWakeStatus(row.qitemId)!.ref };
  };
  const reminder = () => jobs.register({ policy: "periodic-reminder", specYaml: `message: Check work\n`, targetSession: seat, intervalSeconds: 3600, registeredBySession: "owner@test" });
  return { db, bus, jobs, history, outbox, repo, errors, scheduler, park, reminder };
}

it("exhausts one occurrence but delivers the next normal recurring cycle under a new identity", async () => {
  let result = absent; const send = vi.fn(async () => result), f = fixture(send), job = f.reminder();
  later(3600); await f.scheduler.runTickNow();
  for (let i = 0; i < 3; i++) { later(300); await f.scheduler.runTickNow(); }
  expect(send).toHaveBeenCalledTimes(4);
  const old = f.outbox.listForSender("watchdog@system")[0]!;
  expect(old.deliveryState).toBe("failed");
  expect(f.jobs.getByIdOrThrow(job.jobId).state).toBe("active");
  expect(f.history.listForJob(job.jobId)[0]?.evaluationNotes?.nextAction).toContain("next regular cycle");
  result = delivered; later(3599); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(4);
  later(1); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(5);
  const entries = f.outbox.listForSender("watchdog@system");
  expect(entries).toHaveLength(2); expect(f.outbox.getById(old.outboxId)?.deliveryState).toBe("failed");
  expect(entries.filter(e => e.deliveryState === "delivered")).toHaveLength(1);
});

it("does not replay an uncertain occurrence, while keeping the next recurring cycle", async () => {
  let result: SendResult = { ok: false, sessionName: seat, inputPhase: "attempted", error: "Acknowledgement lost" };
  const send = vi.fn(async () => result), f = fixture(send), job = f.reminder();
  later(3600); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
  const old = f.outbox.listForSender("watchdog@system")[0]!; expect(old.deliveryState).toBe("indeterminate");
  expect(f.jobs.getByIdOrThrow(job.jobId).lastFireAt).toBe(new Date().toISOString());
  expect(f.history.listForJob(job.jobId)[0]?.evaluationNotes?.nextAction).toContain("unconfirmed");
  const saved = f.db.serialize(); f.db.close(); const resumed = fixture(send, saved);
  later(3599); await resumed.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
  result = delivered; later(1); await resumed.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(2);
  expect(resumed.outbox.getById(old.outboxId)?.deliveryState).toBe("indeterminate");
  expect(resumed.outbox.listForSender("watchdog@system")).toHaveLength(2);
});

it("records an uncertain one-shot park failure on its row before retiring the timer", async () => {
  const send = vi.fn(async () => ({ ok: false, sessionName: seat, inputPhase: "attempted" as const, error: "Acknowledgement lost" }));
  const f = fixture(send), row = await f.park(); later(3600); await f.scheduler.runTickNow();
  expect(send).toHaveBeenCalledTimes(1); expect(f.repo.getById(row.qitemId)?.state).toBe("blocked");
  expect(f.history.listForJob(row.jobId)[0]?.deliveryStatus).toBe("failed");
  expect(f.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "fired", deliveryStatus: "failed", live: false, unconsumed: true });
  expect(f.jobs.getByIdOrThrow(row.jobId).state).toBe("terminal");
  later(7200); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
});

it("records a retryable refusal on the parked row without consuming its one-shot binding", async () => {
  let result = absent; const send = vi.fn(async () => result), f = fixture(send), row = await f.park();
  later(3600); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
  expect(f.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "armed", live: true });
  const notes = f.db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1").get(row.qitemId) as { transition_note: string };
  expect(notes.transition_note).toContain("retry at");
  result = delivered; later(300); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(2);
  expect(f.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "fired", deliveryStatus: "ok", live: false });
});

it("records exhausted one-shot retries as a failed wake before ending the timer", async () => {
  const send = vi.fn(async () => absent), f = fixture(send), row = await f.park();
  later(3600); await f.scheduler.runTickNow();
  for (let i = 0; i < 3; i++) { later(300); await f.scheduler.runTickNow(); }
  expect(f.errors).toHaveLength(0); expect(send).toHaveBeenCalledTimes(4);
  expect(f.repo.getById(row.qitemId)?.state).toBe("blocked");
  expect(f.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "fired", deliveryStatus: "failed", live: false, unconsumed: true });
  expect(f.jobs.getByIdOrThrow(row.jobId).terminalReason).toBe("park_timer_fired_once");
  expect(f.history.listForJob(row.jobId)[0]?.evaluationNotes?.nextAction).toContain("exhausted");
  later(7200); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(4);
});

it.each([false, true])("repairs a post-fire accounting crash without duplicate input (digest=%s)", async digest => {
  const send = vi.fn(async () => delivered), f = fixture(send, undefined, digest), rows = [await f.park()];
  if (digest) rows.push(await f.park());
  const cut = rows.at(-1)!, original = f.jobs.recordEvaluation.bind(f.jobs); let stampSeen = false;
  vi.spyOn(f.jobs, "recordEvaluation").mockImplementation((id, at, fired, schedule) => {
    original(id, at, fired, schedule);
    if (id === cut.jobId && fired && !stampSeen) {
      stampSeen = true; expect(f.jobs.getByIdOrThrow(id).lastFireAt).toBe(at);
      throw new Error("crash after fire stamp and before queue accounting");
    }
  });
  later(3600); await f.scheduler.runTickNow();
  expect(stampSeen).toBe(true); expect(f.errors).toHaveLength(1); expect(send).toHaveBeenCalledTimes(1);
  expect(f.repo.getById(cut.qitemId)?.state).toBe("blocked");
  expect(f.outbox.listForSender("watchdog@system").filter(e => e.deliveryState === "delivered")).toHaveLength(rows.length);
  const saved = f.db.serialize(); f.db.close(); const resumed = fixture(send, saved, digest);
  later(3600); await resumed.scheduler.runTickNow();
  expect(send).toHaveBeenCalledTimes(1);
  for (const row of rows) {
    expect(resumed.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "fired", deliveryStatus: "ok", live: false });
    expect(resumed.jobs.getByIdOrThrow(row.jobId).state).toBe("terminal");
  }
});

it.each(["mode", "external", "prompt"] as const)("classifies the actual %s transport refusal before input", async kind => {
  const f = fixture(async () => delivered);
  f.db.exec(`INSERT INTO rigs(id,name) VALUES ('r','test'); INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('n','r','worker','terminal');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('s','n','worker@test','running');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane,attachment_type) VALUES ('b','n','worker@test','%1','${kind === "external" ? "external_cli" : "tmux"}');`);
  const exec = vi.fn(async () => ""), tmux = new TmuxAdapter(exec);
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "isPaneInMode").mockResolvedValue(kind === "mode");
  vi.spyOn(tmux, "cancelPaneMode").mockResolvedValue(undefined);
  const transport = new SessionTransport({ db: f.db, tmuxAdapter: tmux, rigRepo: new RigRepository(f.db), sessionRegistry: new SessionRegistry(f.db) });
  vi.spyOn(transport as unknown as { classifySendReadiness: () => Promise<{ state: string; reason: string }> }, "classifySendReadiness")
    .mockResolvedValue({ state: kind === "prompt" ? "needs_input" : "idle", reason: kind === "prompt" ? "permission_prompt" : "fixture idle" });
  const probe = await transport.send(seat, "Preflight", { openrigNotice: true, actorSession: "watchdog@system" });
  expect(probe.reason).toBe(kind === "mode" ? "pane_in_mode" : kind === "prompt" ? "target_needs_input" : "transport_unavailable"); expect(exec).not.toHaveBeenCalled();
  const driven = fixture(transport.send.bind(transport)), job = driven.reminder(); later(3600); await driven.scheduler.runTickNow();
  expect(driven.history.listForJob(job.jobId)[0]?.deliveryStatus).toBe("failed");
  if (kind === "external") expect(driven.jobs.getByIdOrThrow(job.jobId).state).toBe("terminal");
  else {
    expect(driven.outbox.listForSender("watchdog@system")[0]?.deliveryState).toBe("failed");
    expect(driven.history.listForJob(job.jobId)[0]?.evaluationNotes?.retryAt).toEqual(expect.any(String));
  }
  expect(exec).not.toHaveBeenCalled();
});
