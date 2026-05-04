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
        hint: "Run rig config init-workspace, or set workspace.steering_path / OPENRIG_STEERING_PATH for non-canonical layouts, then restart the daemon.",
      }, 503);
    }
    return c.json(composer.compose());
  });

  return app;
}
