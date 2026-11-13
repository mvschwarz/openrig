import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
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
import { buildExecutionView } from "../src/domain/execution-view.js";
import { configureSyncSiteRecorder, recordSlowDiagnostic } from "../src/domain/sync-site-wrap.js";

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

/** One window of t, the way the execution view binds its windows: exclusive lower and inclusive upper rowid first. */
const WINDOW_SQL = "SELECT id, v FROM t WHERE id > ? AND id <= ? ORDER BY id";

describe("cooperative candidate reads", () => {
  it("reads every row in rowid order on its own connection, a window at a time, letting other callbacks run between windows", async () => {
    const { file } = walTable(500);
    const loop = turns(), reader = recordingOpen();
    const read = await readRowsCooperatively<{ id: number }>(file, "t", WINDOW_SQL, [], reader.open, 64);
    loop.stop();
    expect(reader.readers.map((db) => [db.readonly, db.open, db.inTransaction])).toEqual([[true, false, false]]); // readonly, and closed before returning
    expect(read.rows.map((r) => r.id)).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(read.windows).toBe(8);
    expect(loop.count()).toBeGreaterThan(1);
  });

  it("yields between windows even when the filter matches almost nothing", async () => {
    const { file } = walTable(2000);
    const loop = turns();
    const read = await readRowsCooperatively<{ id: number }>(file, "t", "SELECT id FROM t WHERE id > ? AND id <= ? AND v LIKE ?", ['%"a":2000}%']);
    loop.stop();
    expect(read.rows).toEqual([{ id: 2000 }]);
    expect(read.windows).toBe(8); // 2000 rowids, 256 per window
    // A cursor that yields only between returned rows reaches its one match in a single native step, with no turn between.
    expect(loop.count()).toBeGreaterThan(1);
  });

  it("reads an empty table as no rows, and steps over rowid gaps", async () => {
    const { file, db } = walTable(0);
    expect(await readRowsCooperatively(file, "t", WINDOW_SQL, [])).toMatchObject({ rows: [], windows: 0 });
    db.prepare("INSERT INTO t(id, v) VALUES (1, 'a'), (1000, 'b')").run();
    const read = await readRowsCooperatively<{ id: number }>(file, "t", WINDOW_SQL, []);
    expect(read.rows.map((r) => r.id)).toEqual([1, 1000]);
    expect(read.windows).toBe(4);
  });

  it("keeps one snapshot for every window while writers commit between windows; the next read sees them", async () => {
    const { file, db } = walTable(500);
    // Runs at the reader's first yield, after its first window: every change lands in a window it has not read yet.
    setImmediate(() => db.transaction(() => {
      db.prepare("UPDATE t SET v = 'changed' WHERE id = 500").run();
      db.prepare("DELETE FROM t WHERE id = 400").run();
      db.prepare("INSERT INTO t(id, v) VALUES (501, 'new')").run();
    })());
    const during = await readRowsCooperatively<{ id: number; v: string }>(file, "t", WINDOW_SQL, [], undefined, 64);
    expect(during.rows.map((r) => r.id)).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(during.rows.at(-1)).toEqual({ id: 500, v: JSON.stringify({ a: 500 }) });
    const after = await readRowsCooperatively<{ id: number; v: string }>(file, "t", WINDOW_SQL, []);
    expect(after.rows).toHaveLength(500);
    expect(after.rows.some((r) => r.id === 400)).toBe(false);
    expect(after.rows.slice(-2)).toEqual([{ id: 500, v: "changed" }, { id: 501, v: "new" }]);
  });

  it("rethrows a native error raised in a later window, returns nothing, and leaves no reader pinning the WAL", async () => {
    const { file, db } = walTable(500, 300);
    const reader = recordingOpen();
    const sql = "SELECT json_extract(v, '$.a') AS a FROM t WHERE id > ? AND id <= ? ORDER BY id";
    const read = readRowsCooperatively(file, "t", sql, [], reader.open, 64);
    await expect(read).rejects.toMatchObject({ name: "SqliteError", code: "SQLITE_ERROR" });
    expect(reader.readers.map((db) => db.open)).toEqual([false]);
    db.prepare("INSERT INTO t(id, v) VALUES (501, '{}')").run();
    expect(db.pragma("wal_checkpoint(TRUNCATE)")).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]);
    db.prepare("DELETE FROM t WHERE id = 300").run();
    expect((await readRowsCooperatively(file, "t", sql, [])).rows).toHaveLength(500);
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
    migrate(db, [coreSchema, bindingsSessionsSchema, rigArchiveSchema, eventsSchema, queueItemSummarySchema, queueItemsSchema, queueTransitionsSchema, queueTransitionWakesSchema, viewsCustomSchema]);
    return db;
  }
  const insertRow = (db: Database.Database, id: string, state: string, tags: string[] | null, body: string, claimedAt: string | null = "2026-10-25T11:00:00.000Z") =>
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body, claimed_at, last_heartbeat, blocked_on)
      VALUES (?, '2026-10-25T10:00:00.000Z', '2026-10-25T10:00:00.000Z', 'lead@r', 'builder@r', ?, 'normal', 'light', ?, ?, ?, NULL, ?)`)
      .run(id, state, tags && JSON.stringify(tags), body, claimedAt, state === "blocked" ? "external:review" : null);
  const laneIds = (doc: Record<string, unknown>) => (doc.q1_lanes as Array<{ qitem_id: string }>).map((l) => l.qitem_id).sort();
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  // The free-disk reading is taken live at read time (fs.statfsSync); every other field must match.
  const withoutLiveDisk = (doc: unknown) => {
    const copy = structuredClone(doc) as { q6_parallelism?: { df_margin?: { available_kib?: unknown } } };
    if (copy.q6_parallelism?.df_margin) delete copy.q6_parallelism.df_margin.available_kib;
    return copy;
  };

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
    const legacy = await documentOf(memory);
    expect(withoutLiveDisk(await documentOf(file))).toEqual(withoutLiveDisk(legacy));
    expect((legacy as { q1_lanes: unknown[] }).q1_lanes.length).toBeGreaterThan(0);
  });

  it("binds the same rows through the windowed read when the mission filter matches few of them, edge cases included", async () => {
    const missionsRoot = path.dirname(tempFile("missions"));
    fs.mkdirSync(path.join(missionsRoot, "release-9"));
    fs.writeFileSync(path.join(missionsRoot, "release-9", "SPEC.md"), "---\nid: OPR_9\n---\n\n# Fixture mission\n");
    const edges: Array<[id: string, state: string, tags: string[] | null, body: string]> = [
      ["qitem-tagged", "in-progress", ["mission:release-9", "project:p1", "slice:S1"], "Tagged."],
      ["qitem-alias-tag", "in-progress", ["mission:OPR_9", "project:p2", "slice:S2"], "Tagged with the mission's SPEC id."],
      ["qitem-case", "in-progress", ["mission:RELEASE-9", "slice:S3"], "Tagged in another ASCII case."],
      ["qitem-longer-tag", "in-progress", ["mission:release-90", "slice:S4"], "Another mission whose name contains this one."],
      ["qitem-other-tag", "in-progress", ["mission:other", "slice:S5"], "Tagged elsewhere; mentions release-9."],
      ["qitem-body", "in-progress", ["slice:S6", "project:p1"], "Untagged work for release-9."],
      ["qitem-wildcard", "in-progress", ["slice:S7"], "Untagged; mentions OPRx9, which LIKE's _ matches."],
      ["qitem-null-tags", "in-progress", null, "Slice: S8\nNo tags; mentions release-9."],
      ["qitem-empty-body", "in-progress", ["mission:release-9", "slice:S9"], ""],
      ["qitem-null-tags-empty-body", "in-progress", null, ""],
      ["qitem-moved", "in-progress", ["mission:release-9", "slice:S10"], "Claimed, then moved three times."],
    ];
    // 700 unrelated rows around the edge rows, so matches are sparse and fall in different windows.
    const seed = (db: Database.Database) => db.transaction(() => {
      const fill = (from: number, to: number) => {
        for (let i = from; i < to; i++) insertRow(db, `qitem-filler-${String(i).padStart(4, "0")}`, "done", ["slice:S1"], `Unrelated work ${i}.`);
      };
      fill(0, 300);
      for (const [id, state, tags, body] of edges.slice(0, 4)) insertRow(db, id, state, tags, body);
      fill(300, 600);
      for (const [id, state, tags, body] of edges.slice(4)) insertRow(db, id, state, tags, body);
      fill(600, 700);
      for (let n = 0; n < 3; n++) {
        db.prepare("INSERT INTO queue_transitions (qitem_id, ts, state, transition_note, actor_session) VALUES ('qitem-moved', ?, 'in-progress', 'moved', 'builder@r')")
          .run(`2026-10-25T11:3${n}:00.000Z`);
      }
    })();
    const memory = fixture(), file = fixture(tempFile("sparse.sqlite"));
    seed(memory); seed(file);
    expect(cooperativeReadFile(file)).not.toBeNull();
    const deps = (db: Database.Database) => ({ db, now: () => NOW, slicesRoot: () => missionsRoot, rigsRoot: () => "/nonexistent-rigs-root",
      exec: async (): Promise<string> => { throw new Error("not a repository"); } });
    for (const project of [undefined, "p1"]) {
      const legacy = await buildExecutionView(deps(memory), { mission: "release-9", project });
      expect(withoutLiveDisk(await buildExecutionView(deps(file), { mission: "release-9", project }))).toEqual(withoutLiveDisk(legacy));
      expect(laneIds(legacy)).toEqual(project ? ["qitem-body", "qitem-tagged"] : [
        "qitem-alias-tag", "qitem-body", "qitem-case", "qitem-empty-body", "qitem-moved", "qitem-null-tags", "qitem-tagged", "qitem-wildcard",
      ]);
    }
  });
});

describe("slow execution projections in the slow-operation log", () => {
  afterEach(() => configureSyncSiteRecorder(undefined));

  it("offers a diagnostic only at the slow threshold, and a throwing recorder changes nothing for the caller", () => {
    const offered: unknown[] = [];
    configureSyncSiteRecorder({ recordDiagnostic: (record) => { offered.push(record); return true; } });
    recordSlowDiagnostic(249.9, { n: 1 });
    recordSlowDiagnostic(250, { n: 2 });
    recordSlowDiagnostic(Number.NaN, { n: 3 });
    expect(offered).toEqual([{ n: 2 }]);
    configureSyncSiteRecorder({ recordDiagnostic: () => { throw new Error("recorder broke"); } });
    expect(() => recordSlowDiagnostic(300, { n: 4 })).not.toThrow();
  });

  it("records a slow projection's elapsed times and the candidate read's longest stretch, with no row content", async () => {
    const offered: Record<string, unknown>[] = [];
    configureSyncSiteRecorder({ recordDiagnostic: (record) => { offered.push(record); return true; } });
    const db = track(createDb(tempFile("slow.sqlite")));
    migrate(db, [coreSchema, bindingsSessionsSchema, rigArchiveSchema, eventsSchema, queueItemSummarySchema, queueItemsSchema, queueTransitionsSchema, queueTransitionWakesSchema, viewsCustomSchema]);
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
      VALUES ('qitem-slow', '2026-10-25T10:00:00.000Z', '2026-10-25T10:00:00.000Z', 'lead@r', 'builder@r', 'in-progress', 'normal', 'light', ?, ?)`)
      .run(JSON.stringify(["slice:S1"]), "Private words.\nworktree_path=/nowhere/slow\n");
    // Each Git probe of the row's worktree takes 260 ms, so the projection crosses the 250 ms threshold.
    await buildExecutionView({ db, now: () => new Date("2026-10-25T12:00:00.000Z"), slicesRoot: () => null, rigsRoot: () => "/nonexistent-rigs-root",
      exec: async (): Promise<string> => { await new Promise((resolve) => setTimeout(resolve, 260)); throw new Error("not a repository"); } });
    expect(offered).toHaveLength(1);
    const record = offered[0]!;
    expect(record).toMatchObject({ schema: "openrig.execution-view/v1", candidateRead: "windowed", candidateRows: 1, candidateWindows: 1 });
    expect(record.projectionMs).toBeGreaterThanOrEqual(250);
    expect(record.candidateMs).toBeLessThanOrEqual(record.projectionMs as number);
    expect(record.candidateLongestStretchMs).toBeLessThanOrEqual(record.candidateMs as number);
    expect(Object.keys(record).sort()).toEqual(["candidateLongestStretchMs", "candidateMs", "candidateRead", "candidateRows", "candidateWindows", "projectionMs", "schema", "utc"]);
    expect(JSON.stringify(record)).not.toMatch(/Private|nowhere|builder@r|S1/);
  });
});
