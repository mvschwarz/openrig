// UI Enhancement Pack v0 + Operator Surface Reconciliation v0 — file browser routes.
//
// Endpoints (item 3 + item 4):
//   GET  /api/files/roots                          allowlist root list
//   GET  /api/files/list?root=<name>&path=<rel>    directory entries
//   GET  /api/files/read?root=<name>&path=<rel>    file content + metadata
//   GET  /api/files/asset?root=<name>&path=<rel>   raw bytes for embedded images
//   POST /api/files/write                          atomic write (item 4)
//
// Operator Surface Reconciliation v0 item 5: GET /read caps returned
// content at FILE_READ_TRUNCATION_BYTES (1 MB; PRD § Item 5;
// dashboard precedent). Response includes `truncated`, `truncatedAtBytes`,
// `totalBytes` so the UI can render a truncation marker. The hash is
// still computed over the FULL file content so atomic-write conflict
// detection stays honest even when the read was truncated.
//
// Route-order discipline (per Phase A R1 SSE lesson): all routes are
// literal — no `/:param` catchalls — so order doesn't matter for
// shadowing. Kept sequential for readability.

import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveAllowedDirectory,
  resolveAllowedFile,
  resolveAllowedPath,
  FilePathSafetyError,
  type AllowlistRoot,
} from "../domain/files/path-safety.js";
import {
  WriteConflictError,
  FileWriteError,
  sha256Hex,
  type FileWriteService,
} from "../domain/files/file-write-service.js";

export interface FilesRoutesDeps {
  /** Allowlist resolved at startup; empty array = no roots configured. */
  allowlist: AllowlistRoot[];
  /** Atomic-write service; absent → POST /write returns 503 unconfigured. */
  writeService: FileWriteService | null;
}

/** Operator Surface Reconciliation v0 item 5: file-read truncation
 *  cap. PRD § Item 5 picks 1 MB (founder Q6 option b). The dashboard
 *  precedent was 200 KB; the v0 ceiling is 1 MB so the operator can
 *  read most workspace canon files in full. */
export const FILE_READ_TRUNCATION_BYTES = 1_048_576;

export function filesRoutes(): Hono {
  const app = new Hono();

  function getDeps(c: { get: (key: string) => unknown }): FilesRoutesDeps | null {
    const allowlist = c.get("filesAllowlist" as never) as AllowlistRoot[] | undefined;
    const writeService = c.get("fileWriteService" as never) as FileWriteService | null | undefined;
    if (!allowlist) return null;
    return { allowlist, writeService: writeService ?? null };
  }

  function pathSafetyErrorResponse(c: { json: (body: unknown, status?: number) => Response }, err: FilePathSafetyError): Response {
    const status =
      err.code === "root_unknown" ? 400
      : err.code === "path_invalid" || err.code === "path_escape" ? 400
      : err.code === "stat_failed" ? 404
      : err.code === "not_a_file" || err.code === "not_a_directory" ? 400
      : 500;
    return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
  }

  app.get("/roots", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "files_routes_unavailable" }, 503);
    if (deps.allowlist.length === 0) {
      return c.json({
        roots: [],
        hint: "No allowlist roots configured. Set OPENRIG_FILES_ALLOWLIST=name1:/abs/path,name2:/abs/path and restart the daemon.",
      });
    }
    return c.json({
      roots: deps.allowlist.map((r) => ({ name: r.name, path: r.canonicalPath })),
    });
  });

  app.get("/list", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "files_routes_unavailable" }, 503);
    const rootName = c.req.query("root") ?? "";
    const relativePath = c.req.query("path") ?? "";
    if (!rootName) return c.json({ error: "root_required" }, 400);
    try {
      const resolved = resolveAllowedDirectory(deps.allowlist, rootName, relativePath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return c.json({
        root: rootName,
        path: relativePath,
        entries: entries
          .map((entry) => {
            // Skip dotfiles by default unless they're inside an
            // allowlisted root that's a dot-directory itself (e.g.,
            // operator allowlists ~/.openrig — the operator clearly
            // wants to inspect dotfiles in that case). Implementation:
            // include dotfiles always at v0; the operator has already
            // expressed inspection intent by allowlisting the root.
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

  app.get("/read", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "files_routes_unavailable" }, 503);
    const rootName = c.req.query("root") ?? "";
    const relativePath = c.req.query("path") ?? "";
    if (!rootName || !relativePath) return c.json({ error: "root_and_path_required" }, 400);
    try {
      const resolved = resolveAllowedFile(deps.allowlist, rootName, relativePath);
      const stat = fs.statSync(resolved);
      const fullContent = fs.readFileSync(resolved);
      // Operator Surface Reconciliation v0 item 5: cap returned content
      // at FILE_READ_TRUNCATION_BYTES (1 MB). Hash is over the FULL
      // file so edit-mode conflict detection stays honest.
      const truncated = stat.size > FILE_READ_TRUNCATION_BYTES;
      const returnedContent = truncated
        ? fullContent.subarray(0, FILE_READ_TRUNCATION_BYTES)
        : fullContent;
      return c.json({
        root: rootName,
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

  app.get("/asset", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "files_routes_unavailable" }, 503);
    const rootName = c.req.query("root") ?? "";
    const relativePath = c.req.query("path") ?? "";
    if (!rootName || !relativePath) return c.json({ error: "root_and_path_required" }, 400);
    try {
      const resolved = resolveAllowedFile(deps.allowlist, rootName, relativePath);
      const data = fs.readFileSync(resolved);
      const contentType = inferContentType(resolved);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch (err) {
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      return c.json({ error: "asset_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/write", async (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "files_routes_unavailable" }, 503);
    if (!deps.writeService) {
      return c.json({
        error: "file_write_service_unavailable",
        hint: "OPENRIG_FILES_ALLOWLIST is empty or unset; configure at least one root and restart.",
      }, 503);
    }
    const body = await c.req.json<{
      root?: string;
      path?: string;
      content?: string;
      expectedMtime?: string;
      expectedContentHash?: string;
      actor?: string;
    }>().catch(() => ({} as never));
    if (!body.root) return c.json({ error: "root_required" }, 400);
    if (!body.path) return c.json({ error: "path_required" }, 400);
    if (typeof body.content !== "string") return c.json({ error: "content_required" }, 400);
    if (!body.expectedMtime) return c.json({ error: "expectedMtime_required" }, 400);
    if (!body.expectedContentHash) return c.json({ error: "expectedContentHash_required" }, 400);
    if (!body.actor) return c.json({ error: "actor_required" }, 400);
    try {
      const result = deps.writeService.writeAtomic({
        rootName: body.root,
        path: body.path,
        content: body.content,
        expectedMtime: body.expectedMtime,
        expectedContentHash: body.expectedContentHash,
        actor: body.actor,
      });
      return c.json({
        root: body.root,
        path: body.path,
        absolutePath: result.absolutePath,
        newMtime: result.newMtime,
        newContentHash: result.newContentHash,
        byteCountDelta: result.byteCountDelta,
      });
    } catch (err) {
      if (err instanceof WriteConflictError) {
        return c.json({
          error: "write_conflict",
          message: err.message,
          currentMtime: err.currentMtime,
          currentContentHash: err.currentContentHash,
        }, 409);
      }
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      if (err instanceof FileWriteError) {
        return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, 500);
      }
      return c.json({ error: "write_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}

function inferContentType(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".pdf": return "application/pdf";
    case ".md":
    case ".txt":
    case ".log": return "text/plain; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".yaml":
    case ".yml": return "text/yaml; charset=utf-8";
    case ".js":
    case ".ts":
    case ".tsx":
    case ".jsx":
    case ".css":
    case ".html": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

// Re-export for the route-order discipline test in workflow-routes.
export { resolveAllowedPath };
