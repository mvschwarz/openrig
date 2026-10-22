// 51-08 A3 — telemetry routes: the series + top-N burn served over HTTP from
// the ONE projection (PM decision 4: one projection, CLI + HTTP both).
// RED-first: written before routes/telemetry.ts existed.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { telemetryRoutes } from "../src/routes/telemetry.js";

function seeded(): Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(usageSamplesSchema.sql);
  const store = new UsageSamplesStore(db);
  const seed = (seat: string, at: string, tin: number) =>
    store.appendContextSample(
      {
        nodeId: `n-${seat}`,
        seatSession: seat,
        source: "claude_statusline_json",
        sampledAt: at,
        totalInputTokens: tin,
        totalOutputTokens: 0,
        usedPercentage: 10,
      },
      at,
    );
  seed("burner@r", "2026-08-07T10:00:00.000Z", 100_000);
  seed("burner@r", "2026-08-07T12:00:00.000Z", 700_000);
  seed("calm@r", "2026-08-07T10:00:00.000Z", 1_000);
  seed("calm@r", "2026-08-07T12:00:00.000Z", 2_000);
  return db;
}

function appWith(db: Database, nowIso: string): Hono {
  const app = new Hono();
  app.route("/api/telemetry", telemetryRoutes({ db: () => db, nowIso: () => nowIso }));
  return app;
}

describe("telemetry routes", () => {
  const NOW = "2026-08-07T12:30:00.000Z";

  it("GET /usage/series serves raw rows for a seat, and no response key carries account identity", async () => {
    const app = appWith(seeded(), NOW);
    const res = await app.request("/api/telemetry/usage/series?seat=burner%40r");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows.length).toBe(2);
    expect(body.rows[0]!.seatSession).toBe("burner@r");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("account");
  });

  it("GET /usage/series refuses a limit SQLite cannot bind instead of a 500", async () => {
    const app = appWith(seeded(), NOW);
    for (const limit of ["9223372036854775296", "1e19"]) {
      const res = await app.request(`/api/telemetry/usage/series?seat=burner%40r&limit=${limit}`);
      expect({ limit, status: res.status }).toEqual({ limit, status: 400 });
      expect(((await res.json()) as { error: string }).error).toContain("invalid limit");
    }
    // Limits main served keep their rows.
    const rows = async (query: string) => {
      const res = await app.request(`/api/telemetry/usage/series?seat=burner%40r${query}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { rows: unknown[] }).rows;
    };
    const all = await rows("");
    expect(all).toHaveLength(2);
    expect(await rows("&limit=9223372036854775295")).toEqual(all);
    expect(await rows("&limit=1")).toHaveLength(1);
  });

  // A bound keeps main's handling (text comparison against captured_at unless capturedAtBound reads a full
  // ISO instant). A bound that isn't a date or time gets an advisory; any other gets no advisories field.
  const T10 = "2026-08-07T10:00:00.000Z", T12 = "2026-08-07T12:00:00.000Z";
  it.each([
    ["since=garbage", [], ['since "garbage"']],
    ["until=garbage", [T10, T10, T12, T12], ['until "garbage"']],
    ["since=2026-13-45", [], ['since "2026-13-45"']],
    ["since=garbage&until=garbage", [], ['since "garbage"', 'until "garbage"']],
    ["since=2026-08-07T11", [T12, T12], []],
    ["until=2026-08-07T11", [T10, T10], []],
    ["since=2026-08-07", [T10, T10, T12, T12], []],
    ["since=&until=", [T10, T10, T12, T12], []],
    ["", [T10, T10, T12, T12], []],
    ["since=2026-08-07T11:00:00.000Z", [T12, T12], []],
  ] as Array<[string, string[], string[]]>)("GET /usage/series?%s keeps main's rows, with an advisory only for a bound that isn't a date or time", async (query, capturedAts, advised) => {
    const res = await appWith(seeded(), NOW).request(`/api/telemetry/usage/series?${query}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ capturedAt: string }>; advisories?: string[] };
    expect(body.rows.map((r) => r.capturedAt)).toEqual(capturedAts);
    if (advised.length === 0) {
      expect("advisories" in body).toBe(false);
    } else {
      expect(body.advisories).toEqual(advised.map((bound) =>
        `${bound} was not recognised as a date or time; the existing text comparison against captured_at was used`));
    }
  });

  it("GET /usage/top ranks the burner top-1 with tokens/hour computed from the series", async () => {
    const app = appWith(seeded(), NOW);
    const res = await app.request("/api/telemetry/usage/top?window_hours=4&top=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ranked: Array<{ seatSession: string; tokensPerHour: number }>;
      unknown: unknown[];
      totalRankedSeats: number;
    };
    expect(body.ranked[0]!.seatSession).toBe("burner@r");
    expect(body.ranked[0]!.tokensPerHour).toBe(300_000);
    expect(body.totalRankedSeats).toBe(2);
  });

  it.each(["2500000000", "1e308"])("out-of-range finite window %s returns 400", async (window) => {
    const db = seeded();
    try {
      const res = await appWith(db, NOW).request(`/api/telemetry/usage/top?window_hours=${window}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/supported date range/);
    } finally {
      db.close();
    }
  });

  it("invalid window_hours is a teaching 400, never a silent default", async () => {
    const app = appWith(seeded(), NOW);
    const res = await app.request("/api/telemetry/usage/top?window_hours=zero");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/window_hours/);
  });
});
