import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME } from "../src/domain/policies/parked-owner-consumer.js";
import type { PolicyJob } from "../src/domain/policies/types.js";
import { queueRecoveryOwnsWake, readWakeLadderBackstop, PROMPT_ALERT_TAG } from "../src/domain/queue-wake-ladder.js";
import { findQueueRecovery, recoveryTag } from "../src/domain/queue-recovery.js";

const seat = "builder@fixture";
const epoch = Date.parse("2026-11-22T02:37:00.000Z");
const at = (seconds: number) => new Date(epoch + seconds * 1000);

describe("closed recovery wake custody", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
    vi.stubEnv("OPENRIG_WAKE_SUSPEND", "");
    vi.stubEnv("OPENRIG_QUEUE_STUCK_SWEEP_INTERVAL_SECONDS", "300");
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllEnvs(); });

  async function fixture({ closed = true, prompt = false } = {}) {
    const task = await repo.create({ sourceSession: "lead@fixture", destinationSession: seat, body: "build it", nudge: false });
    repo.claim({ qitemId: task.qitemId, destinationSession: seat });
    vi.setSystemTime(at(360));
    const recovery = await repo.create({ sourceSession: "lead@fixture", destinationSession: "lead@fixture", body: "stalled after claim",
      tags: [prompt ? PROMPT_ALERT_TAG : "stuck-sweep-finding", `stuck-sweep:stalled-after-claim:${task.qitemId}`, recoveryTag(task.qitemId)], nudge: false });
    if (closed) await repo.update({ qitemId: recovery.qitemId, actorSession: "lead@fixture", state: "done", closureReason: "no-follow-on",
      transitionNote: prompt ? "prompt escalation retired: the seat's prompt read clear; not a delivery receipt" : "healthy wait" });
    const policy = makeParkedOwnerConsumerPolicy({
      diagnoseRig: () => ({ seats: [{ sessionName: seat, parked: true,
        activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null }, since: at(0).toISOString() },
        obligations: { items: [{ qitemId: task.qitemId, state: repo.getById(task.qitemId)!.state, summary: "build it" }], held: [] },
      }] }),
      history: { listForJob: () => [], countForJob: () => 0 },
      occupantGeneration: () => "fixture-generation",
      rows: {
        listTransitions: x => repo.listTransitions(x), appendNote: () => ({ ok: true }),
        recordNudgeResult: (x, result) => repo.recordNudgeAttempt(x, result), listOpenIds: () => [task.qitemId],
        recoveryOwnsWake: x => queueRecoveryOwnsWake(db, repo.getById(x)),
      },
    });
    const job = { jobId: "fixture-job", policy: PARKED_OWNER_POLICY_NAME, target: { session: makeRigAnchor("fixture") }, context: {} } as PolicyJob;
    return { task, recovery, evaluate: () => policy.evaluate(job) };
  }

  it("releases a closed finding to the idle owner's reminder after one sweep interval", async () => {
    const f = await fixture();
    vi.setSystemTime(at(659));
    expect(queueRecoveryOwnsWake(db, repo.getById(f.task.qitemId))).toBe(true);
    expect((await f.evaluate()).action).toBe("skip");
    vi.setSystemTime(at(660));
    expect(queueRecoveryOwnsWake(db, repo.getById(f.task.qitemId))).toBe(false);
    expect((await f.evaluate()).action).toBe("send");
    // Wake custody expires; the diagnostic episode stays settled, without another finding.
    expect(findQueueRecovery(db, f.task.qitemId)).toMatchObject({ qitemId: f.recovery.qitemId, state: "done" });
    expect(readWakeLadderBackstop(db, f.task.qitemId)?.mechanism).not.toBe("queue-recovery:resolved");
    expect(repo.list({ tag: recoveryTag(f.task.qitemId) })).toHaveLength(1);
  });

  it("keeps an open finding's custody beyond the interval", async () => {
    const f = await fixture({ closed: false });
    vi.setSystemTime(at(3600));
    expect(queueRecoveryOwnsWake(db, repo.getById(f.task.qitemId))).toBe(true);
    expect((await f.evaluate()).action).toBe("skip");
  });

  it("releases a closed finding immediately when the task moves", async () => {
    const f = await fixture();
    vi.setSystemTime(at(361));
    await repo.update({ qitemId: f.task.qitemId, actorSession: seat, transitionNote: "resumed" });
    expect(findQueueRecovery(db, f.task.qitemId)).toBeNull();
    expect((await f.evaluate()).action).toBe("send");
  });

  it("keeps the producer-retired prompt exception immediate", async () => {
    const f = await fixture({ prompt: true });
    expect(queueRecoveryOwnsWake(db, repo.getById(f.task.qitemId))).toBe(false);
    expect((await f.evaluate()).action).toBe("send");
  });

  it("uses the configured sweep cadence rather than a new custody setting", async () => {
    vi.stubEnv("OPENRIG_QUEUE_STUCK_SWEEP_INTERVAL_SECONDS", "60");
    const f = await fixture();
    vi.setSystemTime(at(419));
    expect(queueRecoveryOwnsWake(db, repo.getById(f.task.qitemId))).toBe(true);
    vi.setSystemTime(at(420));
    expect((await f.evaluate()).action).toBe("send");
  });

  it.each([null, "invalid", at(1000).toISOString()])("wakes when the closure time is unusable: %s", async ts => {
    const f = await fixture();
    if (ts === null) db.prepare("DELETE FROM queue_transitions WHERE qitem_id = ? AND closure_reason IS NOT NULL").run(f.recovery.qitemId);
    else db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND closure_reason IS NOT NULL").run(ts, f.recovery.qitemId);
    expect((await f.evaluate()).action).toBe("send");
  });

  it("later bookkeeping does not renew a closed finding's custody", async () => {
    const f = await fixture();
    vi.setSystemTime(at(650));
    await repo.update({ qitemId: f.recovery.qitemId, actorSession: "watchdog@system", transitionNote: "bookkeeping" });
    vi.setSystemTime(at(660));
    expect((await f.evaluate()).action).toBe("send");
  });
});
