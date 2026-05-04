// UI Enhancement Pack v0 — progress browse view route.
//
// Endpoint:
//   GET /api/progress/tree
//
// Returns the indexed PROGRESS.md hierarchy across operator-allowlisted
// scan roots (configured via OPENRIG_PROGRESS_SCAN_ROOTS). Empty roots
// → 503 with a setup hint, mirroring the slices-route shape so the UI
// can render a clear configuration message instead of a generic error.

import { Hono } from "hono";
import type { ProgressIndexer } from "../domain/progress/progress-indexer.js";

export interface ProgressRoutesDeps {
  indexer: ProgressIndexer;
}

export function progressRoutes(): Hono {
  const app = new Hono();

  function getDeps(c: { get: (key: string) => unknown }): ProgressRoutesDeps | null {
    const indexer = c.get("progressIndexer" as never) as ProgressIndexer | undefined;
    if (!indexer) return null;
    return { indexer };
  }

  app.get("/tree", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "progress_indexer_unavailable" }, 503);
    if (!deps.indexer.isReady()) {
      return c.json({
        error: "progress_scan_roots_not_configured",
        hint: "Set OPENRIG_PROGRESS_SCAN_ROOTS=name1:/abs/path,name2:/abs/path and restart the daemon.",
      }, 503);
    }
    return c.json(deps.indexer.scan());
  });

  return app;
}
