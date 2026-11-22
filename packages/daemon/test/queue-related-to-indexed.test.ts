// relatedTo reads a request's recorded relations: rows replying to it, handed off from it, or naming it as their
// blocker. The OR once scanned every queue row, because blocked_on had no index of its own, and the core app's graph
// read calls it once per node, up to 100 times. Migration 182 indexes the rows that name a blocker. These cells pin the
// plan and the answers, including rows a handoff or a cross-host close leaves still naming their blocker.

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
  const related = (id: string) => repo.relatedTo(id).map(({ item, relation }) => [item.qitemId, relation]);

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
    expect(plan.join(" | ")).toContain("idx_queue_items_blocked_on");
  });

  it("returns replies, the rows parked on it and its handed-off successor, in row order", async () => {
    const ask = await repo.create({ sourceSession: planner, destinationSession: worker, body: "ask", nudge: false });
    const reply = await repo.create({ sourceSession: worker, destinationSession: planner, body: "reply", nudge: false });
    setReplyTo(reply.qitemId, ask.qitemId);
    const parked = await repo.create({ sourceSession: planner, destinationSession: worker, body: "waits", nudge: false });
    repo.update({ qitemId: parked.qitemId, actorSession: worker, state: "blocked", blockedOn: ask.qitemId });
    expect(related(ask.qitemId)).toEqual([[reply.qitemId, "reply-to"], [parked.qitemId, "blocked-on"]]);

    // Leaving blocked through update() clears the blocker, so the row is no longer parked on the ask.
    repo.update({ qitemId: parked.qitemId, actorSession: worker, state: "in-progress" });
    expect(related(ask.qitemId)).toEqual([[reply.qitemId, "reply-to"]]);

    const { created } = await repo.handoff({ qitemId: ask.qitemId, fromSession: worker, toSession: next, nudge: false });
    expect(related(ask.qitemId)).toEqual([[reply.qitemId, "reply-to"], [created.qitemId, "handed-off-from"]]);
  });

  it.each(["handoff", "handoff-and-complete", "cross-host close"] as const)(
    "keeps a row parked on the request after a %s leaves it naming its blocker", async (verb) => {
      const ask = await repo.create({ sourceSession: planner, destinationSession: worker, body: "ask", nudge: false });
      const parked = await repo.create({ sourceSession: planner, destinationSession: worker, body: "waits", nudge: false });
      repo.update({ qitemId: parked.qitemId, actorSession: worker, state: "blocked", blockedOn: ask.qitemId });
      if (verb === "cross-host close") {
        repo.closeCrossHostHandoffSource({ qitemId: parked.qitemId, fromSession: worker, toSession: next,
          closureTarget: ["qitem-20261122000000-remote", "other-host"].join("@"), terminalState: "handed-off" });
      } else {
        const input = { qitemId: parked.qitemId, fromSession: worker, toSession: next, nudge: false };
        const { created } = verb === "handoff" ? await repo.handoff(input) : await repo.handoffAndComplete(input);
        expect(related(parked.qitemId)).toEqual([[created.qitemId, "handed-off-from"]]);
      }
      const after = repo.getById(parked.qitemId)!;
      expect(after.state).not.toBe("blocked");
      expect(after.blockedOn).toBe(ask.qitemId);
      expect(related(ask.qitemId)).toEqual([[parked.qitemId, "blocked-on"]]);
    });
});
