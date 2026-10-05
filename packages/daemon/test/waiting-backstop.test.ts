import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { runWakeLadderTick, queueRecoveryOwnsWake, WAKE_SUSPEND_OVERRIDE_ENV } from "../src/domain/queue-wake-ladder.js";
import { lastMeaningfulTransition } from "../src/domain/queue-waiting.js";
import { recoveryTag } from "../src/domain/queue-recovery.js";

describe("waiting face names the next action the existing ladder can actually take", () => {
  let db: Database.Database, queue: QueueRepository, sends: string[];
  const advance = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-09-08T00:00:00Z");
    vi.stubEnv("OPENRIG_QUEUE_WAKE_RETRY_INTERVAL_SECONDS", "300");
    vi.stubEnv("OPENRIG_QUEUE_WAKE_RETRY_CAP", "3");
    vi.stubEnv("OPENRIG_QUEUE_WAKE_UNCONFIRMED_WINDOW_MINUTES", "30");
    db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id,name) VALUES ('r','rig')").run(); sends = [];
    queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, transport: { send: async target => {
      sends.push(target); return target === "healthy@rig" ? { ok: true, verified: true } : { ok: false, error: "synthetic unavailable" };
    } } });
    queue.attachOutbox(new OutboxHandler(db));
  });
  afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllEnvs(); });
  async function handoff(target = "worker@rig") {
    const source = await queue.create({ sourceSession: "owner@rig", destinationSession: "owner@rig", body: "Prepare result", nudge: false });
    const id = (await queue.handoff({ qitemId: source.qitemId, fromSession: "owner@rig", toSession: target, body: "Continue exact work", nudge: true })).created.qitemId;
    // Backstop assertions describe a completed wake attempt, not the earlier persistence receipt.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(queue.getByIdOrThrow(id).lastNudgeResult).not.toBeNull();
    return id;
  }
  const view = (id: string) => queue.getByIdOrThrow(id).waiting!;
  const tick = () => runWakeLadderTick({ db, queueRepo: queue, now: new Date(), resolveOrchestrator: () => null, log: () => {} });

  it("separates failed retry and verified unclaimed grace, and advances only after the actual attempt", async () => {
    const good = await handoff("healthy@rig"), failed = await handoff();
    expect(view(good).nextBackstop).toMatchObject({ mechanism: "queue-stuck-sweep:unclaimed", dueAt: "2026-09-08T01:00:00.000Z" });
    expect(view(failed).nextBackstop).toMatchObject({ owner: "worker@rig", mechanism: "queue-wake-ladder:retry", dueAt: "2026-09-08T00:05:00.000Z" });
    expect(view(failed).laterBackstop?.mechanism).toBe("queue-stuck-sweep:unclaimed");
    const snapshot = db.serialize(); view(failed); view(failed); expect(db.serialize()).toEqual(snapshot);
    const before = sends.length; advance(299); expect((await tick()).actions).toEqual([]); expect(sends).toHaveLength(before);
    advance(2); expect((await tick()).actions).toContainEqual({ qitemId: failed, action: "retry", target: "worker@rig" });
    expect(sends).toHaveLength(before + 1);
    expect(view(failed).nextBackstop.dueAt).toBe("2026-09-08T00:10:01.000Z");
  });

  it("shows the existing suspension deadline and resumes at it without mutating policy", async () => {
    const id = await handoff();
    vi.stubEnv(WAKE_SUSPEND_OVERRIDE_ENV, "worker@rig:2026-09-08T00:20:00.000Z");
    expect(view(id).nextBackstop).toMatchObject({ mechanism: "queue-wake-ladder:retry", dueAt: "2026-09-08T00:20:00.000Z", suspendedUntil: "2026-09-08T00:20:00.000Z" });
    const count = sends.length; advance(301); expect((await tick()).actions).toContainEqual({ qitemId: id, action: "suspend" });
    expect(sends).toHaveLength(count); advance(899);
    expect((await tick()).actions).toContainEqual({ qitemId: id, action: "retry", target: "worker@rig" });
    expect(view(id).nextBackstop.suspendedUntil).toBeUndefined();
    expect(view(id).nextBackstop.dueAt).toBe("2026-09-08T00:25:00.000Z");
  });

  it("derives post-swap suspension from the current seat binding", async () => {
    const id = await handoff(); advance(301);
    db.prepare("INSERT INTO nodes (id,rig_id,logical_id,handover_at) VALUES ('worker-node','r','work.seat',?)").run(new Date().toISOString());
    db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES ('worker-session','worker-node','worker@rig','running')").run();
    expect(view(id).nextBackstop).toMatchObject({ owner: "worker@rig", dueAt: "2026-09-08T00:08:01.000Z", suspendedUntil: "2026-09-08T00:08:01.000Z" });
    expect(view(id).nextBackstop.note).toContain("post-swap grace");
    const count = sends.length; await tick(); expect(sends).toHaveLength(count);
    advance(180); expect((await tick()).actions).toContainEqual({ qitemId: id, action: "retry", target: "worker@rig" });
  });

  it("honors a closed recovery and exposes retry again only after a new meaningful source event", async () => {
    const id = await handoff();
    const recovery = await queue.create({ sourceSession: "owner@rig", destinationSession: "orch@rig", body: "Inspect failed delivery", tags: [recoveryTag(id)], nudge: false });
    await queue.update({ qitemId: recovery.qitemId, actorSession: "orch@rig", state: "done", closureReason: "no-follow-on", resolution: "Do not retry this episode" });
    expect(view(id).nextBackstop).toMatchObject({ owner: "orch@rig", mechanism: "queue-recovery:resolved", dueAt: null, recovery: { qitemId: recovery.qitemId, state: "done" } });
    const count = sends.length; advance(301); expect((await tick()).actions).toEqual([]); expect(sends).toHaveLength(count);
    await queue.update({ qitemId: id, actorSession: "owner@rig", transitionNote: "New evidence: delivery can now be retried" });
    expect(view(id).nextBackstop.mechanism).toBe("queue-wake-ladder:retry");
    expect((await tick()).actions).toContainEqual({ qitemId: id, action: "retry", target: "worker@rig" });
  });

  it("uses configured retry cadence and the shared destination budget", async () => {
    vi.stubEnv("OPENRIG_QUEUE_WAKE_RETRY_INTERVAL_SECONDS", "40");
    vi.stubEnv("OPENRIG_QUEUE_WAKE_RETRY_CAP", "1");
    const first = await handoff(), second = await handoff();
    expect(view(first).nextBackstop.dueAt).toBe("2026-09-08T00:00:40.000Z");
    advance(41); const count = sends.length; await tick(); expect(sends).toHaveLength(count + 1);
    const untried = queue.listTransitions(first).some(t => t.transitionNote?.startsWith("wake-attempt:")) ? second : first;
    expect(view(untried).nextBackstop.dueAt).toBe("2026-09-08T00:01:21.001Z");
    expect(view(untried).nextBackstop.owner).toBe("worker@rig");
  });

  it("shows confirmation escalation rather than retry, and current recovery after the rung completes", async () => {
    const id = await handoff(); queue.recordNudgeAttempt(id, "delivered-ack-pending");
    expect(view(id).nextBackstop).toMatchObject({ mechanism: "queue-wake-ladder:operator", dueAt: "2026-09-08T00:29:30.000Z" });
    const count = sends.length; advance(301); expect((await tick()).actions).toEqual([]); expect(sends).toHaveLength(count);
    advance(1500); const actions = (await tick()).actions;
    expect(actions.some(a => a.action === "retry")).toBe(false);
    expect(actions).toContainEqual({ qitemId: id, action: "escalate-operator" });
    expect(view(id).nextBackstop).toMatchObject({ mechanism: "queue-recovery:delegated", dueAt: null });
    expect(view(id).nextBackstop.recovery?.state).toBe("pending");
  });

  it.each(["daemon@kernel", "daemon@system"])("%s delivery bookkeeping preserves the episode; author notes and state changes still advance it", async (actorSession) => {
    const id = await handoff();
    const before = lastMeaningfulTransition(db, id);
    for (const transitionNote of [
      "delivery-deferral-armed notification_key=episode minutes=30",
      "slack-owner-notification-posted notification_key=episode message_ts=1",
      "delivery-termination: notification_key=episode no-fallback",
    ]) {
      advance(1);
      queue.update({ qitemId: id, actorSession, transitionNote });
      expect(lastMeaningfulTransition(db, id)).toEqual(before);
    }
    // Identical prose from an author remains testimony; no keyword classifier.
    queue.update({ qitemId: id, actorSession: "owner@rig", transitionNote: "delivery-termination: author investigated the actual outcome" });
    const authored = lastMeaningfulTransition(db, id);
    expect(authored!.id).toBeGreaterThan(before!.id);
    queue.update({ qitemId: id, actorSession, state: "blocked", blockedOn: "operator decision" });
    expect(lastMeaningfulTransition(db, id)!.id).toBeGreaterThan(authored!.id);
  });

  // ── #344: a guard-refused wake must keep the unclaimed baton's retry path ──

  it("counts a typing-guard refusal after a closed recovery as fresh evidence, reopening the retry path (#344)", async () => {
    // Every wake this episode is refused by the typing guard: no pane input is
    // written, and the nudge records the retained vocabulary.
    queue = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      transport: { send: async () => ({ outcome: "retained" }) },
    });
    const source = await queue.create({ sourceSession: "owner@rig", destinationSession: "owner@rig", body: "Prepare result", nudge: false });
    const id = (await queue.handoff({ qitemId: source.qitemId, fromSession: "owner@rig", toSession: "worker@rig", body: "Continue exact work", nudge: false })).created.qitemId;
    // A terminal recovery disposition closes BEFORE the next wake attempt.
    const recovery = await queue.create({ sourceSession: "owner@rig", destinationSession: "orch@rig", body: "Inspect failed delivery", tags: [recoveryTag(id)], nudge: false });
    await queue.update({ qitemId: recovery.qitemId, actorSession: "orch@rig", state: "done", closureReason: "no-follow-on", resolution: "Do not retry this episode" });
    // The ladder's later retry is refused again — the refusal is NEWER than the
    // recovery and must count as evidence about the original obligation.
    advance(60);
    queue.recordNudgeAttempt(id, "retained:typing_guard");
    expect(view(id).nextBackstop).toMatchObject({
      mechanism: "queue-wake-ladder:retry",
      dueAt: "2026-09-08T00:06:00.000Z",
    });
    advance(301);
    expect((await tick()).actions).toContainEqual({ qitemId: id, action: "retry", target: "worker@rig" });
  });

  it("keeps an unclaimed baton whose wake was guard-refused inside the retry ladder (#344)", async () => {
    queue = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      transport: { send: async () => ({ outcome: "retained" }) },
    });
    queue.attachOutbox(new OutboxHandler(db));
    const id = await handoff();
    // The handoff nudge was refused by the typing guard: retained:typing_guard.
    expect(queue.getByIdOrThrow(id).lastNudgeResult).toBe("retained:typing_guard");
    // A safe refusal still protects the prompt, but the baton keeps a retry path
    // (each retry is another guard probe; when the prompt clears it verifies).
    expect(view(id).nextBackstop).toMatchObject({
      mechanism: "queue-wake-ladder:retry",
      dueAt: "2026-09-08T00:05:00.000Z",
    });
    advance(301);
    expect((await tick()).actions).toContainEqual({ qitemId: id, action: "retry", target: "worker@rig" });
  });

  it("does not let a retained nudge claim ownership of a claimed parked-owner row (#344 follow-up)", async () => {
    // The retained class is scoped to unclaimed batons. A CLAIMED in-progress row
    // whose last wake was retained must stay not-owned: the ladder's claimed-row
    // retry readback selects `failed:%` only, so owning it here would let the
    // parked-owner watchdog skip a row that nothing retries.
    queue = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      transport: { send: async () => ({ outcome: "retained" }) },
    });
    queue.attachOutbox(new OutboxHandler(db));
    const id = await handoff();
    // Move it to the claimed parked-owner shape: in-progress, claimed, with the
    // consumer's FAILED origin note the claimed arm keys on.
    await queue.claim({ qitemId: id, destinationSession: "worker@rig" });
    queue.recordNudgeAttempt(id, "retained:typing_guard");
    queue.update({ qitemId: id, actorSession: "worker@rig", transitionNote: "parked-owner wake delivery failed: retained:typing_guard" });
    const row = queue.getByIdOrThrow(id);
    expect(row.state).toBe("in-progress");
    expect(row.claimedAt).not.toBeNull();
    expect(queueRecoveryOwnsWake(db, row)).toBe(false);
    expect((await tick()).actions).not.toContainEqual({ qitemId: id, action: "retry", target: "worker@rig" });
  });
});
