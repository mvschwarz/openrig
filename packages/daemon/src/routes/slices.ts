import type { EventBus } from "../domain/event-bus.js";
import { listProjects, selectedProject, projectMission, workSource, insideProject, projectReadResponse } from "../domain/workspace/project-read.js";
import { inferCatalogProject, ProjectReadError } from "../domain/workspace/project-catalog.js";
// Slice Story View v0 — HTTP routes.
//
// Endpoints:
//   GET /api/slices?filter=all|active|done|blocked  — list (default: all)
//   GET /api/slices/:name                            — full per-tab payload
//   GET /api/slices/:name/proof-asset/:relPath{.+}   — serves screenshots /
//                                                       videos / traces from
//                                                       the slice's matched
//                                                       dogfood-evidence dir
//                                                       (path-traversal guarded)
//
// Route-order discipline (per Phase A R1 lesson): static `/api/slices`
// must be registered BEFORE dynamic `/:name` so the bare-list endpoint
// isn't shadowed. The proof-asset route similarly goes BEFORE :name to
// avoid `/proof-asset` being parsed as a slice-name.

import { Hono, type Context } from "hono";
import { readSliceReadiness, readProjectReadinessAsync } from "../domain/proof/judgments.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { SliceIndexer, SliceListEntry, SliceStatus } from "../domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../domain/slices/slice-detail-projector.js";
import { findSliceWorkflowBinding } from "../domain/workflow/slice-workflow-binding.js";

export interface SlicesRoutesDeps {
  indexer: SliceIndexer;
  projector: SliceDetailProjector;
}

const VALID_FILTERS = new Set<SliceStatus | "all">(["all", "active", "done", "blocked"]);

export function slicesRoutes(): Hono {
  const app = new Hono();

  // 1) Static literal `/` BEFORE dynamic `/:name` so the list isn't
  //    shadowed by a slice named "list" or similar.
  app.get("/", async (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    if (!deps.indexer.isReady()) {
      return c.json({
        error: "slices_root_not_configured",
        hint: "Run rig config init-workspace, or set workspace.slices_root to workspace/missions. Supported shape: missions/<mission>/slices/<slice>.",
      }, 503);
    }
    const filter = (c.req.query("filter") ?? "all").toLowerCase();
    if (!VALID_FILTERS.has(filter as SliceStatus | "all")) {
      return c.json({
        error: "filter_invalid",
        hint: `Unknown filter '${filter}'. Allowed: ${[...VALID_FILTERS].sort().join(", ")}.`,
      }, 400);
    }
    const refresh = c.req.query("refresh");
    if (refresh === "1" || refresh === "true") {
      deps.indexer.invalidate();
    }
    // ONE HTTP request is ONE composite
    // operation: the list rebuild, the boundToWorkflow per-slice get loop,
    // and the mission sidecar share ONE membership batch (pre-scope, each
    // uncached get built its own 2-scan batch: 2+2N total queue scans).
    const listing = deps.indexer.withMembershipBatch(() => {
      const all = deps.indexer.list();
      let filtered = filter === "all" ? all : all.filter((s) => s.status === filter);
      // Workflows in Spec Library v0: optional lens filter — narrow to
      // slices bound to a workflow_instance of <name>:<version>.
      const boundToWorkflow = c.req.query("boundToWorkflow");
      let boundDiagnostic: { specName: string; specVersion: string; matched: number; total: number } | null = null;
      if (boundToWorkflow) {
        const colonIdx = boundToWorkflow.lastIndexOf(":");
        if (colonIdx === -1) {
          return c.json({
            error: "boundToWorkflow_invalid",
            hint: "Format is boundToWorkflow=<specName>:<specVersion>",
          }, 400);
        }
        const specName = boundToWorkflow.slice(0, colonIdx);
        const specVersion = boundToWorkflow.slice(colonIdx + 1);
        const db = deps.indexer.db;
        const before = filtered.length;
        filtered = filtered.filter((slice) => {
          // Re-resolve binding per slice. The indexer's list payload
          // doesn't carry workflowName so we do the join here. v0 cost
          // is bounded by the slice count + a small SQL per slice (the
          // membership batch is shared across the whole request).
          const sliceRecord = deps.indexer.get(slice.name);
          if (!sliceRecord || sliceRecord.qitemIds.length === 0) return false;
          const binding = findSliceWorkflowBinding(db, sliceRecord.qitemIds);
          return binding.primary?.workflowName === specName
            && binding.primary?.workflowVersion === specVersion;
        });
        boundDiagnostic = { specName, specVersion, matched: filtered.length, total: before };
      }
      // Sort by lastActivityAt DESC (most recently touched first); slices
      // without activity sort to the end.
      filtered.sort(compareByActivityDesc);
      const projectLookup = resolveSliceProjectLookup(c, deps.indexer);
      const queueCountsByPath = deps.indexer.observedQueueCounts(filtered, projectLookup.resolveProjectId, {
        additionalSliceRoots: projectLookup.additionalSliceRoots,
        complete: projectLookup.complete,
      });
      const authored = deps.indexer.missionAuthoredStatuses();
      return {
        slices: filtered.map((s) => ({
          ...s,
          queueCounts: queueCountsByPath.get(s.slicePath) ?? null,
          readiness: readSliceReadiness(s.slicePath),
        })),
        totalCount: filtered.length,
        filter,
        boundToWorkflow: boundDiagnostic,
        // VM-005 (release-0.4.7): additive authored mission-status sidecar so
        // chip surfaces can honor authored-wins precedence without a second
        // round-trip. The `slices` array itself is byte-untouched.
        missions: authored,
      };
    });
    if (listing instanceof Response) return listing;
    // The membership batch is synchronous and request-local; finish it before yielding to other requests.
    const readiness = await readProjectReadinessAsync(deps.indexer.slicesRoot);
    return c.json({ ...listing, missions: { ...listing.missions, ...Object.fromEntries(readiness.missions.map(m => [m.name, {
      ...listing.missions[m.name],
      authoredStatus: m.historicalStatus ?? listing.missions[m.name]?.authoredStatus ?? null,
      readiness: m,
    }])) } });
  });

  // V0.3.1 slice 17 founder-walk-workspace-state-correctness (walk item 8 — Explorer auto-show): explicit cache invalidation surface.
  // POST /api/slices/refresh drops both indexer caches so newly-created
  // slice / mission folders are picked up without a daemon restart.
  // Registered BEFORE the dynamic /:name routes so it isn't shadowed.
  app.post("/refresh", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    deps.indexer.invalidate();
    (c.get("eventBus" as never) as EventBus | undefined)?.emit({ type: "scope.sources_changed", scope: deps.indexer.slicesRoot });
    return c.json({ ok: true });
  });

  // 2) Proof asset serving — registered BEFORE /:name to keep /:name from
  //    eating /proof-asset paths. Hono's :wildcard matches a single
  //    segment; we parse the rest of the path manually for nested
  //    relative paths like "screenshots/foo.png" or
  //    "headed-browser/screenshots/bar.png".
  app.get("/:name/proof-asset/*", (c) => {
    const name = c.req.param("name");
    const selected = selectSliceDeps(c, name);
    if ("response" in selected) return selected.response;
    const { deps, qualified } = selected;
    let slice = qualified ? null : deps.indexer.get(name);
    if (!qualified && (!slice || !slice.proofPacket)) {
      return c.json({ error: "proof_packet_not_found" }, 404);
    }
    // Hono path: c.req.path = "/api/slices/<name>/proof-asset/<rest>".
    // Pull everything after "/proof-asset/".
    const fullPath = c.req.path;
    const marker = `/proof-asset/`;
    const idx = fullPath.indexOf(marker);
    if (idx === -1) return c.json({ error: "proof_asset_path_invalid" }, 400);
    const relPath = decodeURIComponent(fullPath.slice(idx + marker.length));
    if (!relPath || relPath.includes("..")) {
      return c.json({ error: "proof_asset_path_invalid" }, 400);
    }
    slice ??= deps.indexer.get(name);
    if (!slice || !slice.proofPacket) {
      return c.json({ error: "proof_packet_not_found" }, 404);
    }
    const abs = deps.projector.resolveProofAssetPath(slice.proofPacket, relPath);
    if (!abs) return c.json({ error: "proof_asset_not_found" }, 404);

    let servedPath = abs;
    if (selected.qualified) {
      try { servedPath = insideProject(selected.projectRoot, abs); }
      catch (err) { return projectReadResponse(err); }
    }
    const contentType = inferContentType(abs);
    return fileAssetResponse(servedPath, contentType, c.req.header("Range"));
  });

  // 3) Doc serving for the Docs tab — markdown content of a single file
  //    inside the slice folder. Path-traversal guarded by the projector.
  app.get("/:name/doc/*", (c) => {
    const name = c.req.param("name");
    const selected = selectSliceDeps(c, name, { includeEvidenceRoot: false });
    if ("response" in selected) return selected.response;
    const { deps } = selected;
    const fullPath = c.req.path;
    const marker = `/doc/`;
    const idx = fullPath.indexOf(marker);
    if (idx === -1) return c.json({ error: "doc_path_invalid" }, 400);
    const relPath = decodeURIComponent(fullPath.slice(idx + marker.length));
    if (!relPath || relPath.includes("..")) {
      return c.json({ error: "doc_path_invalid" }, 400);
    }
    const content = deps.projector.readDoc(name, relPath);
    if (content === null) return c.json({ error: "doc_not_found" }, 404);
    return c.json({ relPath, content });
  });

  // 4) Dynamic `/:name` LAST so the literal routes above are not shadowed.
  app.get("/:name", (c) => {
    const name = c.req.param("name");
    const selected = selectSliceDeps(c, name);
    if ("response" in selected) return selected.response;
    const { deps } = selected;
    const slice = deps.indexer.get(name);
    if (!slice) return c.json({ error: "slice_not_found", name }, 404);
    const payload = deps.projector.project(slice);
    return c.json(payload);
  });

  return app;
}

const UNAVAILABLE_EVIDENCE_ROOT_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "ELOOP",
  "EIO",
  "ENAMETOOLONG",
  "ESTALE",
]);

export function qualifiedEvidenceRoot(projectRoot: string, missionsRoot: string): string | null {
  const candidate = path.join(path.dirname(missionsRoot), "dogfood-evidence");
  const relative = path.relative(path.resolve(projectRoot), path.resolve(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  try {
    const resolved = insideProject(projectRoot, candidate);
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
    fs.readdirSync(resolved);
    return resolved;
  } catch (err) {
    if (err instanceof ProjectReadError && err.code === "project_path_escape") return null;
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
    if (typeof code === "string" && UNAVAILABLE_EVIDENCE_ROOT_CODES.has(code)) return null;
    throw err;
  }
}

function selectSliceDeps(
  c: Context,
  name: string,
  opts: { includeEvidenceRoot?: boolean } = {},
): { deps: SlicesRoutesDeps; qualified: false } | { deps: SlicesRoutesDeps; qualified: true; projectRoot: string } | { response: Response } {
  let deps = getDeps(c);
  if (!deps) return { response: c.json({ error: "slices_indexer_unavailable" }, 503) };
  try {
    const project = selectedProject(c);
    if (!project) return { deps, qualified: false };
    const mission = c.req.query("mission");
    if (!mission || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return { response: c.json({ error: "exact_mission_and_slice_required" }, 400) };
    const dir = projectMission(project, mission);
    workSource(project.root, path.join(dir, "slices", name));
    const indexer = new SliceIndexer({
      db: deps.indexer.db,
      slicesRoot: project.missionsRoot,
      dogfoodEvidenceRoot: (opts.includeEvidenceRoot ?? true) ? qualifiedEvidenceRoot(project.root, project.missionsRoot) : null,
      projectId: project.id,
      missionId: mission,
    });
    deps = { indexer, projector: deps.projector.withIndexer(indexer) };
    return { deps, qualified: true, projectRoot: project.root };
  } catch (err) { return { response: projectReadResponse(err) }; }
}

function getDeps(c: { get: (key: string) => unknown }): SlicesRoutesDeps | null {
  const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
  const projector = c.get("sliceDetailProjector" as never) as SliceDetailProjector | undefined;
  if (!indexer || !projector) return null;
  return { indexer, projector };
}

function safeRealpath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isInsideDir(parentDir: string, childPath: string): boolean {
  const rel = path.relative(parentDir, childPath);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

interface SliceProjectLookup {
  resolveProjectId: (slicePath: string) => string | null;
  additionalSliceRoots: string[];
  complete: boolean;
}

function resolveSliceProjectLookup(
  c: { get: (key: string) => unknown },
  indexer: SliceIndexer,
): SliceProjectLookup {
  let catalogPath: string | null = null;
  let projects: Array<{ id: string; root: string; missionsRoot: string; error?: string }> = [];
  try {
    const listed = listProjects(c as never);
    catalogPath = listed.catalogPath;
    projects = listed.projects.map((p) => ({
      id: p.id,
      root: safeRealpath(p.root),
      missionsRoot: safeRealpath(p.missionsRoot),
      error: p.error,
    }));
  } catch {
    return { resolveProjectId: () => null, additionalSliceRoots: [], complete: false };
  }
  const additionalSliceRoots = projects.map((project) => project.missionsRoot);
  const complete = projects.length > 0 && projects.every((project) => !project.error);
  if (projects.length === 0) {
    return { resolveProjectId: () => null, additionalSliceRoots, complete };
  }
  // A project-scoped indexer's explicitly configured roots keep their existing
  // project identity, including compatible roots outside project.yaml. Extra
  // catalog roots are resolved by containment so hidden sibling projects remain
  // distinct candidates.
  const explicitProjectId = typeof indexer.projectId === "string" && indexer.projectId.length > 0
    ? indexer.projectId
    : null;
  const explicitRoots = explicitProjectId
    ? [indexer.slicesRoot, ...indexer.additionalSliceRoots].map(safeRealpath)
    : [];
  // The resolver is request-local. Reuse inference only for the same canonical
  // project/mission-root matches, keeping the two containment relations distinct.
  const inferredByContainment = new Map<string, { id: string; root: string }>();
  const resolveProjectId = (slicePath: string): string | null => {
    const actualSlicePath = safeRealpath(slicePath);
    if (explicitProjectId && explicitRoots.some((root) => isInsideDir(root, actualSlicePath))) return explicitProjectId;
    const matching = projects.flatMap((project) => {
      const projectRootContains = isInsideDir(project.root, actualSlicePath);
      const missionsRootContains = isInsideDir(project.missionsRoot, actualSlicePath);
      return projectRootContains || missionsRootContains
        ? [{ project, projectRootContains, missionsRootContains }]
        : [];
    });
    if (matching.length === 0) return null;

    let selected: (typeof projects)[number] | undefined;
    if (matching.length === 1) {
      selected = matching[0]?.project;
    } else {
      if (!catalogPath) return null;
      const cacheKey = JSON.stringify(
        matching
          .map(({ project, projectRootContains, missionsRootContains }) => ({
            id: project.id,
            root: project.root,
            missionsRoot: project.missionsRoot,
            error: project.error ?? null,
            projectRootContains,
            missionsRootContains,
          }))
          .sort((a, b) => {
            const left = JSON.stringify(a);
            const right = JSON.stringify(b);
            return left < right ? -1 : left > right ? 1 : 0;
          }),
      );
      const cached = inferredByContainment.get(cacheKey);
      if (cached) {
        selected = matching.find(({ project }) => project.id === cached.id && project.root === cached.root)?.project;
      } else {
        try {
          const inferred = inferCatalogProject(
            catalogPath,
            new ProjectReadError("project_required", "Slice queue counts require one containing project"),
            { cwd: actualSlicePath },
            [],
          );
          if (inferred.selectedBy !== "cwd") return null;
          selected = matching.find(({ project }) => project.id === inferred.id && project.root === inferred.root)?.project;
          if (!selected) return null;
          inferredByContainment.set(cacheKey, { id: inferred.id, root: inferred.root });
        } catch {
          return null;
        }
      }
    }
    if (!selected || selected.error || !isInsideDir(selected.missionsRoot, actualSlicePath)) return null;
    return selected.id;
  };
  return { resolveProjectId, additionalSliceRoots, complete };
}

function compareByActivityDesc(a: SliceListEntry, b: SliceListEntry): number {
  if (a.lastActivityAt === b.lastActivityAt) return a.name.localeCompare(b.name);
  if (!a.lastActivityAt) return 1;
  if (!b.lastActivityAt) return -1;
  return b.lastActivityAt.localeCompare(a.lastActivityAt);
}

function inferContentType(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    case ".zip": return "application/zip";
    case ".md":
    case ".txt": return "text/plain; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function fileAssetResponse(absPath: string, contentType: string, rangeHeader?: string): Response {
  const size = fs.statSync(absPath).size;
  const cacheControl = "public, max-age=86400";

  if (rangeHeader) {
    const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    const start = m && m[1] !== "" ? Number(m[1]) : m && m[2] !== "" ? Math.max(0, size - Number(m[2])) : NaN;
    const end = m && m[1] !== "" && m[2] !== "" ? Number(m[2]) : size - 1;
    if (!m || Number.isNaN(start) || start < 0 || start >= size || end < start) {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }

    const boundedEnd = Math.min(end, size - 1);
    const length = boundedEnd - start + 1;
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      return new Response(new Uint8Array(buf), {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Range": `bytes ${start}-${boundedEnd}/${size}`,
          "Content-Length": String(length),
          "Accept-Ranges": "bytes",
          "Cache-Control": cacheControl,
        },
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  const data = fs.readFileSync(absPath);
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl,
    },
  });
}
