import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { usageSamplesClientCostSchema } from "../src/db/migrations/105_usage_samples_client_cost.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { computeTopBurn } from "../src/domain/usage-series.js";

const NOW = "2026-08-07T12:00:00.000Z";
const SEAT = "dev@rig";
let db: Database;
let store: UsageSamplesStore;
beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  db.exec(usageSamplesSchema.sql);
  db.exec(usageSamplesClientCostSchema.sql);
  store = new UsageSamplesStore(db);
});
afterEach(() => db.close());

function sample(hour: string, session: string | null, input: number, output = 0,
  source = "claude_statusline_json", nodeId = "node-1") {
  const at = `2026-08-07T${hour}:00.000Z`;
  store.appendContextSample({ nodeId, seatSession: SEAT, source, sampledAt: at,
    totalInputTokens: input, totalOutputTokens: output, usedPercentage: 10,
    nativeSessionId: session }, at);
}
const top = () => computeTopBurn(db, { windowHours: 4, nowIso: NOW });

describe("top burn across native sessions on one seat", () => {
  it.each([100_000, 100])("does not measure across a new session's baseline of %i", (baseline) => {
    sample("10:00", "old", 1000);
    sample("12:00", "new", baseline);
    expect(top().ranked).toEqual([]);
    expect(top().unknown).toEqual([{ seatSession: SEAT, reason: "insufficient_samples" }]);
  });

  it("sums only measured movement in each native session", () => {
    sample("10:00", "old", 1000, 100);
    sample("10:30", "old", 1200, 150);
    sample("11:00", "new", 100_000, 5000);
    sample("12:00", "new", 100_500, 5050);
    expect(top().ranked[0]).toMatchObject({ tokensDelta: 800, tokensPerHour: 400, resets: 0, samples: 4 });
  });

  it("does not turn a lower new-session baseline into a counter reset", () => {
    sample("10:00", "old", 100_000);
    sample("10:30", "old", 100_200);
    sample("11:00", "new", 1000);
    sample("12:00", "new", 1500);
    expect(top().ranked[0]).toMatchObject({ tokensDelta: 700, resets: 0 });
  });

  it("still reports a counter reset within one native session", () => {
    sample("10:00", "same", 1000);
    sample("10:30", "same", 1200);
    sample("11:00", "same", 100);
    sample("12:00", "same", 150);
    expect(top().ranked[0]).toMatchObject({ tokensDelta: 250, resets: 1 });
  });

  it("keeps sources separate when a seat changes runtime", () => {
    sample("10:00", "same-id", 1000);
    sample("10:30", "same-id", 1200);
    sample("11:00", "same-id", 100_000, 0, "codex_token_count_jsonl");
    sample("12:00", "same-id", 100_500, 0, "codex_token_count_jsonl");
    expect(top().ranked[0]).toMatchObject({ tokensDelta: 700, resets: 0 });
  });

  it("keeps node histories separate even when their native session matches", () => {
    sample("10:00", "same", 1000);
    sample("10:30", "same", 100_000, 0, "claude_statusline_json", "node-2");
    sample("11:00", "same", 1200);
    sample("12:00", "same", 100_500, 0, "claude_statusline_json", "node-2");
    expect(top().ranked[0]).toMatchObject({ tokensDelta: 700, resets: 0 });
  });

  it("does not compare unidentified history with a known native session", () => {
    sample("10:00", null, 1000);
    sample("10:30", null, 1200);
    sample("11:00", "known", 100_000);
    sample("12:00", "known", 100_500);
    expect(top().ranked[0]).toMatchObject({ tokensDelta: 700, resets: 0 });
  });
});
