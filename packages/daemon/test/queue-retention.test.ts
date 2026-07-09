import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  archiveAgedTerminalTransitions,
  pruneWatchdogHistory,
  runQueueRetentionSweep,
  DEFAULT_TERMINAL_STATES,
  type RetentionOptions,
} from "../src/domain/queue-retention.js";

// OPR.0.4.6.FS-1 W2 — queue-retention unit tests. HAND-BUILT minimal schema:
// only the columns the retention functions touch, NO FKs — an isolated unit test
// of the retention LOGIC. Table/column names mirror migrations 024/025/054/034/032.
// The full-schema byte-identity + real-incident-data behavior is the W3 VM proof.
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE queue_items (qitem_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE queue_transitions (
      transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
      qitem_id TEXT NOT NULL, ts TEXT NOT NULL, state TEXT NOT NULL,
      transition_note TEXT, actor_session TEXT NOT NULL,
      closure_reason TEXT, closure_target TEXT
    );
    CREATE TABLE queue_transitions_archive (
      transition_id INTEGER PRIMARY KEY, qitem_id TEXT NOT NULL, ts TEXT NOT NULL,
      state TEXT NOT NULL, transition_note TEXT, actor_session TEXT NOT NULL,
      closure_reason TEXT, closure_target TEXT, archived_at TEXT NOT NULL
    );
    CREATE TABLE workflow_instances (
      instance_id TEXT PRIMARY KEY, workflow_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      current_frontier_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE watchdog_history (
      history_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, evaluated_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedQitem(db: Database.Database, id: string, state: string, tsList: string[]): void {
  db.prepare("INSERT INTO queue_items (qitem_id, state) VALUES (?, ?)").run(id, state);
  const ins = db.prepare(
    "INSERT INTO queue_transitions (qitem_id, ts, state, actor_session) VALUES (?, ?, ?, ?)",
  );
  for (const ts of tsList) ins.run(id, ts, state, "seat@rig");
}

const count = (db: Database.Database, sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { c: number }).c;

const NOW = "2026-07-08T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z"; // > 30d before NOW (aged)
const RECENT = "2026-07-07T00:00:00.000Z"; // < 30d before NOW (fresh)
const opts = (over: Partial<RetentionOptions> = {}): RetentionOptions => ({ nowIso: NOW, ...over });

describe("queue-retention — archiveAgedTerminalTransitions", () => {
  it("archives a terminal qitem whose LAST transition is older than the window (move, not delete)", () => {
    const db = makeDb();
    seedQitem(db, "q-done-old", "done", [OLD, OLD]);
    const r = archiveAgedTerminalTransitions(db, opts());
    expect(r.archivedQitems).toBe(1);
    expect(r.archivedRows).toBe(2);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id=?", "q-done-old")).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions_archive WHERE qitem_id=?", "q-done-old")).toBe(2);
    // provenance: archived_at stamped with nowIso; original ts preserved (moved, not rewritten).
    const row = db
      .prepare("SELECT archived_at, ts FROM queue_transitions_archive WHERE qitem_id=? LIMIT 1")
      .get("q-done-old") as { archived_at: string; ts: string };
    expect(row.archived_at).toBe(NOW);
    expect(row.ts).toBe(OLD);
  });

  it("does NOT archive a terminal qitem whose last transition is WITHIN the window", () => {
    const db = makeDb();
    seedQitem(db, "q-done-recent", "done", [OLD, RECENT]); // MAX(ts)=RECENT → not aged
    expect(archiveAgedTerminalTransitions(db, opts()).archivedQitems).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id=?", "q-done-recent")).toBe(2);
  });

  it("ACTIVE-FRONTIER INVARIANT: never archives a NON-terminal qitem, at any age", () => {
    const db = makeDb();
    seedQitem(db, "q-inprogress-old", "in-progress", [OLD, OLD]);
    expect(archiveAgedTerminalTransitions(db, opts()).archivedQitems).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id=?", "q-inprogress-old")).toBe(2);
  });

  it("archives `handed-off` too (the FULL terminal set, arch D3-REFINEMENT — not done-only)", () => {
    const db = makeDb();
    seedQitem(db, "q-handed", "handed-off", [OLD]);
    expect(archiveAgedTerminalTransitions(db, opts()).archivedQitems).toBe(1);
    expect([...DEFAULT_TERMINAL_STATES]).toEqual(["done", "handed-off"]);
  });

  // P2 — THE NAMED VACUOUS-TODAY FRONTIER-LIVENESS TEST (arch P2 pin).
  it("P2 frontier-liveness (vacuous today): a terminal+aged qitem referenced by a LIVE workflow frontier is NOT archived; once the instance is terminal it archives", () => {
    const db = makeDb();
    seedQitem(db, "q-frontier", "done", [OLD]);
    // A LIVE (active) workflow instance references q-frontier in its frontier.
    db.prepare(
      "INSERT INTO workflow_instances (instance_id, workflow_name, status, current_frontier_json) VALUES (?, ?, ?, ?)",
    ).run("wi-1", "wf", "active", JSON.stringify(["q-frontier"]));
    // Guarded: the NOT EXISTS excludes it while the instance is live.
    expect(archiveAgedTerminalTransitions(db, opts()).archivedQitems).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id=?", "q-frontier")).toBe(1);
    // Flip the instance terminal (completed) + empty frontier → no longer live → archives.
    db.prepare("UPDATE workflow_instances SET status='completed', current_frontier_json='[]' WHERE instance_id=?").run("wi-1");
    expect(archiveAgedTerminalTransitions(db, opts()).archivedQitems).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id=?", "q-frontier")).toBe(0);
  });

  it("bounded batch: honors batchSize (returns only up to batchSize qitems per call)", () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) seedQitem(db, `q${i}`, "done", [OLD]);
    const r = archiveAgedTerminalTransitions(db, opts({ batchSize: 2 }));
    expect(r.archivedQitems).toBe(2);
    expect(count(db, "SELECT COUNT(*) c FROM queue_items q WHERE EXISTS (SELECT 1 FROM queue_transitions t WHERE t.qitem_id=q.qitem_id)", )).toBe(3);
  });
});

describe("queue-retention — pruneWatchdogHistory", () => {
  const insHist = (db: Database.Database) =>
    db.prepare("INSERT INTO watchdog_history (history_id, job_id, evaluated_at) VALUES (?, ?, ?)");

  it("deletes rows older than the window that are BEYOND keep-K per job, keeps the recent-K", () => {
    const db = makeDb();
    const ins = insHist(db);
    ins.run("a1", "jobA", "2026-01-01T00:00:00.000Z");
    ins.run("a2", "jobA", "2026-01-02T00:00:00.000Z");
    ins.run("a3", "jobA", "2026-01-03T00:00:00.000Z");
    const r = pruneWatchdogHistory(db, opts({ watchdogRetentionDays: 14, watchdogKeepPerJob: 2 }));
    expect(r.deletedRows).toBe(1); // only a1 (oldest, rank 3 > keep 2, older than 14d)
    const remaining = (db.prepare("SELECT history_id FROM watchdog_history WHERE job_id='jobA' ORDER BY evaluated_at").all() as Array<{ history_id: string }>).map((x) => x.history_id);
    expect(remaining).toEqual(["a2", "a3"]);
  });

  it("keeps a recent-K row even when it is older than the window (keep-per-job wins)", () => {
    const db = makeDb();
    insHist(db).run("b1", "jobB", "2026-01-01T00:00:00.000Z");
    expect(pruneWatchdogHistory(db, opts({ watchdogKeepPerJob: 50 })).deletedRows).toBe(0);
  });
});

describe("queue-retention — runQueueRetentionSweep", () => {
  it("drains both passes in bounded batches and reports a summary", async () => {
    const db = makeDb();
    seedQitem(db, "q1", "done", [OLD]);
    seedQitem(db, "q2", "handed-off", [OLD]);
    db.prepare("INSERT INTO watchdog_history (history_id, job_id, evaluated_at) VALUES ('h1','j','2026-01-01T00:00:00.000Z')").run();
    const s = await runQueueRetentionSweep(db, opts({ watchdogKeepPerJob: 0, batchSize: 1 }));
    expect(s.archivedQitems).toBe(2); // both terminal qitems archived across bounded batches
    expect(s.watchdogDeleted).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions")).toBe(0);
  });
});
