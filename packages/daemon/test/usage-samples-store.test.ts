// 51-08 A1 (plan-lock 2026-08-07, PM rev-1: README d606b9cbe2e5f4e8) — the append-only
// per-seat usage series. RED-first: this file imported the migration + store before they
// existed. Locked decisions bound here: dedicated table (not events), advance-only rows
// (zero idle growth), Option-A bar (no account identity anywhere in the new lane).
import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import {
  UsageSamplesStore,
  type ContextSampleInput,
  type ProviderWindowSampleInput,
} from "../src/domain/usage-samples-store.js";

function freshDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(usageSamplesSchema.sql);
  return db;
}

const ctx = (over: Partial<ContextSampleInput> = {}): ContextSampleInput => ({
  nodeId: "node-1",
  seatSession: "dev50-qa@v-openrig-build",
  source: "claude_statusline_json",
  sampledAt: "2026-08-07T09:00:00.000Z",
  totalInputTokens: 1000,
  totalOutputTokens: 200,
  usedPercentage: 12.5,
  ...over,
});

const win = (over: Partial<ProviderWindowSampleInput> = {}): ProviderWindowSampleInput => ({
  seatSession: "dev50-qa@v-openrig-build",
  window: "five_hour",
  usedPercent: 40,
  resetsAt: "2026-08-07T12:00:00.000Z",
  asOf: "2026-08-07T09:00:00.000Z",
  ...over,
});

describe("062 usage_samples — append-only series (contract item 1)", () => {
  let db: Database;
  let store: UsageSamplesStore;
  beforeEach(() => {
    db = freshDb();
    store = new UsageSamplesStore(db);
  });

  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM usage_samples").get() as { n: number }).n;

  it("two ADVANCED context samples append two rows; an unchanged sample appends none (zero idle growth)", () => {
    expect(store.appendContextSample(ctx(), "2026-08-07T09:00:01.000Z")).toBe(true);
    // identical sample re-observed on the next tick — the idle seat
    expect(store.appendContextSample(ctx(), "2026-08-07T09:00:31.000Z")).toBe(false);
    expect(count()).toBe(1);
    // the sample ADVANCED (new sampled_at + token movement)
    expect(
      store.appendContextSample(
        ctx({ sampledAt: "2026-08-07T09:00:30.000Z", totalInputTokens: 5000, usedPercentage: 14.1 }),
        "2026-08-07T09:01:01.000Z",
      ),
    ).toBe(true);
    expect(count()).toBe(2);
  });

  it("a value change with an unmoved sampled_at still appends (values are part of advancement)", () => {
    store.appendContextSample(ctx(), "t1");
    expect(store.appendContextSample(ctx({ totalOutputTokens: 900 }), "t2")).toBe(true);
    expect(count()).toBe(2);
  });

  it("advance detection is per SEAT: another seat's identical values append independently", () => {
    store.appendContextSample(ctx(), "t1");
    expect(store.appendContextSample(ctx({ seatSession: "dev-qa@v-openrig-build", nodeId: "node-2" }), "t1")).toBe(true);
    expect(count()).toBe(2);
    // and the first seat's unchanged sample still refuses growth
    expect(store.appendContextSample(ctx(), "t2")).toBe(false);
  });

  it("rows are APPEND-only: a new sample never mutates the prior row (unlike context_usage's upsert)", () => {
    store.appendContextSample(ctx(), "t1");
    store.appendContextSample(ctx({ sampledAt: "2026-08-07T09:00:30.000Z", totalInputTokens: 9999 }), "t2");
    const rows = db
      .prepare("SELECT total_input_tokens AS tin FROM usage_samples ORDER BY id")
      .all() as Array<{ tin: number }>;
    expect(rows.map((r) => r.tin)).toEqual([1000, 9999]); // history preserved, not overwritten
  });
});

describe("062 usage_samples — provider rate-limit windows (contract item 2)", () => {
  let db: Database;
  let store: UsageSamplesStore;
  beforeEach(() => {
    db = freshDb();
    store = new UsageSamplesStore(db);
  });

  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM usage_samples").get() as { n: number }).n;

  it("five_hour and weekly windows accrue per-seat series rows carrying usedPercent + resetsAt", () => {
    expect(store.appendProviderWindowSample(win(), "t1")).toBe(true);
    expect(store.appendProviderWindowSample(win({ window: "weekly", usedPercent: 12 }), "t1")).toBe(true);
    expect(count()).toBe(2);
    const row = db
      .prepare("SELECT window, window_used_percent AS up, resets_at AS ra FROM usage_samples WHERE window = 'five_hour'")
      .get() as { window: string; up: number; ra: string };
    expect(row.up).toBe(40);
    expect(row.ra).toBe("2026-08-07T12:00:00.000Z");
  });

  it("advance-only holds per (seat, window): unchanged asOf+values append none; movement appends", () => {
    store.appendProviderWindowSample(win(), "t1");
    expect(store.appendProviderWindowSample(win(), "t2")).toBe(false);
    expect(store.appendProviderWindowSample(win({ asOf: "2026-08-07T09:05:00.000Z", usedPercent: 43 }), "t3")).toBe(true);
    // the sibling window's advancement is independent
    store.appendProviderWindowSample(win({ window: "weekly", usedPercent: 12 }), "t3");
    expect(store.appendProviderWindowSample(win({ window: "weekly", usedPercent: 12 }), "t4")).toBe(false);
    expect(count()).toBe(3);
  });

  it("OPTION-A PIN (negative): the table carries NO account identity column, and no row can smuggle one", () => {
    const cols = (db.prepare("PRAGMA table_info(usage_samples)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of cols) {
      expect(col.toLowerCase()).not.toMatch(/account/);
    }
    // seat identity is the ONLY identity: the row's identity columns are seat/node
    expect(cols).toContain("seat_session");
    expect(cols).toContain("node_id");
  });
});
