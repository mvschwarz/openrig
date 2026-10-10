// 51-08 A3 — the telemetry read surface over usage_samples (plan-lock rev-1).
// Serves the ONE projection (usage-series.ts) that also backs the CLI (PM
// decision 4) — facts only; thresholds and judgments live at the edge (the
// oversight detector). Option-A bar: no account identity in any response.
import { Hono } from "hono";
import type { Database } from "better-sqlite3";
import { queryUsageSeries, computeTopBurn } from "../domain/usage-series.js";
import { readTelemetryPage, TelemetryInputError, type TelemetrySource, type TelemetryStream } from "../domain/finite-telemetry.js";

export interface TelemetryRouteDeps {
  db: () => Database;
  /** injectable clock so tests and VM seeds are deterministic */
  nowIso?: () => string;
  source?: TelemetrySource;
}

export function telemetryRoutes(deps: TelemetryRouteDeps): Hono {
  const app = new Hono();
  const now = deps.nowIso ?? (() => new Date().toISOString());

  for (const [path, stream] of [["/v1/events", "events"], ["/v1/queue-transitions", "queue-transitions"], ["/v1/nodes/:nodeId/tenures", "tenures"]] as const) {
    app.get(path, (c) => {
      try {
        const input = { cursor: c.req.query("cursor"), start: c.req.query("start"), limit: c.req.query("limit"),
          nodeId: stream === "tenures" ? c.req.param("nodeId") : c.req.query("nodeId"), rigId: c.req.query("rigId"), qitemId: c.req.query("qitemId") };
        return c.json(readTelemetryPage(deps.db(), deps.source ?? { hostId: null, bootEpoch: null }, stream as TelemetryStream, input, now()));
      } catch (error) {
        if (error instanceof TelemetryInputError) return c.json({ code: "telemetry_invalid_request", error: error.message }, 400);
        // Database paths, SQL and stored content are not an error-response surface.
        return c.json({ code: "telemetry_read_unavailable", error: "Telemetry history could not be read.", coverage: { status: "unavailable", historyCompleteness: "unknown" } }, 503);
      }
    });
  }

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
    const nowIso = now();
    const since = new Date(new Date(nowIso).getTime() - windowHours * 3_600_000);
    if (!Number.isFinite(since.getTime())) {
      return c.json({ error: `invalid window_hours "${windowRaw}" — exceeds the supported date range` }, 400);
    }
    return c.json(computeTopBurn(deps.db(), { windowHours, nowIso, topN }));
  });

  return app;
}
