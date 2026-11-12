// A queue listing builds ONE recovery index (withRecoveryIndex) instead of one json_each scan of every
// recovery-tagged row per listed row, and findQueueRecovery still chooses exactly the row the query chooses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RECOVERY_INDEX_SQL, findQueueRecovery, recoveryTag, withRecoveryIndex } from "../src/domain/queue-recovery.js";

describe("withRecoveryIndex: one recovery index per listing", () => {
  let db: Database.Database, repo: QueueRepository;
  const at = "2026-10-09T10:00:00.000Z";
  function row(id: string, state = "done", tags: string | null = "[]", updated = at, destination = "worker@r") {
    db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body)
      VALUES (?, ?, ?, 'sender@r', ?, ?, ?, 'body')`).run(id, at, updated, destination, state, tags);
  }
  const indexBuilds = (run: () => unknown): number => {
    const prepare = db.prepare.bind(db); let n = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => { if (sql === RECOVERY_INDEX_SQL) n++; return prepare(sql); });
    try { run(); } finally { spy.mockRestore(); }
    return n;
  };
  const recoveryLookups = (run: () => unknown): number => {
    const prepare = db.prepare.bind(db); let n = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      // the per-row recovery lookup (findQueueRecovery's query), not the cheap per-qitem tag checks
      if (sql.includes("json_each(tags) WHERE value = ?") && sql.includes("qitem_id DESC LIMIT 1")) n++;
      return prepare(sql);
    });
    try { run(); } finally { spy.mockRestore(); }
    return n;
  };

  beforeEach(() => {
    db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it("chooses the same recovery row as the query, for every ordering and excludeTag case", () => {
    row("qitem-a", "pending"); row("qitem-b", "pending"); row("qitem-c", "pending"); row("qitem-d", "pending");
    // a: an active recovery beats a newer closed one; b: the newest of two closed; c: excludeTag skips one;
    // d: escaped JSON text (the LIKE '%\%' arm) and an object-shaped tags value; e: no recovery at all
    row("rec-a1", "done", JSON.stringify([recoveryTag("qitem-a")]), "2026-10-09T12:00:00.000Z");
    row("rec-a2", "in-progress", JSON.stringify([recoveryTag("qitem-a")]), "2026-10-09T11:00:00.000Z");
    row("rec-b1", "done", JSON.stringify([recoveryTag("qitem-b")]), "2026-10-09T11:00:00.000Z");
    row("rec-b2", "done", JSON.stringify([recoveryTag("qitem-b")]), "2026-10-09T13:00:00.000Z");
    row("rec-c1", "blocked", JSON.stringify([recoveryTag("qitem-c"), "prompt-alert"]), "2026-10-09T14:00:00.000Z");
    row("rec-c2", "blocked", JSON.stringify([recoveryTag("qitem-c")]), "2026-10-09T12:00:00.000Z");
    row("rec-d1", "pending", `["recovery-for:qitem-\\u0064"]`, "2026-10-09T12:00:00.000Z");
    row("rec-d2", "pending", JSON.stringify({ k: recoveryTag("qitem-d") }), "2026-10-09T13:00:00.000Z");
    row("rec-x", "pending", "not json", "2026-10-09T15:00:00.000Z");
    const ids = ["qitem-a", "qitem-b", "qitem-c", "qitem-d", "qitem-e"];
    const asks: Array<string | undefined> = [undefined, "prompt-alert", "slack-undeliverable"];
    const before = ids.flatMap((id) => asks.map((ex) => findQueueRecovery(db, id, ex)));
    const inside = withRecoveryIndex(db, () => ids.flatMap((id) => asks.map((ex) => findQueueRecovery(db, id, ex))));
    expect(inside).toEqual(before);
    expect(before.map((r) => r?.qitemId ?? null).filter((_, i) => i % 3 === 0)).toEqual(["rec-a2", "rec-b2", "rec-c1", "rec-d2", null]);
    expect(before[7]?.qitemId).toBe("rec-c2"); // qitem-c with excludeTag prompt-alert
  });

  it("matches json_each on a duplicated object key and keeps the query's truthy excludeTag ('')", () => {
    row("qitem-k", "pending"); row("qitem-z", "pending");
    // json_each sees both values of a duplicated key (JSON.parse would keep only the last one)
    row("rec-k", "pending", `{"k":"${recoveryTag("qitem-k")}","k":"other"}`, "2026-10-09T12:00:00.000Z");
    row("rec-z", "pending", JSON.stringify([recoveryTag("qitem-z"), ""]), "2026-10-09T12:00:00.000Z");
    const asks: Array<[string, string | undefined]> = [["qitem-k", undefined], ["qitem-k", "other"], ["qitem-z", ""], ["qitem-z", undefined]];
    const before = asks.map(([id, ex]) => findQueueRecovery(db, id, ex));
    expect(before.map((r) => r?.qitemId ?? null)).toEqual(["rec-k", null, "rec-z", "rec-z"]);
    expect(withRecoveryIndex(db, () => asks.map(([id, ex]) => findQueueRecovery(db, id, ex)))).toEqual(before);
  });

  it("compares nested arrays and objects as their JSON text, like the query's value = ?", () => {
    row("qitem-n1", "pending"); row("qitem-n2", "pending");
    row("rec-n1", "pending", JSON.stringify([recoveryTag("qitem-n1"), ["nested"]]), "2026-10-09T12:00:00.000Z");
    row("rec-n2", "pending", JSON.stringify([recoveryTag("qitem-n2"), { k: "v" }]), "2026-10-09T12:00:00.000Z");
    const asks: Array<[string, string | undefined]> = [["qitem-n1", '["nested"]'], ["qitem-n2", '{"k":"v"}'], ["qitem-n1", undefined]];
    const before = asks.map(([id, ex]) => findQueueRecovery(db, id, ex));
    expect(before.map((r) => r?.qitemId ?? null)).toEqual([null, null, "rec-n1"]);
    expect(withRecoveryIndex(db, () => asks.map(([id, ex]) => findQueueRecovery(db, id, ex)))).toEqual(before);
  });

  it("builds the index lazily: a compact listing never builds it, a full one once, nested calls share it", () => {
    for (let i = 0; i < 5; i++) {
      row(`qitem-${i}`, "pending", "[]", at, "orq@r");
      row(`rec-${i}`, "done", JSON.stringify([recoveryTag(`qitem-${i}`)]));
    }
    expect(indexBuilds(() => repo.list({ destinationSession: "orq@r", state: ["pending"], limit: 1000, compact: true }))).toBe(0);
    expect(indexBuilds(() => repo.list({ destinationSession: "orq@r", state: ["pending"], limit: 1000 }))).toBe(1);
    expect(indexBuilds(() => withRecoveryIndex(db, () => {
      findQueueRecovery(db, "qitem-0");
      withRecoveryIndex(db, () => findQueueRecovery(db, "qitem-1"));
    }))).toBe(1);
    expect(indexBuilds(() => withRecoveryIndex(db, () => null))).toBe(0);
  });

  it("a listing reads the recovery rows once, not once per listed row", () => {
    for (let i = 0; i < 30; i++) {
      row(`qitem-${i}`, "pending", "[]", at, "orq@r");
      row(`rec-${i}`, "done", JSON.stringify([recoveryTag(`qitem-${i}`)]));
    }
    const outside = recoveryLookups(() => { for (let i = 0; i < 30; i++) findQueueRecovery(db, `qitem-${i}`); });
    expect(outside).toBe(30);
    const listing = recoveryLookups(() => repo.list({ destinationSession: "orq@r", state: ["pending"], limit: 1000 }));
    expect(listing).toBe(0);
  });

  it("is scoped to the call: after it, a new recovery row is seen at once; nested calls reuse the index", () => {
    row("qitem-n", "pending");
    withRecoveryIndex(db, () => {
      expect(findQueueRecovery(db, "qitem-n")).toBeNull();
      expect(withRecoveryIndex(db, () => findQueueRecovery(db, "qitem-n"))).toBeNull();
    });
    row("rec-n", "pending", JSON.stringify([recoveryTag("qitem-n")]));
    expect(findQueueRecovery(db, "qitem-n")?.qitemId).toBe("rec-n");
    expect(withRecoveryIndex(db, () => findQueueRecovery(db, "qitem-n"))?.qitemId).toBe("rec-n");
  });

  it("another database never reads this one's index", () => {
    const other = new Database(":memory:"); migrate(other, ALL_MIGRATIONS);
    try {
      row("qitem-o", "pending"); row("rec-o", "pending", JSON.stringify([recoveryTag("qitem-o")]));
      withRecoveryIndex(db, () => expect(findQueueRecovery(other, "qitem-o")).toBeNull());
    } finally { other.close(); }
  });
});
