import { listProjects, selectedProject, projectReadResponse, projectMission, workSource, insideProject } from "../domain/workspace/project-read.js";
// SCOPES VIEW (sealed plan d64d2f5c) — the store-direct read routes behind the scopes TUI.
// GET /api/scopes?mission=X          -> mission slice summaries (cards/counts/locks)
// GET /api/scopes?counts=1           -> each slice's own node file only (id/name/status/stage/locks): no readiness, proof or narrative
// GET /api/scopes/slice?mission=&slice= -> the full detail (intent/mini-reqs/contract+drops)
// GET /api/scopes/narrative?mission=&slice= -> PROGRESS.md RAW for the `n` DISPLAY only
// Data path: README frontmatter locks + proof/ C1 drops — never PROGRESS.md for counts.
import { Hono } from "hono";
import { proofSourceObservation } from "../domain/proof/source-watch.js";
import { createProofPolicyRead, readMissionReadiness } from "../domain/proof/judgments.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import { projectSliceHeader, projectSliceScope, type ScopeFsDeps, type SliceScopeDetail } from "../domain/scope/scope-view-projection.js";
import { aggregateFleetScopes, type LocalScopesCounts } from "../domain/hosts/fleet-scopes.js";
import { loadHostRegistry } from "../domain/hosts/hosts-registry-reader.js";

const realFs: ScopeFsDeps = {
  readBytes: p => { try { return fs.readFileSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } },
  exists: (p) => fs.existsSync(p),
  readFile: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
  listDir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
  isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
};

function rootOf(c: Parameters<typeof selectedProject>[0]): { root: string } | { error: Response } {
  const selected = selectedProject(c);
  if (selected) return { root: selected.missionsRoot };
  const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
  if (!indexer) return { error: Response.json({ error: "slices_indexer_unavailable" }, { status: 503 }) };
  if (!indexer.isReady()) return { error: Response.json({ error: "slices_root_not_configured" }, { status: 503 }) };
  return { root: indexer.slicesRoot };
}

/** One counts row per slice directory — the cheap Projects-list projection.
 *  Shared by the local list route (`?counts=1`) and the fleet view's local leg,
 *  so both serve the same row for the same slice. */
function countsRow(sliceName: string, sliceDir: string, selected: ReturnType<typeof selectedProject>): Record<string, unknown> | null {
  let sourcePath: string | undefined;
  try {
    if (selected) sourcePath = workSource(selected.root, sliceDir, false);
    if (selected) workSource(selected.root, sliceDir);
    const header = projectSliceHeader(realFs, sliceDir);
    if (!header) return null;
    const { content: _content, fm: _fm, ...row } = header;
    return { ...row, ...(sourcePath ? { sourcePath } : {}) };
  } catch (err) {
    return { dirName: sliceName, id: null, displayName: sliceName, error: (err as Error).message, ...(sourcePath ? { sourcePath } : {}),
      status: null, stage: null, locks: { spec: null, delivery: null } };
  }
}

export function scopesRoutes(): Hono {
  const app = new Hono();
  app.get("/projects", c => { try { return c.json(listProjects(c)); } catch (err) { return projectReadResponse(err); } });
  app.onError(err => projectReadResponse(err));

  app.get("/", (c) => {
    const r = rootOf(c);
    if ("error" in r) return r.error;
    const selected = selectedProject(c);
    const mission = c.req.query("mission");
    if (selected && mission) projectMission(selected, mission);
    const wantDetail = c.req.query("detail") === "1";
    // A list that needs only names and statuses (Studio's Projects list) skips readiness and proof pairing, the bulk of the work.
    const wantCounts = !wantDetail && c.req.query("counts") === "1";
    const readPolicy = createProofPolicyRead();
    // A selected catalog project's own root bounds readiness, as in `rig proof` (never an ancestor's project.yaml).
    const bound = selected?.root;
    const detailFor = (missionName: string, dirName: string): (SliceScopeDetail & { narrative: string | null; error?: string }) | null => {
      let sourcePath: string | undefined;
      try {
        if (selected) sourcePath = workSource(selected.root, path.join(r.root, missionName, "slices", dirName), false);
        if (selected) workSource(selected.root, path.join(r.root, missionName, "slices", dirName));
        const d = projectSliceScope(realFs, path.join(r.root, missionName, "slices", dirName), readPolicy, bound);
        if (!d) return null;
        // The TUI one-read hydrate: narrative CONTENT rides inline for the `n` DISPLAY —
        // still never a data source (the projection never reads it for counts). Read only when detail is asked for.
        const narrative = wantDetail && d.progressPath ? realFs.readFile(d.progressPath) : null;
        return { ...d, narrative, ...(sourcePath ? { sourcePath } : {}) };
      } catch (err) {
        return { dirName, id: null, displayName: dirName, error: (err as Error).message, ...(sourcePath ? { sourcePath } : {}),
          status: null, stage: null, locks: { spec: null, delivery: null }, proof: { paired: 0, total: 0 },
          intent: "", miniRequirements: [], proofContract: [], progressPath: null, specShaShort: null, prdExists: false, narrative: null };
      }
    };
    const countsFor = (missionName: string, dirName: string) => countsRow(dirName, path.join(r.root, missionName, "slices", dirName), selected);
    const missionFor = (name: string) => {
      if (selected) projectMission(selected, name);
      const dir = path.join(r.root, name);
      const dirs = realFs.listDir(path.join(dir, "slices")).filter(s => realFs.isDirectory(path.join(dir, "slices", s)));
      if (wantCounts) return { mission: name, slices: dirs.map(s => countsFor(name, s)).filter((s): s is NonNullable<typeof s> => s !== null) };
      const slices = dirs.map(s => detailFor(name, s)).filter((s): s is NonNullable<typeof s> => s !== null);
      return { mission: name, slices: wantDetail ? slices : slices.map(({ intent, miniRequirements, proofContract, progressPath, specShaShort, prdExists, narrative, ...summary }) => summary), readiness: readMissionReadiness(dir, readPolicy, bound) };
    };
    if (mission) {
      if (!realFs.isDirectory(path.join(r.root, mission))) return c.json({ error: "mission_not_found", mission }, 404);
      return c.json(missionFor(mission));
    }
    // No mission param: list every mission (the explorer tree); ?detail=1 upgrades rows to details.
    const missionNames = realFs.listDir(r.root).filter((e) => realFs.isDirectory(path.join(r.root, e)));
    const readErrors: string[] = [];
    const sources: Record<string, string> = {};
    const missions = missionNames.map(name => {
      try {
        if (selected) sources[name] = workSource(selected.root, path.join(r.root, name), false);
        return missionFor(name);
      } catch (err) { return { mission: name, slices: [], error: (err as Error).message }; }
    });
    return c.json({ missions, sources, readErrors, project: selected, sourceObservation: proofSourceObservation(c) });
  });

  app.get("/slice", (c) => {
    const r = rootOf(c);
    if ("error" in r) return r.error;
    const selected = selectedProject(c);
    const mission = c.req.query("mission");
    if (selected && mission) projectMission(selected, mission);
    const slice = c.req.query("slice");
    if (selected && slice && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slice)) return c.json({ error: "invalid_slice" }, 400);
    if (!mission || !slice) return c.json({ error: "missing_params", hint: "?mission=&slice=" }, 400);
    if (selected && slice) workSource(selected.root, path.join(r.root, mission!, "slices", slice));
    const detail = projectSliceScope(realFs, path.join(r.root, mission, "slices", slice), undefined, selected?.root);
    return detail ? c.json(detail) : c.json({ error: "slice_not_found", mission, slice }, 404);
  });

  app.get("/narrative", (c) => {
    const r = rootOf(c);
    if ("error" in r) return r.error;
    const selected = selectedProject(c);
    const mission = c.req.query("mission");
    if (selected && mission) projectMission(selected, mission);
    const slice = c.req.query("slice");
    if (selected && slice && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slice)) return c.json({ error: "invalid_slice" }, 400);
    if (!mission || !slice) return c.json({ error: "missing_params", hint: "?mission=&slice=" }, 400);
    const p = path.join(r.root, mission, "slices", slice, "PROGRESS.md");
    if (selected) insideProject(selected.root, p);
    const content = realFs.readFile(p);
    // The narrative DISPLAY (plan atom 3): raw artifact bytes; explicitly not a data source.
    return content !== null ? c.json({ path: p, content }) : c.json({ error: "narrative_not_found" }, 404);
  });


  // #3093 first increment — the FLEET PROJECTS READ-VIEW (read-only, additive).
  // The local leg is the SAME counts projection `?counts=1` serves; each registered
  // HTTP host contributes its own rows, host-attributed, beside per-host status.
  // The local routes above are untouched.
  app.get("/fleet", async (c) => {
    const selected = selectedProject(c);
    // The local root is resolved WITHOUT failing the route: an operator-only
    // machine (no missions root configured) still sees every remote host, with
    // the local leg labelled unavailable instead of a 503 hiding the fleet.
    const localRoot = (): { root: string } | { reason: string } => {
      if (selected) return { root: selected.missionsRoot };
      const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
      if (!indexer) return { reason: "slices indexer unavailable on this daemon" };
      if (!indexer.isReady()) return { reason: "no local missions root configured" };
      return { root: indexer.slicesRoot };
    };
    const listLocalScopes = (): LocalScopesCounts => {
      const root = localRoot();
      if ("reason" in root) return { project: selected?.id ?? null, missions: [], error: root.reason };
      // The ROOT listing has its own handler: a missing root (ENOENT) is an
      // empty-but-honest workspace; any other root failure (EACCES, EIO…) is
      // the local leg's own error state, never an empty list stamped ok.
      let entries: string[];
      try {
        entries = fs.readdirSync(root.root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { project: selected?.id ?? null, missions: [] };
        return { project: selected?.id ?? null, missions: [], error: `local missions read failed: ${(err as Error).message}` };
      }
      // Each ENTRY is checked in its own handler: one vanished entry (a dangling
      // symlink, a folder removed between listing and checking) is skipped, and
      // any other per-entry failure reports on the leg — one bad entry must not
      // hide every local mission behind a healthy-looking empty list.
      const missionNames: string[] = [];
      for (const e of entries) {
        try {
          if (fs.statSync(path.join(root.root, e)).isDirectory()) missionNames.push(e);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          return { project: selected?.id ?? null, missions: [], error: `local missions read failed at '${e}': ${(err as Error).message}` };
        }
      }
      const missions = missionNames.map((name) => {
        try {
          if (selected) projectMission(selected, name);
          const dir = path.join(root.root, name);
          const rows: Record<string, unknown>[] = [];
          for (const s of realFs.listDir(path.join(dir, "slices")).filter((e) => realFs.isDirectory(path.join(dir, "slices", e)))) {
            const row = countsRow(s, path.join(dir, "slices", s), selected);
            if (row) rows.push(row);
          }
          return { mission: name, slices: rows };
        } catch (err) { return { mission: name, slices: [], error: (err as Error).message }; }
      });
      return { project: selected?.id ?? null, missions };
    };
    const registryLoader = (c.get("hostRegistryLoader" as never) as (() => ReturnType<typeof loadHostRegistry>) | undefined) ?? loadHostRegistry;
    const payload = await aggregateFleetScopes({
      listLocalScopes,
      loadRegistry: registryLoader,
      fetchImpl: c.get("remoteFetchImpl" as never) as typeof fetch | undefined,
    });
    return c.json(payload);
  });

  return app;
}
