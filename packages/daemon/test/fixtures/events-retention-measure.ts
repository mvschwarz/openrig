// Measures the events pass of the queue-retention sweep on a database file. Not a test: a standalone script.
//
//   node --import tsx test/fixtures/events-retention-measure.ts --db /tmp/x/events.db --seed [--days 30] [--scale 1]
//   node --import tsx test/fixtures/events-retention-measure.ts --db <copy of a real openrig.sqlite>
//
// With --seed it creates a fresh, fully migrated database at --db and fills it with seedHostShapedDaily. Without
// --seed it measures the database already at --db (meant for a COPY of a real one, e.g. made with
// `sqlite3 <db> ".backup <copy>"`; never point it at a running daemon's file). Options: --retention <days>
// (default 14 here; the setting itself defaults to 0, which keeps every event), --window <rows> and --pause <ms> (the RETENTION_DEFAULTS when absent), --now <ISO> (default now).
// It runs only the events pass (pruneEvents), the same call the boot sweep and the daily sweep make, so the other
// retention tables of a copy are left as they are. It prints, as Markdown: the rows per day and per type before
// and after; the event-loop delay (max and p99) and the time of each statement; the pass's total time, and a
// second, steady-state pass one day later; and the size of the file and of its -wal. The pass writes its low-water
// mark into the file, so measure each setting (e.g. 14 days, then 3) on a fresh copy.
import { statSync, existsSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { createDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../src/db/all-migrations.js";
import { PRUNABLE_EVENT_TYPES, RETENTION_DEFAULTS, pruneEvents } from "../../src/domain/queue-retention.js";
import { seedHostShapedDaily } from "../helpers/seed-host-shaped.js";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    seed: { type: "boolean", default: false },
    "seed-only": { type: "boolean", default: false },
    days: { type: "string", default: "30" },
    scale: { type: "string", default: "1" },
    retention: { type: "string", default: "14" }, // the setting defaults to 0 (keep); 14 is the documented example
    window: { type: "string", default: String(RETENTION_DEFAULTS.eventsWindow) },
    pause: { type: "string", default: String(RETENTION_DEFAULTS.eventsPauseMs) },
    now: { type: "string" },
  },
});
if (!values.db) throw new Error("--db <path> is required");
if (values.seed && existsSync(values.db)) throw new Error(`--seed refuses an existing file: ${values.db}`);
const nowIso = values.now ?? new Date().toISOString();
const retentionDays = Number(values.retention);
const window = Number(values.window);
const pauseMs = Number(values.pause);

const db = createDb(values.db);
if (values.seed) {
  migrate(db, ALL_MIGRATIONS);
  const t = performance.now();
  const rows = seedHostShapedDaily(db, { days: Number(values.days), scale: Number(values.scale), nowIso });
  console.log(`seeded ${rows} events over ${values.days} days in ${((performance.now() - t) / 1000).toFixed(1)} s`);
}
if (values["seed-only"]) {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  process.exit(0);
}
db.pragma("wal_checkpoint(TRUNCATE)");

const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const prunable = new Set<string>(PRUNABLE_EVENT_TYPES);

function perDay(): Map<string, { total: number; prunable: number; types: Map<string, number> }> {
  const rows = db.prepare("SELECT substr(created_at, 1, 10) AS day, type, COUNT(*) AS c FROM events GROUP BY day, type").all() as Array<{ day: string; type: string; c: number }>;
  const out = new Map<string, { total: number; prunable: number; types: Map<string, number> }>();
  for (const r of rows) {
    const d = out.get(r.day) ?? { total: 0, prunable: 0, types: new Map() };
    d.total += r.c;
    if (prunable.has(r.type)) d.prunable += r.c;
    d.types.set(r.type, r.c);
    out.set(r.day, d);
  }
  return out;
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0);

async function sweep(label: string, at: string) {
  const statementMs: number[] = [];
  let mark = performance.now();
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const t0 = performance.now();
  const summary = await pruneEvents(db, {
    nowIso: at,
    eventsRetentionDays: retentionDays,
    eventsWindow: window,
    eventsPauseMs: pauseMs,
    eventsYield: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
      mark = performance.now();
    },
    onEventsWindow: () => { statementMs.push(performance.now() - mark); },
  });
  const totalMs = performance.now() - t0;
  histogram.disable();
  // The first statement's time also covers reading the mark and the seq bounds; report it apart.
  const first = statementMs[0] ?? 0;
  const sorted = statementMs.slice(1).sort((a, b) => a - b);
  console.log(`\n### ${label} (now ${at}, ${retentionDays} days, window ${window}, pause ${pauseMs} ms)`);
  console.log(`- deleted ${summary.deletedRows} events in ${summary.batches} statements; low-water seq ${summary.lowWater}`);
  console.log(`- events pass time ${(totalMs / 1000).toFixed(2)} s (the time it adds to the boot sweep and to the daily one)`);
  console.log(`- first statement (with the mark and bounds reads): ${first.toFixed(1)} ms`);
  console.log(`- the other ${sorted.length} statements: max ${pct(sorted, 100).toFixed(1)} ms, p99 ${pct(sorted, 99).toFixed(1)} ms, p50 ${pct(sorted, 50).toFixed(1)} ms`);
  console.log(`- event-loop delay during the sweep: max ${(histogram.max / 1e6).toFixed(1)} ms, p99 ${(histogram.percentile(99) / 1e6).toFixed(1)} ms`);
  return summary;
}

const before = perDay();
const sizeBefore = { db: size(values.db), wal: size(`${values.db}-wal`) };
await sweep("First sweep (as at boot after the upgrade)", nowIso);
const sizeAfterSweep = { db: size(values.db), wal: size(`${values.db}-wal`) };
const after = perDay();
const nextDay = new Date(new Date(nowIso).getTime() + 86_400_000).toISOString();
await sweep("Second sweep, one day later (steady state)", nextDay);
db.pragma("wal_checkpoint(TRUNCATE)");
const freelist = db.pragma("freelist_count", { simple: true }) as number;
const pageSize = db.pragma("page_size", { simple: true }) as number;

console.log("\n### Rows per day, before → after the first sweep");
console.log("| day | all before | all after | prunable before | prunable after | view.changed before | view.changed after |");
console.log("|---|---:|---:|---:|---:|---:|---:|");
for (const day of [...before.keys()].sort()) {
  const b = before.get(day)!;
  const a = after.get(day);
  console.log(`| ${day} | ${b.total} | ${a?.total ?? 0} | ${b.prunable} | ${a?.prunable ?? 0} | ${b.types.get("view.changed") ?? 0} | ${a?.types.get("view.changed") ?? 0} |`);
}

console.log("\n### Rows per type, before → after the first sweep (all days)");
const typeTotals = (m: typeof before) => {
  const t = new Map<string, number>();
  for (const d of m.values()) for (const [k, v] of d.types) t.set(k, (t.get(k) ?? 0) + v);
  return t;
};
const tb = typeTotals(before);
const ta = typeTotals(after);
console.log("| type | prunable | before | after |");
console.log("|---|:-:|---:|---:|");
for (const [type, n] of [...tb.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`| ${type} | ${prunable.has(type) ? "yes" : ""} | ${n} | ${ta.get(type) ?? 0} |`);
}

console.log("\n### File size");
console.log(`- before: db ${mb(sizeBefore.db)}, -wal ${mb(sizeBefore.wal)}`);
console.log(`- right after the first sweep (PASSIVE checkpoint): db ${mb(sizeAfterSweep.db)}, -wal ${mb(sizeAfterSweep.wal)}`);
console.log(`- after a TRUNCATE checkpoint: db ${mb(size(values.db))}, -wal ${mb(size(`${values.db}-wal`))}; free pages ${freelist} (${mb(freelist * pageSize)} reusable; the file only shrinks with an offline VACUUM)`);
db.close();
