import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSliceReadiness } from "../src/domain/proof/judgments.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";
import { runStuckSweep } from "../src/domain/queue-stuck-sweep.js";
import { queueRecoveryOwnsWake, runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import { makeParkedOwnerConsumerPolicy } from "../src/domain/policies/parked-owner-consumer.js";
import { recoveryTag } from "../src/domain/queue-recovery.js";

describe("quiet waits and bounded recovery on existing domain seams", () => {
  let db: Database.Database, bus: EventBus, queue: QueueRepository, jobs: WatchdogJobsRepository;
  let scheduler: WatchdogScheduler, stop: () => void;
  let sends: Array<{ target: string; message: string; cause: string }>;
  let worker: "working" | "idle-at-prompt" | "unknown", owner: "working" | "unknown", failed: boolean;
  let duringDelivery: (() => Promise<void>) | undefined;
  let occurrences: Array<string | undefined>;
  const now = () => Date.now();
  const advance = (seconds: number) => vi.setSystemTime(now() + seconds * 1000);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-08T00:00:00Z");
    vi.stubEnv("OPENRIG_QUEUE_PICKUP_STALL_THRESHOLD_MINUTES", "3");
    db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id,name) VALUES ('r','rig')").run();
    sends = []; occurrences = []; worker = "working"; owner = "working"; failed = false; duringDelivery = undefined;
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { validateRig: () => true, transport: { send: async (target, message) => {
      sends.push({ target, message, cause: "queue" }); return { ok: true, verified: true };
    } } });
    queue.attachOutbox(new OutboxHandler(db));
    queue.attachActivityReader(session => ({ activity: session === "worker@rig" ? worker : owner, needsInput: { count: 0, reason: null }, decidedBy: "lifecycle-hooks" }));
    jobs = new WatchdogJobsRepository(db); queue.attachWatchdogJobsRepository(jobs);
    stop = queue.startWaitReminders();
    scheduler = new WatchdogScheduler({ jobsRepo: jobs, beforeTick: () => queue.reconcileWaitReminders(), policyEngine: new WatchdogPolicyEngine({
      jobsRepo: jobs, historyLog: new WatchdogHistoryLog(db), eventBus: bus,
      resolveQueueWait: input => queue.evaluateWaitReminder(input),
      onWakeAttempt: ({ jobId, deliveryStatus }) => queue.recordWatchdogWakeAttempt(jobId, deliveryStatus),
      deliver: async ({ targetSession: target, message }, source) => {
        sends.push({ target, message, cause: source.policy });
        occurrences.push(source.occurrenceId);
        const pending = duringDelivery; duringDelivery = undefined;
        await pending?.();
        return { status: failed ? "failed" : "ok" };
      },
    }) });
  });
  afterEach(() => { stop(); db.close(); vi.useRealTimers(); vi.unstubAllEnvs(); });
  async function waiting() {
    const blocker = await queue.create({ sourceSession: "owner@rig", destinationSession: "worker@rig", body: "Produce the result", nudge: false });
    queue.claim({ qitemId: blocker.qitemId, destinationSession: "worker@rig" });
    const waiter = await queue.create({ sourceSession: "owner@rig", destinationSession: "owner@rig", body: "Complete instructions\n" + "Evidence 😀\n".repeat(1000), nudge: false });
    await queue.update({ qitemId: waiter.qitemId, actorSession: "owner@rig", state: "blocked", blockedOn: blocker.qitemId, wakeAfterSeconds: 300, wakeMaxSeconds: 2400, wakeMessage: waiter.body });
    return { blocker: blocker.qitemId, waiter: waiter.qitemId, job: queue.getParkWakeStatus(waiter.qitemId)!.ref };
  }
  const sweep = () => runStuckSweep({ db, queueRepo: queue, now: new Date(), unclaimedAgeMinutes: 60, resolveOrchestrator: () => "orch@rig", isRegisteredHost: () => false });

  it.each(["ok", "failed"])("preserves a blocker change when in-flight delivery returns %s", async (status) => {
    const { blocker, waiter, job } = await waiting();
    failed = status === "failed";
    advance(1);
    await queue.update({ qitemId: blocker, actorSession: "worker@rig", transitionNote: "First result evidence" });
    duringDelivery = async () => {
      advance(1);
      await queue.update({ qitemId: blocker, actorSession: "worker@rig", transitionNote: "New evidence while the first wake is sending" });
    };
    await scheduler.runTickNow();
    expect(sends).toHaveLength(1);
    const pending = jobs.getByIdOrThrow(job);
    await scheduler.runTickNow();
    expect(sends).toHaveLength(2);
    expect(occurrences[0]).toBeDefined();
    expect(occurrences[1]).not.toBe(occurrences[0]);
    expect(queue.getByIdOrThrow(waiter).state).toBe("blocked");
    expect(pending.lastEvaluationAt).toBe(new Date(0).toISOString());
    expect(JSON.parse(pending.specYaml).context.queue_wait.eventPending).toBe(true);
    expect(JSON.parse(pending.specYaml).context.queue_wait.notice).toBeUndefined();
    advance(300);
    await scheduler.runTickNow();
    expect(sends).toHaveLength(2);
  });

  it("does not credit an in-flight notice to a blocker's onward handoff", async () => {
    const { blocker, waiter, job } = await waiting();
    advance(1);
    await queue.update({ qitemId: blocker, actorSession: "worker@rig", transitionNote: "First result evidence" });
    let successor = "";
    duringDelivery = async () => {
      advance(1);
      const onward = await queue.handoff({ qitemId: blocker, fromSession: "worker@rig", toSession: "other@rig", body: "Continue the result", nudge: false });
      successor = onward.created.qitemId;
    };
    await scheduler.runTickNow();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.message).toContain(blocker);
    expect(queue.getByIdOrThrow(waiter).blockedOn).toBe(successor);
    expect(jobs.getByIdOrThrow(job).lastEvaluationAt).toBe(new Date(0).toISOString());
    await scheduler.runTickNow();
    expect(sends).toHaveLength(2);
    expect(sends[1]!.message).toContain(successor);
    expect(occurrences[1]).not.toBe(occurrences[0]);
    advance(300);
    await scheduler.runTickNow();
    expect(sends).toHaveLength(2);
  });

  it("keeps working-owner waits quiet, wakes once for change, and repairs a missed event on the next tick", async () => {
    const { blocker, waiter, job } = await waiting();
    const original = queue.getByIdOrThrow(waiter).body;
    for (const seconds of [300, 600, 1200]) { advance(seconds); await scheduler.runTickNow(); await sweep(); }
    expect(sends).toEqual([]);
    expect(jobs.getByIdOrThrow(job).intervalSeconds).toBe(2400);
    advance(1); await queue.update({ qitemId: blocker, actorSession: "worker@rig", transitionNote: "Result evidence changed" });
    await scheduler.runTickNow(); expect(sends).toHaveLength(1);
    expect(sends[0]!.message).toContain(`rig queue show ${waiter} --full`);
    expect(Buffer.byteLength(sends[0]!.message)).toBeLessThan(1024);
    expect(queue.getByIdOrThrow(waiter).body).toBe(original);
    const change = queue.waitingView(waiter)!.lastMeaningfulChange;
    advance(1); await queue.update({ qitemId: blocker, actorSession: "watchdog@system", transitionNote: "parked-owner wake reserved: fixture" });
    await scheduler.runTickNow(); expect(sends).toHaveLength(1);
    expect(queue.waitingView(waiter)!.lastMeaningfulChange).toEqual(change);
    stop(); advance(1); await queue.update({ qitemId: blocker, actorSession: "worker@rig", transitionNote: "Distinct later evidence" });
    await scheduler.runTickNow(); expect(sends).toHaveLength(2);
    stop = queue.startWaitReminders(); await scheduler.runTickNow(); expect(sends).toHaveLength(2);
    advance(2400); await scheduler.runTickNow(); expect(sends).toHaveLength(2);
  });

  it("a failed notice escalates once within pickup grace plus sweep, remains unknown, and does not reset on reminders", async () => {
    vi.stubEnv("OPENRIG_QUEUE_STUCK_SWEEP_INTERVAL_SECONDS", "77");
    const { blocker, waiter } = await waiting(); owner = "unknown"; worker = "unknown"; failed = true;
    advance(300); await scheduler.runTickNow(); expect(sends).toHaveLength(1);
    expect(queue.waitingView(waiter)!.liveness.confidence).toBe("unknown");
    expect(queue.waitingView(waiter)!.nextBackstop.intervalSeconds).toBe(77);
    advance(301); await scheduler.runTickNow(); await sweep();
    const notices = queue.list({ tag: recoveryTag(waiter), limit: 100 });
    expect(notices).toHaveLength(1); expect(notices[0]!.destinationSession).toBe("orch@rig");
    expect(notices[0]!.body).toContain("delivery=failed");
    const count = sends.length, transitions = queue.listTransitions(notices[0]!.qitemId).length;
    advance(2400); await scheduler.runTickNow(); await sweep();
    expect(sends).toHaveLength(count);
    expect(queue.listTransitions(notices[0]!.qitemId)).toHaveLength(transitions);
    // A real response, not an observer refresh, clears the diagnostic.
    advance(1); await queue.update({ qitemId: waiter, actorSession: "owner@rig", transitionNote: `Inspected ${blocker}; continuing the recorded wait` });
    await sweep(); expect(queue.getByIdOrThrow(notices[0]!.qitemId).state).toBe("done");
  });

  it("does not treat one old progress note or delivery machinery as permanent pickup", async () => {
    const { blocker } = await waiting();
    advance(1); await queue.update({ qitemId: blocker, actorSession: "worker@rig", transitionNote: "Initial progress" });
    worker = "idle-at-prompt"; advance(181);
    await queue.update({ qitemId: blocker, actorSession: "wake-ladder@system", transitionNote: "wake-attempt: 1/3" });
    expect(queue.getByIdOrThrow(blocker).pickup?.state).toBe("stalled-after-claim");
    expect(queue.getByIdOrThrow(blocker).pickup?.evidence).toContain("queue age does not prove idle");
  });

  it("onward handoff follows exact custody; a returned result coalesces arrival and resume with both receipts", async () => {
    const { blocker, waiter, job } = await waiting();
    const onward = await queue.handoff({ qitemId: blocker, fromSession: "worker@rig", toSession: "other@rig", body: "Continue producing result", nudge: true });
    await new Promise<void>(r => setImmediate(r));
    expect(queue.getByIdOrThrow(waiter)).toMatchObject({ state: "blocked", blockedOn: onward.created.qitemId });
    expect(queue.getParkWakeStatus(waiter)!.ref).toBe(job);
    const before = sends.length;
    const returned = await queue.handoff({ qitemId: onward.created.qitemId, fromSession: "other@rig", toSession: "owner@rig", body: "The result", nudge: true });
    await new Promise<void>(r => setImmediate(r));
    expect(sends).toHaveLength(before + 1);
    expect(sends.at(-1)!.message).toContain(returned.created.qitemId);
    expect(sends.at(-1)!.message).toContain(waiter);
    expect(queue.getByIdOrThrow(waiter).state).toBe("pending");
    expect(queue.getByIdOrThrow(returned.created.qitemId).state).toBe("pending");
    expect(jobs.getByIdOrThrow(job).state).toBe("terminal");
    expect(queue.getByIdOrThrow(waiter).lastNudgeResult).toBe("verified");
    expect(queue.getByIdOrThrow(returned.created.qitemId).lastNudgeResult).toBe("verified");
    await Promise.all([queue.drainPendingWakeIntents(), queue.drainPendingWakeIntents()]);
    expect(sends).toHaveLength(before + 1);
  });

  it("an unnamed timed wait stays armed and unknown instead of silently terminating", async () => {
    owner = "unknown";
    const waiter = await queue.create({ sourceSession: "owner@rig", destinationSession: "owner@rig", body: "Wait for the authored backstop", nudge: false });
    await queue.update({ qitemId: waiter.qitemId, actorSession: "owner@rig", state: "blocked", wakeAfterSeconds: 300, wakeMaxSeconds: 2400 });
    const job = queue.getParkWakeStatus(waiter.qitemId)!.ref;
    advance(300); await scheduler.runTickNow();
    expect(jobs.getByIdOrThrow(job).state).toBe("active");
    expect(sends).toHaveLength(1);
    advance(600); await scheduler.runTickNow(); expect(sends).toHaveLength(1);
  });

  it("a failed handoff has one retry owner while an independent parked obligation still wakes", async () => {
    const source = await queue.create({ sourceSession: "owner@rig", destinationSession: "owner@rig", body: "Next work", nudge: false });
    const handoff = await queue.handoff({ qitemId: source.qitemId, fromSession: "owner@rig", toSession: "worker@rig", body: "Assigned work", nudge: false });
    queue.recordNudgeAttempt(handoff.created.qitemId, "failed: synthetic unavailable");
    const independently = await queue.create({ sourceSession: "owner@rig", destinationSession: "worker@rig", body: "Different decision", nudge: false });
    const policy = makeParkedOwnerConsumerPolicy({
      diagnoseRig: () => ({ seats: [{ sessionName: "worker@rig", parked: true, activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null } }, obligations: { items: queue.list({ destinationSession: "worker@rig" }).map(r => ({ qitemId: r.qitemId, state: r.state, summary: r.summary })), held: [] } }] }),
      history: { listForJob: () => [], countForJob: () => 0 },
      rows: { listTransitions: id => queue.listTransitions(id), appendNote: () => ({ ok: true }), recordNudgeResult: (id, result) => queue.recordNudgeAttempt(id, result), listOpenIds: () => [handoff.created.qitemId, independently.qitemId], recoveryOwnsWake: id => queueRecoveryOwnsWake(db, queue.getById(id)) },
    });
    const job = jobs.register({ policy: policy.name, specYaml: "{}", targetSession: "parked-owner-consumer@rig", intervalSeconds: 120, registeredBySession: "daemon@kernel" });
    const result = await policy.evaluate({ ...job, target: { session: job.targetSession }, context: {} });
    expect(result.action).toBe("send");
    if (result.action === "send") { expect(result.message).toContain(independently.qitemId); expect(result.message).not.toContain(handoff.created.qitemId); }
    const attempts: string[] = [];
    advance(300);
    await runWakeLadderTick({ db, queueRepo: queue, now: new Date(), attemptWake: async id => { attempts.push(id); return "failed: synthetic unavailable"; }, resolveOrchestrator: () => "orch@rig" });
    expect(attempts).toEqual([handoff.created.qitemId]);
  });

  it("different approvals with identical bytes remain two obligations and two deliveries", async () => {
    for (let i = 0; i < 2; i++) await queue.create({ sourceSession: "owner@rig", destinationSession: "worker@rig", body: "Approved", nudge: true });
    expect(queue.list({ destinationSession: "worker@rig", limit: 100 })).toHaveLength(2);
    expect(sends).toHaveLength(2);
  });

  it("restart drains only current pending intents and retains superseded history without claiming delivery", async () => {
    const offline = new QueueRepository(db, bus, { validateRig: () => true });
    offline.attachOutbox(new OutboxHandler(db));
    const source = await offline.create({ sourceSession: "owner@rig", destinationSession: "worker@rig", body: "Old assignment", nudge: false });
    const returned = await offline.handoff({ qitemId: source.qitemId, fromSession: "worker@rig", toSession: "owner@rig", body: "Result", nudge: true });
    const replacement = await offline.handoff({ qitemId: returned.created.qitemId, fromSession: "owner@rig", toSession: "other@rig", body: "Current assignment", nudge: true });
    queue.reconcileAbandonedWakeIntents();
    await queue.drainPendingWakeIntents();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.message).toContain(replacement.created.qitemId);
    expect(sends[0]!.target).toBe("other@rig");
    const obsolete = new OutboxHandler(db).getById(`wake-intent-${returned.created.qitemId}`)!;
    expect(obsolete.deliveryState).toBe("failed");
    expect(obsolete.tags).toContain("queue:wake-superseded");
    expect(obsolete.deliveredAt).toBeNull();
    expect(queue.getByIdOrThrow(returned.created.qitemId).lastNudgeAttempt).toBeNull();
  });

  it("consumes S01 attention revisions through the canonical reader, including a missed proof event", async () => {
    const root = mkdtempSync(join(tmpdir(), "s04-proof-"));
    try {
      const scope = join(root, "missions/trial/slices/one"); mkdirSync(scope, { recursive: true });
      writeFileSync(join(root, "project.yaml"), "kind: project\nproofPolicy:\n  judges: [worker@rig]\n");
      const spec = join(scope, "SPEC.md"); writeFileSync(spec, "## Proof contract\n- [ ] Observe the result.\n");
      const { blocker, waiter, job } = await waiting();
      const evidence = { attention: readSliceReadiness(scope).attention };
      const park = { qitemId: waiter, actorSession: "owner@rig", state: "blocked" as const, blockedOn: blocker, wakeAfterSeconds: 300, wakeMaxSeconds: 2400, wakeProgressEvidence: evidence };
      await queue.update(park); advance(300); await scheduler.runTickNow(); expect(sends).toHaveLength(0);
      const schedule = jobs.getByIdOrThrow(job);
      await queue.update(park); expect(jobs.getByIdOrThrow(job)).toEqual(schedule);
      writeFileSync(spec, "## Proof contract\n- [ ] Observe the corrected result.\n");
      bus.emit({ type: "proof.sources_changed", scope, revision: "event-is-only-an-invalidation" });
      await scheduler.runTickNow(); expect(sends).toHaveLength(1);
      bus.emit({ type: "proof.sources_changed", scope, revision: "reordered-or-duplicate" });
      await scheduler.runTickNow(); expect(sends).toHaveLength(1);
      stop(); writeFileSync(spec, "## Proof contract\n- [ ] Observe the final changed result.\n");
      advance(jobs.getByIdOrThrow(job).intervalSeconds); await scheduler.runTickNow();
      expect(sends).toHaveLength(2);
      expect(JSON.parse(jobs.getByIdOrThrow(job).specYaml).context.queue_wait.attentionRevision).toBe(readSliceReadiness(scope).revision);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
