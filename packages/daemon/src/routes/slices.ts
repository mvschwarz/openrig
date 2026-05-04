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

import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SliceIndexer, SliceListEntry, SliceStatus } from "../domain/slices/slice-indexer.js";
import type { SliceDetailProjector } from "../domain/slices/slice-detail-projector.js";

export interface SlicesRoutesDeps {
  indexer: SliceIndexer;
  projector: SliceDetailProjector;
}

const VALID_FILTERS = new Set<SliceStatus | "all">(["all", "active", "done", "blocked"]);

export function slicesRoutes(): Hono {
  const app = new Hono();

  // 1) Static literal `/` BEFORE dynamic `/:name` so the list isn't
  //    shadowed by a slice named "list" or similar.
  app.get("/", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    if (!deps.indexer.isReady()) {
      return c.json({
        error: "slices_root_not_configured",
        hint: "Set OPENRIG_SLICES_ROOT to the directory containing slice folders",
      }, 503);
    }
    const filter = (c.req.query("filter") ?? "all").toLowerCase();
    if (!VALID_FILTERS.has(filter as SliceStatus | "all")) {
      return c.json({
        error: "filter_invalid",
        hint: `Unknown filter '${filter}'. Allowed: ${[...VALID_FILTERS].sort().join(", ")}.`,
      }, 400);
    }
    const all = deps.indexer.list();
    const filtered = filter === "all" ? all : all.filter((s) => s.status === filter);
    // Sort by lastActivityAt DESC (most recently touched first); slices
    // without activity sort to the end.
    filtered.sort(compareByActivityDesc);
    return c.json({ slices: filtered, totalCount: filtered.length, filter });
  });

  // 2) Proof asset serving — registered BEFORE /:name to keep /:name from
  //    eating /proof-asset paths. Hono's :wildcard matches a single
  //    segment; we parse the rest of the path manually for nested
  //    relative paths like "screenshots/foo.png" or
  //    "headed-browser/screenshots/bar.png".
  app.get("/:name/proof-asset/*", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    const name = c.req.param("name");
    const slice = deps.indexer.get(name);
    if (!slice || !slice.proofPacket) {
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
    const abs = deps.projector.resolveProofAssetPath(slice.proofPacket, relPath);
    if (!abs) return c.json({ error: "proof_asset_not_found" }, 404);

    const contentType = inferContentType(abs);
    const data = fs.readFileSync(abs);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        // Cache aggressively — proof assets are immutable once published.
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  // 3) Doc serving for the Docs tab — markdown content of a single file
  //    inside the slice folder. Path-traversal guarded by the projector.
  app.get("/:name/doc/*", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    const name = c.req.param("name");
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
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    const name = c.req.param("name");
    const slice = deps.indexer.get(name);
    if (!slice) return c.json({ error: "slice_not_found", name }, 404);
    const payload = deps.projector.project(slice);
    return c.json(payload);
  });

  return app;
}

function getDeps(c: { get: (key: string) => unknown }): SlicesRoutesDeps | null {
  const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
  const projector = c.get("sliceDetailProjector" as never) as SliceDetailProjector | undefined;
  if (!indexer || !projector) return null;
  return { indexer, projector };
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
