// Operator Surface Reconciliation v0 — compact health-summary routes.
//
// Endpoints (item 1F):
//   GET /api/health-summary/nodes    cross-rig roll-up of node sessionStatus + lifecycle
//   GET /api/health-summary/context  cross-rig roll-up of context-usage urgency + freshness
//
// Both wrap existing daemon-side aggregation helpers; the steering
// surface's compact gates consume them.

import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import {
  computeContextHealthSummary,
  computeNodeHealthSummary,
} from "../domain/steering/health-summary.js";

export interface HealthSummaryRoutesDeps {
  db: Database.Database;
  rigRepo: RigRepository;
}

export function healthSummaryRoutes(): Hono {
  const app = new Hono();

  function getDeps(c: { get: (key: string) => unknown }): HealthSummaryRoutesDeps | null {
    const rigRepo = c.get("rigRepo" as never) as RigRepository | undefined;
    if (!rigRepo) return null;
    return { db: rigRepo.db, rigRepo };
  }

  app.get("/nodes", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "health_summary_unavailable" }, 503);
    return c.json(computeNodeHealthSummary(deps));
  });

  app.get("/context", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "health_summary_unavailable" }, 503);
    return c.json(computeContextHealthSummary({ db: deps.db }));
  });

  return app;
}
