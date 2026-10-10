import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { usageSamplesLatestIndexesSchema } from "../src/db/migrations/094_usage_samples_latest_indexes.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";

const BEFORE = ALL_MIGRATIONS.filter(m => m.name < usageSamplesLatestIndexesSchema.name);
const THROUGH = ALL_MIGRATIONS.filter(m => m.name <= usageSamplesLatestIndexesSchema.name);
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function database(indexed = false) {
  const db = createDb();
  databases.push(db);
  migrate(db, indexed ? THROUGH : BEFORE);
  return db;
}
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const context = (value: number) => ({
  nodeId: "node", seatSession: "worker@test", source: "fixture", sampledAt: at(value),
  totalInputTokens: value, totalOutputTokens: 0, usedPercentage: value,
});
const windowSample = (value: number) => ({
  seatSession: "worker@test", window: "weekly" as const,
  asOf: at(value), usedPercent: value, resetsAt: null,
});
const rows = (db: Database.Database) => db.prepare("SELECT * FROM usage_samples ORDER BY id").all();

function latestReadPlans(db: Database.Database) {
  const spy = vi.spyOn(db, "prepare");
  let reads: string[];
  try {
    const store = new UsageSamplesStore(db);
    store.appendContextSample(context(1), at(1));
    store.appendProviderWindowSample(windowSample(1), at(1));
    reads = spy.mock.calls.map(([sql]) => sql).filter(sql => /^SELECT sampled_at/.test(sql));
  } finally {
    spy.mockRestore();
  }
  expect(reads).toHaveLength(2);
  return reads.map(sql => db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...["worker@test", "weekly"].slice(0, sql.split("?").length - 1))
    .map(row => (row as { detail: string }).detail).join(" | "));
}

describe("usage-sample latest-row indexes", () => {
  it("removes the sort from both actual store queries without changing their ordering", () => {
    const db = database();
    for (const plan of latestReadPlans(db)) {
      expect(plan).toContain("SEARCH usage_samples");
      expect(plan).toContain("TEMP B-TREE");
    }
    migrate(db, THROUGH);
    const plans = latestReadPlans(db);
    expect(plans[0]).toContain("idx_usage_samples_context_latest");
    expect(plans[1]).toContain("idx_usage_samples_window_latest");
    for (const plan of plans) {
      expect(plan).toContain("SEARCH usage_samples");
      expect(plan).not.toContain("TEMP B-TREE");
    }
  });

  it.each([false, true])("upgrades current schema (populated=%s) and reapplying is inert", populated => {
    const db = database();
    if (populated) {
      const store = new UsageSamplesStore(db);
      for (const value of [1, 2, 3]) {
        store.appendContextSample(context(value), at(4 - value));
        store.appendProviderWindowSample(windowSample(value), at(4 - value));
      }
    }
    const beforeRows = rows(db);
    const tables = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const beforeTables = tables();
    const oldIndexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name").all();
    const sequence = db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all();
    migrate(db, THROUGH);
    expect(rows(db)).toEqual(beforeRows);
    expect(tables()).toEqual(beforeTables);
    expect(db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all()).toEqual(sequence);
    const newIndexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name").all();
    expect(newIndexes).toEqual(expect.arrayContaining(oldIndexes));
    expect(newIndexes.length - oldIndexes.length).toBe(2);
    const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY name").all();
    expect(ledger).toContainEqual(expect.objectContaining({ name: usageSamplesLatestIndexesSchema.name }));
    const version = db.pragma("schema_version", { simple: true });
    migrate(db, THROUGH);
    db.exec(usageSamplesLatestIndexesSchema.sql); // SQL is safe even outside the ledger guard.
    expect(db.pragma("schema_version", { simple: true })).toBe(version);
    expect(rows(db)).toEqual(beforeRows);
    expect(db.prepare("SELECT * FROM schema_migrations ORDER BY name").all()).toEqual(ledger);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("installs the indexes through the full empty-database migration path", () => {
    const db = database(true);
    for (const plan of latestReadPlans(db)) expect(plan).not.toContain("TEMP B-TREE");
  });

  for (const lane of ["context", "provider_window"] as const) {
    it.each([
      { name: "increasing", captures: [10, 20, 30], values: [1, 2, 2], expected: [true, true, false] },
      { name: "equal-time tie", captures: [10, 10, 10], values: [1, 2, 2], expected: [true, true, false] },
      { name: "clock backstep, idle", captures: [20, 10, 11], values: [1, 2, 2], expected: [true, true, false] },
      { name: "clock backstep, return", captures: [20, 10, 11], values: [1, 2, 1], expected: [true, true, true] },
    ])(`${lane}: preserves insertion-order dedup for $name`, ({ captures, values, expected }) => {
      const observe = (indexed: boolean) => {
        const db = database(indexed), store = new UsageSamplesStore(db);
        // Interleave another seat and provider window to check the filter boundary.
        const decisions = values.map((value, i) => {
          store.appendContextSample({ ...context(value), seatSession: "other@test" }, at(59));
          store.appendProviderWindowSample({ ...windowSample(value), window: "five_hour" }, at(59));
          return lane === "context"
            ? store.appendContextSample(context(value), at(captures[i]!))
            : store.appendProviderWindowSample(windowSample(value), at(captures[i]!));
        });
        expect(decisions).toEqual(expected);
        return { decisions, rows: rows(db) };
      };
      expect(observe(true)).toEqual(observe(false));
    });
  }
});
