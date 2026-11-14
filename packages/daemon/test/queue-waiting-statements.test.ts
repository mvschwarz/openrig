import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { WaitingStatements, lastMeaningfulTransition, lastMeaningfulTransitionMany, reusedStatement } from "../src/domain/queue-waiting.js";

// The waiting view reuses its statements per connection. These pin what that reuse must not change: every read sees
// current data, the schema checks run each call, the cached texts are bounded, and statements go with their connection.
describe("the waiting view's reused statements", () => {
  const open: Database.Database[] = [];
  const connection = (wakes = true) => {
    const db = new Database(":memory:");
    open.push(db);
    db.exec(`CREATE TABLE queue_transitions (transition_id INTEGER PRIMARY KEY AUTOINCREMENT, qitem_id TEXT NOT NULL, ts TEXT NOT NULL,
      state TEXT NOT NULL, actor_session TEXT NOT NULL)`);
    if (wakes) db.exec("CREATE TABLE queue_transition_wakes (transition_id INTEGER NOT NULL, qitem_id TEXT NOT NULL, phase TEXT NOT NULL)");
    return db;
  };
  const transition = (db: Database.Database, qitemId: string, state: string, actor = "a-one@rig") =>
    Number(db.prepare("INSERT INTO queue_transitions (qitem_id, ts, state, actor_session) VALUES (?, ?, ?, ?)")
      .run(qitemId, new Date().toISOString(), state, actor).lastInsertRowid);
  afterEach(() => {
    for (const db of open.splice(0)) if (db.open) db.close();
  });

  it("reads current data on every call through the same statement", () => {
    const db = connection();
    const first = transition(db, "q-1", "pending");
    expect(lastMeaningfulTransition(db, "q-1")?.id).toBe(first);
    const second = transition(db, "q-1", "in-progress");
    expect(lastMeaningfulTransition(db, "q-1")?.id).toBe(second);
    transition(db, "q-1", "in-progress", "watchdog@system"); // bookkeeping, not progress
    expect(lastMeaningfulTransition(db, "q-1")?.id).toBe(second);
    expect(lastMeaningfulTransitionMany(db, ["q-1", "q-2"])).toEqual(new Map([["q-1", { id: second, at: expect.any(String) }], ["q-2", null]]));
    const third = transition(db, "q-2", "pending");
    expect(lastMeaningfulTransitionMany(db, ["q-1", "q-2"]).get("q-2")?.id).toBe(third);
  });

  it("checks the schema each call, and keeps working across a schema change", () => {
    const db = connection(false);
    const id = transition(db, "q-1", "pending");
    expect(lastMeaningfulTransition(db, "q-1")?.id).toBe(id);
    // The wakes table arrives later: the next call sees it and leaves out a fired wake's transition.
    db.exec("CREATE TABLE queue_transition_wakes (transition_id INTEGER NOT NULL, qitem_id TEXT NOT NULL, phase TEXT NOT NULL)");
    const woken = transition(db, "q-1", "blocked", "a-one@rig");
    db.prepare("INSERT INTO queue_transition_wakes (transition_id, qitem_id, phase) VALUES (?, 'q-1', 'fired')").run(woken);
    expect(lastMeaningfulTransition(db, "q-1")?.id).toBe(id);
    // A column added under a reused statement: SQLite re-prepares it, and the result is unchanged.
    db.exec("ALTER TABLE queue_transitions ADD COLUMN note TEXT");
    expect(lastMeaningfulTransition(db, "q-1")?.id).toBe(id);
    // A WaitingStatements instance memoizes its table checks; a fresh one checks again.
    const before = new WaitingStatements(db);
    expect(before.hasTable("late_table")).toBe(false);
    db.exec("CREATE TABLE late_table (x INTEGER)");
    expect(before.hasTable("late_table")).toBe(false);
    expect(new WaitingStatements(db).hasTable("late_table")).toBe(true);
  });

  it("reuses one statement per text and connection, never across connections, and caps the cached texts", () => {
    const one = connection();
    const two = connection();
    const sql = "SELECT 1 FROM sqlite_master WHERE name = 'queue_transitions'";
    expect(reusedStatement(one, sql)).toBe(reusedStatement(one, sql));
    expect(new WaitingStatements(one).statement(sql)).toBe(reusedStatement(one, sql));
    expect(reusedStatement(two, sql)).not.toBe(reusedStatement(one, sql));
    // Past the cap a text is prepared fresh each time, never kept.
    const texts = Array.from({ length: 40 }, (_, i) => `SELECT ${i} AS n`);
    for (const text of texts) reusedStatement(two, text);
    expect(reusedStatement(two, texts[39]!)).not.toBe(reusedStatement(two, texts[39]!));
    expect(reusedStatement(two, texts[0]!)).toBe(reusedStatement(two, texts[0]!));
    // A closed connection fails as a prepare on it would; the other keeps working.
    one.close();
    expect(() => lastMeaningfulTransition(one, "q-1")).toThrow();
    expect(lastMeaningfulTransition(two, "q-1")).toBeNull();
  });
});
