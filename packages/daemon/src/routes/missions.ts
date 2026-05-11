// V0.3.1 slice 12 walk-item 1 — mission scope data layer.
//
// GET /api/missions/:missionId — returns aggregated mission metadata
// (missionPath + slices in this mission). Powers the Mission Overview
// + Mission Progress tabs in the Project surface; pairs with the
// generalized useScopeMarkdown hook which reads README.md / PROGRESS.md
// content via the existing /api/files/read route.
//
// Returns:
//   200 { missionId, missionPath, slices: SliceListEntry[] }
//   404 { error: "mission_not_found" } when no slices match
//   503 { error: "slices_indexer_unavailable" } when indexer not wired
//   503 { error: "slices_root_not_configured" } when indexer not ready
//
// This route does NOT itself read frontmatter / README / PROGRESS
// content — it's the metadata layer. File content reuses
// /api/files/read so the route surface stays minimal.

import { Hono } from "hono";
import * as path from "node:path";
import type { SliceIndexer, SliceListEntry } from "../domain/slices/slice-indexer.js";

export function missionsRoutes(): Hono {
  const app = new Hono();

  app.get("/:missionId", (c) => {
    const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    if (!indexer) {
      return c.json(
        {
          error: "slices_indexer_unavailable",
          hint: "Mission data layer requires the SliceIndexer to be wired into AppDeps.",
        },
        503,
      );
    }
    if (!indexer.isReady()) {
      return c.json(
        {
          error: "slices_root_not_configured",
          hint: "Run rig config init-workspace, or set workspace.slices_root to workspace/missions. Supported shape: missions/<mission>/slices/<slice>.",
        },
        503,
      );
    }
    const missionId = c.req.param("missionId");
    const allSlices = indexer.list();
    const slices = allSlices.filter((s) => s.missionId === missionId);
    if (slices.length === 0) {
      return c.json({ error: "mission_not_found", missionId }, 404);
    }
    const missionPath = computeMissionPath(slices[0]!);
    return c.json({
      missionId,
      missionPath,
      slices,
    });
  });

  return app;
}

/** Derive the mission folder's absolute path from any slice's
 *  `slicePath`. Slices live at
 *  `<missionsRoot>/<missionId>/slices/<sliceName>` per the workspace
 *  contract, so going up two levels yields the mission folder. */
function computeMissionPath(slice: SliceListEntry): string {
  // slicePath = <root>/<missionId>/slices/<sliceName>
  // up 2 levels = <root>/<missionId>
  return path.resolve(slice.slicePath, "..", "..");
}
