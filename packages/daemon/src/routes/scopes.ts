// SCOPES VIEW (sealed plan d64d2f5c) — the store-direct read routes behind the scopes TUI.
// GET /api/scopes?mission=X          -> mission slice summaries (cards/counts/locks)
// GET /api/scopes/slice?mission=&slice= -> the full detail (intent/mini-reqs/contract+drops)
// GET /api/scopes/narrative?mission=&slice= -> PROGRESS.md RAW for the `n` DISPLAY only
// Data path: README frontmatter locks + proof/ C1 drops — never PROGRESS.md for counts.
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import { projectMissionScopes, projectSliceScope, type ScopeFsDeps, type SliceScopeDetail } from "../domain/scope/scope-view-projection.js";

const realFs: ScopeFsDeps = {
  exists: (p) => fs.existsSync(p),
  readFile: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
  listDir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
  isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
};

function rootOf(c: { get: (k: never) => unknown }): { root: string } | { error: Response } {
  const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
  if (!indexer) return { error: Response.json({ error: "slices_indexer_unavailable" }, { status: 503 }) };
  if (!indexer.isReady()) return { error: Response.json({ error: "slices_root_not_configured" }, { status: 503 }) };
  return { root: indexer.slicesRoot };
}

export function scopesRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const r = rootOf(c);
    if ("error" in r) return r.error;
    const mission = c.req.query("mission");
    const wantDetail = c.req.query("detail") === "1";
    const detailFor = (missionName: string, dirName: string): (SliceScopeDetail & { narrative: string | null }) | null => {
      const d = projectSliceScope(realFs, path.join(r.root, missionName, "slices", dirName));
      if (!d) return null;
      // The TUI one-read hydrate: narrative CONTENT rides inline for the `n` DISPLAY —
      // still never a data source (the projection never reads it for counts).
      const narrative = d.progressPath ? realFs.readFile(d.progressPath) : null;
      return { ...d, narrative };
    };
    if (mission) {
      const m = projectMissionScopes(realFs, r.root, mission);
      if (!m) return c.json({ error: "mission_not_found", mission }, 404);
      if (!wantDetail) return c.json(m);
      return c.json({ mission: m.mission, slices: m.slices.map((sl) => detailFor(mission, sl.dirName)).filter(Boolean) });
    }
    // No mission param: list every mission (the explorer tree); ?detail=1 upgrades rows to details.
    const missionNames = realFs.listDir(r.root).filter((e) => realFs.isDirectory(path.join(r.root, e)));
    const missions = missionNames
      .map((e) => projectMissionScopes(realFs, r.root, e))
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .map((m) => (wantDetail ? { mission: m.mission, slices: m.slices.map((sl) => detailFor(m.mission, sl.dirName)).filter(Boolean) } : m));
    return c.json({ missions });
  });

  app.get("/slice", (c) => {
    const r = rootOf(c);
    if ("error" in r) return r.error;
    const mission = c.req.query("mission");
    const slice = c.req.query("slice");
    if (!mission || !slice) return c.json({ error: "missing_params", hint: "?mission=&slice=" }, 400);
    const detail = projectSliceScope(realFs, path.join(r.root, mission, "slices", slice));
    return detail ? c.json(detail) : c.json({ error: "slice_not_found", mission, slice }, 404);
  });

  app.get("/narrative", (c) => {
    const r = rootOf(c);
    if ("error" in r) return r.error;
    const mission = c.req.query("mission");
    const slice = c.req.query("slice");
    if (!mission || !slice) return c.json({ error: "missing_params", hint: "?mission=&slice=" }, 400);
    const p = path.join(r.root, mission, "slices", slice, "PROGRESS.md");
    const content = realFs.readFile(p);
    // The narrative DISPLAY (plan atom 3): raw artifact bytes; explicitly not a data source.
    return content !== null ? c.json({ path: p, content }) : c.json({ error: "narrative_not_found" }, 404);
  });

  return app;
}
