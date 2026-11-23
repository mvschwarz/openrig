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
      runningSeats: psService.countRunningSeats(),
      capture: getTranscriptCaptureStats(),
    });
  });
});

psRoutes.get("/", (c) => {
  const psService = c.get("psProjectionService" as never) as PsProjectionService;
  // OPR.0.3.3.19 - default excludes archived; ?includeArchived=true / ?archived=only opt in.
  const includeArchived = c.req.query("includeArchived") === "true";
  const archivedOnly = c.req.query("archived") === "only";
  // ?seats=true adds each rig's seat session names from the projection's one inventory pass: a caller that needs every
  // seat's name makes this one read, not one node read per rig.
  const seats = c.req.query("seats") === "true";
  // slice-04: the whole projection + JSON serialization runs as ONE cooperative
  // lane job (shared with /api/rigs/summary) so a concurrent burst yields the event
  // loop between jobs and /healthz stays responsive. Only query-flag parsing is here.
  return projectionLane.run(() => {
    const entries = psService.getEntries({ includeArchived, archivedOnly }, { seats });
    // #3636: the archived count rides beside the list as a header, so `rig ps` can print its count line from the default
    // (active-only) list instead of folding every archived rig. The bare-array body is unchanged. It's read after the
    // list, so the list stays the route's first read, and a failure in either is the route's existing 500.
    if (typeof psService.countArchivedRigs === "function") c.header("X-OpenRig-Archived-Count", String(psService.countArchivedRigs()));
    return c.json(entries);
  });
});
