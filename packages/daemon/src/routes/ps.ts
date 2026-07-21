import { Hono } from "hono";
import type { PsProjectionService } from "../domain/ps-projection.js";
import { projectionLane } from "../domain/projection-lane.js";

export const psRoutes = new Hono();

psRoutes.get("/", (c) => {
  const psService = c.get("psProjectionService" as never) as PsProjectionService;
  // OPR.0.3.3.19 - default excludes archived; ?includeArchived=true / ?archived=only opt in.
  const includeArchived = c.req.query("includeArchived") === "true";
  const archivedOnly = c.req.query("archived") === "only";
  // slice-04: the whole projection + JSON serialization runs as ONE cooperative
  // lane job (shared with /api/rigs/summary) so a concurrent burst yields the event
  // loop between jobs and /healthz stays responsive. Only query-flag parsing is here.
  return projectionLane.run(() => c.json(psService.getEntries({ includeArchived, archivedOnly })));
});
