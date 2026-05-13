// Slice 28 Checkpoint C-3 — Skill library HTTP routes.
//
// SC-29 EXCEPTION #11 cumulative (verbatim declaration at
// packages/daemon/src/routes/plugins.ts header; this file adds the skill
// surface symmetric with the plugin endpoints landed in C-1):
//
// Slice 28 SKILL-side scope (additive read-only endpoints):
//   GET /api/skills/library                          → LibrarySkillPublic[]
//   GET /api/skills/:id/files/list?path=<rel>        → file listing
//   GET /api/skills/:id/files/read?path=<rel>        → file content
//
// Why this exists: see velocity-qa BLOCKING verdict for slice 28 C-final
// (qitem-20260513045711-39ccfdf3) — on the founder-walk VM the daemon's
// allowlist doesn't include the openrig source tree, so the prior
// useLibrarySkills 3-path probe over /api/files/list couldn't reach
// `packages/daemon/specs/agents/shared/skills`. Daemon-owned discovery
// resolves shared-skills via the daemon install path (symmetric with how
// /api/plugins/:id/files/* resolve via pluginDiscoveryService).

import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillLibraryDiscoveryService } from "../domain/skill-library-discovery.js";
import {
  resolveAllowedDirectory,
  resolveAllowedFile,
  FilePathSafetyError,
  type AllowlistRoot,
} from "../domain/files/path-safety.js";
import { sha256Hex } from "../domain/files/file-write-service.js";
import { FILE_READ_TRUNCATION_BYTES } from "./files.js";

type ContextGetter = (key: string) => unknown;

function getService(c: { get: ContextGetter }): SkillLibraryDiscoveryService | undefined {
  return c.get("skillLibraryDiscoveryService" as never) as SkillLibraryDiscoveryService | undefined;
}

function skillRootAllowlist(absolutePath: string): AllowlistRoot[] {
  // Synthetic single-root allowlist scoped to the skill's folder.
  // Same pattern as pluginRootAllowlist (plugins.ts) — reuses the
  // existing path-safety helpers via a one-element allowlist.
  let canonical: string;
  try {
    canonical = fs.realpathSync(absolutePath);
  } catch {
    canonical = path.resolve(absolutePath);
  }
  return [{ name: "skill", canonicalPath: canonical }];
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

export function skillsRoutes(): Hono {
  const router = new Hono();

  // GET /library — consolidated skill list (workspace + openrig-managed).
  router.get("/library", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "skill_library_unavailable" }, 503);
    return c.json(service.listLibrarySkillsPublic());
  });

  // GET /:id/files/list — list a directory inside the skill folder.
  // Mounted BEFORE any bare /:id route (defensive — there's no current
  // bare /:id endpoint, but the order discipline matches plugins.ts).
  router.get("/:id/files/list", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "skill_library_unavailable" }, 503);
    const id = c.req.param("id");
    const skill = service.getSkill(id);
    if (!skill) return c.notFound();
    const relativePath = c.req.query("path") ?? "";
    try {
      const allowlist = skillRootAllowlist(skill.absolutePath);
      const resolved = resolveAllowedDirectory(allowlist, "skill", relativePath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return c.json({
        skillId: id,
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

  // GET /:id/files/read — read a file inside the skill folder.
  router.get("/:id/files/read", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "skill_library_unavailable" }, 503);
    const id = c.req.param("id");
    const skill = service.getSkill(id);
    if (!skill) return c.notFound();
    const relativePath = c.req.query("path") ?? "";
    if (!relativePath) return c.json({ error: "path_required" }, 400);
    try {
      const allowlist = skillRootAllowlist(skill.absolutePath);
      const resolved = resolveAllowedFile(allowlist, "skill", relativePath);
      const stat = fs.statSync(resolved);
      const fullContent = fs.readFileSync(resolved);
      const truncated = stat.size > FILE_READ_TRUNCATION_BYTES;
      const returnedContent = truncated
        ? fullContent.subarray(0, FILE_READ_TRUNCATION_BYTES)
        : fullContent;
      return c.json({
        skillId: id,
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

  return router;
}
