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
import { readWatchdogUsageLimitState, type WatchdogUsageLimitState } from "../src/domain/watchdog-usage-limit.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { hookOrPaneActivity } from "../src/domain/node-inventory.js";
import type { StructuralObservation } from "../src/domain/seat-structural-activity-service.js";

const seat = "worker@test", stores: Database.Database[] = [];
const absent: SendResult = { ok: false, sessionName: seat, sent: false, inputPhase: "not_reached", reason: "tmux_unavailable", error: "Terminal service not yet listening" };
const delivered: SendResult = { ok: true, sessionName: seat, sent: true };
// Only the clock is faked: a pass takes a real event-loop turn between due jobs, which a faked setImmediate never runs.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => { for (const db of stores.splice(0)) if (db.open) db.close(); vi.useRealTimers(); });
const later = (s: number) => vi.setSystemTime(Date.now() + s * 1000);
function fixture(send: (session: string, body: string) => Promise<SendResult>, saved?: Buffer, digest = false,
  readUsageLimitState?: (session: string) => WatchdogUsageLimitState | null) {
  const db = new Database(saved ?? ":memory:"); stores.push(db); if (!saved) migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db), outbox = new OutboxHandler(db), jobs = new WatchdogJobsRepository(db), history = new WatchdogHistoryLog(db);
  const repo = new QueueRepository(db, bus);
  repo.attachWatchdogJobsRepository(jobs);
  // The optional argument is ignored by the old callback; the test still exercises its actual old behavior.
  const account = repo.recordWatchdogWakeAttempt.bind(repo) as (id: string, status: string, retryAt?: string) => void;
  const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: bus,
    deliver: makeWatchdogDeliver({ sessionTransport: { send }, outbox, now: () => new Date(), retryIntervalSeconds: 300, retryCap: 3, readUsageLimitState }),
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

const interactive: SendResult = { ...absent, reason: "target_needs_input", error: "Refused: 'worker@test' is at an interactive prompt" };
const limitState = (): WatchdogUsageLimitState => ({ identity: "occupant-a/account-a",
  limit: { asOf: "2026-01-01T00:59:00.000Z", resetsAt: "2026-01-06T00:00:00.000Z" } });

it.each([false, true])("records the usage reset, keeps the park owed across restart, and retries at reset (digest=%s)", async digest => {
  let result = interactive;
  const state = limitState(), read = vi.fn(() => state), send = vi.fn(async () => result);
  const f = fixture(send, undefined, digest, read), rows = [await f.park()];
  if (digest) rows.push(await f.park());
  later(3600); await f.scheduler.runTickNow();
  const ids = f.outbox.listForSender("watchdog@system").map(e => e.outboxId).sort();
  for (const row of rows) {
    expect(f.history.listForJob(row.jobId)[0]).toMatchObject({ outcome: "refused", evaluationNotes: {
      retryAt: state.limit!.resetsAt, deliveryReason: expect.stringContaining(`usage limit until ${state.limit!.resetsAt}`),
    } });
    expect(f.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "armed", live: true });
  }
  later(300); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
  const saved = f.db.serialize(); f.db.close(); const resumed = fixture(send, saved, digest, read);
  vi.setSystemTime(new Date(Date.parse(state.limit!.resetsAt) - 1)); await resumed.scheduler.runTickNow();
  expect(send).toHaveBeenCalledTimes(1);
  for (const row of rows) expect(resumed.history.listForJob(row.jobId)).toHaveLength(1);
  result = delivered; vi.setSystemTime(new Date(state.limit!.resetsAt)); await resumed.scheduler.runTickNow();
  expect(send).toHaveBeenCalledTimes(2);
  expect(resumed.outbox.listForSender("watchdog@system").map(e => e.outboxId).sort()).toEqual(ids);
  for (const row of rows) {
    expect(resumed.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "fired", deliveryStatus: "ok", live: false });
    expect(resumed.repo.getById(row.qitemId)?.state).toBe("blocked");
  }
  expect(resumed.errors).toEqual([]);
});

it("reconsiders the same owed occurrence on a newer working frame despite a fresh limit hook, through the real fold and reader", async () => {
  let result = interactive, structural: StructuralObservation | null = null;
  let read = (_session: string): WatchdogUsageLimitState | null => null;
  const send = vi.fn(async () => result), f = fixture(send, undefined, false, session => read(session));
  const rig = new RigRepository(f.db).createRig("test");
  const node = new RigRepository(f.db).addNode(rig.id, "worker", { runtime: "claude-code" });
  const sessions = new SessionRegistry(f.db), session = sessions.registerSession(node.id, seat);
  sessions.updateStatus(session.id, "running"); sessions.updateResumeToken(session.id, "claude_id", "conversation");
  sessions.updateBinding(node.id, { tmuxSession: seat, tmuxPane: "%1" });
  const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
  const activity = new AgentActivityStore({ db: f.db, eventBus: f.bus, now: () => new Date(),
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, gen) => sessions.isOccupantGenerationRegistered(id, gen) });
  read = name => readWatchdogUsageLimitState({ db: f.db, activity, structuralActivity: () => structural }, name);
  const row = await f.park(); later(3599);
  const asOf = new Date().toISOString(), resetsAt = "2026-01-06T00:00:00.000Z";
  expect(activity.recordHookEvent({ sessionName: seat, runtime: "claude-code", sessionId: "conversation", generation,
    hookEvent: "StopFailure", subtype: "rate_limit", occurredAt: asOf, resetsAt }).ok).toBe(true);
  later(1); await f.scheduler.runTickNow();
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.history.listForJob(row.jobId)[0]?.evaluationNotes?.retryAt).toBe(resetsAt);
  const owedIds = f.outbox.listForSender("watchdog@system").map(entry => entry.outboxId);
  const hook = () => activity.getLatestForNode({ nodeId: node.id, sessionName: seat, order: "source" });
  later(1);
  structural = { state: "agent_idle", reason: "idle_frame", evidence: null, observedAt: new Date().toISOString() };
  await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
  // Working must postdate the limit, not merely arrive in the cache later.
  structural = { ...structural, state: "agent_active", reason: "working_frame", observedAt: asOf };
  await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
  structural = { ...structural, observedAt: new Date().toISOString() };
  expect(hook()?.stale).not.toBe(true);
  expect(hookOrPaneActivity(hook(), structural, false, "claude-code")?.source).toBe("limit");
  expect(read(seat)?.clearedAt).toBe(structural.observedAt);
  result = delivered; await f.scheduler.runTickNow();
  expect(send).toHaveBeenCalledTimes(2);
  expect(f.outbox.listForSender("watchdog@system").map(entry => entry.outboxId)).toEqual(owedIds);
  expect(f.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "fired", deliveryStatus: "ok", live: false });
  expect(hook()?.eventAt).toBe(asOf); // No later hook made the reader recover.
  expect(f.errors).toEqual([]);
});

it.each(["occupant", "account", "activity", "clear"])("retries on positive %s evidence before reset, without reusing the old limit", async recovery => {
  let state = limitState(), result = interactive;
  const send = vi.fn(async () => result), f = fixture(send, undefined, false, () => state), row = await f.park();
  later(3600); await f.scheduler.runTickNow();
  later(1);
  state = recovery === "occupant" ? { ...state, identity: "occupant-b/account-a" }
    : recovery === "account" ? { ...state, identity: "occupant-a/account-b" }
    : { ...state, ...(recovery === "clear" ? { limit: null } : {}), clearedAt: new Date().toISOString() };
  // It may now be an ordinary prompt: the old account's limit must not hold it again.
  await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(2);
  expect(f.history.listForJob(row.jobId)[0]?.evaluationNotes?.retryAt).toBe(new Date(Date.now() + 300_000).toISOString());
  result = delivered; later(300); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(3);
  expect(f.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "fired", deliveryStatus: "ok" });
});

it.each(["missing", "error"])("falls back to the ordinary deadline if held limit becomes %s", async kind => {
  let readable = true;
  const send = vi.fn(async () => interactive), read = () => {
    if (readable) return limitState();
    if (kind === "error") throw new Error("unreadable");
    return null;
  };
  const f = fixture(send, undefined, false, read); await f.park();
  later(3600); await f.scheduler.runTickNow(); readable = false;
  later(1); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
  later(299); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(2);
  later(300); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(3);
  expect(f.errors).toEqual([]);
});

it.each(["unknown signal", "busy prompt", "unknown transport", "regular reminder"])("keeps ordinary retry for %s", async kind => {
  const state = kind === "unknown signal" ? null : kind === "busy prompt" ? { ...limitState(), limit: null } : limitState();
  const send = vi.fn(async () => kind === "unknown transport" ? absent : interactive);
  const f = fixture(send, undefined, false, () => state);
  const jobId = kind === "regular reminder" ? f.reminder().jobId : (await f.park()).jobId;
  later(3600); await f.scheduler.runTickNow();
  expect(f.history.listForJob(jobId)[0]?.evaluationNotes?.retryAt).toBe(new Date(Date.now() + 300_000).toISOString());
  later(300); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(2);
});

it("still recognizes an account move after an unreadable tick, and accepts only a later limit on that account", async () => {
  let state: WatchdogUsageLimitState | null = limitState();
  const send = vi.fn(async () => interactive), f = fixture(send, undefined, false, () => state), row = await f.park();
  later(3600); await f.scheduler.runTickNow();
  state = null; later(1); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(1);
  state = { ...limitState(), identity: "occupant-a/account-b" };
  later(1); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(2);
  expect(f.history.listForJob(row.jobId)[0]?.evaluationNotes?.retryAt).toBe(new Date(Date.now() + 300_000).toISOString());
  state = { ...state, limit: { asOf: new Date().toISOString(), resetsAt: limitState().limit!.resetsAt } };
  later(300); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(3);
  expect(f.history.listForJob(row.jobId)[0]?.evaluationNotes?.retryAt).toBe(state.limit!.resetsAt);
});

it("does not pin an old refusal to an account moved during the transport await", async () => {
  let state = limitState();
  const send = vi.fn(async () => { state = { ...state, identity: "occupant-a/account-b" }; return interactive; });
  const f = fixture(send, undefined, false, () => state), row = await f.park();
  later(3600); await f.scheduler.runTickNow();
  expect(f.history.listForJob(row.jobId)[0]?.evaluationNotes?.retryAt).toBe(new Date(Date.now() + 300_000).toISOString());
  later(300); await f.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(2);
  expect(f.history.listForJob(row.jobId)[0]?.evaluationNotes?.retryAt).toBe(new Date(Date.now() + 300_000).toISOString());
});

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

it.each([false, true])("keeps a refused one-shot owed beyond the retry cap and across restart (digest=%s)", async digest => {
  let result = absent;
  const send = vi.fn(async () => result), f = fixture(send, undefined, digest), rows = [await f.park()];
  if (digest) rows.push(await f.park());
  later(3600); await f.scheduler.runTickNow();
  for (let i = 0; i < 5; i++) { later(300); await f.scheduler.runTickNow(); }
  expect(f.errors).toHaveLength(0); expect(send).toHaveBeenCalledTimes(6);
  const ids = f.outbox.listForSender("watchdog@system").map(e => e.outboxId).sort();
  for (const row of rows) {
    expect(f.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "armed", live: true });
    expect(f.jobs.getByIdOrThrow(row.jobId)).toMatchObject({ state: "active", lastFireAt: null });
    expect(f.history.listForJob(row.jobId)[0]?.evaluationNotes?.nextAction).toContain("remains owed");
  }
  const saved = f.db.serialize(); f.db.close(); const resumed = fixture(send, saved, digest);
  result = delivered; later(299); await resumed.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(6);
  later(1); await resumed.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(7);
  for (const row of rows) {
    expect(resumed.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "fired", deliveryStatus: "ok", live: false });
    expect(resumed.jobs.getByIdOrThrow(row.jobId).terminalReason).toBe("park_timer_fired_once");
    expect(resumed.repo.getById(row.qitemId)).toMatchObject({ state: "blocked", blockedOn: "external:wait", body: "Continue work" });
    expect(resumed.repo.currentParkContinuation(row.qitemId)).toBe("work");
  }
  expect(resumed.outbox.listForSender("watchdog@system").map(e => e.outboxId).sort()).toEqual(ids);
  expect(resumed.outbox.listForSender("watchdog@system").every(e => e.deliveryState === "delivered")).toBe(true);
  later(7200); await resumed.scheduler.runTickNow(); expect(send).toHaveBeenCalledTimes(7);
  expect(resumed.errors).toHaveLength(0);
});

it("keeps a one-shot owed when its transport is unavailable, then delivers when repaired", async () => {
  let result: SendResult = { ...absent, reason: "transport_unavailable" };
  const send = vi.fn(async () => result), f = fixture(send), row = await f.park();
  later(3600); await f.scheduler.runTickNow();
  expect(f.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "armed", live: true });
  result = delivered; later(300); await f.scheduler.runTickNow();
  expect(send).toHaveBeenCalledTimes(2);
  expect(f.repo.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "fired", deliveryStatus: "ok", live: false });
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
