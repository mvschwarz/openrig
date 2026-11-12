import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueListOptions } from "../src/domain/queue-repository.js";
import { RECOVERY_INDEX_SQL } from "../src/domain/queue-recovery.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";

describe("bounded queue lists use their ordering indexes", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    const insert = db.prepare(`INSERT INTO queue_items
      (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, tags)
      VALUES (?, ?, ?, 'sender@r', 'worker@r', ?, ?, ?)`);
    db.transaction(() => {
      for (let i = 0; i < 240; i++) {
        // Equal timestamps across states exercise the existing scan's tie order too.
        const ts = new Date(Date.UTC(2026, 10, 12, 0, 0, Math.floor(i / 3))).toISOString();
        const tags = i % 7 === 0 ? ["first", "second"] : i % 2 ? ["first"] : ["second"];
        insert.run(`q-${i}`, ts, ts, ["pending", "done", "blocked"][i % 3], "body".repeat(256), JSON.stringify(tags));
      }
    })();
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  function selection(options: QueueListOptions) {
    const prepare = db.prepare.bind(db);
    let selected: { sql: string; args: unknown[] } | undefined;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (/^SELECT (?:\*|qitem_id,).* FROM queue_items\s+(?:WHERE\b|ORDER BY\b)/s.test(sql)) {
        const all = statement.all.bind(statement);
        statement.all = (...args: unknown[]) => { selected = { sql, args }; return all(...args); };
      }
      return statement;
    });
    let ids: string[];
    try { ids = repo.list(options).map((item) => item.qitemId); }
    finally { spy.mockRestore(); }
    expect(selected).toBeDefined();
    const { sql, args } = selected!;
    const legacy = prepare(sql.replace("FROM queue_items", "FROM queue_items NOT INDEXED"))
      .all(...args) as Array<{ qitem_id: string }>;
    expect(ids).toEqual(legacy.map((row) => row.qitem_id));
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>;
    return { ids, details: plan.map((row) => row.detail).join("\n") };
  }

  it.each([false, true])("does not scan and sort all rows for a bounded list (compact=%s)", (compact) => {
    const { ids, details } = selection({ compact, limit: 6 });
    expect(ids).toHaveLength(6);
    expect(details).toContain("USING INDEX");
    expect(details).not.toContain("TEMP B-TREE");
  });

  it.each([false, true])("keeps active rows first without sorting all rig history (compact=%s)", (compact) => {
    const { ids, details } = selection({ rig: "r", compact, limit: 6 });
    expect(ids).toHaveLength(6);
    expect(details).toContain("USING INDEX");
    expect(details).not.toContain("TEMP B-TREE");
  });

  it.each([false, true])("keeps scoped update-time ordering indexed (compact=%s)", (compact) => {
    const { ids, details } = selection({ rig: "r", sortByUpdated: true, compact, limit: 6 });
    expect(ids).toHaveLength(6);
    expect(details).toContain("USING INDEX");
    expect(details).not.toContain("TEMP B-TREE");
  });

  it("looks for owner notifications without reading ordinary live or archived transitions", () => {
    const log = new QueueTransitionLog(db);
    const prepare = db.prepare.bind(db);
    let query = "";
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("ROW_NUMBER()") && sql.includes("owner_notification_level IS NOT NULL")) query = sql;
      return prepare(sql);
    });
    try { expect(log.ownerNotificationsForQitems(["q-0"])).toEqual(new Map()); }
    finally { spy.mockRestore(); }
    expect(query).not.toBe("");
    const plan = prepare(`EXPLAIN QUERY PLAN ${query}`).all(JSON.stringify(["q-0"])) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_queue_transitions_owner_notification_qitem");
    expect(details).toContain("idx_queue_transitions_archive_owner_notification_qitem");
  });

  it("still applies both exact tags before the bound, including zero and unbounded limits", () => {
    for (const limit of [0, 1, 6, -1]) {
      const { ids } = selection({ rig: "r", tag: ["first", "second"], limit });
      expect(ids.every((id) => Number(id.slice(2)) % 7 === 0)).toBe(true);
      expect(ids).toHaveLength(limit < 0 ? 35 : Math.min(limit, 35));
    }
  });

  it("keeps recovery lookup on its small partial index when listing indexes exist", () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${RECOVERY_INDEX_SQL}`).all() as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("idx_queue_items_recovery_tags"))).toBe(true);
  });
});
