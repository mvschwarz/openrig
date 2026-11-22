// relatedTo reads a request's recorded relations: rows replying to it, handed off from it, or parked on it. The OR
// once scanned every queue row, because blocked_on has no index of its own, and the core app's graph read calls it
// once per node, up to 100 times. A row keeps its blocker only while blocked, so the parked arm reads the blocked
// rows and every arm uses an index. These cells pin the plan, the answers, and the one difference: a row from before
// that clearing that left blocked still naming a blocker.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { deriveCanonicalSessionName } from "../src/domain/session-name.js";

const planner = deriveCanonicalSessionName("dev", "planner", "rig");
const worker = deriveCanonicalSessionName("dev", "worker", "rig");
const next = deriveCanonicalSessionName("dev", "next", "rig");

describe("relatedTo reads each relation through an index", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db));
  });
  afterEach(() => db.close());

  /** A reply's link, set directly: a reply that create() accepts is an update to a person, with its own required fields,
   *  and this read only needs the column. */
  const setReplyTo = (id: string, to: string) => db.prepare("UPDATE queue_items SET reply_to = ? WHERE qitem_id = ?").run(to, id);

  /** The statement relatedTo prepares, as it runs. */
  function relatedToSql(qitemId: string): string {
    const sql: string[] = [];
    const original = db.prepare;
    (db as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => { sql.push(s); return original.call(db, s); };
    try { repo.relatedTo(qitemId); } finally { (db as unknown as { prepare: typeof original }).prepare = original; }
    const statement = sql.find((s) => s.includes("FROM queue_items") && s.includes("reply_to = ?"));
    expect(statement).toBeDefined();
    return statement!;
  }

  it("plans as a multi-index OR, with no scan of queue_items", async () => {
    const ask = await repo.create({ sourceSession: planner, destinationSession: worker, body: "ask", nudge: false });
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${relatedToSql(ask.qitemId)}`).all(ask.qitemId, ask.qitemId, ask.qitemId, 101) as Array<{ detail: string }>)
      .map((row) => row.detail);
    expect(plan.join(" | ")).not.toMatch(/SCAN queue_items/);
    expect(plan).toContain("MULTI-INDEX OR");
  });

  it("returns replies, the rows parked on it and its handed-off successor, in row order", async () => {
    const ask = await repo.create({ sourceSession: planner, destinationSession: worker, body: "ask", nudge: false });
    const reply = await repo.create({ sourceSession: worker, destinationSession: planner, body: "reply", nudge: false });
    setReplyTo(reply.qitemId, ask.qitemId);
    const parked = await repo.create({ sourceSession: planner, destinationSession: worker, body: "waits", nudge: false });
    repo.update({ qitemId: parked.qitemId, actorSession: worker, state: "blocked", blockedOn: ask.qitemId });
    const related = () => repo.relatedTo(ask.qitemId).map(({ item, relation }) => [item.qitemId, relation]);
    expect(related()).toEqual([[reply.qitemId, "reply-to"], [parked.qitemId, "blocked-on"]]);

    // Leaving blocked clears the blocker, so the row is no longer parked on the ask.
    repo.update({ qitemId: parked.qitemId, actorSession: worker, state: "in-progress" });
    expect(related()).toEqual([[reply.qitemId, "reply-to"]]);

    const { created } = await repo.handoff({ qitemId: ask.qitemId, fromSession: worker, toSession: next, nudge: false });
    expect(related()).toEqual([[reply.qitemId, "reply-to"], [created.qitemId, "handed-off-from"]]);
  });

  it("doesn't list an older row that left blocked still naming a blocker", async () => {
    const ask = await repo.create({ sourceSession: planner, destinationSession: worker, body: "ask", nudge: false });
    const old = await repo.create({ sourceSession: worker, destinationSession: planner, body: "old", nudge: false });
    setReplyTo(old.qitemId, ask.qitemId);
    const parkedOnly = await repo.create({ sourceSession: planner, destinationSession: worker, body: "parked long ago", nudge: false });
    // How a row closed before 0.5.1-53's clear-on-exit can read: done, with its blocker still set.
    for (const id of [old.qitemId, parkedOnly.qitemId]) {
      db.prepare("UPDATE queue_items SET state = 'done', blocked_on = ? WHERE qitem_id = ?").run(ask.qitemId, id);
    }
    expect(repo.relatedTo(ask.qitemId).map(({ item, relation }) => [item.qitemId, relation])).toEqual([[old.qitemId, "reply-to"]]);
  });
});
