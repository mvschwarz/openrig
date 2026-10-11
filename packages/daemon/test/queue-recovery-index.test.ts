// Migration 099: the recovery and dedup lookups read idx_queue_items_recovery_tags instead of scanning
// and parsing every queue row, and still choose exactly the row the unindexed queries chose.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { findQueueRecovery, recoveryTag } from "../src/domain/queue-recovery.js";
import { createStuckSweepStatus, runStuckSweep } from "../src/domain/queue-stuck-sweep.js";

const INDEX = "idx_queue_items_recovery_tags";
// The pre-099 statement, kept here as the reference the new one must agree with.
const UNINDEXED = `SELECT qitem_id, state, ts_updated FROM queue_items
  WHERE json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
  ORDER BY CASE WHEN state IN ('pending','in-progress','blocked') THEN 0 ELSE 1 END, ts_updated DESC, qitem_id DESC LIMIT 1`;

describe("recovery and dedup lookups use the partial tag index (migration 099)", () => {
  let db: Database.Database, repo: QueueRepository;
  const at = "2026-10-09T10:00:00.000Z";
  function row(id: string, state = "done", tags: string | null = "[]", updated = at) {
    db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body)
      VALUES (?, ?, ?, 'sender@r', 'worker@r', ?, ?, 'body')`).run(id, at, updated, state, tags);
  }
  /** The SQL a call prepared that matches `pick`, so the assertion reads the statement actually used. */
  function preparedDuring(pick: (sql: string) => boolean, run: () => unknown): string[] {
    const prepare = db.prepare.bind(db); const seen: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => { if (pick(sql)) seen.push(sql); return prepare(sql); });
    try { run(); } finally { spy.mockRestore(); }
    return seen;
  }
  const plan = (sql: string, ...args: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
  const isRecoveryLookup = (sql: string) => sql.includes("json_each(tags) WHERE value = ?") && sql.includes("qitem_id DESC LIMIT 1");

  beforeEach(() => {
    db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it("findQueueRecovery's statement reads the index rather than scanning queue_items", () => {
    row("source", "pending");
    const [sql] = preparedDuring(isRecoveryLookup, () => findQueueRecovery(db, "source"));
    expect(sql).toBeDefined();
    expect(plan(sql!, recoveryTag("source"))).toContain(INDEX);
    expect(plan(sql!, recoveryTag("source"))).not.toMatch(/SCAN queue_items(?! USING)/);
  });

  it("the projection path (getById of a pending row, and so list and whoami) reads the index", () => {
    row("source", "pending");
    const seen = preparedDuring(isRecoveryLookup, () => repo.getById("source"));
    expect(seen.length).toBeGreaterThan(0);
    for (const sql of seen) expect(plan(sql, recoveryTag("source"))).toContain(INDEX);
  });

  it("the stuck sweep's dedup lookup reads the index", async () => {
    row("stuck", "pending");
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = 'stuck'").run(new Date(Date.now() - 3 * 3_600_000).toISOString());
    const prepare = db.prepare.bind(db); const seen: string[] = [];
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => { if (sql.includes("tags LIKE ?") && sql.includes("ts_created DESC")) seen.push(sql); return prepare(sql); });
    await runStuckSweep({ db, queueRepo: repo, status: createStuckSweepStatus(), resolveOrchestrator: () => null,
      isRegisteredHost: () => false, unclaimedAgeMinutes: 60, log: () => {} });
    vi.restoreAllMocks();
    expect(seen.length).toBeGreaterThan(0);
    expect(plan(seen[0]!, `%"stuck-sweep:unclaimed-obligation:stuck"%`)).toContain(INDEX);
  });

  it("finds a recovery tag the wake ladder appends to an existing row", () => {
    row("source", "pending"); row("aggregate", "pending", JSON.stringify(["wake-escalation", "wake-escalation:dest"]));
    expect(findQueueRecovery(db, "source")).toBeNull();
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = 'aggregate'")
      .run(JSON.stringify(["wake-escalation", "wake-escalation:dest", recoveryTag("source")]));
    expect(findQueueRecovery(db, "source")).toEqual({ qitemId: "aggregate", state: "pending" });
  });

  it("finds a user-created row carrying the tag, whatever its id", async () => {
    row("source", "pending");
    const created = await repo.create({ sourceSession: "person@r", destinationSession: "worker@r", body: "by hand", tags: ["note", recoveryTag("source")], nudge: false });
    expect(findQueueRecovery(db, "source")).toEqual({ qitemId: created.qitemId, state: "pending" });
  });

  it.each([
    ["plain id, verbatim tag", "source", (t: string) => JSON.stringify([t])],
    ["plain id, escaped storage", "source", (t: string) => JSON.stringify([t]).replace("recovery", "\\u0072ecovery")],
    ["plain id, object member", "source", (t: string) => JSON.stringify({ member: t })],
    ["id JSON must escape", "odd'\"\\\n%_ id", (t: string) => JSON.stringify([t])],
  ])("keeps exact decoded membership: %s", (_label, id, encode) => {
    row(id, "pending");
    row("substring", "pending", JSON.stringify([recoveryTag(id) + "suffix"]));
    row("malformed", "pending", "{"); row("null-tags", "pending", null);
    row("holder", "blocked", encode(recoveryTag(id)));
    expect(findQueueRecovery(db, id)).toEqual({ qitemId: "holder", state: "blocked" });
    expect(db.prepare(UNINDEXED).get(recoveryTag(id))).toMatchObject({ qitem_id: "holder" });
  });

  it("keeps open-before-closed, then newest, then highest id", () => {
    row("source", "pending");
    const tags = JSON.stringify([recoveryTag("source")]);
    row("z-closed-newest", "done", tags, "2026-10-09T12:00:00.000Z");
    row("a-open", "pending", tags, "2026-10-09T10:00:00.000Z");
    row("b-open", "blocked", tags, "2026-10-09T10:00:00.000Z");
    expect(findQueueRecovery(db, "source")).toEqual({ qitemId: "b-open", state: "blocked" });
    db.prepare("UPDATE queue_items SET ts_updated = '2026-10-09T11:00:00.000Z' WHERE qitem_id = 'a-open'").run();
    expect(findQueueRecovery(db, "source")).toEqual({ qitemId: "a-open", state: "pending" });
  });

  it("chooses the same row as the unindexed query across mixed encodings, states and times", () => {
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const ids = Array.from({ length: 40 }, (_, i) => (i % 9 === 0 ? `odd"${i}\\` : `qitem-${i}`));
    const encodings = [(t: string[]) => JSON.stringify(t), (t: string[]) => JSON.stringify(t).replace(/recovery/g, "\\u0072ecovery"),
      (t: string[]) => JSON.stringify(Object.fromEntries(t.map((v, i) => [`k${i}`, v]))), () => "{not json", () => null];
    const states = ["pending", "in-progress", "blocked", "done", "canceled"];
    for (let i = 0; i < 400; i++) {
      const tags = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => (rnd() < 0.6 ? recoveryTag(ids[Math.floor(rnd() * ids.length)]!) : `stuck-sweep:k:${i}`));
      const encode = encodings[Math.floor(rnd() * encodings.length)]!;
      row(`r-${i}`, states[Math.floor(rnd() * states.length)]!, encode(tags), `2026-10-0${1 + Math.floor(rnd() * 8)}T00:00:00.000Z`);
    }
    const [indexed] = preparedDuring(isRecoveryLookup, () => findQueueRecovery(db, ids[1]!));
    let compared = 0;
    for (const id of [...ids, "absent"]) {
      const reference = db.prepare(UNINDEXED).get(recoveryTag(id)) as { qitem_id: string; state: string } | undefined;
      // The chosen row, open or closed, is identical; the later transition check is shared code.
      expect(db.prepare(indexed!).get(recoveryTag(id))).toEqual(reference);
      if (reference && ["pending", "in-progress", "blocked"].includes(reference.state)) {
        expect(findQueueRecovery(db, id)).toEqual({ qitemId: reference.qitem_id, state: reference.state });
      }
      compared++;
    }
    expect(compared).toBe(ids.length + 1);
  });
});
