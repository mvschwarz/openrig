// The live context health source keeps each live seat's window of context samples between /api/health reads
// (health-context-samples.ts). Its answers must equal a fresh read's after any history of appends and deletes, and it
// may lean on usage_samples being append-and-delete only, which the last two cases pin.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { LiveContextHealthSource } from "../src/domain/health-detectors.js";
import { ContextSampleMemo } from "../src/domain/health-context-samples.js";
import { queryUsageSeries } from "../src/domain/usage-series.js";

const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
type Deps = ConstructorParameters<typeof LiveContextHealthSource>[0];
interface Seat { rigId: string; nodeId: string; sessionName: string; sessionId: string; live: boolean; bootAt: string;
  usage: Record<string, unknown> | null }

/** A database with the real schema and stub seats, rigs and usage, read by a long-lived source (the memo) and compared
 *  with a fresh source's first read (the original read). `fullReads` counts the original read's statement. */
function harness(seats: Seat[], start = Date.parse("2026-11-25T12:00:00.000Z")) {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  const state = { clock: start, fullReads: 0 };
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    if (/FROM usage_samples[\s\S]*ORDER BY captured_at ASC, id ASC\s+LIMIT \?/.test(sql)) state.fullReads += 1;
    return prepare(sql);
  }) as typeof db.prepare);
  const rigs = [...new Set(seats.map((s) => s.rigId))];
  const deps = {
    db,
    now: () => new Date(state.clock),
    resolveContextPressurePolicy: () => ({ warningPercent: 70, criticalPercent: 90 }),
    rigRepo: {
      listRigs: () => rigs.map((id) => ({ id })),
      getRig: (id: string) => ({ nodes: seats.filter((s) => s.rigId === id).map((s) => ({ id: s.nodeId, continuityOutcome: "continued" })) }),
    },
    sessionRegistry: {
      getLatestLiveSessions: (rigId: string) => seats.filter((s) => s.rigId === rigId && s.live)
        .map((s) => ({ nodeId: s.nodeId, sessionName: s.sessionName, sessionId: s.sessionId })),
      currentOccupantTenure: (nodeId: string) => ({ bootAt: seats.find((s) => s.nodeId === nodeId)!.bootAt }),
    },
    contextUsageStore: {
      getForNodes: (list: Array<{ nodeId: string }>) => new Map(list.flatMap(({ nodeId }) => {
        const usage = seats.find((s) => s.nodeId === nodeId)!.usage;
        return usage ? [[nodeId, usage]] : [];
      })),
    },
  } as unknown as Deps;
  const kept = new LiveContextHealthSource(deps);
  const compare = () => {
    const expected = JSON.stringify(new LiveContextHealthSource(deps).read());
    state.fullReads = 0;
    const actual = JSON.stringify(kept.read());
    return { equal: expected === actual, expected, actual, fullReads: state.fullReads };
  };
  return { db, state, compare };
}

const seat = (i: number, rigId = `rig-${i % 3}`): Seat => ({ rigId, nodeId: `node-${i}`, sessionName: `seat-${i}@rig`,
  sessionId: `s-${i}-0`, live: true, bootAt: "2026-11-24 00:00:00", usage: null });

describe("a live seat's context samples kept between health reads", () => {
  // Inserts, clock steps both ways, wrong-node and other-lane rows, null and repeated sample times, odd spellings,
  // erasure of a row, a seat or the newest row, retention, windows sliding past 24 h, seats going live and stopping,
  // new sessions and tenures. After every step the kept source answers exactly as a fresh one.
  it.each([[1, "mixed", 700], [2, "mixed", 700], [3, "dense", 1_200]] as const)(
    "answers as a fresh read through a random append-and-delete history (seed %i, %s)", (seedArg, mode, steps) => {
      let seed = seedArg >>> 0;
      const rand = () => {
        seed = (seed + 0x6d2b79f5) >>> 0; let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
      const seats = Array.from({ length: 12 }, (_, i) => seat(i));
      const { db, state, compare } = harness(seats, Date.parse("2026-11-25T00:00:00.000Z"));
      const insert = db.prepare(`INSERT INTO usage_samples (lane, seat_session, node_id, source, sampled_at, captured_at, used_percentage)
        VALUES (?, ?, ?, 'statusline', ?, ?, ?)`);
      const percent = new Map<string, number>();
      const add = (s: Seat, count: number) => {
        for (let k = 0; k < count; k++) {
          const roll = rand();
          const capturedMs = roll < 0.85 ? state.clock - Math.floor(rand() * 900)
            : roll < 0.93 ? state.clock - Math.floor(rand() * 7_200_000) : state.clock - 86_400_000;
          let captured = iso(capturedMs);
          if (rand() < 0.01) captured = captured.replace("T", " ").replace("Z", "");
          const p = Math.max(0, Math.min(100, (percent.get(s.nodeId) ?? 40) + (rand() - 0.45) * 30));
          percent.set(s.nodeId, p);
          const sampled = rand() < 0.05 ? null : rand() < 0.1 ? String(s.usage?.sampledAt ?? iso(capturedMs)) : iso(capturedMs - Math.floor(rand() * 5000));
          const node = rand() < 0.08 ? pick(seats).nodeId : s.nodeId;
          const lane = rand() < 0.05 ? "provider_window" : "context";
          insert.run(lane, s.sessionName, node, sampled, captured, Math.round(p * 10) / 10);
          if (lane === "context" && sampled && node === s.nodeId && rand() < 0.7) {
            s.usage = { availability: "known", usedPercentage: Math.round(p * 10) / 10, sampledAt: sampled, source: "statusline", sessionId: s.sessionId, fresh: true };
          }
        }
      };
      let generation = 0, mismatches = 0, seatReads = 0, served = 0;
      let first = "";
      for (let step = 0; step < steps; step++) {
        const op = rand();
        if (mode === "dense" && op >= 0.65 && op < 0.70) add(pick(seats), 3);
        else if (op < 0.45) add(pick(seats), 1 + Math.floor(rand() * 6));
        else if (op < 0.65) state.clock += pick([1_000, 15_000, 60_000, 600_000, H, 3 * H]);
        else if (op < 0.70) state.clock += 25 * H;
        else if (op < 0.76) {
          const row = db.prepare("SELECT id FROM usage_samples WHERE seat_session = ? ORDER BY random() LIMIT 1").get(pick(seats).sessionName) as { id: number } | undefined;
          if (row) db.prepare("DELETE FROM usage_samples WHERE id = ?").run(row.id);
        }
        else if (op < 0.78) db.prepare("DELETE FROM usage_samples WHERE seat_session = ?").run(pick(seats).sessionName);
        else if (op < 0.80) db.prepare("DELETE FROM usage_samples WHERE id = (SELECT MAX(id) FROM usage_samples)").run();
        else if (op < 0.83) db.prepare("DELETE FROM usage_samples WHERE captured_at < ?").run(iso(state.clock - 30 * H));
        else if (op < 0.87) { const s = pick(seats); s.live = !s.live; }
        else if (op < 0.90) { const s = pick(seats); generation += 1; s.sessionName = `seat-${s.nodeId}-g${generation}@rig`; s.sessionId = `s-g${generation}`; s.usage = null; }
        else if (op < 0.93) pick(seats).bootAt = iso(state.clock - Math.floor(rand() * 20 * H)).replace("T", " ").slice(0, 19);
        else if (op < 0.96) state.clock -= pick([1_000, 60_000, H]);
        else {
          const s = pick(seats); add(s, 1);
          const last = db.prepare("SELECT sampled_at, used_percentage FROM usage_samples WHERE id = (SELECT MAX(id) FROM usage_samples)").get() as { sampled_at: string | null; used_percentage: number };
          insert.run("context", s.sessionName, s.nodeId, last.sampled_at, iso(state.clock), last.used_percentage);
        }
        const result = compare();
        const reads = seats.filter((s) => s.live && s.usage).length;
        seatReads += reads; served += reads - result.fullReads;
        if (!result.equal) { mismatches += 1; first ||= `step ${step}:\n  expected ${result.expected.slice(0, 300)}\n  actual   ${result.actual.slice(0, 300)}`; }
      }
      expect(mismatches, first).toBe(0);
      // The memo actually served: most seat reads didn't take the original read.
      expect(served / seatReads).toBeGreaterThan(mode === "dense" ? 0.85 : 0.6);
    });

  // A missing row and a deleted row can offset each other in the window's count. Only the boundary guard and the
  // backward-window guard keep these two exact.
  it("drops a cached row that left the window even when another row's erasure evens out the count", () => {
    const s = seat(0, "rig");
    const { db, state, compare } = harness([s]);
    const T = state.clock;
    const insert = (ms: number, percent: number) => Number(db.prepare(`INSERT INTO usage_samples (lane, seat_session, node_id, source,
      sampled_at, captured_at, used_percentage) VALUES ('context', ?, ?, 'statusline', ?, ?, ?)`)
      .run(s.sessionName, s.nodeId, iso(ms), iso(ms), percent).lastInsertRowid);
    const at = (percent: number) => { s.usage = { availability: "known", usedPercentage: percent, sampledAt: iso(state.clock), source: "statusline", sessionId: s.sessionId, fresh: true }; };
    insert(T - 23 * H, 95); const doomed = insert(T - 2 * H, 50); insert(T - H, 80); at(80);
    expect(compare().equal).toBe(true);
    state.clock = T + H; // the 95% row now sits exactly on the window's start, still inside it
    db.prepare("DELETE FROM usage_samples WHERE id = ?").run(doomed);
    expect(compare()).toMatchObject({ equal: true });

    const b = seat(1, "rig");
    const back = harness([b]);
    const T2 = back.state.clock;
    const insertB = (ms: number, percent: number) => Number(back.db.prepare(`INSERT INTO usage_samples (lane, seat_session, node_id, source,
      sampled_at, captured_at, used_percentage) VALUES ('context', ?, ?, 'statusline', ?, ?, ?)`)
      .run(b.sessionName, b.nodeId, iso(ms), iso(ms), percent).lastInsertRowid);
    insertB(T2 - 24.5 * H, 97); const gone = insertB(T2 - 2 * H, 50); insertB(T2 - H, 75);
    b.usage = { availability: "known", usedPercentage: 75, sampledAt: iso(T2), source: "statusline", sessionId: b.sessionId, fresh: true };
    expect(back.compare().equal).toBe(true);
    back.state.clock = T2 - H; // the clock steps back: the 97% row comes into the window
    back.db.prepare("DELETE FROM usage_samples WHERE id = ?").run(gone);
    expect(back.compare()).toMatchObject({ equal: true });
  });

  it("puts a newly added row that was captured before kept rows into captured_at order", () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const memo = new ContextSampleMemo(db);
    const start = "2026-11-25T00:00:00.000Z";
    const insert = (captured: string, percent: number) => db.prepare(`INSERT INTO usage_samples (lane, seat_session, node_id,
      captured_at, sampled_at, used_percentage) VALUES ('context', 'seat@rig', 'node', ?, ?, ?)`).run(captured, captured, percent);
    const original = () => queryUsageSeries(db, { seatSession: "seat@rig", lane: "context", sinceIso: start, limit: 10_000 })
      .map(({ id, nodeId, sampledAt, capturedAt, usedPercentage }) => ({ id, nodeId, sampledAt, capturedAt, usedPercentage }));
    insert("2026-11-25T10:00:00.000Z", 40); insert("2026-11-25T11:00:00.000Z", 60);
    memo.read("seat@rig", start);
    // A writer whose clock stepped back: a higher id, an earlier capture, still in the window.
    insert("2026-11-25T10:30:00.000Z", 50); insert("2026-11-25T11:30:00.000Z", 70);
    expect(memo.read("seat@rig", start)).toEqual(original());
    expect(memo.read("seat@rig", start).map((row) => row.usedPercentage)).toEqual([40, 50, 60, 70]);
  });

  it("takes the original read when its own count fails, and never answers from the memo when the original read fails", () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const memo = new ContextSampleMemo(db);
    const start = "2026-11-25T00:00:00.000Z";
    db.prepare(`INSERT INTO usage_samples (lane, seat_session, node_id, captured_at, sampled_at, used_percentage)
      VALUES ('context', 'seat@rig', 'node', ?, ?, 40)`).run("2026-11-25T01:00:00.000Z", "2026-11-25T01:00:00.000Z");
    const original = () => queryUsageSeries(db, { seatSession: "seat@rig", lane: "context", sinceIso: start, limit: 10_000 })
      .map(({ id, nodeId, sampledAt, capturedAt, usedPercentage }) => ({ id, nodeId, sampledAt, capturedAt, usedPercentage }));
    expect(memo.read("seat@rig", start)).toMatchObject(original());
    const statements = (memo as unknown as { statements: { window: { get: () => unknown } } }).statements;
    const count = vi.spyOn(statements.window, "get").mockImplementationOnce(() => { throw new Error("busy"); });
    expect(memo.read("seat@rig", start)).toMatchObject(original());
    expect(count).toHaveBeenCalled();
    db.exec("DROP TABLE usage_samples");
    expect(() => memo.read("seat@rig", start)).toThrow();
  });
});

describe("the writer invariant the memo relies on", () => {
  // A sample rewritten in place keeps its id and the window's count, so the memo keeps its old values: the limit that
  // the producer's comment names. Each of these three rewrites is a stale answer, and no production writer makes one.
  it.each([
    ["its percentage", "UPDATE usage_samples SET used_percentage = 99 WHERE id = ?"],
    ["its node", "UPDATE usage_samples SET node_id = 'node-other' WHERE id = ?"],
    ["its sample time", "UPDATE usage_samples SET sampled_at = '2026-11-25T11:59:00.000Z' WHERE id = ?"],
  ])("keeps serving a sample whose %s was rewritten in place", (_field, rewrite) => {
    const s = seat(0, "rig");
    const { db, state, compare } = harness([s]);
    const id = Number(db.prepare(`INSERT INTO usage_samples (lane, seat_session, node_id, source, sampled_at, captured_at, used_percentage)
      VALUES ('context', ?, ?, 'statusline', ?, ?, 92)`).run(s.sessionName, s.nodeId, iso(state.clock - H), iso(state.clock - H)).lastInsertRowid);
    s.usage = { availability: "known", usedPercentage: 92, sampledAt: iso(state.clock), source: "statusline", sessionId: s.sessionId, fresh: true };
    expect(compare().equal).toBe(true);
    db.prepare(rewrite).run(id);
    expect(compare().equal).toBe(false);
  });

  it("has no production writer that rewrites a sample: only INSERTs, and deletes by retention and erasure", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else if (name.endsWith(".ts")) files.push(path);
    } };
    walk(root);
    const rewrites: string[] = [];
    const tableLists: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const where = (index: number) => `${file.slice(root.length + 1)}:${source.slice(0, index).split("\n").length}`;
      for (const m of source.matchAll(/\bUPDATE\s+(?:OR\s+\w+\s+)?usage_samples\b|\b(?:REPLACE|INSERT\s+OR\s+\w+)\s+INTO\s+usage_samples\b/gi)) rewrites.push(where(m.index!));
      for (const m of source.matchAll(/INSERT\s+INTO\s+usage_samples\b[\s\S]{0,600}?\bON\s+CONFLICT\b/gi)) rewrites.push(where(m.index!));
      // A table list that a loop writes generically (erasure's): it must be the delete list.
      for (const m of source.matchAll(/table:\s*["'`]usage_samples["'`]/g)) tableLists.push(where(m.index!));
    }
    expect(rewrites, "a writer rewrites usage_samples: change health-context-samples.ts too").toEqual([]);
    const erasure = readFileSync(join(root, "domain/queue-erasure.ts"), "utf8");
    const deletes = erasure.slice(erasure.indexOf("const RIG_RECORDS"), erasure.indexOf("];", erasure.indexOf("const RIG_RECORDS")));
    expect(tableLists).toHaveLength(1);
    expect(tableLists[0]).toMatch(/^domain\/queue-erasure\.ts:/);
    expect(deletes).toMatch(/table:\s*"usage_samples"/);
    expect(erasure).toMatch(/for \(const \{ table, where, byRigId \} of RIG_RECORDS\)[\s\S]{0,800}DELETE FROM \$\{table\}/);
  });
});


describe("memo reads outside committed named-seat windows", () => {
  const project = (rows: ReturnType<ContextSampleMemo["read"]>) => rows.map(({ id, nodeId, sampledAt, capturedAt, usedPercentage }) =>
    ({ id, nodeId, sampledAt, capturedAt, usedPercentage }));
  const fixture = () => {
    const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    const memo = new ContextSampleMemo(db), start = "2026-11-25T00:00:00.000Z", at = "2026-11-25T01:00:00.000Z";
    const insert = (percent: number) => db.prepare(`INSERT INTO usage_samples (lane, seat_session, node_id, captured_at, sampled_at, used_percentage)
      VALUES ('context', 'seat@rig', 'node', ?, ?, ?)`).run(at, at, percent).lastInsertRowid;
    const original = (key: string) => project(queryUsageSeries(db, { seatSession: key, lane: "context", sinceIso: start, limit: 10_000 }));
    return { db, memo, start, insert, original };
  };

  it("does not keep observations of a rolled-back row when its uncommitted id is reused", () => {
    const f = fixture(); let rolledBack: number | bigint = 0;
    try {
      expect(() => f.db.transaction(() => {
        rolledBack = f.insert(95);
        expect(f.db.inTransaction).toBe(true);
        expect(project(f.memo.read("seat@rig", f.start))).toEqual(f.original("seat@rig"));
        throw new Error("fixture rollback after read");
      })()).toThrow("fixture rollback after read");
      expect(f.insert(10)).toBe(rolledBack);
      expect(project(f.memo.read("seat@rig", f.start))).toEqual(f.original("seat@rig"));
    } finally { f.db.close(); }
  });

  it("keeps the original empty-seat filter semantics after a later append", () => {
    const f = fixture();
    try {
      expect(project(f.memo.read("", f.start))).toEqual([]);
      f.insert(40);
      expect(project(f.memo.read("", f.start))).toEqual(f.original(""));
    } finally { f.db.close(); }
  });
});


describe("memo fallback and lifetime boundaries", () => {
  it.each([10_000, 10_001])("matches the original page at %i samples", (n) => {
    const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    try {
      const insert = db.prepare(`INSERT INTO usage_samples (lane, seat_session, node_id, captured_at, used_percentage)
        VALUES ('context', 'seat@rig', 'node', '2026-11-25T01:00:00.000Z', ?)`);
      db.transaction(() => { for (let i = 0; i < n; i++) insert.run(i % 100); })();
      const memo = new ContextSampleMemo(db), bound = "2026-11-25T00:00:00.000Z";
      const expected = queryUsageSeries(db, { seatSession: "seat@rig", lane: "context", sinceIso: bound, limit: 10_000 });
      const project = (rows: ReturnType<ContextSampleMemo["read"]>) => rows.map(({ id, nodeId, sampledAt, capturedAt, usedPercentage }) =>
        ({ id, nodeId, sampledAt, capturedAt, usedPercentage }));
      const prepare = db.prepare.bind(db); let fullReads = 0;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (/ORDER BY captured_at ASC, id ASC\s+LIMIT/.test(sql)) fullReads += 1;
        return prepare(sql);
      }) as typeof db.prepare);
      expect(project(memo.read("seat@rig", bound))).toEqual(project(expected));
      fullReads = 0;
      expect(project(memo.read("seat@rig", bound))).toEqual(project(expected));
      expect(fullReads).toBe(n === 10_000 ? 0 : 1);
    } finally { db.close(); }
  });

  it("drops a seat omitted from a pass and keeps database instances separate", () => {
    const a = new Database(":memory:"), b = new Database(":memory:");
    try {
      for (const db of [a, b]) migrate(db, ALL_MIGRATIONS);
      const memoA = new ContextSampleMemo(a), memoB = new ContextSampleMemo(b), bound = "2026-11-25T00:00:00.000Z";
      a.exec(`INSERT INTO usage_samples (lane, seat_session, captured_at, used_percentage)
        VALUES ('context', 'seat@rig', '2026-11-25T01:00:00.000Z', 95)`);
      memoA.startPass(); expect(memoA.read("seat@rig", bound)).toHaveLength(1); memoA.endPass();
      expect(memoB.read("seat@rig", bound)).toEqual([]);
      memoA.startPass(); memoA.endPass();
      const prepare = vi.spyOn(a, "prepare");
      expect(memoA.read("seat@rig", bound)).toHaveLength(1);
      expect(prepare.mock.calls.some(([sql]) => /ORDER BY captured_at ASC, id ASC\s+LIMIT/.test(sql))).toBe(true);
    } finally { a.close(); b.close(); }
  });
});
