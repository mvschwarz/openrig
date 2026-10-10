import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { usageSamplesLatestIndexesSchema } from "../src/db/migrations/094_usage_samples_latest_indexes.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { computeTopBurn, queryUsageSeries } from "../src/domain/usage-series.js";

const start = Date.parse("2026-08-07T09:00:00.000Z");
const nowIso = "2026-08-07T12:00:00.000Z";
const at = (index: number) => new Date(start + index * 1000).toISOString();

it("counts the latest context change beyond the raw-series default page", () => {
  const db = new BetterSqlite3(":memory:"); db.exec(usageSamplesSchema.sql); db.exec(usageSamplesLatestIndexesSchema.sql);
  try {
    const store = new UsageSamplesStore(db);
    db.transaction(() => {
      for (let index = 0; index <= 10_000; index++) store.appendContextSample({ nodeId: "n", seatSession: "seat", source: "fixture",
        sampledAt: at(index), totalInputTokens: index === 10_000 ? 1000 : 0, totalOutputTokens: 0, usedPercentage: 0 }, at(index));
    })();
    expect(queryUsageSeries(db, { seatSession: "seat" })).toHaveLength(10_000);
    expect(queryUsageSeries(db, { seatSession: "seat", limit: 2 })).toHaveLength(2);
    const row = computeTopBurn(db, { windowHours: 4, nowIso }).ranked[0]!;
    expect(row.tokensDelta).toBe(1000);
    expect(row.samples).toBe(10_001);
    expect(row.spanHours).toBeCloseTo(10_000 / 3600);
  } finally { db.close(); }
});

it("uses the latest provider endpoint beyond the raw-series default page", () => {
  const db = new BetterSqlite3(":memory:"); db.exec(usageSamplesSchema.sql); db.exec(usageSamplesLatestIndexesSchema.sql);
  try {
    const store = new UsageSamplesStore(db);
    for (const index of [0, 10_000]) store.appendContextSample({ nodeId: "n", seatSession: "seat", source: "fixture",
      sampledAt: at(index), totalInputTokens: index, totalOutputTokens: 0, usedPercentage: 0 }, at(index));
    db.transaction(() => {
      for (let index = 0; index <= 10_000; index++) store.appendProviderWindowSample({ seatSession: "seat", window: "five_hour",
        usedPercent: index === 10_000 ? 50 : 10, resetsAt: "2026-08-07T14:00:00.000Z", asOf: at(index) }, at(index));
    })();
    const window = computeTopBurn(db, { windowHours: 4, nowIso }).ranked[0]!.windows[0]!;
    expect(window.usedPercentLast).toBe(50);
    expect(window.percentPerHour).toBeCloseTo(40 / (10_000 / 3600));
  } finally { db.close(); }
});
