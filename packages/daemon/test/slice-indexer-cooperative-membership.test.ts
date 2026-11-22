// SliceIndexer cooperative membership: a route's slice read builds the same membership index without one long
// synchronous scan of queue_items.
//
// ensureMembershipIndex reads the typed scan (`tags LIKE '%slice:%'`, ts_created DESC / qitem_id DESC) and the
// fallback scan (every row's body and tags, rowid order) on the main handle in one synchronous stretch: on a large
// queue every uncached get() or cold list() holds the event loop for the whole read. getCooperatively and
// withMembershipBatchCooperatively read the same scans with readRowsCooperatively first, then build the record from
// that index. These cells pin that the two builds agree, including the typed scan's order, which the windowed read
// has to reproduce in JS; that a standalone read runs neither scan on the main handle and lets the event loop turn;
// and where the synchronous path stays.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";

interface MembershipIndexView {
  typedBySlice: Map<string, string[]>;
  fallbackTermsBySlice: Map<string, string[]>;
  fallbackByTerm: Map<string, string[]>;
  knownSlices: Set<string>;
}

interface IndexerInternals {
  membershipIndex: MembershipIndexView | null;
  preparedMembership: unknown;
  ensureMembershipIndex(served: Set<string> | null): MembershipIndexView;
  readMembershipIndexCooperatively(file: string, served: Set<string> | null): Promise<MembershipIndexView>;
}

function internals(indexer: SliceIndexer): IndexerInternals {
  return indexer as unknown as IndexerInternals;
}

function writeSlice(root: string, mission: string | null, slice: string, frontmatter: string[] = []): void {
  const dir = mission === null ? path.join(root, slice) : path.join(root, mission, "slices", slice);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), ["---", "status: active", ...frontmatter, "---", "# slice", ""].join("\n"));
}

function insertRow(db: Database.Database, id: string, body: string | Buffer, tags: string | null, tsCreated: string | Buffer): void {
  db.prepare(
    `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tags, body)
     VALUES (?, ?, '2026-07-11T12:00:00.000Z', 'src@rig', 'dst@rig', 'in-progress', 'routine', ?, ?)`,
  ).run(id, tsCreated, tags, body);
}

const tagList = (...tags: string[]) => JSON.stringify(tags);

/** A seeded linear congruential generator, so a failing case reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** The statements prepared on the main handle while `fn` runs. */
async function preparedDuring<T>(db: Database.Database, fn: () => Promise<T> | T): Promise<{ result: T; sql: string[] }> {
  const sql: string[] = [];
  const original = db.prepare;
  (db as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
    sql.push(s);
    return original.call(db, s);
  };
  try {
    return { result: await fn(), sql };
  } finally {
    (db as unknown as { prepare: typeof original }).prepare = original;
  }
}

const isMembershipScan = (s: string) => s.startsWith("SELECT qitem_id, body") || s.includes("tags LIKE '%slice:%' ORDER BY ts_created");

/** Counts event-loop turns until stopped: other callbacks ran while a read was in progress. */
function turns(): { count: () => number; stop: () => void } {
  let count = 0, stopped = false;
  const spin = () => { if (stopped) return; count++; setImmediate(spin); };
  setImmediate(spin);
  return { count: () => count, stop: () => { stopped = true; } };
}

describe("SliceIndexer cooperative membership", () => {
  let dir: string;
  let root: string;
  let file: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-cooperative-membership-"));
    root = path.join(dir, "missions");
    fs.mkdirSync(root, { recursive: true });
    file = path.join(dir, "openrig.sqlite");
    db = createDb(file);
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
  });

  afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const indexer = (target: Database.Database = db, projectId?: string) =>
    new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db: target, projectId });

  /** Slices covering both tiers: typed (by name and by frontmatter id), a modern mission's zero-typed sibling with
   *  an authored rail, a legacy mission, and a flat slice. */
  function seedSlices(): string[] {
    writeSlice(root, "modern", "01-typed");
    writeSlice(root, "modern", "02-plain", ["rail-item: RAIL-9"]);
    writeSlice(root, "modern", "03-by-id", ["id: S-THREE"]);
    writeSlice(root, "legacy", "04-legacy");
    writeSlice(root, "legacy", "05-legacy-railed", ["rail-item: R5"]);
    writeSlice(root, null, "06-flat");
    return ["01-typed", "02-plain", "03-by-id", "04-legacy", "05-legacy-railed", "06-flat"];
  }

  /** Rows whose rowid order differs from the typed order, with ts ties broken by qitem_id, ids that sort differently
   *  by UTF-8 bytes than by UTF-16 units, a BLOB ts_created, several windows' worth of fallback rows and a term past
   *  its 500 cap. */
  function seedRows(seed: number, count: number): void {
    const next = rng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]!;
    const words = ["01-typed", "02-PLAIN", "rail-9", "S-THREE", "04-legacy", "legacy", "r5", "06-flat", "modern", "noise", "02-plai", "LEGACY"];
    const tags = [
      null, tagList(), tagList("slice:01-typed"), tagList("slice:S-THREE"), tagList("mission:modern"),
      tagList("mission:legacy", "slice:99-ghost"), tagList("SLICE:01-typed"), "not json slice:04-legacy",
    ];
    const times = ["2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z", "2026-07-03T00:00:00.000Z"];
    insert(() => {
      insertRow(db, "q-～", "01-typed", tagList("slice:01-typed"), times[0]!);
      insertRow(db, "q-\u{1f600}", "01-typed", tagList("slice:01-typed"), times[0]!);
      insertRow(db, "q-blob-ts", "x", tagList("slice:01-typed"), Buffer.from("2026"));
      for (let i = 0; i < count; i++) {
        const body = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(words)).join(" ");
        insertRow(db, `q-${String(Math.floor(next() * 1e9)).padStart(9, "0")}-${i}`, body, pick(tags), pick(times));
      }
      for (let i = 0; i < 520; i++) insertRow(db, `q-cap-${i}`, "06-flat again", null, times[1]!);
    });
  }

  function insert(fn: () => void): void {
    db.transaction(fn)();
  }

  for (const seed of [1, 7, 2026]) {
    it(`seed ${seed}: the cooperative build equals the synchronous build for every scope, buckets in order`, async () => {
      const slices = seedSlices();
      seedRows(seed, 1500);
      for (const served of [null, ...slices.map((s) => new Set([s]))]) {
        const sync = internals(indexer()).ensureMembershipIndex(served);
        const cooperative = await internals(indexer()).readMembershipIndexCooperatively(file, served);
        expect(cooperative).toEqual(sync);
      }
      const typed = internals(indexer()).ensureMembershipIndex(null).typedBySlice.get("01-typed")!;
      // SQLite's BINARY order is by UTF-8 bytes: U+FF5E (EF BD 9E) sorts before U+1F600 (F0 9F 98 80), the
      // reverse of JS's UTF-16 order; DESC puts it after. The BLOB ts_created sorts above every TEXT one.
      expect(typed[0]).toBe("q-blob-ts");
      expect(typed.indexOf("q-\u{1f600}")).toBeLessThan(typed.indexOf("q-～"));
    });
  }

  it("the typed rows are put in SQLite's order with no allocation per comparison", async () => {
    seedSlices();
    insert(() => {
      for (let i = 0; i < 2000; i++) {
        insertRow(db, `q-${(i * 7919) % 2000}-${i}`, "x", tagList("slice:01-typed"), `2026-07-0${1 + (i % 3)}T00:00:00.000Z`);
      }
      // A tie on ts_created that UTF-16 order breaks the other way: U+FF5E against U+1F600, a surrogate pair.
      insertRow(db, "q-～", "x", tagList("slice:01-typed"), "2026-07-09T00:00:00.000Z");
      insertRow(db, "q-\u{1f600}", "x", tagList("slice:01-typed"), "2026-07-09T00:00:00.000Z");
    });
    const sync = internals(indexer()).ensureMembershipIndex(null);
    const from = vi.spyOn(Buffer, "from");
    try {
      const cooperative = await internals(indexer()).readMembershipIndexCooperatively(file, null);
      // The previous comparator made two Buffers per comparison: tens of thousands for these 2,002 rows.
      expect(from).not.toHaveBeenCalled();
      expect(cooperative).toEqual(sync);
      expect(cooperative.typedBySlice.get("01-typed")!.slice(0, 2)).toEqual(["q-\u{1f600}", "q-～"]);
    } finally {
      from.mockRestore();
    }
  });

  it("an invalidate() during a cooperative read answers that request and keeps nothing it cached", async () => {
    seedSlices();
    seedRows(13, 600);
    const expected = indexer().get("02-plain");

    // The control: with no invalidate() during the read, the record is cached and the next get() reads no scan.
    const kept = indexer();
    await kept.getCooperatively("02-plain");
    expect((await preparedDuring(db, () => kept.get("02-plain"))).sql.filter(isMembershipScan)).toEqual([]);

    const dropped = indexer();
    const pending = dropped.getCooperatively("02-plain");
    dropped.invalidate();
    expect(await pending).toEqual(expected);
    expect((await preparedDuring(db, () => dropped.get("02-plain"))).sql.filter(isMembershipScan)).toHaveLength(2);

    const listed = indexer();
    const listing = listed.withMembershipBatchCooperatively(() => listed.list());
    listed.invalidate();
    expect(await listing).toEqual(indexer().list());
    expect((await preparedDuring(db, () => listed.list())).sql.filter(isMembershipScan)).toHaveLength(2);
  });

  it("with a project selected, both builds count only that project's rows", async () => {
    seedSlices();
    insert(() => {
      insertRow(db, "q-p1", "02-plain", tagList("project:alpha"), "2026-07-01T00:00:00.000Z");
      insertRow(db, "q-p2", "02-plain", tagList("project:beta"), "2026-07-01T00:00:00.000Z");
      insertRow(db, "q-p3", "x", tagList("project:beta", "slice:01-typed"), "2026-07-01T00:00:00.000Z");
    });
    const sync = internals(indexer(db, "alpha")).ensureMembershipIndex(null);
    expect(await internals(indexer(db, "alpha")).readMembershipIndexCooperatively(file, null)).toEqual(sync);
    expect(sync.fallbackByTerm.get("02-plain")).toEqual(["q-p1"]);
  });

  it("a standalone getCooperatively runs neither scan on the main handle, lets the event loop turn, and returns get()'s record", async () => {
    const slices = seedSlices();
    seedRows(11, 1500);
    for (const name of slices) {
      const expected = indexer().get(name);
      const loop = turns();
      const { result, sql } = await preparedDuring(db, () => indexer().getCooperatively(name));
      loop.stop();
      expect(result).toEqual(expected);
      expect(sql.filter(isMembershipScan)).toEqual([]);
      expect(loop.count()).toBeGreaterThan(1);
    }
    // The control: plain get() still reads both scans synchronously on the main handle.
    const { sql } = await preparedDuring(db, () => indexer().get("02-plain"));
    expect(sql.filter(isMembershipScan)).toHaveLength(2);
  });

  it("withMembershipBatchCooperatively serves the cold list and its gets from one cooperative read, with list()'s entries", async () => {
    seedSlices();
    seedRows(5, 800);
    const expected = indexer().withMembershipBatch(() => {
      const all = indexer().list();
      return all;
    });
    const cooperative = indexer();
    const { result, sql } = await preparedDuring(db, () =>
      cooperative.withMembershipBatchCooperatively(() => ({ list: cooperative.list(), plain: cooperative.get("02-plain") })));
    expect(result.list).toEqual(expected);
    expect(result.plain).toEqual(indexer().get("02-plain"));
    expect(sql.filter(isMembershipScan)).toEqual([]);
    expect(internals(cooperative).preparedMembership).toBeNull();
  });

  it("concurrent reads of different slices each get their own record", async () => {
    const slices = seedSlices();
    seedRows(3, 1200);
    const shared = indexer();
    const records = await Promise.all(slices.map((name) => shared.getCooperatively(name)));
    expect(records).toEqual(slices.map((name) => indexer().get(name)));
  });

  it("a cached record, an open batch, a memory database and a missing slice keep the synchronous path", async () => {
    seedSlices();
    seedRows(9, 300);
    const cached = indexer();
    cached.get("02-plain");
    expect((await preparedDuring(db, () => cached.getCooperatively("02-plain"))).sql.filter(isMembershipScan)).toEqual([]);

    const batched = indexer();
    const inBatch = await preparedDuring(db, () => batched.withMembershipBatch(() => batched.getCooperatively("02-plain")));
    expect(inBatch.sql.filter(isMembershipScan)).toHaveLength(2);

    expect(await indexer().getCooperatively("no-such-slice")).toBeNull();

    const memory = createDb();
    try {
      migrate(memory, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
      insertRow(memory, "q-m", "02-plain", null, "2026-07-01T00:00:00.000Z");
      const { result, sql } = await preparedDuring(memory, () => indexer(memory).getCooperatively("02-plain"));
      expect(result?.qitemIds).toEqual(["q-m"]);
      expect(sql.filter(isMembershipScan)).toHaveLength(2);
    } finally {
      memory.close();
    }
  });

  it("a failed cooperative read rejects as the synchronous build throws, and leaves nothing prepared or published", async () => {
    seedSlices();
    insertRow(db, "q-blob", Buffer.from("02-plain"), null, "2026-07-01T00:00:00.000Z");
    expect(() => indexer().get("02-plain")).toThrow(TypeError);
    const failing = indexer();
    await expect(failing.getCooperatively("02-plain")).rejects.toThrow(TypeError);
    expect(internals(failing).preparedMembership).toBeNull();
    expect(internals(failing).membershipIndex).toBeNull();
  });
});
