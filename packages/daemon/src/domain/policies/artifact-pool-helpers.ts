// PL-004 Phase C: shared artifact-pool helpers (TypeScript port of POC
// `lib/policies/artifact-pool.js`).
//
// Used by artifact-pool-ready and edge-artifact-required policies. Pure
// filesystem scanner; no event-bus, no DB, no Hono. Reverse-engineers
// the POC contract for include_statuses + frontmatter extraction.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

export interface ArtifactPoolSpec {
  /** Absolute path to the pool directory (or `paths` array variant). */
  path?: string;
  paths?: string[];
  /** File extensions to include (default: ['.md']). */
  extensions?: string[];
  /** Filter on frontmatter `status:` field (default: include all). */
  include_statuses?: string[];
  /** Frontmatter field used for keying artifacts (default: 'entry'). */
  key_field?: string;
}

export interface ScannedArtifact {
  /** Absolute path to the artifact file. */
  path: string;
  /** Parsed YAML frontmatter (top-level keys only). */
  frontmatter: Record<string, string>;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/**
 * Parse top-level YAML frontmatter from a markdown-style document.
 * Only extracts `key: value` pairs (no nested structures, no arrays).
 * Mirrors POC's lightweight extraction in lib/policies/artifact-pool.js.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return {};
  const block = match[1] ?? "";
  const fm: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (key) fm[key] = value;
  }
  return fm;
}

/**
 * Scan a single pool directory for artifacts matching extensions +
 * include_statuses. Returns ScannedArtifact[] with parsed frontmatter.
 */
function scanPool(spec: ArtifactPoolSpec & { path: string }): ScannedArtifact[] {
  if (!existsSync(spec.path)) return [];
  let entries: string[];
  try {
    entries = readdirSync(spec.path);
  } catch {
    return [];
  }
  const exts = spec.extensions ?? [".md"];
  const includeStatuses = spec.include_statuses;
  const out: ScannedArtifact[] = [];
  for (const entry of entries) {
    if (!exts.some((e) => entry.endsWith(e))) continue;
    const fullPath = join(spec.path, entry);
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    if (includeStatuses && includeStatuses.length > 0) {
      if (!includeStatuses.includes(fm.status ?? "")) continue;
    }
    out.push({ path: fullPath, frontmatter: fm });
  }
  return out;
}

/**
 * Scan one or more artifact pools per spec(s). Mirrors POC
 * `scanArtifactPools(pools)`. Returns the flat union of matches across
 * all pools. Missing/unreadable pools yield empty contributions.
 */
export async function scanArtifactPools(
  pools: ArtifactPoolSpec | ArtifactPoolSpec[] | undefined,
): Promise<ScannedArtifact[]> {
  if (!pools) return [];
  const list = Array.isArray(pools) ? pools : [pools];
  const out: ScannedArtifact[] = [];
  for (const spec of list) {
    if (spec.path) {
      out.push(...scanPool({ ...spec, path: spec.path }));
    } else if (Array.isArray(spec.paths)) {
      for (const p of spec.paths) out.push(...scanPool({ ...spec, path: p }));
    }
  }
  return out;
}

/**
 * Format an artifact list as bullet lines. Mirrors POC formatArtifactList.
 */
export function formatArtifactList(artifacts: ScannedArtifact[], maxItems: number): string {
  return artifacts
    .slice(0, maxItems)
    .map((a) => `- ${basename(a.path)} (${a.path})`)
    .join("\n");
}

/**
 * Compute the source-key for an artifact (used by edge-artifact-required).
 * Mirrors POC sourceKeyFor: prefer frontmatter[keyField], else basename
 * sans .md extension.
 */
export function sourceKeyFor(artifact: ScannedArtifact, keyField: string): string {
  const value = artifact.frontmatter[keyField];
  if (value === undefined || value === null || value === "") {
    return basename(artifact.path).replace(/\.md$/, "");
  }
  return value;
}
