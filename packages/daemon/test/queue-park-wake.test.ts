import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { USAGE_LIMIT_BLOCKER_TAG } from "../src/domain/queue-wake-repository.js";
import { isDue } from "../src/domain/watchdog-scheduler.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";

// S03 R25 RED-FIRST fixture: this is the contract shape migration 073 will ship.
// Keeping the table local in the RED commit lets every behavior fail on its own
// assertion at the old base instead of one missing-module error masking the set.
function createWakeContractTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE queue_transition_wakes (
      transition_id INTEGER PRIMARY KEY,
      qitem_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      wake_kind TEXT NOT NULL,
      wake_ref TEXT NOT NULL,
      delivery_status TEXT
    );
    CREATE INDEX idx_queue_transition_wakes_qitem
      ON queue_transition_wakes(qitem_id, transition_id);
    CREATE INDEX idx_queue_transition_wakes_ref
      ON queue_transition_wakes(wake_ref, phase);
  `);
}

describe("S03 R25 — a park records its wake on the append-only transition", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let jobs: WatchdogJobsRepository;
  let sent: Array<{ session: string; text: string }>;
  let transportResult: Awaited<ReturnType<QueueNudgeTransport["send"]>>;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      outboxEntriesSchema,
      watchdogJobsSchema,
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
    ]);
    createWakeContractTable(db);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    repo.attachOutbox(new OutboxHandler(db));
    sent = [];
    transportResult = { ok: true, verified: true };
    repo.attachTransport({
      async send(session, text) {
        sent.push({ session, text });
        return transportResult;
      },
    });
    jobs = new WatchdogJobsRepository(db);
  });

  afterEach(() => db.close());

  async function item(destinationSession = "worker@rig") {
    return repo.create({ sourceSession: "orch@rig", destinationSession, body: "work", nudge: false });
  }

  function wakes(qitemId: string): Array<Record<string, unknown>> {
    return db.prepare(
      "SELECT transition_id, qitem_id, phase, wake_kind, wake_ref, delivery_status FROM queue_transition_wakes WHERE qitem_id = ? ORDER BY transition_id",
    ).all(qitemId) as Array<Record<string, unknown>>;
  }

  it("records an existing active watchdog id on the park transition", async () => {
    const row = await item();
    const job = jobs.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: worker@rig\nmessage: resume\n",
      targetSession: "worker@rig",
      intervalSeconds: 60,
      registeredBySession: "orch@rig",
    });

    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:vendor-window",
      transitionNote: "continuation: resume when the vendor window opens",
      wakeWatchdogId: job.jobId,
    } as never);

    expect(wakes(row.qitemId)).toEqual([
      expect.objectContaining({ phase: "armed", wake_kind: "watchdog", wake_ref: job.jobId }),
    ]);
  });

  it("arms a timer atomically and records its generated watchdog id", async () => {
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:cooldown",
      transitionNote: "continuation: retry after cooldown",
      wakeAfterSeconds: 90,
    } as never);

    const wake = wakes(row.qitemId)[0] as { wake_kind: string; wake_ref: string } | undefined;
    expect(wake?.wake_kind).toBe("timer");
    const job = wake ? jobs.getById(wake.wake_ref) : null;
    expect(job).toMatchObject({ state: "active", targetSession: "worker@rig", intervalSeconds: 90 });
    // AMENDED by OPR.0.5.8.1 S1. This test's subject — a park arms a timer
    // ATOMICALLY and records its generated watchdog id — is unchanged and still
    // asserted above. Only these two incidental lines described behaviour that
    // was a defect: an unseeded `last_evaluation_at` made `isDue` true at
    // registration, so a 90s timer (like the measured 20m and 2h ones) fired on
    // the scheduler's first pass. The interval now starts at registration for
    // every explicit `--wake-after`, as it already did for provider-limit parks.
    expect(job?.lastEvaluationAt).toBe(job?.registeredAt);
    const armedAt = Date.parse(job!.registeredAt);
    expect(isDue(job!, armedAt)).toBe(false);              // not due the instant it is armed
    expect(isDue(job!, armedAt + 89_999)).toBe(false);     // nor one tick early
    expect(isDue(job!, armedAt + 90_000)).toBe(true);      // due at the requested 90s
    // Unchanged and deliberately still asserted: this repair does not add an
    // expiry field to ordinary timer parks (no new per-wake bookkeeping).
    expect(repo.getParkWakeStatus(row.qitemId)).not.toHaveProperty("expiresAt");
  });

  it("OPR.0.5.8.1 S1 — two materially different --wake-after durations do NOT converge on one latency", async () => {
    // The SPEC's own contract line. Measured on the base build through the real
    // public seam: a requested 20m fired 0.69s after arming and a requested 2h
    // fired 0.77s — a 6x difference in request collapsing to a shared sub-second
    // latency, because `isDue` treats a job with no `last_evaluation_at` as due.
    // Each duration must now be measured against its own arming instant.
    const short = await item("worker@rig");
    const long = await item("worker@rig");
    await repo.update({
      qitemId: short.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: short", wakeAfterSeconds: 120,
    } as never);
    await repo.update({
      qitemId: long.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: long", wakeAfterSeconds: 7200,
    } as never);

    const shortJob = jobs.getById((wakes(short.qitemId)[0] as { wake_ref: string }).wake_ref)!;
    const longJob = jobs.getById((wakes(long.qitemId)[0] as { wake_ref: string }).wake_ref)!;
    expect(shortJob.intervalSeconds).toBe(120);
    expect(longJob.intervalSeconds).toBe(7200);

    const shortArmed = Date.parse(shortJob.registeredAt);
    const longArmed = Date.parse(longJob.registeredAt);

    // Neither fires on the scheduler's first pass.
    expect(isDue(shortJob, shortArmed + 1_000)).toBe(false);
    expect(isDue(longJob, longArmed + 1_000)).toBe(false);

    // At two minutes the short one is due and the long one is emphatically not:
    // the durations separate instead of converging.
    expect(isDue(shortJob, shortArmed + 120_000)).toBe(true);
    expect(isDue(longJob, longArmed + 120_000)).toBe(false);

    // And the long one comes due only at its own requested time.
    expect(isDue(longJob, longArmed + 7_199_999)).toBe(false);
    expect(isDue(longJob, longArmed + 7_200_000)).toBe(true);
  });

  it("rolls the generated timer back when the park transaction aborts", async () => {
    const row = await item();
    db.exec(`
      CREATE TRIGGER reject_test_park BEFORE UPDATE OF state ON queue_items
      WHEN NEW.qitem_id = '${row.qitemId}'
      BEGIN SELECT RAISE(ABORT, 'forced park failure'); END;
    `);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM watchdog_jobs").get() as { n: number }).n;
    expect(() => repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:cooldown",
      transitionNote: "continuation: retry after cooldown",
      wakeAfterSeconds: 90,
    } as never)).toThrow(/forced park failure/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM watchdog_jobs").get() as { n: number }).n).toBe(before);
    expect(repo.getById(row.qitemId)?.state).toBe("pending");
    expect(wakes(row.qitemId)).toEqual([]);
  });

  it("auto-unpark publishes the dependent event and records the real post-commit delivery outcome", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    const sibling = await item("worker-2@rig");
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: resume after gate closes",
    });
    repo.update({
      qitemId: sibling.qitemId,
      actorSession: "worker-2@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: sibling resumes after gate closes",
    });

    expect(wakes(row.qitemId)).toEqual([
      expect.objectContaining({ phase: "armed", wake_kind: "blocker", wake_ref: blocker.qitemId }),
    ]);

    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));
    transportResult = { ok: false, error: "owner unreachable" };
    repo.update({
      qitemId: blocker.qitemId,
      actorSession: "gate@rig",
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "gate cleared",
    });

    expect(repo.getById(row.qitemId)?.state).toBe("pending");
    expect(repo.getById(sibling.qitemId)?.state).toBe("pending");
    const updatedIds = received
      .filter((event) => event.type === "queue.updated")
      .map((event) => event.qitemId);
    expect(updatedIds).toHaveLength(3);
    expect(new Set(updatedIds)).toEqual(new Set([row.qitemId, sibling.qitemId, blocker.qitemId]));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(new Set(sent.map((call) => call.session))).toEqual(new Set(["worker@rig", "worker-2@rig"]));
    expect(sent.some((call) => call.text.includes(row.qitemId))).toBe(true);
    expect(sent.some((call) => call.text.includes(sibling.qitemId))).toBe(true);
    expect(repo.getById(row.qitemId)?.lastNudgeResult).toBe("failed:owner unreachable");
    expect(repo.getById(sibling.qitemId)?.lastNudgeResult).toBe("failed:owner unreachable");
    expect(wakes(row.qitemId).at(-1)).toMatchObject({
      phase: "fired",
      wake_kind: "blocker",
      wake_ref: blocker.qitemId,
      delivery_status: "failed:owner unreachable",
    });
    expect(wakes(sibling.qitemId).at(-1)).toMatchObject({
      phase: "fired",
      wake_kind: "blocker",
      wake_ref: blocker.qitemId,
      delivery_status: "failed:owner unreachable",
    });
    const intent = db.prepare(
      "SELECT COUNT(*) AS n FROM outbox_entries WHERE audit_pointer IN (?, ?) AND delivery_state = 'failed'",
    ).get(row.qitemId, sibling.qitemId) as { n: number };
    expect(intent.n).toBe(2);
  });

  it("outer transactions publish every auto-unpark event through the exact notify envelope", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: resume after gate closes",
    });
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.withNotifyEnvelope((register) => {
      const result = repo.updateWithinTransaction({
        qitemId: blocker.qitemId,
        actorSession: "gate@rig",
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: "gate cleared transactionally",
      });
      register(result.persistedEvent);
    });

    expect(received.filter((event) => event.type === "queue.updated").map((event) => event.qitemId)).toEqual([
      row.qitemId,
      blocker.qitemId,
    ]);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it("a rolled-back blocker completion leaves no intent and performs no wake effect", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: resume after gate closes",
    });

    expect(() => bus.withNotifyEnvelope((register) => {
      const result = repo.updateWithinTransaction({
        qitemId: blocker.qitemId,
        actorSession: "gate@rig",
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: "this whole transaction will abort",
      });
      register(result.persistedEvent);
      throw new Error("forced outer rollback");
    })).toThrow(/forced outer rollback/);

    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    expect(sent).toEqual([]);
    expect(repo.getById(blocker.qitemId)?.state).toBe("pending");
    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect((db.prepare("SELECT COUNT(*) AS n FROM outbox_entries").get() as { n: number }).n).toBe(0);
  });

  it("a committed auto-unpark intent survives a missing transport and the recovery drain records its delivery", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: resume after gate closes",
    });

    const recovering = new QueueRepository(db, bus);
    recovering.attachOutbox(new OutboxHandler(db));
    recovering.update({
      qitemId: blocker.qitemId,
      actorSession: "gate@rig",
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "gate cleared while transport is absent",
    });
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    expect(sent).toEqual([]);
    expect(db.prepare(
      "SELECT delivery_state FROM outbox_entries WHERE audit_pointer = ?",
    ).get(row.qitemId)).toMatchObject({ delivery_state: "pending" });
    expect(wakes(row.qitemId).at(-1)).toMatchObject({ phase: "armed", delivery_status: null });

    recovering.attachTransport({
      async send(session, text) {
        sent.push({ session, text });
        return { ok: true, verified: true };
      },
    });
    await expect(recovering.drainPendingWakeIntents()).resolves.toEqual({
      delivered: 1,
      indeterminate: 0,
      failed: 0,
    });
    expect(sent).toHaveLength(1);
    expect(wakes(row.qitemId).at(-1)).toMatchObject({
      phase: "fired",
      wake_kind: "blocker",
      wake_ref: blocker.qitemId,
      delivery_status: "verified",
    });
  });

  it("S16 resolves one provider-limit timer into exactly one durable wake per dependent", async () => {
    const blocker = await repo.create({
      sourceSession: "wake-ladder@system",
      destinationSession: "wake-ladder@rig",
      body: "provider limit for one account pool",
      tags: [USAGE_LIMIT_BLOCKER_TAG, "usage-limit-pool:claude%3Alocal"],
      nudge: false,
    });
    repo.update({
      qitemId: blocker.qitemId,
      actorSession: "wake-ladder@system",
      state: "blocked",
      blockedOn: "external:provider-limit:claude:local",
      transitionNote: "usage-limit park until stated reset",
      wakeAfterSeconds: 60,
    } as never);
    const timer = repo.getParkWakeStatus(blocker.qitemId)!;

    const dependents = await Promise.all([
      item("worker-1@rig"),
      item("worker-2@rig"),
      item("worker-3@rig"),
    ]);
    for (const dependent of dependents) {
      repo.update({
        qitemId: dependent.qitemId,
        actorSession: "wake-ladder@system",
        state: "blocked",
        blockedOn: blocker.qitemId,
        transitionNote: "usage-limit park on the shared provider/account timer",
      });
      expect(repo.getParkWakeStatus(dependent.qitemId)).toMatchObject({
        kind: "blocker",
        ref: blocker.qitemId,
        live: true,
        expiresAt: timer.expiresAt,
      });
    }

    repo.recordWatchdogWakeAttempt(timer.ref, "failed:synthetic timer target");
    await repo.drainPendingWakeIntents();

    expect(jobs.getById(timer.ref)?.state).toBe("terminal");
    expect(repo.getById(blocker.qitemId)?.state).toBe("done");
    expect(dependents.map((row) => repo.getById(row.qitemId)?.state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(sent.map((call) => call.session).sort()).toEqual([
      "worker-1@rig",
      "worker-2@rig",
      "worker-3@rig",
    ]);

    repo.recordWatchdogWakeAttempt(timer.ref, "failed:duplicate watchdog callback");
    await repo.drainPendingWakeIntents();
    expect(sent).toHaveLength(3);
  });

  it("S16 initializes its timer baseline so it becomes due at the projected expiry, never immediately", async () => {
    const blocker = await repo.create({
      sourceSession: "wake-ladder@system",
      destinationSession: "wake-ladder@rig",
      body: "provider limit for one account pool",
      tags: [USAGE_LIMIT_BLOCKER_TAG, "usage-limit-pool:claude%3Alocal"],
      nudge: false,
    });
    repo.update({
      qitemId: blocker.qitemId,
      actorSession: "wake-ladder@system",
      state: "blocked",
      blockedOn: "external:provider-limit:claude:local",
      transitionNote: "usage-limit park until stated reset",
      wakeAfterSeconds: 60,
    } as never);

    const timer = repo.getParkWakeStatus(blocker.qitemId)!;
    const job = jobs.getById(timer.ref)!;
    const registeredAt = Date.parse(job.registeredAt);
    expect(job.lastEvaluationAt).toBe(job.registeredAt);
    expect(timer.expiresAt).toBe(new Date(registeredAt + 60_000).toISOString());
    expect(repo.listTransitions(blocker.qitemId).find((transition) => transition.wake)?.wake)
      .toMatchObject({ expiresAt: timer.expiresAt });
    expect(isDue(job, registeredAt + 59_999)).toBe(false);
    expect(isDue(job, registeredAt + 60_000)).toBe(true);
  });

  it("an ordinary blocker wake remains expiry-less", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "ordinary blocker",
    });

    expect(repo.getParkWakeStatus(row.qitemId)).toEqual(expect.objectContaining({
      kind: "blocker",
      ref: blocker.qitemId,
    }));
    expect(repo.getParkWakeStatus(row.qitemId)).not.toHaveProperty("expiresAt");
  });

  it("negative control: a wakeless park still succeeds and records no invented wake", async () => {
    const row = await item();
    const parked = repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:unknown",
      transitionNote: "legacy wakeless park",
    });
    expect(parked.state).toBe("blocked");
    expect(wakes(row.qitemId)).toEqual([]);
    expect(repo.getParkWakeStatus(row.qitemId)).toBeNull();

    const teaching = "`parked` means the row is blocked; use `rig parked` to diagnose its wake.";
    expect(teaching).toContain("`parked` means the row is blocked");
    expect(teaching).toContain("`rig parked`");
    expect(teaching).not.toContain("it carries its wake and legitimately waits");
  });

  it("a fired timer appends a resume attempt; remaining blocked makes it observably unconsumed", async () => {
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:cooldown",
      transitionNote: "continuation: resume after cooldown",
      wakeAfterSeconds: 30,
    } as never);
    const timerId = String(wakes(row.qitemId)[0]?.wake_ref);

    (repo as unknown as { recordWatchdogWakeAttempt: (jobId: string, status: string) => void })
      .recordWatchdogWakeAttempt(timerId, "ok");

    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect(wakes(row.qitemId).at(-1)).toMatchObject({
      phase: "fired",
      wake_kind: "timer",
      wake_ref: timerId,
      delivery_status: "ok",
    });
    expect((repo as unknown as { getParkWakeStatus: (id: string) => { unconsumed: boolean } | null })
      .getParkWakeStatus(row.qitemId)?.unconsumed).toBe(true);
  });

  it("FR-6 negative control: valid human-seat park still requires and persists summary + evidence", async () => {
    const row = await item();
    const parked = repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "human-review@kernel",
      summary: "choose the release boundary",
      evidenceRef: "/proof/release.md",
      transitionNote: "continuation: apply the human ruling",
    });
    expect(parked).toMatchObject({
      state: "blocked",
      summary: "choose the release boundary",
      evidenceRef: "/proof/release.md",
    });
  });
});
