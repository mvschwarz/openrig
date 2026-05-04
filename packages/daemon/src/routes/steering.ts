// Operator Surface Reconciliation v0 — steering composition route.
//
// Endpoint:
//   GET /api/steering — composed payload for the /steering UI surface.
//
// Per PRD § Item 1, returns priority-stack + roadmap-rail + lane-rails
// in a single payload. The UI fetches in-motion + loop-state from
// existing PL-005 endpoints and health gates from /api/health-summary
// (kept separate so the steering composer stays narrow + testable).

import { Hono } from "hono";
import type { SteeringComposer } from "../domain/steering/steering-composer.js";

export interface SteeringRoutesDeps {
  composer: SteeringComposer;
}

export function steeringRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const composer = c.get("steeringComposer" as never) as SteeringComposer | undefined;
    if (!composer) return c.json({ error: "steering_composer_unavailable" }, 503);
    if (!composer.isReady()) {
      return c.json({
        error: "steering_workspace_not_configured",
        hint: "Set OPENRIG_STEERING_WORKSPACE=/abs/path (and optionally OPENRIG_STEERING_PATH / OPENRIG_ROADMAP_PATH / OPENRIG_DELIVERY_READY_DIR for non-canonical layouts) and restart the daemon.",
      }, 503);
    }
    return c.json(composer.compose());
  });

  return app;
}
