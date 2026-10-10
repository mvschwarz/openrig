import { afterEach, beforeEach, expect, it } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { computeTopBurn } from "../src/domain/usage-series.js";
const NOW = "2026-08-07T12:00:00.000Z";
let db: Database;
let store: UsageSamplesStore;
beforeEach(() => { db = new BetterSqlite3(":memory:"); db.exec(usageSamplesSchema.sql); store = new UsageSamplesStore(db); });
afterEach(() => db.close());
function sample(at: string, input: number | null, output: number | null) {
  store.appendContextSample({ nodeId: "node-fixture", seatSession: "dev@fixture", source: "fixture",
    sampledAt: at, totalInputTokens: input, totalOutputTokens: output, usedPercentage: 50 }, at);
}
it("reports unknown instead of zero burn when token counters are unavailable", () => {
  sample("2026-08-07T10:00:00.000Z", null, null); sample(NOW, null, null);
  const result = computeTopBurn(db, { windowHours: 4, nowIso: NOW });
  expect(result.ranked).toEqual([]);
  expect(result.unknown).toEqual([{ seatSession: "dev@fixture", reason: "insufficient_samples" }]);
});
it("does not fabricate a rate from one partial and one complete observation", () => {
  sample("2026-08-07T10:00:00.000Z", 1000, null); sample(NOW, 1100, 200);
  expect(computeTopBurn(db, { windowHours: 4, nowIso: NOW }).ranked).toEqual([]);
});
it("ignores a missing-counter sample instead of inventing a restart and subsequent burn", () => {
  sample("2026-08-07T10:00:00.000Z", 1000, 100); sample("2026-08-07T11:00:00.000Z", null, null); sample(NOW, 1100, 100);
  const row = computeTopBurn(db, { windowHours: 4, nowIso: NOW }).ranked[0]!;
  expect(row.tokensDelta).toBe(100); expect(row.resets).toBe(0); expect(row.samples).toBe(2); expect(row.tokensPerHour).toBe(50);
});
it("includes the exact snapshot endpoint but excludes future context observations", () => {
  sample("2026-08-07T10:00:00.000Z", 1000, 0); sample(NOW, 1100, 0); sample("2026-08-07T13:00:00.000Z", 101100, 0);
  const row = computeTopBurn(db, { windowHours: 4, nowIso: NOW }).ranked[0]!;
  expect(row.samples).toBe(2); expect(row.tokensDelta).toBe(100); expect(row.spanHours).toBe(2);
});
it("excludes future provider observations from the same reporting snapshot", () => {
  sample("2026-08-07T10:00:00.000Z", 1000, 0); sample(NOW, 1100, 0);
  for (const [at, usedPercent] of [["2026-08-07T10:00:00.000Z", 10], [NOW, 20], ["2026-08-07T13:00:00.000Z", 90]] as const) {
    store.appendProviderWindowSample({ seatSession: "dev@fixture", window: "five_hour", usedPercent, resetsAt: null, asOf: at }, at);
  }
  const row = computeTopBurn(db, { windowHours: 4, nowIso: NOW }).ranked[0]!.windows[0]!;
  expect(row.usedPercentLast).toBe(20); expect(row.percentPerHour).toBe(5);
});
