// A successor index whose build takes most of the sweep's elapsed-time budget must not be rebuilt for every custody
// row. The row after a slow build is already due to yield by elapsed time; the yield drops the index, and rebuilding
// it at the next lookup would make every row in the loop pay one full build instead of about one per 50.
// The clock is moved by the test (performance.now): only while the index is being built and, when a case says so,
// by a fixed cost per getById (the row's own work).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { runStuckSweep, STUCK_SWEEP_YIELD_AFTER_MS, STUCK_SWEEP_YIELD_EVERY_ROWS } from "../src/domain/queue-stuck-sweep.js";

let db: Database.Database;
let repo: QueueRepository;

const ROWS = 120;
const buildSql = (sql: string) => sql.includes("s.handed_off_from IN (SELECT value FROM json_each(?))");
const perRowSuccessor = (sql: string) => sql.includes("s.qitem_id = ? OR s.destination_session = ?");
const sourceId = (i: number) => `qitem-c${String(i).padStart(4, "0")}`;

function row(id: string, o: { state: string; updated: string; destination: string; handedOffFrom?: string;
  closureReason?: string; closureTarget?: string }) {
  db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body,
      handed_off_from,closure_reason,closure_target)
    VALUES (?, ?, ?, 'sender@r', ?, ?, '[]', 'body', ?, ?, ?)`).run(id, o.updated, o.updated, o.destination, o.state,
    o.handedOffFrom ?? null, o.closureReason ?? null, o.closureTarget ?? null);
}

/** ROWS custody rows closed onto a seat. The even ones have their successor in that seat; the odd ones don't, so each
 *  odd one is a dangling-closure finding and no even one is. */
function custodyRows(): string[] {
  const updated = new Date(Date.now() - 5 * 60_000).toISOString();
  const dangling: string[] = [];
  for (let i = 0; i < ROWS; i++) {
    const seat = `seat-${i % 7}@r`;
    row(sourceId(i), { state: "done", updated, destination: "worker@r", closureReason: "handed_off_to", closureTarget: seat });
    if (i % 2 === 0) row(`s-${i}`, { state: "pending", updated, destination: seat, handedOffFrom: sourceId(i) });
    else dangling.push(sourceId(i));
  }
  return dangling;
}

/** A frozen clock that moves by `buildMs` per build of the successor index and by `rowMs` per getById. Counts the
 *  builds, the per-row successor queries, and the builds between two yields of the pass. */
function instrument(buildMs: number, rowMs = 0) {
  let now = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const getById = repo.getById.bind(repo);
  vi.spyOn(repo, "getById").mockImplementation(((...args: Parameters<typeof repo.getById>) => {
    now += rowMs;
    return getById(...args);
  }) as typeof repo.getById);
  const counts = { builds: 0, perRow: 0, buildsPerStretch: [0] };
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    if (buildSql(sql)) { counts.builds++; counts.buildsPerStretch[counts.buildsPerStretch.length - 1]!++; now += buildMs; }
    if (perRowSuccessor(sql)) counts.perRow++;
    return prepare(sql);
  });
  const setImmediateReal = globalThis.setImmediate;
  vi.spyOn(globalThis, "setImmediate").mockImplementation(((fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    counts.buildsPerStretch.push(0);
    return setImmediateReal(fn, ...args);
  }) as typeof setImmediate);
  return counts;
}

beforeEach(() => {
  db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe("runStuckSweep: a successor index slower to build than the elapsed-time budget", () => {
  it("builds it once in the pass, not once per custody row, and judges every row as the live query does", async () => {
    const dangling = custodyRows();
    const counts = instrument(2 * STUCK_SWEEP_YIELD_AFTER_MS);
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    const created = result.findings.filter((f) => f.action === "created").map((f) => f.qitemId).sort();
    expect(created).toEqual(dangling);
    // one build, in the first stretch that asks for it; every row after the yield it causes asks its own query
    expect(counts.builds).toBe(1);
    expect(Math.max(...counts.buildsPerStretch)).toBeLessThanOrEqual(1);
    expect(counts.perRow).toBeGreaterThan(2 * dangling.length);
  });

  it("keeps a fast index and rebuilds it only after a yield, with the same findings (control)", async () => {
    const dangling = custodyRows();
    const counts = instrument(0);
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    const created = result.findings.filter((f) => f.action === "created").map((f) => f.qitemId).sort();
    expect(created).toEqual(dangling);
    expect(counts.builds).toBeGreaterThanOrEqual(1);
    expect(counts.builds).toBeLessThanOrEqual(1 + Math.ceil(ROWS / STUCK_SWEEP_YIELD_EVERY_ROWS));
    expect(Math.max(...counts.buildsPerStretch)).toBeLessThanOrEqual(1);
    // only the live re-check of each finding before its create asks the per-row query (two point queries each)
    expect(counts.perRow).toBe(2 * dangling.length);
  });

  it("stops rebuilding a build under the budget that, with the row's own work, still ends each stretch in a row", async () => {
    const dangling = custodyRows();
    // 35 ms of build and 20 ms of the row: the stretch yields by elapsed time after one row, most of it the build
    const counts = instrument(0.7 * STUCK_SWEEP_YIELD_AFTER_MS, 0.4 * STUCK_SWEEP_YIELD_AFTER_MS);
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(result.findings.filter((f) => f.action === "created").map((f) => f.qitemId).sort()).toEqual(dangling);
    expect(counts.builds).toBe(1);
  });

  it("keeps an index whose build is a small part of a stretch that yields by elapsed time (control)", async () => {
    const dangling = custodyRows();
    // 10 ms of build and 2 ms per row: each stretch covers about 20 rows, a fifth of it the build
    const counts = instrument(0.2 * STUCK_SWEEP_YIELD_AFTER_MS, 0.04 * STUCK_SWEEP_YIELD_AFTER_MS);
    const result = await runStuckSweep({ db, queueRepo: repo, log: () => {} });
    expect(result.findings.filter((f) => f.action === "created").map((f) => f.qitemId).sort()).toEqual(dangling);
    expect(counts.builds).toBeGreaterThan(1);
    expect(counts.builds).toBeLessThanOrEqual(1 + Math.ceil(ROWS / 15));
    expect(Math.max(...counts.buildsPerStretch)).toBeLessThanOrEqual(1);
    expect(counts.perRow).toBe(2 * dangling.length);
  });
});
