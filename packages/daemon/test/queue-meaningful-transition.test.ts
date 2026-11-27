import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { lastMeaningfulTransition, lastMeaningfulTransitionMany } from "../src/domain/queue-waiting.js";

describe("indexed meaningful transition reads", () => {
  const connections: Database.Database[] = [];
  const connection = (wakes: boolean) => {
    const db = new Database(":memory:");
    connections.push(db);
    // Nullable legacy rows exercise SQL's NULL comparisons as well as today's non-null schema.
    db.exec(`CREATE TABLE queue_transitions (transition_id INTEGER PRIMARY KEY, qitem_id TEXT, ts TEXT, state TEXT, actor_session TEXT);
      CREATE INDEX idx_queue_transitions_qitem_id_order ON queue_transitions(qitem_id, transition_id)`);
    if (wakes) db.exec("CREATE TABLE queue_transition_wakes (transition_id INTEGER PRIMARY KEY, phase TEXT)");
    return db;
  };
  afterEach(() => {
    for (const db of connections.splice(0)) if (db.open) db.close();
  });

  // The pre-repair window query is the oracle: its predecessor includes all transitions before wake filtering.
  const original = (db: Database.Database, wakes: boolean, id: string) => {
    const row = db.prepare(`SELECT t.transition_id, t.ts FROM (
      SELECT *, LAG(state) OVER (ORDER BY transition_id) AS previous_state FROM queue_transitions WHERE qitem_id = ?
    ) t WHERE (t.actor_session NOT IN ('watchdog@system', 'wake-ladder@system', 'daemon@kernel', 'daemon@system') OR t.state IS NOT t.previous_state)
    ${wakes ? "AND NOT EXISTS (SELECT 1 FROM queue_transition_wakes w WHERE w.transition_id = t.transition_id AND w.phase = 'fired')" : ""}
    ORDER BY t.transition_id DESC LIMIT 1`).get(id) as { transition_id: number; ts: string } | undefined;
    return row ? { id: row.transition_id, at: row.ts } : null;
  };

  it("matches the window query for 1,000 row histories, singly and in batches", () => {
    let seed = 1;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor(seed / 4294967296 * n);
    };
    const ids = ["row0", "row1", "row2", "row3", "absent"];
    const states = ["pending", "in-progress", "blocked", "done", null];
    const actors = ["watchdog@system", "wake-ladder@system", "daemon@kernel", "daemon@system", "author@rig", null];
    for (const wakes of [false, true]) {
      for (let fixture = 0; fixture < 100; fixture++) {
        const db = connection(wakes);
        const insert = db.prepare("INSERT INTO queue_transitions VALUES (?, ?, ?, ?, ?)");
        const wake = wakes ? db.prepare("INSERT INTO queue_transition_wakes VALUES (?, ?)") : null;
        db.transaction(() => {
          for (let i = 1; i <= 300; i++) {
            insert.run(i, "row" + random(4), "2026-11-" + String(1 + random(27)).padStart(2, "0"),
              states[random(states.length)], actors[random(actors.length)]);
            if (wake && random(3) === 0) wake.run(i, random(2) ? "armed" : "fired");
          }
        })();
        const expected = new Map(ids.map(id => [id, original(db, wakes, id)]));
        for (const id of ids) expect(lastMeaningfulTransition(db, id), `${wakes}/${fixture}/${id}`).toEqual(expected.get(id));
        // Duplicates, missing ids and caller order keep the existing Map contract.
        expect(lastMeaningfulTransitionMany(db, [...ids, ids[0]!])).toEqual(expected);
        expect([...lastMeaningfulTransitionMany(db, [...ids].reverse()).keys()]).toEqual([...ids].reverse());
        db.close();
      }
    }
  });

  it("compares with a fired predecessor and orders by insertion, not the wall clock", () => {
    const db = connection(true);
    db.exec(`INSERT INTO queue_transitions VALUES
      (1, 'q', '2026-11-27', 'pending', 'watchdog@system'),
      (2, 'q', '2026-11-26', 'blocked', 'author@rig'),
      (3, 'q', '2026-11-25', 'blocked', 'daemon@system');
      INSERT INTO queue_transition_wakes VALUES (2, 'fired')`);
    // Row 3 matches the fired row's state, so neither 2 nor 3 counts as progress.
    expect(lastMeaningfulTransition(db, "q")).toEqual({ id: 1, at: "2026-11-27" });
    db.exec("INSERT INTO queue_transitions VALUES (4, 'q', '2026-11-24', 'in-progress', 'daemon@kernel')");
    expect(lastMeaningfulTransitionMany(db, ["q"]).get("q")).toEqual({ id: 4, at: "2026-11-24" });
    db.exec("INSERT INTO queue_transitions VALUES (5, 'q', '2026-11-23', 'in-progress', 'author@rig')");
    expect(lastMeaningfulTransition(db, "q")).toEqual({ id: 5, at: "2026-11-23" });
  });

  it("preserves first-row NULL semantics and an entirely excluded machine tail", () => {
    const db = connection(false);
    db.exec("INSERT INTO queue_transitions VALUES (1, 'null-state', '2026-11-27', NULL, 'daemon@system')");
    const insert = db.prepare("INSERT INTO queue_transitions VALUES (?, 'tail', '2026-11-27', 'pending', 'watchdog@system')");
    db.transaction(() => { for (let i = 2; i <= 10001; i++) insert.run(i); })();
    const expected = new Map<string, { id: number; at: string } | null>([["null-state", null], ["tail", { id: 2, at: "2026-11-27" }], ["absent", null]]);
    expect(lastMeaningfulTransitionMany(db, [...expected.keys()])).toEqual(expected);
    for (const [id, result] of expected) expect(lastMeaningfulTransition(db, id)).toEqual(result);
  });

  it("returns nulls when the transition table is absent", () => {
    const db = new Database(":memory:");
    connections.push(db);
    expect(lastMeaningfulTransition(db, "q")).toBeNull();
    expect(lastMeaningfulTransitionMany(db, ["q", "q", "other"])).toEqual(new Map([["q", null], ["other", null]]));
    expect(lastMeaningfulTransitionMany(db, [])).toEqual(new Map());
  });
});
