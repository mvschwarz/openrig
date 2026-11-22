// The fleet rollup's per-rig queue summary matches sessions by a suffix LIKE, which no index serves, so its statement
// walks rows until it has a rig's latest 100: every row, for a quiet rig, in one synchronous stretch. On a WAL file it
// now reads the same rows cooperatively (rowid windows on a read-only connection) and orders them here. These cells pin
// that both reads give the same rollup, ties and LIKE's own matching included, and that the main handle stays free.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { reviewReadIndexesSchema } from "../src/db/migrations/083_review_read_indexes.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { MissionControlFleetCliCapability } from "../src/domain/mission-control/mission-control-fleet-cli-capability.js";

const RIGS = ["rig-alpha", "rig-beta", "rig_gamma", "rig-quiet"];
const at = (rig: string, member: string) => [member, rig].join("@");

/** A seeded linear congruential generator, so a failing case reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

/** The same rows, in the same rowid order, on any database: three busy rigs, a quiet one, a rig whose `_` LIKE reads
 *  as any one character (`rigXgamma` matches it), case LIKE folds, ts ties, and rowid order unlike ts order. */
function seed(db: Database.Database, rows: number): void {
  migrate(db, [coreSchema, eventsSchema, queueItemsSchema, rigArchiveSchema]);
  RIGS.forEach((name, i) => db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(`r-${i}`, name));
  const next = rng(42);
  const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]!;
  const suffixes = ["rig-alpha", "rig-beta", "rig_gamma", "rigXgamma", "RIG-ALPHA", "elsewhere"];
  const states = ["pending", "in-progress", "blocked", "done", "failed", "canceled"];
  const insert = db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, blocked_on, body)
    VALUES (?, '2026-11-01T00:00:00.000Z', ?, ?, ?, ?, 'routine', ?, 'x')`);
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const state = pick(states);
      const ts = `2026-11-${String(1 + Math.floor(next() * 20)).padStart(2, "0")}T0${Math.floor(next() * 3)}:00:00.000Z`;
      insert.run(`q-${i}`, ts, at(pick(suffixes), "src"), at(pick(suffixes), "dst"), state, state === "blocked" ? `q-${Math.floor(next() * rows)}` : null);
    }
    insert.run("q-quiet-old", "2026-10-01T00:00:00.000Z", at("rig-quiet", "src"), at("elsewhere", "dst"), "blocked", "q-1");
  })();
}

/** Counts event-loop turns until stopped: other callbacks ran while a read was in progress. */
function turns(): { count: () => number; stop: () => void } {
  let count = 0, stopped = false;
  const spin = () => { if (stopped) return; count++; setImmediate(spin); };
  setImmediate(spin);
  return { count: () => count, stop: () => { stopped = true; } };
}

describe("the fleet rollup's per-rig queue summary on a WAL file", () => {
  let dir: string;
  let file: Database.Database;
  let memory: Database.Database;
  const now = () => new Date("2026-11-22T03:00:00.000Z");
  const capability = (db: Database.Database) => new MissionControlFleetCliCapability({ db, eventBus: new EventBus(db), rigRepo: new RigRepository(db),
    probeRig: async () => ({ cliVersionLabel: "head", unsupportedFields: [] }), now });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-summary-cooperative-"));
    file = createDb(path.join(dir, "openrig.sqlite"));
    memory = createDb();
    seed(file, 3000);
    seed(memory, 3000);
  });
  afterEach(() => {
    file.close();
    memory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives the same rollup as the statement on the main connection, for every rig", async () => {
    const cooperative = await capability(file).rollupFleet();
    const synchronous = await capability(memory).rollupFleet();
    expect(cooperative.rows).toEqual(synchronous.rows);
    expect(synchronous.rows.map((row) => row.rigName)).toEqual(RIGS);
    expect(synchronous.rows.find((row) => row.rigName === "rig-quiet")).toMatchObject({ activityState: "blocked", attentionReason: "blocked-on: q-1" });
  });

  it("prepares no summary statement on the main handle, and lets the event loop turn", async () => {
    const sql: string[] = [];
    const original = file.prepare;
    (file as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => { sql.push(s); return original.call(file, s); };
    const loop = turns();
    try { await capability(file).rollupFleet(); } finally {
      loop.stop();
      (file as unknown as { prepare: typeof original }).prepare = original;
    }
    expect(sql.filter((s) => s.includes("destination_session LIKE ?"))).toEqual([]);
    expect(loop.count()).toBeGreaterThan(1);
  });

  it("assembles each rig's latest 100 from many windows, row for row the statement's", async () => {
    const spread = memory.prepare(`SELECT MIN(rid) AS lo, MAX(rid) AS hi FROM (SELECT rowid AS rid FROM queue_items
      WHERE destination_session LIKE ? OR source_session LIKE ? ORDER BY ts_updated DESC, rowid DESC LIMIT 100)`)
      .get("%@rig-alpha", "%@rig-alpha") as { lo: number; hi: number };
    // The 100 come from far apart in rowid order, so from different windows of the cooperative read.
    expect(spread.hi - spread.lo).toBeGreaterThan(1000);
    for (const rig of RIGS) {
      const cooperative = await rigRows(capability(file), rig);
      const synchronous = await rigRows(capability(memory), rig);
      expect(cooperative).toEqual(synchronous);
      expect(cooperative.length).toBe(rig === "rig-quiet" ? 1 : 100);
    }
  });
});

/** The rows the summary is computed from: a rig's latest 100. */
function rigRows(cap: MissionControlFleetCliCapability, rig: string): Promise<Array<Record<string, unknown>>> {
  return (cap as unknown as { readRigQueueRows: (pattern: string) => Promise<Array<Record<string, unknown>>> }).readRigQueueRows(`%@${rig}`);
}

describe("the window read's plan and its tie boundary", () => {
  let dir: string;
  let file: Database.Database;
  let memory: Database.Database;
  const now = () => new Date("2026-11-22T03:00:00.000Z");
  const capability = (db: Database.Database) => new MissionControlFleetCliCapability({ db, eventBus: new EventBus(db), rigRepo: new RigRepository(db),
    probeRig: async () => ({ cliVersionLabel: "head", unsupportedFields: [] }), now });
  const insert = (db: Database.Database, id: string, ts: string, dst: string, marker: string) =>
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, blocked_on, body)
      VALUES (?, '2026-11-01T00:00:00.000Z', ?, ?, ?, 'blocked', 'routine', ?, 'x')`).run(id, ts, at("elsewhere", "src"), dst, marker);
  /** The real schema through the ts_updated index, and the same rows on both databases. */
  const build = (rows: (db: Database.Database) => void) => {
    for (const db of [file, memory]) {
      migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, rigArchiveSchema, reviewReadIndexesSchema]);
      db.prepare("INSERT INTO rigs (id, name) VALUES ('r-0', 'rig-rare')").run();
      db.transaction(() => rows(db))();
    }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-summary-plan-"));
    file = createDb(path.join(dir, "openrig.sqlite"));
    memory = createDb();
  });
  afterEach(() => {
    file.close();
    memory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads each window by its rowid range, not the ts_updated index, when matches are rare", async () => {
    build((db) => {
      for (let i = 0; i < 3000; i++) {
        const rare = i % 750 === 0;
        insert(db, `q-${i}`, `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T00:00:00.000Z`, at(rare ? "rig-rare" : "elsewhere", "dst"), `m-${i}`);
      }
    });
    expect(file.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_queue_items_ts_updated'").get()).toBeDefined();
    const seen: string[] = [];
    const original = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, source: string) {
      seen.push(source);
      return original.call(this, source);
    } as typeof original);
    let cooperative;
    try { cooperative = await capability(file).rollupFleet(); } finally { spy.mockRestore(); }
    const windowSql = seen.find((s) => s.includes("rowid > ?") && s.includes("destination_session LIKE ?"));
    expect(windowSql).toBeDefined();
    const plan = (file.prepare(`EXPLAIN QUERY PLAN ${windowSql}`).all(0, 4000, "%@rig-rare", "%@rig-rare") as Array<{ detail: string }>)
      .map((row) => row.detail);
    expect(plan.some((detail) => /SEARCH queue_items USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/.test(detail))).toBe(true);
    expect(plan.join("\n")).not.toContain("idx_queue_items_ts_updated");
    expect(cooperative.rows).toEqual((await capability(memory).rollupFleet()).rows);
    expect(await rigRows(capability(file), "rig-rare")).toHaveLength(4);
  });

  it("breaks a tie at the 100th row by the newest rowid, on both reads", async () => {
    build((db) => {
      for (let i = 0; i < 150; i++) {
        insert(db, `tie-${i}`, "2026-11-10T00:00:00.000Z", at("rig-rare", "dst"), `tie-${i}`);
        insert(db, `other-${i}`, "2026-11-12T00:00:00.000Z", at("elsewhere", "dst"), `other-${i}`);
      }
    });
    const expected = Array.from({ length: 100 }, (_, k) => `tie-${149 - k}`);
    expect((await rigRows(capability(file), "rig-rare")).map((row) => row.blocked_on)).toEqual(expected);
    expect((await rigRows(capability(memory), "rig-rare")).map((row) => row.blocked_on)).toEqual(expected);
  });
});
