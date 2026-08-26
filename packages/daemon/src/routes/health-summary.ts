// Operator Surface Reconciliation v0 — compact health-summary routes.
//
// Endpoints (item 1F):
//   GET /api/health-summary/nodes    cross-rig roll-up of node sessionStatus + lifecycle
//   GET /api/health-summary/context  cross-rig roll-up of context-usage urgency + freshness
//   GET /api/health-summary/version  the daemon's own running version (OPR.0.4.1.14)
//
// The nodes/context routes wrap existing daemon-side aggregation helpers; the
// steering surface's compact gates consume them. The version route is a
// dependency-free read of the daemon's own package.json, so the dashboard Field
// Environment shows the REAL running daemon version (never the UI bundle
// version, which would silently drift on a version mismatch).

import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import {
  computeContextHealthSummary,
  computeNodeHealthSummary,
} from "../domain/steering/health-summary.js";
import { getDaemonVersion } from "../domain/daemon-version.js";

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

  // No deps: the running version is a read of the daemon's own package.json.
  // getDaemonVersion returns "unknown" on any read failure, so this route is
  // always 200 and the client renders the value (or its own honest fallback).
  app.get("/version", (c) => {
    return c.json({ version: getDaemonVersion() });
  });

  // S10 — the in-daemon gateway subsystem's health (amended M1 §3 shape). An absent handle is
  // reported honestly (a daemon built without the subsystem must not read as a healthy gateway).
  app.get("/gateway", (c) => {
    const subsystem = c.get("gatewaySubsystem" as never) as
      | { status: () => Record<string, unknown> }
      | undefined;
    if (!subsystem) return c.json({ error: "gateway_subsystem_unavailable" }, 503);
    return c.json(subsystem.status());
  });

  return app;
}
