// SliceIndexer membership buckets — exact ORDERED contents, pinned.
//
// The membership index (see MembershipIndex in slice-indexer.ts) is three
// maps: typedBySlice (typed `slice:` rows, ts_created DESC / qitem_id DESC,
// 500 confirmed per slice), fallbackTermsBySlice (the terms a zero-typed
// slice may consult, in authored precedence order) and fallbackByTerm (rows
// whose body or tags contain the term under SQLite LIKE '%term%', in rowid
// order, 500 per term). This file pins the exact ordered membership of each
// bucket for the dimensions the fallback scan must keep: typed versus
// fallback precedence, the per-term limit, project filtering, ASCII folding,
// LIKE wildcards, non-ASCII and U+0000 on either side, overlapping terms,
// and what happens when the build fails. It deliberately knows nothing about
// HOW the fallback scan matches, so it reads the same before and after a
// change to the scan's matching engine; the last case compares the buckets
// against SQLite's own LIKE on seeded random data.
//
// Map KEY order is not pinned: it follows directory-listing order, which is
// filesystem-dependent. Vitest compares Maps by key; the bucket arrays are
// compared in order.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

const NOW = "2026-07-11T12:00:00.000Z";

interface MembershipIndexView {
  typedBySlice: Map<string, string[]>;
  fallbackTermsBySlice: Map<string, string[]>;
  fallbackByTerm: Map<string, string[]>;
  knownSlices: Set<string>;
}

/** The private build entry point and the published slot it fills. */
interface IndexerInternals {
  membershipIndex: MembershipIndexView | null;
  ensureMembershipIndex(served: Set<string> | null): MembershipIndexView;
}

function internals(indexer: SliceIndexer): IndexerInternals {
  return indexer as unknown as IndexerInternals;
}

/** A slice folder. `mission` null writes a flat slice (no mission term). */
function writeSlice(root: string, mission: string | null, slice: string, frontmatter: string[] = []): void {
  const dir = mission === null ? path.join(root, slice) : path.join(root, mission, "slices", slice);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), ["---", "status: active", ...frontmatter, "---", "# slice", ""].join("\n"));
}

/** One queue row. `tags` is the raw column text (null, JSON or anything). */
function insertRow(
  db: Database.Database,
  id: string,
  body: string | Buffer,
  tags: string | Buffer | null = null,
  tsCreated = NOW,
): void {
  db.prepare(
    `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tags, body)
     VALUES (?, ?, ?, 'src@rig', 'dst@rig', 'in-progress', 'routine', ?, ?)`,
  ).run(id, tsCreated, tsCreated, tags, body);
}

function tagList(...tags: string[]): string {
  return JSON.stringify(tags);
}

describe("SliceIndexer membership buckets (exact ordered contents)", () => {
  let db: Database.Database;
  let cleanup: string;
  let root: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-membership-buckets-"));
    root = path.join(cleanup, "missions");
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  function build(opts: { projectId?: string; target?: Database.Database } = {}): MembershipIndexView {
    const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db: opts.target ?? db, projectId: opts.projectId });
    return internals(indexer).ensureMembershipIndex(null);
  }

  function publicIds(slice: string, projectId?: string): string[] {
    const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db, projectId });
    return indexer.get(slice)!.qitemIds;
  }

  it("(a) typed versus fallback precedence: a typed slice consults no fallback term, a modern mission drops its mission term, and the fallback scan still reads typed rows for other slices' terms", () => {
    writeSlice(root, "modern", "01-typed");
    writeSlice(root, "modern", "02-plain");
    writeSlice(root, "modern", "04-railed", ["rail-item: RAIL-9"]);
    writeSlice(root, "legacy", "03-legacy");
    insertRow(db, "q-t1", "02-plain and 01-typed", tagList("slice:01-typed"), "2026-07-01T00:00:00.000Z");
    insertRow(db, "q-t2", "x", tagList("mission:modern", "slice:01-typed"), "2026-07-03T00:00:00.000Z");
    insertRow(db, "q-ghost", "03-legacy", tagList("slice:99-ghost"));
    insertRow(db, "q-mission-only", "modern mission chatter", tagList("mission:modern"));
    insertRow(db, "q-rail", "see RAIL-9", null);
    insertRow(db, "q-legacy-mission", "x", tagList("mission:legacy"));
    insertRow(db, "q-legacy-name", "03-LEGACY done", tagList());
    insertRow(db, "q-typed-mentions-legacy", "03-legacy", tagList("slice:01-typed"), "2026-07-02T00:00:00.000Z");

    const index = build();
    expect(index.typedBySlice).toEqual(new Map([
      ["01-typed", ["q-t2", "q-typed-mentions-legacy", "q-t1"]],
      ["99-ghost", ["q-ghost"]],
    ]));
    expect(index.fallbackTermsBySlice).toEqual(new Map([
      ["02-plain", ["02-plain"]],
      ["04-railed", ["04-railed", "RAIL-9"]],
      ["03-legacy", ["03-legacy", "legacy"]],
    ]));
    expect(index.fallbackByTerm).toEqual(new Map([
      ["02-plain", ["q-t1"]],
      ["04-railed", []],
      ["RAIL-9", ["q-rail"]],
      ["03-legacy", ["q-ghost", "q-legacy-name", "q-typed-mentions-legacy"]],
      ["legacy", ["q-ghost", "q-legacy-mission", "q-legacy-name", "q-typed-mentions-legacy"]],
    ]));
    expect(publicIds("01-typed")).toEqual(["q-t2", "q-typed-mentions-legacy", "q-t1"]);
    expect(publicIds("02-plain")).toEqual(["q-t1"]);
  });

  it("(b) per-term limit: a term keeps the FIRST 500 matching rows in rowid order, independently of the other terms the same rows match", () => {
    writeSlice(root, "legacy-cap", "05-cap");
    // Inserted with DESCENDING ids so rowid order and id order disagree.
    for (let i = 599; i >= 0; i--) {
      insertRow(db, `q-cap-${String(i).padStart(4, "0")}`, "touches 05-cap", i % 3 === 0 ? tagList("mission:legacy-cap") : null);
    }
    const id = (i: number) => `q-cap-${String(i).padStart(4, "0")}`;
    const capBucket = Array.from({ length: 500 }, (_, k) => id(599 - k));
    const missionBucket = Array.from({ length: 600 }, (_, k) => 599 - k).filter((i) => i % 3 === 0).map(id);

    const index = build();
    expect(index.fallbackTermsBySlice).toEqual(new Map([["05-cap", ["05-cap", "legacy-cap"]]]));
    expect(index.fallbackByTerm).toEqual(new Map([
      ["05-cap", capBucket],
      ["legacy-cap", missionBucket],
    ]));
    // Public order with equal ts_created is the union in term order.
    expect(publicIds("05-cap")).toEqual([...capBucket, ...missionBucket.filter((q) => !capBucket.includes(q))]);
  });

  it("(c) project filtering: with a project selected only rows tagged with it count, in both scans, so a typed row of another project leaves the slice zero-typed", () => {
    writeSlice(root, "proj", "06-proj");
    // Another mission, so a typed 07-proj leaves mission "proj" legacy.
    writeSlice(root, "other", "07-proj");
    insertRow(db, "q-p1", "06-proj", tagList("project:p1"));
    insertRow(db, "q-p2", "06-proj", tagList("project:p2"));
    insertRow(db, "q-unscoped", "06-proj", null);
    insertRow(db, "q-p1-comma", "x", tagList("project:p1,mission:proj"));
    insertRow(db, "q-malformed", "06-proj", "project:p1 06-proj");
    insertRow(db, "q-p2-typed", "06-proj", tagList("project:p2", "slice:06-proj"));
    insertRow(db, "q-p1-typed", "x", tagList("project:p1", "slice:07-proj"));

    const scoped = build({ projectId: "p1" });
    expect(scoped.typedBySlice).toEqual(new Map([["07-proj", ["q-p1-typed"]]]));
    expect(scoped.fallbackTermsBySlice).toEqual(new Map([["06-proj", ["06-proj", "proj"]]]));
    // "proj" is also inside every "project:" tag, so each p1 row credits it.
    expect(scoped.fallbackByTerm).toEqual(new Map([
      ["06-proj", ["q-p1"]],
      ["proj", ["q-p1", "q-p1-comma", "q-p1-typed"]],
    ]));
    expect(publicIds("06-proj", "p1")).toEqual(["q-p1", "q-p1-comma", "q-p1-typed"]);
    expect(publicIds("07-proj", "p1")).toEqual(["q-p1-typed"]);

    const unscoped = build();
    expect(unscoped.typedBySlice).toEqual(new Map([["06-proj", ["q-p2-typed"]], ["07-proj", ["q-p1-typed"]]]));
    expect(unscoped.fallbackTermsBySlice).toEqual(new Map());
    expect(unscoped.fallbackByTerm).toEqual(new Map());
  });

  it("(d) ASCII folding: A-Z fold to a-z on both sides; non-ASCII letters (É/é, Æ/æ, À/A, the Kelvin sign) and the neighbours @ and ` never fold; terms equal after folding each keep a bucket", () => {
    writeSlice(root, null, "fold-AbC");
    writeSlice(root, null, "e-rail", ["rail-item: ÉCOLE-æ"]);
    writeSlice(root, null, "kit-ab@");
    writeSlice(root, null, "dup-x", ["rail-item: DUP-X"]);
    insertRow(db, "q1", "FOLD-ABC");
    insertRow(db, "q2", "fold-abc");
    insertRow(db, "q3", "x", "fOlD-aBc");
    insertRow(db, "q4", "école-æ");
    insertRow(db, "q5", "ÉcOlE-æ");
    insertRow(db, "q6", "ÉCOLE-Æ");
    insertRow(db, "q7", "ÉCOLE-æ");
    insertRow(db, "q8", "FOLD-ÀBC");
    insertRow(db, "q9", "KIT-AB@");
    insertRow(db, "q10", "KIT-AB@");
    insertRow(db, "q11", "kit-ab`");
    insertRow(db, "q12", "xDuP-xx");

    const index = build();
    expect(index.fallbackTermsBySlice).toEqual(new Map([
      ["fold-AbC", ["fold-AbC"]],
      ["e-rail", ["e-rail", "ÉCOLE-æ"]],
      ["kit-ab@", ["kit-ab@"]],
      ["dup-x", ["dup-x", "DUP-X"]],
    ]));
    expect(index.fallbackByTerm).toEqual(new Map([
      ["fold-AbC", ["q1", "q2", "q3"]],
      ["e-rail", []],
      ["ÉCOLE-æ", ["q5", "q7"]],
      ["kit-ab@", ["q10"]],
      ["dup-x", ["q12"]],
      ["DUP-X", ["q12"]],
    ]));
  });

  it("(e) LIKE wildcards: % and _ in a term are wildcards (spanning newline and astral characters); % and _ in a row are plain characters; regex specials in a term are literal", () => {
    const specials = "re.+?^$" + "{}()|[x]\\z";
    writeSlice(root, null, "pct%mid");
    writeSlice(root, null, "under_score");
    writeSlice(root, null, "plain-lit", [`rail-item: ${specials}`]);
    insertRow(db, "e01", "pctXYZmid");
    insertRow(db, "e02", "pctmid");
    insertRow(db, "e03", "PCT%MID");
    insertRow(db, "e04", "pc%tmid");
    insertRow(db, "e05", "underXscore");
    insertRow(db, "e06", "underscore");
    insertRow(db, "e07", "under\nscore");
    insertRow(db, "e08", "under\u{1F600}score");
    insertRow(db, "e09", "under__score");
    insertRow(db, "e10", "plain%lit");
    insertRow(db, "e11", "plain_lit");
    insertRow(db, "e12", "PLAIN-LIT");
    insertRow(db, "e13", specials);
    insertRow(db, "e14", "reX+?^$" + "{}()|[x]\\z");
    insertRow(db, "e15", "under_score");

    const index = build();
    expect(index.fallbackTermsBySlice).toEqual(new Map([
      ["pct%mid", ["pct%mid"]],
      ["under_score", ["under_score"]],
      ["plain-lit", ["plain-lit", specials]],
    ]));
    expect(index.fallbackByTerm).toEqual(new Map([
      ["pct%mid", ["e01", "e02", "e03"]],
      ["under_score", ["e05", "e07", "e08", "e15"]],
      ["plain-lit", ["e12"]],
      [specials, ["e13"]],
    ]));
  });

  it("(f) non-ASCII: a non-ASCII term matches only its exact non-ASCII characters; an ASCII term matches across a non-ASCII neighbour but not through one", () => {
    writeSlice(root, null, "café-ü");
    writeSlice(root, null, "rocket-\u{1F680}");
    writeSlice(root, null, "abc");
    insertRow(db, "f01", "CAFÉ-ü");
    insertRow(db, "f02", "Café-ü");
    insertRow(db, "f03", "CAFé-Ü");
    insertRow(db, "f04", "cAfé-ü");
    insertRow(db, "f05", "ROCKET-\u{1F680}");
    insertRow(db, "f06", "rocket-\u{1F681}");
    insertRow(db, "f07", "xabcé");
    insertRow(db, "f08", "abéc");
    insertRow(db, "f09", "éABC");
    insertRow(db, "f10", "ab\u{1F680}c");
    insertRow(db, "f11", "x", "\u{1F680}abc\u{1F680}");

    const index = build();
    expect(index.fallbackByTerm).toEqual(new Map([
      ["café-ü", ["f02", "f04"]],
      ["rocket-\u{1F680}", ["f05"]],
      ["abc", ["f07", "f09", "f11"]],
    ]));
  });

  it("(g) U+0000: a row is read only up to its first NUL (body and tags separately); a NUL in a term truncates the bound pattern %term% and end-anchors what is left", () => {
    writeSlice(root, null, "nul-lit");
    writeSlice(root, null, "nul_wild");
    writeSlice(root, null, "railnul", ["rail-item: RAIL\u0000TAIL"]);
    insertRow(db, "g01", "nul-lit\u0000");
    insertRow(db, "g02", "x\u0000nul-lit");
    insertRow(db, "g03", "\u0000nul-lit", "nul-lit");
    insertRow(db, "g04", "x", "\u0000nul-lit");
    insertRow(db, "g05", "nul-l\u0000it");
    insertRow(db, "g06", "nulXwild\u0000");
    insertRow(db, "g07", "nul\u0000wild");
    insertRow(db, "g08", "ends with RAIL");
    insertRow(db, "g09", "RAIL mid");
    insertRow(db, "g10", "xrail");
    insertRow(db, "g11", "rail\u0000junk");
    insertRow(db, "g12", "RAIL\u0000TAIL more");
    insertRow(db, "g13", "x", "\u0000nulXwild");

    const index = build();
    expect(index.fallbackTermsBySlice).toEqual(new Map([
      ["nul-lit", ["nul-lit"]],
      ["nul_wild", ["nul_wild"]],
      ["railnul", ["railnul", "RAIL\u0000TAIL"]],
    ]));
    expect(index.fallbackByTerm).toEqual(new Map([
      ["nul-lit", ["g01", "g03"]],
      ["nul_wild", ["g06"]],
      ["railnul", []],
      ["RAIL\u0000TAIL", ["g08", "g10", "g11", "g12"]],
    ]));
  });

  describe("(h) when the build cannot run or fails", () => {
    it("queue_items absent: the index is still published, with the terms and no fallback buckets", () => {
      const bare = createDb();
      try {
        migrate(bare, [coreSchema]);
        writeSlice(root, null, "h-slice", ["rail-item: PL-5"]);
        const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db: bare });
        const index = internals(indexer).ensureMembershipIndex(null);
        expect(index.typedBySlice).toEqual(new Map());
        expect(index.fallbackTermsBySlice).toEqual(new Map([["h-slice", ["h-slice", "PL-5"]]]));
        expect(index.fallbackByTerm).toEqual(new Map());
        expect(index.knownSlices).toEqual(new Set(["h-slice"]));
        expect(internals(indexer).membershipIndex).toBe(index);
      } finally {
        bare.close();
      }
    });

    it("tags column absent: no typed scan, the fallback reads bodies only; with a project selected no row belongs to it", () => {
      const bare = createDb();
      try {
        bare.exec(`CREATE TABLE queue_items (qitem_id TEXT PRIMARY KEY, ts_created TEXT NOT NULL, body TEXT NOT NULL)`);
        const add = bare.prepare(`INSERT INTO queue_items (qitem_id, ts_created, body) VALUES (?, ?, ?)`);
        add.run("q-a", NOW, "h-slice");
        add.run("q-b", NOW, "PL-5 x");
        add.run("q-c", NOW, "slice:h-slice");
        writeSlice(root, null, "h-slice", ["rail-item: PL-5"]);
        const index = build({ target: bare });
        expect(index.typedBySlice).toEqual(new Map());
        expect(index.fallbackByTerm).toEqual(new Map([
          ["h-slice", ["q-a", "q-c"]],
          ["PL-5", ["q-b"]],
        ]));
        const scoped = build({ target: bare, projectId: "p1" });
        expect(scoped.fallbackByTerm).toEqual(new Map([
          ["h-slice", []],
          ["PL-5", []],
        ]));
      } finally {
        bare.close();
      }
    });

    it("a scan that throws mid-iteration propagates and publishes nothing; the same indexer then rebuilds the complete buckets", () => {
      writeSlice(root, null, "h-slice");
      insertRow(db, "q-1", "h-slice one");
      insertRow(db, "q-2", "h-slice two");
      insertRow(db, "q-3", "h-slice three");
      const clean = build();

      let armed = true;
      const origPrepare = db.prepare.bind(db);
      (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        const stmt = origPrepare(sql) as unknown as { iterate: (...a: unknown[]) => Iterable<unknown> };
        if (!armed || !sql.startsWith("SELECT qitem_id, body")) return stmt;
        return {
          iterate: (...args: unknown[]) => (function* () {
            let n = 0;
            for (const row of stmt.iterate(...args)) {
              if (n >= 1) throw new Error("injected scan fault");
              n++;
              yield row;
            }
          })(),
        };
      };
      const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
      expect(() => internals(indexer).ensureMembershipIndex(null)).toThrow("injected scan fault");
      expect(internals(indexer).membershipIndex).toBeNull();

      armed = false;
      const rebuilt = internals(indexer).ensureMembershipIndex(null);
      expect(rebuilt.fallbackByTerm).toEqual(new Map([["h-slice", ["q-1", "q-2", "q-3"]]]));
      expect(rebuilt.fallbackByTerm).toEqual(clean.fallbackByTerm);
    });

    it("a non-TEXT (BLOB) body or tags value fails the build with a TypeError and publishes nothing, unless the project filter drops the row first", () => {
      writeSlice(root, null, "h-slice");
      insertRow(db, "q-text", "h-slice", tagList("project:p1"));
      insertRow(db, "q-blob", Buffer.from("h-slice"), tagList("project:p2"));
      const failing = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
      expect(() => internals(failing).ensureMembershipIndex(null)).toThrow(TypeError);
      expect(internals(failing).membershipIndex).toBeNull();

      // The project filter reads the tags first; a dropped row is never read.
      expect(build({ projectId: "p1" }).fallbackByTerm).toEqual(new Map([["h-slice", ["q-text"]]]));

      db.prepare(`DELETE FROM queue_items WHERE qitem_id = 'q-blob'`).run();
      insertRow(db, "q-blob-tags", "h-slice", Buffer.from("zzz"));
      const failingTags = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
      expect(() => internals(failingTags).ensureMembershipIndex(null)).toThrow(TypeError);
      expect(internals(failingTags).membershipIndex).toBeNull();

      // An empty BLOB fails the same way: it is not TEXT, whatever its length.
      db.prepare(`DELETE FROM queue_items WHERE qitem_id = 'q-blob-tags'`).run();
      insertRow(db, "q-empty-blob", Buffer.alloc(0));
      const failingEmpty = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
      expect(() => internals(failingEmpty).ensureMembershipIndex(null)).toThrow(TypeError);
    });
  });

  it("(i) overlapping terms: prefixes, suffixes and nested terms all credit the same row, once per term even when body and tags both match", () => {
    for (const slice of ["he", "she", "his", "hers", "abcd"]) writeSlice(root, null, slice);
    insertRow(db, "i1", "USHERS");
    insertRow(db, "i2", "x", "this");
    insertRow(db, "i3", "she", "SHE");
    insertRow(db, "i4", "hishers");
    insertRow(db, "i5", "h\u0000ers");
    insertRow(db, "i6", "abcd", "abc");
    insertRow(db, "i7", "he", "his");

    const index = build();
    expect(index.fallbackByTerm).toEqual(new Map([
      ["he", ["i1", "i3", "i4", "i7"]],
      ["she", ["i1", "i3", "i4"]],
      ["his", ["i2", "i4", "i7"]],
      ["hers", ["i1", "i4"]],
      ["abcd", ["i6"]],
    ]));
    expect(publicIds("she")).toEqual(["i1", "i3", "i4"]);
  });

  describe("(j) differential against SQLite LIKE on seeded random data", () => {
    // mulberry32: a small deterministic PRNG; the seeds below are literal.
    function prng(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const PLAIN = ["a", "A", "b", "B", "z", "Z", "-", "."];
    const NAME = [...PLAIN, "%", "_", "é", "É", "æ", "Æ", "\u{1F600}"];
    const RAIL = [...NAME, "\u0000"];
    const ROW = [...RAIL, "\n", " "];

    /** The per-term query the batch index replaced (c8f858020), with its
     *  implicit rowid order made explicit: SQLite evaluates LIKE itself. */
    function sqliteBuckets(terms: Iterable<string>): Map<string, string[]> {
      const stmt = db.prepare(`SELECT qitem_id FROM queue_items WHERE body LIKE ? OR tags LIKE ? ORDER BY rowid LIMIT 500`);
      const out = new Map<string, string[]>();
      for (const term of terms) {
        const rows = stmt.all(`%${term}%`, `%${term}%`) as Array<{ qitem_id: string }>;
        out.set(term, rows.map((r) => r.qitem_id));
      }
      return out;
    }

    function isPlainAsciiLiteral(term: string): boolean {
      return /^[\u0001-\u007f]+$/.test(term) && !/[%_]/.test(term);
    }

    for (const seed of [1, 2, 3, 3354, 0xc0ffee]) {
      it(`seed ${seed}: every fallback bucket equals SQLite's own LIKE '%term%' over body OR tags, in rowid order, first 500`, () => {
        const rand = prng(seed);
        const pick = (alphabet: string[], min: number, max: number) =>
          Array.from({ length: min + Math.floor(rand() * (max - min + 1)) }, () => alphabet[Math.floor(rand() * alphabet.length)]!).join("");
        const fresh = (alphabet: string[], taken: Set<string>) => {
          for (;;) {
            const name = pick(alphabet, 1, 4);
            if (!name.startsWith(".") && !taken.has(name)) {
              taken.add(name);
              return name;
            }
          }
        };

        const taken = new Set<string>();
        const terms: string[] = [];
        for (let m = 0; m < 3; m++) {
          const mission = fresh(m === 0 ? PLAIN : NAME, taken);
          terms.push(mission);
          for (let s = 0; s < 4; s++) {
            const slice = fresh(s % 2 === 0 ? PLAIN : NAME, taken);
            terms.push(slice);
            const frontmatter: string[] = [];
            if (rand() < 0.5) {
              const rail = pick(RAIL, 1, 4);
              frontmatter.push(`rail-item: ${rail}`);
              terms.push(rail);
            }
            writeSlice(root, mission, slice, frontmatter);
          }
        }

        const flipCase = (s: string) => [...s].map((c) => (/[a-z]/i.test(c) && rand() < 0.5 ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c)).join("");
        const text = (maxSegments: number) =>
          Array.from({ length: Math.floor(rand() * (maxSegments + 1)) }, () =>
            rand() < 0.4 ? flipCase(terms[Math.floor(rand() * terms.length)]!) : pick(ROW, 0, 6),
          ).join("");
        for (let i = 0; i < 700; i++) {
          insertRow(db, `q-${seed}-${String(i).padStart(4, "0")}`, text(4), rand() < 0.3 ? null : text(2));
        }

        const index = build();
        const universe = new Set([...index.fallbackTermsBySlice.values()].flat());
        expect(new Set(index.fallbackByTerm.keys())).toEqual(universe);
        // The universe holds both plain ASCII literals and pattern terms, and
        // some plain literal actually matched rows.
        expect([...universe].some(isPlainAsciiLiteral)).toBe(true);
        expect([...universe].some((term) => !isPlainAsciiLiteral(term))).toBe(true);
        expect([...index.fallbackByTerm].some(([term, ids]) => isPlainAsciiLiteral(term) && ids.length > 0)).toBe(true);
        expect(index.fallbackByTerm).toEqual(sqliteBuckets(universe));
      });
    }
  });
});
