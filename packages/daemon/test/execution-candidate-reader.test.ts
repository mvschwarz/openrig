import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTransitionWakesSchema } from "../src/db/migrations/073_queue_transition_wakes.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { cooperativeReadFile, readRowsCooperatively } from "../src/domain/execution-candidate-reader.js";

const dirs: string[] = [];
const handles: Database.Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-candidate-"));
  dirs.push(dir);
  return path.join(dir, name);
}
function track<T extends Database.Database>(db: T): T { handles.push(db); return db; }
/** A WAL file with `n` rows t(id, v); `bad` makes one row's v malformed JSON. */
function walTable(n: number, bad?: number): { file: string; db: Database.Database } {
  const file = tempFile("t.sqlite");
  const db = track(createDb(file));
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const insert = db.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
  db.transaction(() => { for (let i = 1; i <= n; i++) insert.run(i, i === bad ? "{" : JSON.stringify({ a: i })); })();
  return { file, db };
}
/** The production readonly open, keeping the reader's handle so a test can see it was closed. (SQLite's unix VFS
 *  keeps a closed connection's descriptor while another connection holds a lock, so descriptors cannot show it.) */
function recordingOpen(): { open: (file: string) => Database.Database; readers: Database.Database[] } {
  const readers: Database.Database[] = [];
  return { readers, open: (file) => { const db = new Database(file, { readonly: true, fileMustExist: true }); readers.push(db); return db; } };
}
/** Counts event-loop turns until stopped: proof that other callbacks ran while a read was in progress. */
function turns(): { count: () => number; stop: () => void } {
  let count = 0, stopped = false;
  const spin = () => { if (stopped) return; count++; setImmediate(spin); };
  setImmediate(spin);
  return { count: () => count, stop: () => { stopped = true; } };
}

describe("cooperative candidate reads", () => {
  it("reads every row in order on its own connection, letting other callbacks run between slices", async () => {
    const { file } = walTable(500);
    const loop = turns(), reader = recordingOpen();
    const rows = await readRowsCooperatively<{ id: number }>(file, "SELECT id, v FROM t ORDER BY id", [], reader.open);
    loop.stop();
    expect(reader.readers.map((db) => [db.readonly, db.open])).toEqual([[true, false]]); // readonly, and closed before returning
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(loop.count()).toBeGreaterThan(1);
  });

  it("keeps one snapshot for the whole read while writers commit between slices; the next read sees them", async () => {
    const { file, db } = walTable(500);
    // Runs at the reader's first yield, after its cursor has started.
    setImmediate(() => db.transaction(() => {
      db.prepare("UPDATE t SET v = 'changed' WHERE id = 1").run();
      db.prepare("INSERT INTO t(id, v) VALUES (501, 'new')").run();
    })());
    const during = await readRowsCooperatively<{ id: number; v: string }>(file, "SELECT id, v FROM t ORDER BY id", []);
    expect(during).toHaveLength(500);
    expect(during[0]!.v).toBe(JSON.stringify({ a: 1 }));
    const after = await readRowsCooperatively<{ id: number; v: string }>(file, "SELECT id, v FROM t ORDER BY id", []);
    expect(after).toHaveLength(501);
    expect(after[0]!.v).toBe("changed");
  });

  it("rethrows a native error raised mid-read, returns nothing, and leaves no reader pinning the WAL", async () => {
    const { file, db } = walTable(500, 300);
    const reader = recordingOpen();
    const read = readRowsCooperatively(file, "SELECT json_extract(v, '$.a') AS a FROM t ORDER BY id", [], reader.open);
    await expect(read).rejects.toMatchObject({ name: "SqliteError", code: "SQLITE_ERROR" });
    expect(reader.readers.map((db) => db.open)).toEqual([false]);
    db.prepare("INSERT INTO t(id, v) VALUES (501, '{}')").run();
    expect(db.pragma("wal_checkpoint(TRUNCATE)")).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]);
    db.prepare("DELETE FROM t WHERE id = 300").run();
    expect(await readRowsCooperatively(file, "SELECT json_extract(v, '$.a') AS a FROM t ORDER BY id", [])).toHaveLength(500);
  });

  it("stays on the main handle inside a transaction and for memory or non-WAL databases", () => {
    const { file, db } = walTable(1);
    expect(cooperativeReadFile(db)).toBe(fs.realpathSync(file));
    db.transaction(() => { expect(cooperativeReadFile(db)).toBeNull(); })();
    expect(cooperativeReadFile(track(createDb()))).toBeNull();
    const rollback = track(new Database(tempFile("delete.sqlite")));
    rollback.exec("CREATE TABLE t(id INTEGER)");
    expect(rollback.pragma("journal_mode", { simple: true })).toBe("delete");
    expect(cooperativeReadFile(rollback)).toBeNull();
  });
});

describe("the projector's execution queue", () => {
  const NOW = new Date("2026-10-25T12:00:00.000Z");
  function fixture(file?: string) {
    const db = track(file ? createDb(file) : createDb());
    migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, queueItemSummarySchema, queueItemsSchema, queueTransitionsSchema, queueTransitionWakesSchema, viewsCustomSchema]);
    return db;
  }
  const insertRow = (db: Database.Database, id: string, state: string, tags: string[], body: string, claimedAt: string | null = "2026-10-25T11:00:00.000Z") =>
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body, claimed_at, last_heartbeat, blocked_on)
      VALUES (?, '2026-10-25T10:00:00.000Z', '2026-10-25T10:00:00.000Z', 'lead@r', 'builder@r', ?, 'normal', 'light', ?, ?, ?, NULL, ?)`)
      .run(id, state, JSON.stringify(tags), body, claimedAt, state === "blocked" ? "external:review" : null);
  const laneIds = (doc: Record<string, unknown>) => (doc.q1_lanes as Array<{ qitem_id: string }>).map((l) => l.qitem_id).sort();
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("builds one execution at a time in arrival order, each reading fresh, and a failed build does not block the next", async () => {
    const db = fixture(tempFile("queue.sqlite"));
    insertRow(db, "qitem-a", "in-progress", ["slice:S1"], "Lane A.\nworktree_path=/nowhere/a\n");
    let started = 0, failNext = false, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gitCalls = 0;
    const projector = new ViewProjector(db, new EventBus(db), { now: () => NOW });
    projector.setExecutionDeps({
      db, now: () => NOW, rigsRoot: () => tempFile("rigs"),
      slicesRoot: () => { started++; if (failNext) { failNext = false; throw new Error("slices root unreadable"); } return null; },
      exec: async () => { if (++gitCalls === 1) await gate; throw new Error("not a repository"); },
    });
    const first = projector.show("execution");
    while (gitCalls === 0) await tick();
    const second = projector.show("execution");
    for (let i = 0; i < 20; i++) await tick();
    expect(started).toBe(1); // the second build waits for the whole first build, Git awaits included
    insertRow(db, "qitem-b", "in-progress", ["slice:S2"], "Lane B.");
    release();
    expect(laneIds((await first).rows[0] as Record<string, unknown>)).toEqual(["qitem-a"]);
    expect(laneIds((await second).rows[0] as Record<string, unknown>)).toEqual(["qitem-a", "qitem-b"]); // read when admitted
    failNext = true;
    await expect(projector.show("execution")).rejects.toThrow("slices root unreadable");
    expect((await projector.show("execution")).rowCount).toBe(1);
    expect(started).toBe(4);
  });

  it("runs a caller's build inside its transaction at once, seeing its uncommitted rows", async () => {
    const db = fixture(tempFile("tx.sqlite"));
    const projector = new ViewProjector(db, new EventBus(db), { now: () => NOW });
    projector.setExecutionDeps({ db, now: () => NOW, slicesRoot: () => null, rigsRoot: () => tempFile("rigs"), exec: async () => { throw new Error("not a repository"); } });
    let pending!: ReturnType<ViewProjector["show"]>;
    expect(() => db.transaction(() => {
      insertRow(db, "qitem-uncommitted", "in-progress", ["slice:S1"], "Never committed.");
      pending = projector.show("execution");
      throw new Error("roll back");
    })()).toThrow("roll back");
    expect(db.prepare("SELECT COUNT(*) AS n FROM queue_items").get()).toEqual({ n: 0 });
    // The candidate read ran synchronously inside the transaction, before the rollback.
    expect(laneIds((await pending).rows[0] as Record<string, unknown>)).toEqual(["qitem-uncommitted"]);
  });

  it("returns the same document from a WAL file's cooperative read as from the main-handle read", async () => {
    const seed = (db: Database.Database) => db.transaction(() => {
      for (let i = 0; i < 200; i++) {
        const state = ["in-progress", "done", "blocked", "pending", "handed-off"][i % 5]!;
        insertRow(db, `qitem-${String(i).padStart(3, "0")}`, state, [`slice:S${i % 7}`, "mission:m1"], `Row ${i} é.${i % 11 === 0 ? `\nworktree_path=/nowhere/${i}\n` : ""}`, i % 3 ? "2026-10-25T11:00:00.000Z" : null);
        db.prepare("INSERT INTO queue_transitions (qitem_id, ts, state, transition_note, actor_session) VALUES (?, '2026-10-25T11:30:00.000Z', 'in-progress', 'progress', 'builder@r')").run(`qitem-${String(i).padStart(3, "0")}`);
      }
    })();
    const documentOf = async (db: Database.Database) => {
      const projector = new ViewProjector(db, new EventBus(db), { now: () => NOW });
      projector.setExecutionDeps({ db, now: () => NOW, slicesRoot: () => null, rigsRoot: () => "/nonexistent-rigs-root", exec: async () => { throw new Error("not a repository"); } });
      return (await projector.show("execution")).rows[0];
    };
    const memory = fixture(), file = fixture(tempFile("parity.sqlite"));
    seed(memory); seed(file);
    expect(cooperativeReadFile(memory)).toBeNull();
    expect(cooperativeReadFile(file)).not.toBeNull();
    // The free-disk reading is taken live at read time (fs.statfsSync); every other field must match.
    const withoutLiveDisk = (doc: unknown) => {
      const copy = structuredClone(doc) as { q6_parallelism?: { df_margin?: { available_kib?: unknown } } };
      if (copy.q6_parallelism?.df_margin) delete copy.q6_parallelism.df_margin.available_kib;
      return copy;
    };
    const legacy = await documentOf(memory);
    expect(withoutLiveDisk(await documentOf(file))).toEqual(withoutLiveDisk(legacy));
    expect((legacy as { q1_lanes: unknown[] }).q1_lanes.length).toBeGreaterThan(0);
  });
});
