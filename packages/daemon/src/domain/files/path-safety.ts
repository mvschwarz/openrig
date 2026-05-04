// UI Enhancement Pack v0 — file allowlist + path-safety helpers.
//
// Daemon-enforced fail-closed path-safety for the operator-allowlisted
// file browser surface (item 3 + item 4). Reused by all four
// /api/files/* routes.
//
// Allowlist source (driver pivot from PRD's suggested ConfigStore key
// family — see handoff): OPENRIG_FILES_ALLOWLIST env var, comma-
// separated `<name>:<absolute-path>` pairs. Operator sets via shell
// (or via `~/.openrig` env file). Empty / unset → no allowlist roots
// → routes return empty roots list with a structured "configure
// OPENRIG_FILES_ALLOWLIST" hint. Default after fresh install: nothing
// (the safe default per PRD § Item 3).
//
// Path-safety contract:
//   - Each request resolves <relativePath> against <rootName>'s
//     canonical absolute path.
//   - Any escape attempt (.., absolute-path passed as relativePath,
//     symlink whose realpath escapes the root) is rejected with a
//     structured error.
//   - Symlinks INSIDE the allowlisted tree resolve normally; symlinks
//     pointing OUTSIDE the tree are treated as escape attempts.
//   - Reads/lists never return content from outside the resolved root.
//
// MVP single-host context: no per-rig overrides, no remote allowlist
// management, no audit at allowlist-resolution time (allowlist
// resolution is read-only). Audit applies to writes only (item 4).

import * as fs from "node:fs";
import * as path from "node:path";

export interface AllowlistRoot {
  /** Operator-supplied display name (e.g., "workspace"). */
  name: string;
  /** Canonical absolute path on disk. */
  canonicalPath: string;
}

export class FilePathSafetyError extends Error {
  constructor(
    public readonly code: "root_unknown" | "path_escape" | "path_invalid" | "stat_failed" | "not_a_file" | "not_a_directory",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FilePathSafetyError";
  }
}

const ENV_VAR = "OPENRIG_FILES_ALLOWLIST";
const LEGACY_ENV_VAR = "RIGGED_FILES_ALLOWLIST";

/**
 * Decodes a raw `name:/abs/path,name:/abs/path` allowlist string into
 * canonical AllowlistRoot[]. Whitespace around delimiters trimmed.
 * Invalid pairs (no colon, empty name, non-absolute path) silently
 * skipped. Duplicate names: last wins. Same shape both env-var and
 * settings-file-resolved values produce.
 */
export function decodeAllowlist(raw: string): AllowlistRoot[] {
  if (!raw.trim()) return [];
  const out = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const name = trimmed.slice(0, colon).trim();
    const rawPath = trimmed.slice(colon + 1).trim();
    if (!name || !rawPath) continue;
    if (!path.isAbsolute(rawPath)) continue;
    let canonical: string;
    try {
      canonical = fs.realpathSync(rawPath);
    } catch {
      canonical = path.resolve(rawPath);
    }
    out.set(name, canonical);
  }
  return Array.from(out.entries()).map(([name, canonicalPath]) => ({ name, canonicalPath }));
}

/**
 * Reads the allowlist env var directly and returns the parsed root list.
 * Preserved for backward-compat callers; v0 callers prefer the resolved
 * settings-store path which honors env > settings-file > empty.
 */
export function readAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): AllowlistRoot[] {
  // Use || (not ??) so an empty-string OPENRIG_FILES_ALLOWLIST falls
  // back to the legacy var. ?? only handles null/undefined.
  const raw = (env[ENV_VAR] || env[LEGACY_ENV_VAR] || "").toString();
  return decodeAllowlist(raw);
}

/**
 * Resolves a relative path against an allowlist root. Throws
 * FilePathSafetyError on any unsafe condition. Returns the
 * canonical absolute path on success. Caller is expected to stat
 * the result to distinguish file/directory.
 *
 * Path-safety algorithm:
 *   1. Validate the root exists in the allowlist (reject "root_unknown").
 *   2. Reject relative paths that look absolute or contain `..`
 *      segments (reject "path_invalid" / "path_escape").
 *   3. Resolve the relative path against the canonical root.
 *   4. Resolve symlinks: if the realpath does not start with the
 *      canonical root + path separator, reject "path_escape".
 *   5. The base case `path = ""` resolves to the root itself (allowed
 *      so callers can list the root directory).
 */
export function resolveAllowedPath(
  allowlist: AllowlistRoot[],
  rootName: string,
  relativePath: string,
): string {
  const root = allowlist.find((r) => r.name === rootName);
  if (!root) {
    throw new FilePathSafetyError(
      "root_unknown",
      `allowlist root '${rootName}' is not configured. Allowlist configured roots: ${allowlist.map((r) => r.name).join(", ") || "(none)"}.`,
      { rootName, configuredRoots: allowlist.map((r) => r.name) },
    );
  }
  // Reject ../ escape attempts BEFORE filesystem resolution. Even
  // though step 4 catches realpath escapes, this rejects the
  // expressed-intent-to-escape with a clearer error code.
  if (relativePath.includes("..")) {
    // Distinguish a literal ".." segment from a filename like "foo..bar"
    // — split on path.sep and `/` and inspect each segment.
    const segments = relativePath.split(/[\\/]/).filter((s) => s.length > 0);
    for (const seg of segments) {
      if (seg === "..") {
        throw new FilePathSafetyError(
          "path_escape",
          `relative path '${relativePath}' contains a '..' segment; reject.`,
          { rootName, relativePath },
        );
      }
    }
  }
  if (path.isAbsolute(relativePath)) {
    throw new FilePathSafetyError(
      "path_invalid",
      `relative path '${relativePath}' must not be absolute (reject).`,
      { rootName, relativePath },
    );
  }
  const candidate = path.resolve(root.canonicalPath, relativePath);
  let realpath: string;
  try {
    realpath = fs.realpathSync(candidate);
  } catch {
    // If the candidate doesn't exist on disk yet, fall back to the
    // unresolved candidate. Subsequent stat will surface the absence
    // with a more specific error code.
    realpath = candidate;
  }
  // Containment check with path.sep boundary to avoid the
  // /foo/bar matching /foo/bar-other false-positive.
  const rootWithSep = root.canonicalPath.endsWith(path.sep)
    ? root.canonicalPath
    : `${root.canonicalPath}${path.sep}`;
  if (realpath !== root.canonicalPath && !realpath.startsWith(rootWithSep)) {
    throw new FilePathSafetyError(
      "path_escape",
      `resolved path '${realpath}' falls outside allowlist root '${rootName}' (${root.canonicalPath}).`,
      { rootName, relativePath, resolved: realpath, rootCanonical: root.canonicalPath },
    );
  }
  return realpath;
}

/** Convenience: resolve + assert the result is an existing regular file. */
export function resolveAllowedFile(
  allowlist: AllowlistRoot[],
  rootName: string,
  relativePath: string,
): string {
  const resolved = resolveAllowedPath(allowlist, rootName, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new FilePathSafetyError(
      "stat_failed",
      `failed to stat '${resolved}': ${err instanceof Error ? err.message : String(err)}`,
      { rootName, relativePath, resolved },
    );
  }
  if (!stat.isFile()) {
    throw new FilePathSafetyError(
      "not_a_file",
      `resolved path '${resolved}' is not a regular file.`,
      { rootName, relativePath, resolved },
    );
  }
  return resolved;
}

/** Convenience: resolve + assert the result is an existing directory. */
export function resolveAllowedDirectory(
  allowlist: AllowlistRoot[],
  rootName: string,
  relativePath: string,
): string {
  const resolved = resolveAllowedPath(allowlist, rootName, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new FilePathSafetyError(
      "stat_failed",
      `failed to stat '${resolved}': ${err instanceof Error ? err.message : String(err)}`,
      { rootName, relativePath, resolved },
    );
  }
  if (!stat.isDirectory()) {
    throw new FilePathSafetyError(
      "not_a_directory",
      `resolved path '${resolved}' is not a directory.`,
      { rootName, relativePath, resolved },
    );
  }
  return resolved;
}
