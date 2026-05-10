// Built-in workflow-spec loader.
//
// Walks a built-in starter directory at daemon startup and seeds each
// spec file into PL-004 Phase D's WorkflowSpecCache. Idempotent: on
// repeated startup (or when an operator has authored a competing spec
// at a workspace path), the loader SKIPS specs that are already cached
// for the same (name, version) — the workspace-surface reconciliation
// contract from Phase D requires that operator edits win at next read,
// so the loader must not clobber them.
//
// Why skip-if-present rather than always-readThrough:
//   WorkflowSpecCache.readThrough(absPath) UPDATES the cached row's
//   source_path to whatever the caller passes. If we called readThrough
//   on the built-in path every startup, an operator-authored row at a
//   workspace path would have its source_path overwritten back to the
//   built-in path — silently undoing the operator's override. The
//   skip-if-present check preserves the override.
//
// Resolution: operators who want to refresh the built-in row from the
// shipped file (e.g., after deleting a workspace override) can call
// `cache.readThrough(builtinAbsPath)` directly via a future explicit
// refresh path; v0 does not surface that path, since the typical case
// (cold daemon, no override) is handled by the loader on first start.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  WorkflowSpecError,
  parseWorkflowSpec,
  type WorkflowSpecCache,
} from "../workflow-spec-cache.js";

export interface StarterSpecLoadResult {
  /** Specs newly seeded into the cache during this call. */
  loaded: Array<{ name: string; version: string; sourcePath: string }>;
  /** Specs that were already cached (operator override or prior startup). */
  skipped: Array<{ name: string; version: string; sourcePathInCache: string }>;
  /** Specs that failed to parse / load — surfaced for diagnostic logging. */
  errors: Array<{ sourcePath: string; code: string; message: string }>;
}

export interface StarterSpecLoaderOpts {
  /** Phase D's workflow-spec-cache (already constructed in startup.ts). */
  cache: WorkflowSpecCache;
  /** Absolute directory containing built-in starter spec files (.yaml only at v0). */
  builtinDir: string;
}

const SPEC_FILE_EXTENSIONS = new Set([".yaml", ".yml"]);

/**
 * Walks the builtinDir and seeds each spec file into the cache, skipping
 * those that are already cached for the same (name, version). Idempotent
 * on repeated calls. Returns a structured result for diagnostic logging
 * (which the daemon can log at INFO; tests assert on the shape).
 *
 * If the builtinDir doesn't exist, returns an empty result (no error) —
 * a daemon shipped without bundled starter specs is a valid configuration.
 */
export function loadStarterWorkflowSpecs(opts: StarterSpecLoaderOpts): StarterSpecLoadResult {
  const result: StarterSpecLoadResult = { loaded: [], skipped: [], errors: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(opts.builtinDir, { withFileTypes: true });
  } catch {
    // Directory absent — no starter specs bundled. This is a valid
    // configuration; not an error.
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SPEC_FILE_EXTENSIONS.has(ext)) continue;

    const absPath = path.join(opts.builtinDir, entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, "utf-8");
    } catch (err) {
      result.errors.push({
        sourcePath: absPath,
        code: "spec_read_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let parsedName: string;
    let parsedVersion: string;
    try {
      const parsed = parseWorkflowSpec(raw, absPath);
      parsedName = parsed.id;
      parsedVersion = parsed.version;
    } catch (err) {
      if (err instanceof WorkflowSpecError) {
        result.errors.push({ sourcePath: absPath, code: err.code, message: err.message });
      } else {
        result.errors.push({
          sourcePath: absPath,
          code: "spec_parse_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // Workspace-surface reconciliation: if an entry already exists for
    // this (name, version), DO NOT seed — operator override (or a prior
    // startup's seed) wins.
    const existing = opts.cache.getByNameVersion(parsedName, parsedVersion);
    if (existing) {
      result.skipped.push({
        name: parsedName,
        version: parsedVersion,
        sourcePathInCache: existing.sourcePath,
      });
      continue;
    }

    // Seed via readThrough so the cache's normal insert path runs (hash
    // computation, cached_at timestamp, JSON serialization of roles +
    // steps). readThrough re-reads + re-parses the file; that's a small
    // duplicate-work cost per spec at startup, acceptable for v0.
    try {
      const row = opts.cache.readThrough(absPath);
      result.loaded.push({ name: row.name, version: row.version, sourcePath: row.sourcePath });
    } catch (err) {
      if (err instanceof WorkflowSpecError) {
        result.errors.push({ sourcePath: absPath, code: err.code, message: err.message });
      } else {
        result.errors.push({
          sourcePath: absPath,
          code: "spec_seed_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

/**
 * Resolves the default built-in starter directory relative to this
 * loader file's location on disk. Works in both dev (running from
 * `src/`) and prod (running from `dist/`) — the build step copies the
 * workflow spec files to `dist/builtins/workflow-specs/` when bundled
 * specs are present, so the resolved path works in both layouts.
 *
 * Layout: this file is at `<pkg>/{src|dist}/domain/workflow/`. The
 * built-in dir is at `<pkg>/{src|dist}/builtins/workflow-specs/`. Two
 * levels up from this file's dirname is the package's src/ or dist/
 * root.
 */
export function defaultBuiltinSpecsDir(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  // here = .../{src|dist}/domain/workflow
  // package src/dist root = .../{src|dist}
  return path.resolve(here, "..", "..", "builtins", "workflow-specs");
}
