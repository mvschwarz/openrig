import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME, REFUSED_PREFIX } from "../src/domain/policies/parked-owner-consumer.js";
import type { PolicyJob } from "../src/domain/policies/types.js";
import type { WatchdogHistoryEntry } from "../src/domain/watchdog-history-log.js";
import { runWakeLadderTick, queueRecoveryOwnsWake, classifyPromptAfterRefusal, readWakeLadderBackstop } from "../src/domain/queue-wake-ladder.js";
import { LADDER_ATTEMPT_PREFIX, LADDER_EXHAUSTED_PREFIX } from "../src/domain/queue-stuck-sweep.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { CLAUDE_ACTIVITY_RUNG_INVENTORY, type ActivityEvidence } from "../src/domain/activity-taxonomy.js";

const seat = "worker@fixture";
const epoch = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(epoch + seconds * 1000);
const retiredNote = "prompt escalation retired: prompt cleared or original episode ended; not a delivery receipt";
const kinds = ["claimed-normal", "claimed-failed", "pending-failed", "pending-retained"] as const;
type Kind = typeof kinds[number];
const modes = ["no-alert", "newer-clear", "unknown", "manual-close-then-clear"] as const;

// Real queue/policy/ladder composition, injected arbitration and recording sinks.
// No daemon, terminal, Slack or provider is started. Virtual cadence is not a
// measurement of production scheduling or native prompt handling.
describe("original wake continuation after prompt clearing", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
    // Readback and execution deliberately resolve the SAME configuration.
    vi.stubEnv("OPENRIG_QUEUE_WAKE_RETRY_INTERVAL_SECONDS", "60");
    vi.stubEnv("OPENRIG_QUEUE_WAKE_RETRY_CAP", "3");
    vi.stubEnv("OPENRIG_WAKE_SUSPEND", "");
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllEnvs(); });

  async function fixture(kind: Kind, withRefusal = true) {
    let original;
    if (kind.startsWith("pending")) {
      const source = await repo.create({ sourceSession: "sender@fixture", destinationSession: "relay@fixture", body: "same work", nudge: false });
      original = (await repo.handoff({ qitemId: source.qitemId, fromSession: "relay@fixture", toSession: seat, nudge: false })).created;
    } else {
      original = await repo.create({ sourceSession: "sender@fixture", destinationSession: seat, body: "same work", nudge: false });
      repo.claim({ qitemId: original.qitemId, destinationSession: seat });
    }
    const id = original.qitemId;
    const history: WatchdogHistoryEntry[] = [];
    const wakes: Array<{ via: string; qitemId: string; second: number }> = [];
    let observed: Parameters<typeof classifyPromptAfterRefusal>[0];
    const observe = (state: "blocked" | "clear" | "unknown", second: number) => {
      observed = { activity: state === "unknown" ? "unknown" : "idle-at-prompt",
        needsInput: { count: state === "blocked" ? 1 : 0, reason: state === "blocked" ? "fixture prompt" : null },
        needsInputEvidence: state === "unknown" ? null : { rung: "needs-input-chrome", observedAt: at(second).toISOString() },
        changedAt: at(second).toISOString(), rungs: [{ rung: "needs-input-chrome", sourceId: "fixture", trust: "authoritative", lastEvidenceAt: at(second).toISOString() }] };
    };
    const policy = makeParkedOwnerConsumerPolicy({
      diagnoseRig: () => ({ seats: [{ sessionName: seat, parked: true,
        activity: { value: "idle-at-prompt", needsInput: observed?.needsInput ?? { count: 0, reason: null } },
        obligations: { items: [{ qitemId: id, state: repo.getById(id)!.state, summary: "work" }], held: [] },
      }] }),
      history: { listForJob: () => history, countForJob: () => history.length },
      rows: {
        listTransitions: x => repo.listTransitions(x),
        appendNote: (x, note) => { repo.update({ qitemId: x, actorSession: "watchdog@system", transitionNote: note }); return { ok: true }; },
        recordNudgeResult: (x, result) => repo.recordNudgeAttempt(x, result),
        listOpenIds: () => [id], recoveryOwnsWake: x => queueRecoveryOwnsWake(db, repo.getById(x)),
      },
    });
    const job = { jobId: "fixture-job", policy: PARKED_OWNER_POLICY_NAME, target: { session: makeRigAnchor("fixture") }, context: {} } as PolicyJob;
    observe("blocked", 1);
    if (withRefusal) {
      if (kind.startsWith("claimed")) {
        const first = await policy.evaluate(job);
        expect(first.action).toBe("send");
        history.push({ historyId: "fixture-history", jobId: job.jobId, evaluatedAt: at(0).toISOString(), outcome: "sent",
          skipReason: null, deliveryTargetSession: seat, deliveryStatus: "failed", deliveryMessage: "wake",
          evaluationNotes: { ...first.notes, deliveryReason: `Refused: '${seat}' is at an interactive prompt (target_needs_input). No text was sent.` } });
        await policy.evaluate(job);
      } else {
        // Same persisted pending-baton specimen as prompt-blocked-alert.test.ts.
        const key = `${seat}|fixture#1`;
        for (const transitionNote of [`parked-owner wake reserved: ${key}; obligations ${id}`, `${REFUSED_PREFIX} ${key}; Refused: interactive prompt`]) {
          repo.transitionLog.append({ qitemId: id, state: "pending", actorSession: "watchdog@system", transitionNote });
        }
      }
    }
    if (kind !== "claimed-normal") {
      repo.recordNudgeAttempt(id, kind === "pending-retained" ? "retained:typing_guard" : "failed:fixture");
      if (kind === "claimed-failed") repo.transitionLog.append({ qitemId: id, state: "in-progress", actorSession: "watchdog@system", transitionNote: "parked-owner wake delivery failed: fixture" });
    }
    const tick = async (second: number) => {
      vi.setSystemTime(at(second));
      const result = await runWakeLadderTick({ db, queueRepo: repo, resolveOrchestrator: () => null,
        readPromptState: (_dest, refusedAt) => classifyPromptAfterRefusal(observed, refusedAt), now: at(second),
        deliveryEngine: { dispatchEscalation: async () => ({ decision: "undeliverable:no-registered-human", resolved: false }) },
        attemptWake: async (qitemId, target) => {
          expect(target).toBe(seat);
          wakes.push({ via: "ladder", qitemId, second });
          repo.recordNudgeAttempt(qitemId, "failed:fixture");
          return "failed:fixture";
        }, log: () => {},
      });
      expect(result.outcome).not.toBe("failed");
    };
    const evaluate = async (second: number) => {
      const result = await policy.evaluate(job);
      if (result.action === "send") wakes.push({ via: "policy", qitemId: id, second });
      return result;
    };
    if (withRefusal) {
      await tick(10);
      expect(wakes).toEqual([]);
      expect(queueRecoveryOwnsWake(db, repo.getById(id))).toBe(true);
    }
    const alert = repo.list({ limit: 1000 }).find(row => row.tags?.includes("wake-prompt-refusal"));
    if (withRefusal) expect(alert).toBeDefined();
    const setObserved = (state: Parameters<typeof classifyPromptAfterRefusal>[0]) => { observed = state; };
    return { id, alert, tick, evaluate, observe, setObserved, wakes };
  }

  for (const kind of kinds) for (const mode of modes) it(`${kind}: ${mode}`, async () => {
    const f = await fixture(kind, mode !== "no-alert");
    const { qitemId, body, state, destinationSession, claimedAt, handedOffFrom } = repo.getById(f.id)!;
    if (mode === "manual-close-then-clear") {
      vi.setSystemTime(at(15));
      repo.update({ qitemId: f.alert!.qitemId, actorSession: f.alert!.destinationSession, state: "done", closureReason: "no-follow-on" });
    }
    f.observe(mode === "unknown" ? "unknown" : "clear", 20);
    for (const second of [20, 59, 60, 61, 120, 121, 180]) {
      await f.tick(second);
      await f.evaluate(second);
      const backstop = readWakeLadderBackstop(db, f.id);
      if (mode === "unknown" || mode === "manual-close-then-clear") {
        expect(backstop).toMatchObject({ mechanism: mode === "unknown" ? "queue-recovery:delegated" : "queue-recovery:resolved", dueAt: null });
        expect(queueRecoveryOwnsWake(db, repo.getById(f.id))).toBe(true);
      } else if (kind === "claimed-normal") {
        expect(backstop).toBeNull();
        expect(queueRecoveryOwnsWake(db, repo.getById(f.id))).toBe(false);
      } else if (second < 180) {
        expect(backstop).toMatchObject({ owner: seat, mechanism: "queue-wake-ladder:retry", intervalSeconds: 60,
          dueAt: at((Math.floor(second / 60) + 1) * 60).toISOString() });
      }
    }
    expect(repo.getById(f.id)).toMatchObject({ qitemId, body, state, destinationSession, claimedAt, handedOffFrom });
    if (mode === "newer-clear") {
      expect(repo.getById(f.alert!.qitemId)?.state).toBe("done");
      expect(repo.listTransitions(f.alert!.qitemId)).toContainEqual(expect.objectContaining({ actorSession: f.alert!.sourceSession, transitionNote: retiredNote }));
      expect(repo.listTransitions(f.id).some(t => t.transitionNote?.includes("interactive prompt cleared"))).toBe(true);
    }
    if (mode === "unknown") expect(repo.getById(f.alert!.qitemId)?.state).toBe("pending");
    if (mode === "unknown" || mode === "manual-close-then-clear") expect(f.wakes).toEqual([]);
    else expect(f.wakes).toEqual(kind === "claimed-normal"
      ? [{ via: "policy", qitemId, second: 20 }]
      : [60, 120, 180].map(second => ({ via: "ladder", qitemId, second })));
  });

  it.each(["wrong-actor", "wrong-note", "missing-tag", "still-open"])("does not exempt a recovery with %s", async variant => {
    const f = await fixture("pending-failed");
    vi.setSystemTime(at(15));
    repo.update({ qitemId: f.alert!.qitemId,
      actorSession: variant === "wrong-actor" ? "other@fixture" : f.alert!.sourceSession,
      ...(variant === "still-open" ? {} : { state: "done" as const, closureReason: "no-follow-on" as const }),
      transitionNote: variant === "wrong-note" ? `${retiredNote} extra` : retiredNote });
    if (variant === "missing-tag") db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?")
      .run(JSON.stringify(f.alert!.tags.filter(t => t !== "wake-prompt-refusal")), f.alert!.qitemId);
    f.observe("unknown", 20);
    await f.tick(120);
    expect(f.wakes).toEqual([]);
    expect(queueRecoveryOwnsWake(db, repo.getById(f.id))).toBe(true);
    expect(readWakeLadderBackstop(db, f.id)?.mechanism).toBe(variant === "still-open" ? "queue-recovery:delegated" : "queue-recovery:resolved");
  });

  it("keeps the original retry count and last-attempt cadence after clear", async () => {
    const f = await fixture("pending-failed");
    vi.setSystemTime(at(15));
    for (let n = 1; n <= 2; n++) repo.transitionLog.append({ qitemId: f.id, state: "pending", actorSession: "wake-ladder@system", transitionNote: `${LADDER_ATTEMPT_PREFIX} ${n}/3 outcome=failed:fixture` });
    f.observe("clear", 20); await f.tick(20);
    expect(readWakeLadderBackstop(db, f.id)).toMatchObject({ mechanism: "queue-wake-ladder:retry", dueAt: at(75).toISOString() });
    await f.tick(74); expect(f.wakes).toEqual([]);
    await f.tick(75); await f.tick(135); await f.tick(195);
    expect(f.wakes).toEqual([{ via: "ladder", qitemId: f.id, second: 75 }]);
  });

  it("preserves the shared destination budget at its inclusive boundary", async () => {
    const f = await fixture("pending-failed");
    const sibling = await repo.create({ sourceSession: "sender@fixture", destinationSession: seat, body: "other work", nudge: false });
    vi.setSystemTime(at(15));
    for (let n = 1; n <= 3; n++) repo.transitionLog.append({ qitemId: sibling.qitemId, state: "pending", actorSession: "wake-ladder@system", transitionNote: `${LADDER_ATTEMPT_PREFIX} ${n}/3 outcome=failed:fixture` });
    f.observe("clear", 20); await f.tick(20);
    expect(readWakeLadderBackstop(db, f.id)).toMatchObject({ mechanism: "queue-wake-ladder:retry", dueAt: at(75.001).toISOString() });
    await f.tick(75); expect(f.wakes).toEqual([]);
    await f.tick(75.001); expect(f.wakes).toEqual([{ via: "ladder", qitemId: f.id, second: 75.001 }]);
  });

  it("does not restart an exhausted original ladder after a clear observation", async () => {
    const f = await fixture("pending-failed");
    vi.setSystemTime(at(15));
    repo.transitionLog.append({ qitemId: f.id, state: "pending", actorSession: "wake-ladder@system", transitionNote: `${LADDER_EXHAUSTED_PREFIX} fixture` });
    f.observe("clear", 20);
    for (const second of [20, 60, 120, 180]) { await f.tick(second); await f.evaluate(second); }
    expect(f.wakes).toEqual([]);
    expect(readWakeLadderBackstop(db, f.id)?.mechanism).toContain("queue-wake-ladder:exhausted");
    expect(repo.listTransitions(f.id).filter(t => t.transitionNote?.startsWith(LADDER_EXHAUSTED_PREFIX))).toHaveLength(1);
  });

  // The daemon classifies the refused seat from the oracle's arbitrated state (src/index.ts
  // readPromptState). These drive a real SeatActivityService for a Claude seat, whose
  // needs-input rungs are all declared authoritative, after a refusal at second 0.
  describe("a prompt episode retires only on needs-input evidence observed after the refusal", () => {
    const node = "worker-node";
    async function episode(drive: (report: (e: Omit<ActivityEvidence, "seatNodeId" | "sessionName" | "seq">) => void) => void) {
      const f = await fixture("pending-failed");
      const svc = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date() });
      svc.declareRungInventory({ seatNodeId: node, sessionName: seat }, CLAUDE_ACTIVITY_RUNG_INVENTORY);
      let n = 0;
      vi.setSystemTime(at(20));
      drive((e) => svc.reportEvidence({ seatNodeId: node, sessionName: seat, seq: ++n, ...e } as ActivityEvidence));
      f.setObserved(svc.getSeatState(node));
      await f.tick(20);
      await f.tick(60);
      return f;
    }
    const hookClear = (second: number) => ({ rung: "lifecycle-hooks" as const, sourceId: "claude-code:hooks",
      observedAt: at(second).toISOString(), activity: "idle-at-prompt" as const, needsInput: { count: 0, reason: null } });

    it("a declared needs-input rung that never reported keeps the episode open", async () => {
      const f = await episode((report) => report({ rung: "window-sampling", sourceId: "tmux:window-activity", observedAt: at(20).toISOString(), activity: "working" }));
      expect(repo.getById(f.alert!.qitemId)?.state).toBe("pending");
    });

    it("working/idle-only evidence (self-report busy) keeps the episode open", async () => {
      const f = await episode((report) => report({ rung: "self-report", sourceId: "claude:pid-json", observedAt: at(20).toISOString(), activity: "working" }));
      expect(repo.getById(f.alert!.qitemId)?.state).toBe("pending");
    });

    it("an older explicit clear plus a newer busy/idle update keeps the episode open", async () => {
      const f = await episode((report) => {
        report(hookClear(-5));
        report({ rung: "self-report", sourceId: "claude:pid-json", observedAt: at(20).toISOString(), activity: "working" });
      });
      expect(repo.getById(f.alert!.qitemId)?.state).toBe("pending");
    });

    it("an explicit clear observed after the refusal retires the episode", async () => {
      const f = await episode((report) => report(hookClear(20)));
      expect(repo.getById(f.alert!.qitemId)?.state).toBe("done");
      expect(repo.listTransitions(f.alert!.qitemId)).toContainEqual(expect.objectContaining({ actorSession: f.alert!.sourceSession, transitionNote: retiredNote }));
    });
  });
});
