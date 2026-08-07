// 51-08 A3 — the over-time query + top-N burn projection (plan-lock rev-1).
// PM decisions 3+4: ONE daemon-side projection serves both the route and the
// CLI — no fifth copy of thresholds; the rig serves FACTS (rates, spans,
// deltas), the detector owns judgments. RED-first: written before
// usage-series.ts existed.
import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { queryUsageSeries, computeTopBurn } from "../src/domain/usage-series.js";

const NOW = "2026-08-07T12:00:00.000Z";

function db_(): Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(usageSamplesSchema.sql);
  return db;
}

function seedContext(
  store: UsageSamplesStore,
  seat: string,
  at: string,
  tin: number,
  tout: number,
): void {
  store.appendContextSample(
    {
      nodeId: `n-${seat}`,
      seatSession: seat,
      source: "claude_statusline_json",
      sampledAt: at,
      totalInputTokens: tin,
      totalOutputTokens: tout,
      usedPercentage: 10,
    },
    at,
  );
}

describe("queryUsageSeries — raw rows, time-bounded, per-seat", () => {
  let db: Database;
  let store: UsageSamplesStore;
  beforeEach(() => {
    db = db_();
    store = new UsageSamplesStore(db);
  });

  it("serves the RAW stored rows filtered by seat and since-bound, oldest first", () => {
    seedContext(store, "a@r", "2026-08-07T10:00:00.000Z", 1000, 100);
    seedContext(store, "a@r", "2026-08-07T11:00:00.000Z", 3000, 200);
    seedContext(store, "b@r", "2026-08-07T11:00:00.000Z", 500, 50);
    const rows = queryUsageSeries(db, { seatSession: "a@r", sinceIso: "2026-08-07T09:00:00.000Z" });
    expect(rows.map((r) => r.totalInputTokens)).toEqual([1000, 3000]);
    expect(rows.every((r) => r.seatSession === "a@r")).toBe(true);
    // no account field in any served row (Option-A pin at the projection)
    for (const r of rows) {
      expect(Object.keys(r).some((k) => /account/i.test(k))).toBe(false);
    }
  });

  it("since-bound is absolute on captured_at: a row just outside is excluded, just inside included", () => {
    seedContext(store, "a@r", "2026-08-07T09:59:59.999Z", 1000, 100);
    seedContext(store, "a@r", "2026-08-07T10:00:00.001Z", 2000, 100);
    const rows = queryUsageSeries(db, { seatSession: "a@r", sinceIso: "2026-08-07T10:00:00.000Z" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.totalInputTokens).toBe(2000);
  });
});

describe("computeTopBurn — tokens/hour + window velocity, facts not judgments", () => {
  let db: Database;
  let store: UsageSamplesStore;
  beforeEach(() => {
    db = db_();
    store = new UsageSamplesStore(db);
  });

  it("ranks seats by tokens/hour over the window; the synthetic burner is top-1", () => {
    // burner: 600k tokens across 10:00→12:00 (2h) = 300k/h
    seedContext(store, "burner@r", "2026-08-07T10:00:00.000Z", 100_000, 0);
    seedContext(store, "burner@r", "2026-08-07T11:00:00.000Z", 400_000, 0);
    seedContext(store, "burner@r", "2026-08-07T12:00:00.000Z", 700_000, 0);
    // calm seat: 10k across the same span = 5k/h
    seedContext(store, "calm@r", "2026-08-07T10:00:00.000Z", 10_000, 0);
    seedContext(store, "calm@r", "2026-08-07T12:00:00.000Z", 20_000, 0);
    const top = computeTopBurn(db, { windowHours: 4, nowIso: NOW });
    expect(top.ranked.length).toBe(2);
    expect(top.ranked[0]!.seatSession).toBe("burner@r");
    expect(top.ranked[0]!.tokensPerHour).toBe(300_000);
    expect(top.ranked[1]!.seatSession).toBe("calm@r");
    expect(top.ranked[1]!.tokensPerHour).toBe(5_000);
  });

  it("a totals RESET (restart) never fabricates negative burn: positive deltas sum, resets counted", () => {
    seedContext(store, "a@r", "2026-08-07T10:00:00.000Z", 500_000, 0);
    seedContext(store, "a@r", "2026-08-07T11:00:00.000Z", 600_000, 0); // +100k
    seedContext(store, "a@r", "2026-08-07T11:30:00.000Z", 50_000, 0);  // RESET (restart)
    seedContext(store, "a@r", "2026-08-07T12:00:00.000Z", 150_000, 0); // +100k
    const top = computeTopBurn(db, { windowHours: 4, nowIso: NOW });
    expect(top.ranked[0]!.tokensPerHour).toBe(100_000); // 200k positive delta over 2h span
    expect(top.ranked[0]!.resets).toBe(1);
  });

  it("HONEST UNKNOWN: a seat with series history but <2 in-window samples is listed unknown, never 0", () => {
    seedContext(store, "stale@r", "2026-08-07T01:00:00.000Z", 100_000, 0);
    seedContext(store, "stale@r", "2026-08-07T02:00:00.000Z", 200_000, 0);
    seedContext(store, "single@r", "2026-08-07T11:30:00.000Z", 1_000, 0);
    const top = computeTopBurn(db, { windowHours: 2, nowIso: NOW });
    expect(top.ranked.length).toBe(0);
    const unknown = Object.fromEntries(top.unknown.map((u) => [u.seatSession, u.reason]));
    expect(unknown["stale@r"]).toBe("no_fresh_samples");
    expect(unknown["single@r"]).toBe("insufficient_samples");
    // and NEVER a fabricated zero row in the ranking
    expect(top.ranked.some((r) => r.tokensPerHour === 0)).toBe(false);
  });

  it("window velocity rides the provider lane per window kind (facts: first/last/velocity)", () => {
    store.appendProviderWindowSample(
      { seatSession: "a@r", window: "five_hour", usedPercent: 20, resetsAt: null, asOf: "2026-08-07T10:00:00.000Z" },
      "2026-08-07T10:00:00.000Z",
    );
    store.appendProviderWindowSample(
      { seatSession: "a@r", window: "five_hour", usedPercent: 60, resetsAt: null, asOf: "2026-08-07T12:00:00.000Z" },
      "2026-08-07T12:00:00.000Z",
    );
    seedContext(store, "a@r", "2026-08-07T10:00:00.000Z", 1000, 0);
    seedContext(store, "a@r", "2026-08-07T12:00:00.000Z", 2000, 0);
    const top = computeTopBurn(db, { windowHours: 4, nowIso: NOW });
    const w = top.ranked[0]!.windows.find((x) => x.window === "five_hour")!;
    expect(w.usedPercentFirst).toBe(20);
    expect(w.usedPercentLast).toBe(60);
    expect(w.percentPerHour).toBe(20); // +40% over 2h
  });

  it("topN caps the ranking; the cap is reported so truncation is never silent", () => {
    for (let i = 0; i < 5; i += 1) {
      seedContext(store, `s${i}@r`, "2026-08-07T10:00:00.000Z", 0, 0);
      seedContext(store, `s${i}@r`, "2026-08-07T12:00:00.000Z", (i + 1) * 1000, 0);
    }
    const top = computeTopBurn(db, { windowHours: 4, nowIso: NOW, topN: 2 });
    expect(top.ranked.length).toBe(2);
    expect(top.ranked[0]!.seatSession).toBe("s4@r");
    expect(top.totalRankedSeats).toBe(5);
  });
});
