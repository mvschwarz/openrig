// PL-004 Phase C R1: shared artifact-pool helpers (TypeScript port of
// POC `lib/policies/artifact-pool.js`).
//
// R1 fix (guard blocker 3): full POC parity for the scanner. The
// artifact-pool-ready and edge-artifact-required policies depend on:
//   - Default ignores: README.md and .DS_Store always excluded.
//   - Configured ignore_names: per-pool extra exclusions.
//   - Recursive scan when pool.recursive=true.
//   - Malformed-frontmatter exclusion unless pool.include_malformed_frontmatter.
//   - Raw content preserved on every artifact (used by edge-artifact-required
//     for body-reference target satisfaction).
//   - Missing pool path returns empty (ENOENT-tolerant).
//
// Pure filesystem scanner; no event-bus, no DB, no Hono.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const DEFAULT_EXTENSIONS = [".md"];
const DEFAULT_IGNORE_NAMES = ["README.md", ".DS_Store"];

export interface ArtifactPoolSpec {
  /** Absolute path to the pool directory. POC contract: one path per pool. */
  path?: string;
  /** Convenience array form; expanded to one pool per path. */
  paths?: string[];
  /** File extensions to include (default: ['.md']). */
  extensions?: string[];
  /** Filter on frontmatter `status:` field. Empty/absent = include all. */
  include_statuses?: string[];
  /** Frontmatter field used for keying artifacts (default: 'entry'). */
  key_field?: string;
  /** Per-pool extra ignore names (added to defaults). */
  ignore_names?: string[];
  /** When true, descend into subdirectories. Default false. */
  recursive?: boolean;
  /**
   * When true, artifacts whose frontmatter cannot be parsed are still
   * included with empty frontmatter. Default false: malformed frontmatter
   * causes the artifact to be excluded (matches POC behavior so that
   * agents do not get woken about half-written drafts).
   */
  include_malformed_frontmatter?: boolean;
}

export interface ScannedArtifact {
  /** Absolute path to the artifact file. */
  path: string;
  /** The pool path that produced this artifact. */
  pool_path: string;
  /** Full file content (used by edge-artifact-required body-match). */
  raw: string;
  /** Parsed YAML frontmatter (top-level keys only). */
  frontmatter: Record<string, string>;
  /** Parse error message when include_malformed_frontmatter=true; else null. */
  frontmatter_parse_error: string | null;
  /** Convenience accessor for frontmatter.status; null when absent. */
  status: string | null;
}

const FRONTMATTER_OPEN = "---\n";

/**
 * Parse top-level YAML frontmatter from a markdown-style document.
 * Returns { raw, frontmatter, parseError } so callers can decide whether
 * to include malformed artifacts.
 *
 * Detection of malformed frontmatter mirrors POC behavior: lines that
 * fail the `key: value` shape after the opener are treated as parse
 * errors (rather than silently dropped) so include_malformed_frontmatter
 * gating works as POC tests expect.
 */
function readFrontmatter(filePath: string): {
  raw: string;
  frontmatter: Record<string, string>;
  frontmatter_parse_error: string | null;
} {
  const raw = readFileSync(filePath, "utf-8");
  if (!raw.startsWith(FRONTMATTER_OPEN)) {
    return { raw, frontmatter: {}, frontmatter_parse_error: null };
  }
  const endIdx = raw.indexOf("\n---\n", FRONTMATTER_OPEN.length);
  if (endIdx === -1) {
    return { raw, frontmatter: {}, frontmatter_parse_error: null };
  }
  const block = raw.slice(FRONTMATTER_OPEN.length, endIdx);
  const fm: Record<string, string> = {};
  let parseError: string | null = null;
  for (const line of block.split("\n")) {
    if (line.trim().length === 0) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      parseError = `frontmatter line missing ':' (${line.slice(0, 40)})`;
      break;
    }
    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1);
    let value = valueRaw.trim();
    // Detect malformed values like 'broken: value: still broken' where the
    // value side itself contains another `:` outside quotes. POC treats
    // these as parse errors so half-written drafts do not slip through.
    const stripped = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (
      stripped !== value &&
      stripped.length === value.length - 2
    ) {
      // Was quoted; treat as a clean string regardless of inner colons.
      value = stripped;
    } else if (value.includes(":")) {
      parseError = `frontmatter value contains unescaped ':' for key '${key}'`;
      break;
    }
    if (!key) {
      parseError = "frontmatter line missing key";
      break;
    }
    fm[key] = value;
  }
  return {
    raw,
    frontmatter: parseError ? {} : fm,
    frontmatter_parse_error: parseError,
  };
}

function listFiles(rootDir: string, recursive: boolean): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...listFiles(full, recursive));
      continue;
    }
    if (entry.isFile()) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function shouldIncludeFile(filePath: string, pool: ArtifactPoolSpec): boolean {
  const name = basename(filePath);
  const ignoreNames = new Set([
    ...DEFAULT_IGNORE_NAMES,
    ...(Array.isArray(pool.ignore_names) ? pool.ignore_names : []),
  ]);
  if (ignoreNames.has(name)) return false;
  const exts = Array.isArray(pool.extensions) ? pool.extensions : DEFAULT_EXTENSIONS;
  return exts.some((e) => name.endsWith(e));
}

function statusAllowed(status: string | null, pool: ArtifactPoolSpec): boolean {
  const include = pool.include_statuses;
  if (!Array.isArray(include) || include.length === 0) return true;
  return status !== null && include.includes(status);
}

/**
 * Scan one or more artifact pools per spec(s). Mirrors POC
 * `scanArtifactPools(pools)`. Returns the flat union of matches across
 * all pools, sorted by absolute path. Missing pools yield empty.
 *
 * Throws if `pools` is undefined / empty / shapeless — POC contract:
 * the policy spec MUST declare at least one pool.
 */
export async function scanArtifactPools(
  pools: ArtifactPoolSpec | ArtifactPoolSpec[] | undefined,
): Promise<ScannedArtifact[]> {
  const expanded = expandPools(pools);
  if (expanded.length === 0) {
    throw new Error("artifact pool policy: context pool list is required");
  }
  const out: ScannedArtifact[] = [];
  for (const pool of expanded) {
    if (!pool.path) {
      throw new Error("artifact pool policy: every pool requires a path");
    }
    const files = listFiles(pool.path, Boolean(pool.recursive));
    for (const filePath of files) {
      if (!shouldIncludeFile(filePath, pool)) continue;
      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      let parsed;
      try {
        parsed = readFrontmatter(filePath);
      } catch {
        continue;
      }
      if (parsed.frontmatter_parse_error && !pool.include_malformed_frontmatter) {
        continue;
      }
      const status = parsed.frontmatter.status ?? null;
      if (!statusAllowed(status, pool)) continue;
      out.push({
        path: filePath,
        pool_path: pool.path,
        raw: parsed.raw,
        frontmatter: parsed.frontmatter,
        frontmatter_parse_error: parsed.frontmatter_parse_error,
        status,
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Expand the convenience input shape (single object, array of objects,
 * or `paths: [...]` shorthand) into a flat array of single-path pools.
 */
function expandPools(
  pools: ArtifactPoolSpec | ArtifactPoolSpec[] | undefined,
): ArtifactPoolSpec[] {
  if (!pools) return [];
  const list = Array.isArray(pools) ? pools : [pools];
  const out: ArtifactPoolSpec[] = [];
  for (const spec of list) {
    if (spec.path) {
      out.push(spec);
    } else if (Array.isArray(spec.paths)) {
      for (const p of spec.paths) out.push({ ...spec, path: p, paths: undefined });
    }
  }
  return out;
}

/**
 * Format an artifact list as bullet lines. Mirrors POC formatArtifactList:
 * `- /full/absolute/path`. The POC favors the full path so receivers can
 * cd / open / cat the artifact directly without further lookup.
 */
export function formatArtifactList(artifacts: ScannedArtifact[], maxItems: number): string {
  return artifacts
    .slice(0, maxItems)
    .map((a) => `- ${a.path}`)
    .join("\n");
}

/**
 * Compute the source-key for an artifact. Mirrors POC sourceKeyFor:
 * prefer frontmatter[keyField], else basename sans .md extension.
 */
export function sourceKeyFor(artifact: ScannedArtifact, keyField: string): string {
  const value = artifact.frontmatter[keyField];
  if (value === undefined || value === null || value === "") {
    return basename(artifact.path).replace(/\.md$/, "");
  }
  return String(value);
}
