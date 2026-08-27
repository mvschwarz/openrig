import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
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
  let repo: QueueRepository;
  let jobs: WatchdogJobsRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      watchdogJobsSchema,
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
    ]);
    createWakeContractTable(db);
    repo = new QueueRepository(db, new EventBus(db));
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

  it("records a live blocker whose terminal resolution is the wake", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: resume after gate closes",
    });

    expect(wakes(row.qitemId)).toEqual([
      expect.objectContaining({ phase: "armed", wake_kind: "blocker", wake_ref: blocker.qitemId }),
    ]);

    repo.update({
      qitemId: blocker.qitemId,
      actorSession: "gate@rig",
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "gate cleared",
    });
    expect(repo.getById(row.qitemId)?.state).toBe("pending");
    expect(wakes(row.qitemId).at(-1)).toMatchObject({
      phase: "fired",
      wake_kind: "blocker",
      wake_ref: blocker.qitemId,
      delivery_status: "resumed",
    });
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
