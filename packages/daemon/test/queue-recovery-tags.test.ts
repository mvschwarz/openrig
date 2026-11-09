// queue_recovery_tags (migration 156): the exact-tag lookup of findQueueRecovery and of the stuck sweep's dedup, kept
// equal to queue_items by triggers whoever writes, so a lookup by tag can be a search and not a parse of every tagged row.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { findQueueRecovery, recoveryLiveSql, recoveryTag } from "../src/domain/queue-recovery.js";
import { runStuckSweep, STUCK_SWEEP_DEDUP_SQL } from "../src/domain/queue-stuck-sweep.js";
import { migrationsForFullTestDb } from "./helpers/test-app.js";

let db: Database.Database;
let repo: QueueRepository;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;
beforeEach(() => {
  db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function insert(target: Database.Database, id: string, o: Record<string, string | null>) {
  const cols = { ts_created: iso(3 * 60 * MIN), ts_updated: iso(MIN), source_session: "sender@r", destination_session: "worker@r",
    state: "pending", tags: "[]", body: "b", ...o };
  target.prepare(`INSERT INTO queue_items(qitem_id, ${Object.keys(cols).join(", ")}) VALUES (?, ${Object.keys(cols).map(() => "?").join(", ")})`)
    .run(id, ...Object.values(cols));
}
/** The table as queue_items' tags say it should be: every top-level text value of valid JSON tags with a kept prefix. */
function expected(target: Database.Database): string[] {
  return (target.prepare(`SELECT j.value || ' ' || q.qitem_id AS k FROM queue_items q,
      json_each(CASE WHEN json_valid(q.tags) THEN q.tags ELSE '[]' END) j
     WHERE typeof(j.value) = 'text' AND (j.value GLOB 'recovery-for:*' OR j.value GLOB 'stuck-sweep:*') ORDER BY k`)
    .all() as Array<{ k: string }>).map((r) => r.k);
}
const actual = (target: Database.Database) => (target.prepare("SELECT tag || ' ' || qitem_id AS k FROM queue_recovery_tags ORDER BY k")
  .all() as Array<{ k: string }>).map((r) => r.k);

/** Rows written every way the daemon writes tags: create, a bare UPDATE of tags (no ts_updated), invalid JSON, escapes,
 *  a scalar JSON string, non-text values, a renamed id, a delete. */
async function writes() {
  insert(db, "rec-open", { tags: JSON.stringify(["x", recoveryTag("qitem-a"), "stuck-sweep:overdue-claim:qitem-a"]), ts_updated: iso(30 * MIN) });
  insert(db, "rec-done", { state: "done", tags: JSON.stringify([recoveryTag("qitem-a"), "slack-undeliverable"]), ts_updated: iso(5 * MIN) });
  insert(db, "rec-escaped", { state: "done", tags: '["recovery\\u002dfor:qitem-b", "stuck\\u002dsweep:unclaimed-obligation:qitem-b"]', ts_updated: iso(4 * MIN) });
  insert(db, "rec-scalar", { state: "done", tags: JSON.stringify(recoveryTag("qitem-c")), ts_updated: iso(3 * MIN) });
  insert(db, "rec-bad", { tags: `["${recoveryTag("qitem-a")}"`, ts_updated: iso(MIN) });
  insert(db, "rec-num", { tags: JSON.stringify([7, { v: recoveryTag("qitem-a") }, ["recovery-for:qitem-a"]]) });
  insert(db, "rec-case", { tags: JSON.stringify(["RECOVERY-FOR:qitem-a"]) });
  insert(db, "rec-null", { tags: null });
  const created = await repo.create({ sourceSession: "sender@r", destinationSession: "worker@r", body: "f", tags: ["prompt-alert", recoveryTag("qitem-c")] });
  // the wake ladder's bare UPDATE: tags change, ts_updated does not
  db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify(["x", recoveryTag("qitem-a"), recoveryTag("qitem-d")]), "rec-case");
  db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run("{broken", "rec-done");
  db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify([recoveryTag("qitem-a")]), "rec-bad");
  db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify(["stuck-sweep:unclaimed-obligation:qitem-e"]), "rec-null");
  db.prepare("UPDATE queue_items SET qitem_id = ? WHERE qitem_id = ?").run("rec-renamed", "rec-open");
  repo.update({ qitemId: created.qitemId, actorSession: "worker@r", state: "done", closureReason: "no-follow-on" });
  insert(db, "rec-gone", { tags: JSON.stringify([recoveryTag("qitem-d")]) });
  db.prepare("DELETE FROM queue_items WHERE qitem_id = ?").run("rec-gone");
  return created.qitemId;
}

describe("queue_recovery_tags", () => {
  it("stays equal to what queue_items' tags say through creates, bare tag updates, invalid JSON, renames and deletes", async () => {
    const created = await writes();
    expect(actual(db)).toEqual(expected(db));
    expect(actual(db)).toEqual(expect.arrayContaining([
      "stuck-sweep:unclaimed-obligation:qitem-b rec-escaped", // escapes decoded, as json_each reads them
      "recovery-for:qitem-c rec-scalar", // a scalar JSON string
      `recovery-for:qitem-c ${created}`, // the repository's own create
      "recovery-for:qitem-d rec-case", // a bare UPDATE of tags
      "stuck-sweep:unclaimed-obligation:qitem-e rec-null", // NULL tags given a value later
      "recovery-for:qitem-a rec-renamed",
    ]));
    for (const gone of [" rec-gone", " rec-done", " rec-num", " rec-open"]) {
      expect(actual(db).some((k) => k.endsWith(gone)), gone).toBe(false);
    }
  });

  it("is filled from the rows already there when the migration runs", () => {
    const old = new Database(":memory:");
    try {
      migrate(old, ALL_MIGRATIONS.filter((m) => m.name !== "156_queue_recovery_tags.sql"));
      expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'queue_recovery_tags'").get()).toBeUndefined();
      insert(old, "r1", { tags: JSON.stringify([recoveryTag("qitem-a"), "stuck-sweep:parked-owner-no-input:qitem-a", "x"]) });
      insert(old, "r2", { tags: '["recovery\\u002dfor:qitem-b"]' });
      insert(old, "r3", { tags: "{nope" });
      insert(old, "r4", { tags: JSON.stringify(["plain"]) });
      insert(old, "r5", { tags: null });
      migrate(old, ALL_MIGRATIONS);
      expect(actual(old)).toEqual(expected(old));
      expect(actual(old)).toHaveLength(3);
      // and kept from then on
      insert(old, "r6", { tags: JSON.stringify([recoveryTag("qitem-f")]) });
      expect(actual(old)).toEqual(expected(old));
    } finally { old.close(); }
  });

  it("is on the shared full test fixture, so a fixture-backed queue keeps it too", () => {
    const fixture = new Database(":memory:");
    try {
      migrate(fixture, migrationsForFullTestDb);
      insert(fixture, "f1", { tags: JSON.stringify([recoveryTag("qitem-a")]) });
      expect(actual(fixture)).toEqual(["recovery-for:qitem-a f1"]);
    } finally { fixture.close(); }
  });

  it("is searched by tag, and the triggers' deletes by queue row are searches too", () => {
    const plan = (sql: string, ...params: string[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail);
    const byTag = plan("SELECT qitem_id FROM queue_recovery_tags WHERE tag = ?", "recovery-for:q");
    expect(byTag.some((d) => /^SEARCH queue_recovery_tags USING (PRIMARY KEY|COVERING INDEX)/.test(d)), byTag.join("\n")).toBe(true);
    const byRow = plan("DELETE FROM queue_recovery_tags WHERE qitem_id = ?", "q");
    expect(byRow.some((d) => /^SEARCH queue_recovery_tags USING (COVERING )?INDEX idx_queue_recovery_tags_qitem/.test(d)), byRow.join("\n")).toBe(true);
  });
});

/** findQueueRecovery's live read before the table, for the comparison. */
const LEGACY = (exclude: boolean) => `SELECT qitem_id, state, ts_updated FROM queue_items
  WHERE (tags LIKE '%"recovery-for:%' OR tags LIKE '%\\%') AND json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
  ${exclude ? "AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)" : ""}
  ORDER BY CASE WHEN state IN ('pending','in-progress','blocked') THEN 0 ELSE 1 END, ts_updated DESC, qitem_id DESC LIMIT 1`;
const legacy = (id: string, exclude?: string) => (db.prepare(LEGACY(!!exclude)).get(...(exclude ? [recoveryTag(id), exclude] : [recoveryTag(id)])) as
  { qitem_id: string } | undefined)?.qitem_id ?? null;
const live = (id: string, exclude?: string) => (db.prepare(recoveryLiveSql(!!exclude)).get(...(exclude ? [recoveryTag(id), exclude] : [recoveryTag(id)])) as
  { qitem_id: string } | undefined)?.qitem_id ?? null;

describe("the readers of queue_recovery_tags", () => {
  it("findQueueRecovery's live read answers as the json_each read did, with and without excludeTag", async () => {
    await writes();
    for (const id of ["qitem-a", "qitem-b", "qitem-c", "qitem-d", "qitem-e", "qitem-none"]) {
      for (const exclude of [undefined, "x", "slack-undeliverable", "prompt-alert", recoveryTag(id), "stuck-sweep:overdue-claim:qitem-a"]) {
        expect(live(id, exclude), `${id} without ${exclude}`).toBe(legacy(id, exclude));
      }
    }
    const prepare = db.prepare.bind(db); const used: string[] = [];
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => { used.push(sql); return prepare(sql); });
    expect(findQueueRecovery(db, "qitem-a")?.qitemId ?? null).toBe(legacy("qitem-a"));
    findQueueRecovery(db, "qitem-a", "x");
    expect(used).toEqual(expect.arrayContaining([recoveryLiveSql(false), recoveryLiveSql(true)]));
    expect(live("qitem-b")).toBe("rec-escaped");
  });

  it("the live recovery read and the sweep's dedup read search the table: neither scans queue_items or its tag index", () => {
    const plans = [[recoveryLiveSql(false), ["recovery-for:q"]], [recoveryLiveSql(true), ["recovery-for:q", "x"]],
      [STUCK_SWEEP_DEDUP_SQL, ["stuck-sweep:overdue-claim:q"]]] as const;
    for (const [sql, params] of plans) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail);
      expect(plan.some((d) => /^SEARCH t USING (PRIMARY KEY|COVERING INDEX)/.test(d)), plan.join("\n")).toBe(true);
      expect(plan.filter((d) => /^SCAN (q|queue_items|t)\b/.test(d)), plan.join("\n")).toEqual([]);
    }
  });

  it("the sweep looks up an existing finding by its dedup tag through the table, and still refreshes it", async () => {
    insert(db, "qitem-u1", { ts_updated: iso(3 * 60 * MIN), ts_created: iso(3 * 60 * MIN) }); // unclaimed
    const first = await runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null });
    expect(first.findings.map((f) => f.action)).toEqual(["created"]);
    const prepare = db.prepare.bind(db); let dedupReads = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => { if (sql === STUCK_SWEEP_DEDUP_SQL) dedupReads++; return prepare(sql); });
    // the finding's own recovery tag holds the row: its custody is shared, so drop it to reach the dedup read
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?")
      .run(JSON.stringify(["stuck-sweep-finding", "stuck-sweep:unclaimed-obligation:qitem-u1"]), first.findings[0]!.findingQitemId);
    const second = await runStuckSweep({ db, queueRepo: repo, log: () => {}, resolveOrchestrator: () => null });
    expect(second.findings).toEqual([expect.objectContaining({ action: "refreshed", findingQitemId: first.findings[0]!.findingQitemId })]);
    expect(dedupReads).toBe(1);
  });
});

describe("the sweep's dedup read with and without queue_recovery_tags", () => {
  /** A stuck row whose id has a LIKE wildcard, and an open finding for another row that the wildcard (and case) match. */
  async function dedupOf(target: Database.Database): Promise<Array<[string, string]>> {
    const queue = new QueueRepository(target, new EventBus(target), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    insert(target, "qitem_u1", { ts_updated: iso(3 * 60 * MIN), ts_created: iso(3 * 60 * MIN) }); // unclaimed
    insert(target, "rec-other", { ts_created: iso(MIN), ts_updated: iso(MIN), destination_session: "lead@r",
      tags: JSON.stringify(["stuck-sweep-finding", "stuck-sweep:unclaimed-obligation:QITEMxU1"]) });
    const result = await runStuckSweep({ db: target, queueRepo: queue, log: () => {}, resolveOrchestrator: () => null });
    return result.findings.filter((f) => f.qitemId === "qitem_u1").map((f) => [f.action, f.findingQitemId === "rec-other" ? "rec-other" : "new"]);
  }

  it("with the table, the dedup tag matches exactly; without it, the LIKE read also matched `_` as a wildcard and other case", async () => {
    // the table: only the finding whose tag is exactly the stuck row's dedup tag counts, so the row gets its own
    expect(await dedupOf(db)).toEqual([["created", "new"]]);
    // a database without the table keeps the LIKE read, where `_` is any character and ASCII case is ignored: it takes
    // another row's finding as this row's. The sweep's ids (qitem-<time>-<hex>) have neither, so the two agree on them.
    const old = new Database(":memory:");
    try {
      migrate(old, ALL_MIGRATIONS.filter((m) => m.name !== "156_queue_recovery_tags.sql"));
      expect(await dedupOf(old)).toEqual([["refreshed", "rec-other"]]);
    } finally { old.close(); }
  });
});
