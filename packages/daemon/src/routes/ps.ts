import { Hono } from "hono";
import type { PsProjectionService } from "../domain/ps-projection.js";
import { projectionLane } from "../domain/projection-lane.js";

import { availableParallelism, loadavg, platform } from "node:os";
import { getTranscriptCaptureStats } from "../domain/transcript-rotation.js";

export const psRoutes = new Hono();

// Separate opt-in payload: the ordinary /api/ps bare-array contract is unchanged.
psRoutes.get("/resources", (c) => {
  const psService = c.get("psProjectionService" as never) as PsProjectionService;
  return projectionLane.run(() => {
    const cpuCount = availableParallelism();
    const load = platform() === "win32" ? null : loadavg();
    return c.json({
      sampledAt: new Date().toISOString(), cpuCount,
      loadAverage: load, loadPerCpu: load ? load.map((value) => value / cpuCount) : null,
      // Forced archival can hide a rig without stopping its seats. Host load
      // measurements must count those running processes as well.
      runningSeats: psService.getEntries({ includeArchived: true, archivedOnly: false }).reduce((n, entry) => n + entry.runningCount, 0),
      capture: getTranscriptCaptureStats(),
    });
  });
});

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
