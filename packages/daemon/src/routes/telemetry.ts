// 51-08 A3 — the telemetry read surface over usage_samples (plan-lock rev-1).
// Serves the ONE projection (usage-series.ts) that also backs the CLI (PM
// decision 4) — facts only; thresholds and judgments live at the edge (the
// oversight detector). Option-A bar: no account identity in any response.
import { Hono } from "hono";
import type { Database } from "better-sqlite3";
import { queryUsageSeries, computeTopBurn } from "../domain/usage-series.js";

export interface TelemetryRouteDeps {
  db: () => Database;
  /** injectable clock so tests and VM seeds are deterministic */
  nowIso?: () => string;
}

export function telemetryRoutes(deps: TelemetryRouteDeps): Hono {
  const app = new Hono();
  const now = deps.nowIso ?? (() => new Date().toISOString());

  app.get("/usage/series", (c) => {
    const seat = c.req.query("seat") || undefined;
    const lane = c.req.query("lane");
    const sinceIso = c.req.query("since") || undefined;
    const untilIso = c.req.query("until") || undefined;
    const limitRaw = c.req.query("limit");
    if (lane && lane !== "context" && lane !== "provider_window") {
      return c.json({ error: `unknown lane "${lane}" — known: context, provider_window` }, 400);
    }
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      limit = Number(limitRaw);
      if (!Number.isFinite(limit) || limit < 1) {
        return c.json({ error: `invalid limit "${limitRaw}" — must be a positive number` }, 400);
      }
    }
    const rows = queryUsageSeries(deps.db(), {
      seatSession: seat,
      lane: lane as "context" | "provider_window" | undefined,
      sinceIso,
      untilIso,
      limit,
    });
    return c.json({ rows });
  });

  app.get("/usage/top", (c) => {
    const windowRaw = c.req.query("window_hours") ?? "1";
    const windowHours = Number(windowRaw);
    if (!Number.isFinite(windowHours) || windowHours <= 0) {
      return c.json({ error: `invalid window_hours "${windowRaw}" — must be a positive number of hours` }, 400);
    }
    const topRaw = c.req.query("top");
    let topN: number | undefined;
    if (topRaw !== undefined) {
      topN = Number(topRaw);
      if (!Number.isFinite(topN) || topN < 1) {
        return c.json({ error: `invalid top "${topRaw}" — must be a positive count` }, 400);
      }
    }
    return c.json(computeTopBurn(deps.db(), { windowHours, nowIso: now(), topN }));
  });

  return app;
}
