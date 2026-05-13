// Phase 3a slice 3.3 — Plugins HTTP routes (read-only).
//
// SC-29 EXCEPTION #8 declared verbatim:
// "Slice 3.3 (UI plugin surface) requires daemon-side plugin-discovery-service
// + 3 HTTP routes (GET /api/plugins, GET /api/plugins/:id, GET /api/plugins/:id/used-by)
// as backing API. No additional state, no SQL migration, no mutation routes.
// Read-only discovery surface aggregating filesystem-scan unions per
// DESIGN.md §5.4. Per IMPL-PRD §3.3 'Code touches' this allocation is explicit;
// documenting in compliance with banked SC-29 verbatim-declaration rule."
//
// SC-29 EXCEPTION #11 (slice 28 library-explorer-finishing) declared verbatim:
// "Slice 28 (Library Explorer finishing — founder-walk follow-up) requires:
// (a) two additive read-only HTTP routes — GET /api/plugins/:id/files/list
// and GET /api/plugins/:id/files/read — that wrap the existing path-safety
// machinery (resolveAllowedDirectory/File) with the discovered plugin's
// absolute path acting as a synthetic single-root allowlist. Enables
// docs-browser file navigation of a plugin's on-disk folder without
// requiring the operator to allowlist ~/.openrig/plugins/ in
// OPENRIG_FILES_ALLOWLIST.
// (b) one PluginEntry shape extension — skillCount: number — populated in
// detectPlugin() by readdir of <plugin>/skills/. Surfaces skill-count in
// the plugin list response so PluginsIndexPage can render the column
// without an N+1 detail fetch per row.
// No additional state, no SQL migration, no write mutations on plugin
// folders. Read-only docs-browser surface per slice 28 founder direction
// 'finishing it is 0.3.1 work, not 0.3.2'. Routing decision
// qitem-20260513042155-f31c11c3 (orch OPT-A authorization)."
//
// Endpoint shape:
//   GET /api/plugins                              → PluginEntry[]   (?runtime=, ?source= filters)
//   GET /api/plugins/:id                          → PluginDetail    (404 when unknown)
//   GET /api/plugins/:id/used-by                  → AgentReference[]
//   GET /api/plugins/:id/files/list?path=<rel>    → FilesListResponse (slice 28)
//   GET /api/plugins/:id/files/read?path=<rel>    → FilesReadResponse (slice 28)
//
// All endpoints return 503 when the service is not provisioned in context
// (consistent with the existing daemon route pattern for optional services).
// /files/list + /files/read use the discovered plugin path as a synthetic
// AllowlistRoot + reuse resolveAllowedDirectory/File for path-safety.

import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PluginDiscoveryService,
  PluginRuntime,
  PluginSourceKind,
} from "../domain/plugin-discovery-service.js";
import {
  resolveAllowedDirectory,
  resolveAllowedFile,
  FilePathSafetyError,
  type AllowlistRoot,
} from "../domain/files/path-safety.js";
import { sha256Hex } from "../domain/files/file-write-service.js";
import { FILE_READ_TRUNCATION_BYTES } from "./files.js";

type ContextGetter = (key: string) => unknown;

function getService(c: { get: ContextGetter }): PluginDiscoveryService | undefined {
  return c.get("pluginDiscoveryService" as never) as PluginDiscoveryService | undefined;
}

function parseRuntimeFilter(value: string | undefined): PluginRuntime | undefined {
  if (value === "claude" || value === "codex") return value;
  return undefined;
}

function parseSourceFilter(value: string | undefined): PluginSourceKind | undefined {
  if (value === "vendored" || value === "claude-cache" || value === "codex-cache") return value;
  return undefined;
}

function pluginRootAllowlist(absolutePath: string): AllowlistRoot[] {
  // Synthetic single-root allowlist scoped to the plugin's folder.
  // Reuses the existing path-safety helpers for ../ escape / symlink
  // realpath containment checks without any allowlist env-var coupling
  // (operator does not need to declare plugin paths in OPENRIG_FILES_ALLOWLIST).
  //
  // Normalize via fs.realpathSync so the containment check (realpath vs
  // canonicalPath) holds on platforms where the input path is itself
  // a symlink chain (e.g. macOS /tmp → /private/tmp, /var/folders →
  // /private/var/folders). Matches decodeAllowlist's normalization in
  // path-safety.ts.
  let canonical: string;
  try {
    canonical = fs.realpathSync(absolutePath);
  } catch {
    canonical = path.resolve(absolutePath);
  }
  return [{ name: "plugin", canonicalPath: canonical }];
}

function pathSafetyErrorResponse(
  c: { json: (body: unknown, status?: number) => Response },
  err: FilePathSafetyError,
): Response {
  const status =
    err.code === "root_unknown" ? 400
    : err.code === "path_invalid" || err.code === "path_escape" ? 400
    : err.code === "stat_failed" ? 404
    : err.code === "not_a_file" || err.code === "not_a_directory" ? 400
    : 500;
  return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
}

export function pluginsRoutes(): Hono {
  const router = new Hono();

  // GET / — list discoverable plugins
  router.get("/", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const runtimeFilter = parseRuntimeFilter(c.req.query("runtime"));
    const sourceFilter = parseSourceFilter(c.req.query("source"));
    // Slice 3.3 fix-C — DESIGN §5.4 union 4th category: rig-bundled
    // <cwd>/.claude/plugins/* + <cwd>/.codex/plugins/*. The API caller
    // (UI in rig context, CLI in slice 3.4) passes ?cwd=<path> when
    // they want the rig-cwd discoveries included; the Library page
    // omits it (cross-cutting view).
    const cwd = c.req.query("cwd");
    const cwdScanRoots = cwd ? [cwd] : undefined;
    const plugins = service.listPlugins({ runtimeFilter, sourceFilter, cwdScanRoots });
    return c.json(plugins);
  });

  // GET /:id/used-by — reverse query for agents referencing this plugin.
  // Mounted BEFORE /:id so the literal sub-path doesn't get eaten by the
  // bare-param catchall (per spec-library-routes Phase A R1 SSE route-order
  // lesson banked in that file).
  router.get("/:id/used-by", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const id = c.req.param("id");
    return c.json(service.findUsedBy(id));
  });

  // Slice 28 — GET /:id/files/list?path=<rel>
  // Lists directory entries inside the plugin's source folder. Uses the
  // existing path-safety helpers with a synthetic single-root allowlist
  // built from the discovered plugin's absolute path. Mounted BEFORE the
  // bare /:id route (same route-order discipline as /:id/used-by).
  router.get("/:id/files/list", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const id = c.req.param("id");
    const detail = service.getPlugin(id);
    if (!detail) return c.notFound();
    const relativePath = c.req.query("path") ?? "";
    try {
      const allowlist = pluginRootAllowlist(detail.entry.path);
      const resolved = resolveAllowedDirectory(allowlist, "plugin", relativePath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return c.json({
        pluginId: id,
        path: relativePath,
        entries: entries
          .map((entry) => {
            const fullPath = path.join(resolved, entry.name);
            let stat: fs.Stats | null = null;
            try { stat = fs.statSync(fullPath); } catch { /* skip stat-failed */ }
            return {
              name: entry.name,
              type: entry.isDirectory() ? "dir" as const : entry.isFile() ? "file" as const : "other" as const,
              size: stat?.isFile() ? stat.size : null,
              mtime: stat ? stat.mtime.toISOString() : null,
            };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
          }),
      });
    } catch (err) {
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      return c.json({ error: "list_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Slice 28 — GET /:id/files/read?path=<rel>
  // Reads a file inside the plugin's source folder. Same truncation cap
  // semantics as /api/files/read (FILE_READ_TRUNCATION_BYTES; hash over
  // full content for honest edit-conflict semantics — but plugin folders
  // are read-only at v0 so the hash is informational only).
  router.get("/:id/files/read", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const id = c.req.param("id");
    const detail = service.getPlugin(id);
    if (!detail) return c.notFound();
    const relativePath = c.req.query("path") ?? "";
    if (!relativePath) return c.json({ error: "path_required" }, 400);
    try {
      const allowlist = pluginRootAllowlist(detail.entry.path);
      const resolved = resolveAllowedFile(allowlist, "plugin", relativePath);
      const stat = fs.statSync(resolved);
      const fullContent = fs.readFileSync(resolved);
      const truncated = stat.size > FILE_READ_TRUNCATION_BYTES;
      const returnedContent = truncated
        ? fullContent.subarray(0, FILE_READ_TRUNCATION_BYTES)
        : fullContent;
      return c.json({
        pluginId: id,
        path: relativePath,
        absolutePath: resolved,
        content: returnedContent.toString("utf-8"),
        mtime: stat.mtime.toISOString(),
        contentHash: sha256Hex(fullContent),
        size: stat.size,
        truncated,
        truncatedAtBytes: truncated ? FILE_READ_TRUNCATION_BYTES : null,
        totalBytes: stat.size,
      });
    } catch (err) {
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      return c.json({ error: "read_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // GET /:id — plugin detail
  router.get("/:id", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const id = c.req.param("id");
    const detail = service.getPlugin(id);
    if (!detail) return c.notFound();
    return c.json(detail);
  });

  return router;
}
