// Slice Story View v0 — slice indexer.
//
// Reads slice folders from a configured filesystem root. The default
// workspace contract is `workspace/missions/<mission>/slices/<slice>`;
// explicitly configured flat roots (`workspace/slices/<slice>`) remain
// supported for compatibility. The indexer parses each slice's
// frontmatter + acceptance section markers and exposes a
// normalized Slice record stitched against already-shipped tables
// (queue_items, queue_transitions, mission_control_actions) and
// dogfood-evidence directories.
//
// MVP context: single-developer, single-user, single-host. v0 uses the
// slice folder as the navigable entity. NO new SQLite migrations, NO new
// event types: read-only projection over existing data + the filesystem.

import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";

export type SliceStatus = "active" | "done" | "blocked" | "draft";

export interface SliceQitemRef {
  qitemId: string;
  state: string;
  sourceSession: string;
  destinationSession: string;
  tier: string | null;
  tsUpdated: string;
}

export interface SliceProofPacket {
  /** Directory name under the dogfood-evidence root. */
  dirName: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Markdown file paths (relative to dirName). Latest-first by mtime. */
  markdownFiles: string[];
  /** Inline-renderable image paths (relative to dirName). */
  screenshots: string[];
  /** Video file paths (relative to dirName). Empty array if QA hasn't captured one yet. */
  videos: string[];
  /** Trace zip paths (relative to dirName). */
  traces: string[];
  /** mtime of the directory (ISO string). */
  mtime: string;
}

/** V0.3.1 slice 13 walk-item 7 — `workflow_spec: <name>@<version>`
 *  frontmatter declaration. When set, the Topology tab projects a
 *  spec graph from this declaration via WorkflowSpecCache.getByName-
 *  Version + projectSpecGraph, even when no live workflow_instance
 *  is bound. Null when the field is absent or malformed. */
export interface WorkflowSpecRef {
  name: string;
  version: string;
}

export interface SliceRecord {
  /** Folder name (canonical id). */
  name: string;
  /** Mission folder id when discovered under missions/<mission>/slices/<slice>. */
  missionId: string | null;
  /** Absolute filesystem path of the slice folder. */
  slicePath: string;
  /** Display name from frontmatter or first H1; falls back to name. */
  displayName: string;
  /** Optional rail-item code (PL-005, PL-019, etc.) parsed from frontmatter. */
  railItem: string | null;
  /** Mapped status from frontmatter status field. */
  status: SliceStatus;
  /** Raw status string from frontmatter (for debugging). */
  rawStatus: string | null;
  /** Joined qitem ids from queue_items matched by frontmatter rail-item or slice-name body. */
  qitemIds: string[];
  /** Commit refs parsed from frontmatter (phase-X-shipped-commits, target-commit, etc.). */
  commitRefs: string[];
  /** Latest matching dogfood-evidence directory (or null). */
  proofPacket: SliceProofPacket | null;
  /** Max of slice folder mtimes + matched qitem ts_updated values. */
  lastActivityAt: string | null;
  /** Sources cited in frontmatter (e.g. PRDs, planner-briefs). */
  files: string[];
  /** Parsed `workflow_spec: <name>@<version>` frontmatter declaration; null when absent or malformed. */
  workflowSpec: WorkflowSpecRef | null;
}

export interface SliceListEntry {
  name: string;
  missionId: string | null;
  displayName: string;
  railItem: string | null;
  /** Mirrors SliceRecord.workflowSpec; null when absent or malformed. */
  workflowSpec: WorkflowSpecRef | null;
  status: SliceStatus;
  rawStatus: string | null;
  qitemCount: number;
  hasProofPacket: boolean;
  lastActivityAt: string | null;
  /** PL-007 — absolute filesystem path of the slice folder. UI resolves
   *  workspace kind by matching this against RigSpec.workspace.repos[].path
   *  / knowledgeRoot. Always populated by toListEntry. */
  slicePath: string;
}

export interface SliceIndexerOpts {
  /** Root directory containing slice folders. */
  slicesRoot: string;
  /** Additional compatible roots to scan after the primary root. */
  additionalSliceRoots?: string[];
  /** Root directory containing dogfood-evidence directories. */
  dogfoodEvidenceRoot: string | null;
  /** SQLite handle for read-only joins to queue_items + transitions + actions. */
  db: Database.Database;
  /** Cache TTL in milliseconds. Default 60_000 (60s) — re-walks on next request after expiry. */
  cacheTtlMs?: number;
}

interface CachedListing {
  entries: SliceListEntry[];
  expiresAt: number;
}

interface CachedSlice {
  record: SliceRecord;
  expiresAt: number;
}

interface SliceLocation {
  name: string;
  missionId: string | null;
  slicePath: string;
}

const FRONTMATTER_DELIM = "---";
const DEFAULT_CACHE_TTL_MS = 60_000;

const STATUS_TO_BUCKET: Record<string, SliceStatus> = {
  active: "active",
  "in-flight": "active",
  ratified: "active",
  "draft-pending-orch-ratification": "draft",
  draft: "draft",
  done: "done",
  shipped: "done",
  promoted: "done",
  closed: "done",
  blocked: "blocked",
  "parked-with-evidence": "blocked",
};

export class SliceIndexer {
  readonly slicesRoot: string;
  readonly additionalSliceRoots: string[];
  readonly dogfoodEvidenceRoot: string | null;
  /** Workflows in Spec Library v0: exposed read-only so the slices
   *  route's `boundToWorkflow` lens filter can call
   *  `findSliceWorkflowBinding(db, qitemIds)` without re-injecting
   *  the db handle elsewhere. Internal callers continue to use it
   *  the same way; read-only consumer outside the class. */
  readonly db: Database.Database;
  private readonly cacheTtlMs: number;
  private listingCache: CachedListing | null = null;
  private detailCache: Map<string, CachedSlice> = new Map();

  constructor(opts: SliceIndexerOpts) {
    this.slicesRoot = opts.slicesRoot;
    this.additionalSliceRoots = opts.additionalSliceRoots ?? [];
    this.dogfoodEvidenceRoot = opts.dogfoodEvidenceRoot;
    this.db = opts.db;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /** Returns true when any configured slice root exists on disk. */
  isReady(): boolean {
    return this.sliceRoots().some((root) => this.isDirectory(root));
  }

  /** Drops both caches. Used by tests + by a future explicit-refresh route. */
  invalidate(): void {
    this.listingCache = null;
    this.detailCache.clear();
  }

  list(): SliceListEntry[] {
    if (!this.isReady()) return [];
    const now = Date.now();
    if (this.listingCache && this.listingCache.expiresAt > now) {
      return this.listingCache.entries;
    }
    const locations = this.readSliceLocations();
    const entries: SliceListEntry[] = locations.map((location) => this.toListEntry(location));
    this.listingCache = { entries, expiresAt: now + this.cacheTtlMs };
    return entries;
  }

  get(name: string): SliceRecord | null {
    if (!this.isReady()) return null;
    const now = Date.now();
    const cached = this.detailCache.get(name);
    if (cached && cached.expiresAt > now) {
      return cached.record;
    }
    const location = this.findSliceLocation(name);
    if (!location) return null;

    const record = this.buildRecord(location);
    this.detailCache.set(name, { record, expiresAt: now + this.cacheTtlMs });
    return record;
  }

  // --- internals ---

  private readSliceLocations(): SliceLocation[] {
    const locations: SliceLocation[] = [];
    const seen = new Set<string>();
    const addLocation = (location: SliceLocation) => {
      if (seen.has(location.name)) return;
      seen.add(location.name);
      locations.push(location);
    };

    for (const root of this.sliceRoots()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const entryPath = path.join(root, entry.name);
        const nestedSlicesRoot = path.join(entryPath, "slices");
        if (this.isDirectory(nestedSlicesRoot)) {
          let nestedEntries: fs.Dirent[];
          try {
            nestedEntries = fs.readdirSync(nestedSlicesRoot, { withFileTypes: true });
          } catch {
            nestedEntries = [];
          }
          for (const nested of nestedEntries) {
            if (!nested.isDirectory() || nested.name.startsWith(".")) continue;
            addLocation({
              name: nested.name,
              missionId: entry.name,
              slicePath: path.join(nestedSlicesRoot, nested.name),
            });
          }
          continue;
        }
        addLocation({
          name: entry.name,
          missionId: null,
          slicePath: entryPath,
        });
      }
    }
    return locations.sort((a, b) => a.name.localeCompare(b.name));
  }

  private findSliceLocation(name: string): SliceLocation | null {
    return this.readSliceLocations().find((location) => location.name === name) ?? null;
  }

  private isDirectory(absPath: string): boolean {
    try {
      return fs.statSync(absPath).isDirectory();
    } catch {
      return false;
    }
  }

  private sliceRoots(): string[] {
    const roots = [this.slicesRoot, ...this.additionalSliceRoots].filter((root) => root.length > 0);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const root of roots) {
      const resolved = path.resolve(root);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push(root);
    }
    return out;
  }

  private toListEntry(location: SliceLocation): SliceListEntry {
    const { name, missionId, slicePath } = location;
    const frontmatter = this.readPrimaryFrontmatter(slicePath);
    const status = this.mapStatus(frontmatter["status"] as string | undefined);
    const railItem = this.extractRailItem(frontmatter, missionId);
    const qitemIds = this.matchQitems(name, railItem, missionId);
    const proofPacket = this.findProofPacket(name);
    const lastActivityAt = this.computeLastActivity(slicePath, qitemIds, proofPacket);

    return {
      name,
      missionId,
      displayName: this.extractDisplayName(slicePath, frontmatter, name),
      railItem,
      workflowSpec: parseWorkflowSpecRef(frontmatter["workflow_spec"]),
      status,
      rawStatus: (frontmatter["status"] as string | undefined) ?? null,
      qitemCount: qitemIds.length,
      hasProofPacket: proofPacket !== null,
      lastActivityAt,
      slicePath,
    };
  }

  private buildRecord(location: SliceLocation): SliceRecord {
    const { name, missionId, slicePath } = location;
    const frontmatter = this.readPrimaryFrontmatter(slicePath);
    const status = this.mapStatus(frontmatter["status"] as string | undefined);
    const railItem = this.extractRailItem(frontmatter, missionId);
    const qitemIds = this.matchQitems(name, railItem, missionId);
    const proofPacket = this.findProofPacket(name);
    const lastActivityAt = this.computeLastActivity(slicePath, qitemIds, proofPacket);
    const commitRefs = this.extractCommitRefs(frontmatter);
    const files = this.listSliceFiles(slicePath);

    return {
      name,
      missionId,
      slicePath,
      displayName: this.extractDisplayName(slicePath, frontmatter, name),
      railItem,
      status,
      rawStatus: (frontmatter["status"] as string | undefined) ?? null,
      qitemIds,
      commitRefs,
      proofPacket,
      lastActivityAt,
      files,
      workflowSpec: parseWorkflowSpecRef(frontmatter["workflow_spec"]),
    };
  }

  private readPrimaryFrontmatter(slicePath: string): Record<string, unknown> {
    // Merge canonical slice frontmatter in document-order, with PROGRESS.md
    // last so the current lifecycle cursor overrides older dispatch metadata
    // while README.md/IMPLEMENTATION-PRD.md still supply slice title, rail item,
    // and source refs when PROGRESS.md is sparse.
    const candidates = ["IMPLEMENTATION-PRD.md", "README.md", "PROGRESS.md"];
    const merged: Record<string, unknown> = {};
    for (const candidate of candidates) {
      const fullPath = path.join(slicePath, candidate);
      if (!fs.existsSync(fullPath)) continue;
      const fm = parseFrontmatter(fs.readFileSync(fullPath, "utf8"));
      if (Object.keys(fm).length > 0) {
        Object.assign(merged, fm);
      }
    }
    if (Object.keys(merged).length > 0) return merged;

    // Some slices only have a planner-brief at this point.
    // Best-effort: any planner-brief shape.
    try {
      const entries = fs.readdirSync(slicePath, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".md")) continue;
        const fm = parseFrontmatter(fs.readFileSync(path.join(slicePath, e.name), "utf8"));
        if (Object.keys(fm).length > 0) return fm;
      }
    } catch {
      // Slice folder unreadable — return empty.
    }
    return {};
  }

  private extractDisplayName(slicePath: string, frontmatter: Record<string, unknown>, fallback: string): string {
    if (typeof frontmatter["title"] === "string") return frontmatter["title"] as string;
    if (typeof frontmatter["slice"] === "string") return frontmatter["slice"] as string;
    // Pull the first H1 from the primary doc.
    for (const candidate of ["README.md", "IMPLEMENTATION-PRD.md", "PROGRESS.md"]) {
      const fullPath = path.join(slicePath, candidate);
      if (!fs.existsSync(fullPath)) continue;
      const content = fs.readFileSync(fullPath, "utf8");
      const m = content.match(/^# (.+?)$/m);
      if (m && m[1]) return m[1].trim();
    }
    return fallback;
  }

  private extractRailItem(frontmatter: Record<string, unknown>, missionId: string | null): string | null {
    const raw = frontmatter["rail-item"];
    if (typeof raw === "string") {
      // Strip array brackets if YAML parser dropped them as a string ("[PL-008]").
      const stripped = raw.replace(/^\[|\]$/g, "").trim();
      if (stripped.length > 0) return stripped.split(",")[0]!.trim();
    }
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") return raw[0];
    const related = frontmatter["related-rail-items"];
    if (typeof related === "string") {
      const stripped = related.replace(/^\[|\]$/g, "").trim();
      if (stripped.length > 0) return stripped.split(",")[0]!.trim();
    }
    if (Array.isArray(related) && related.length > 0 && typeof related[0] === "string") return related[0];
    return missionId;
  }

  private extractCommitRefs(frontmatter: Record<string, unknown>): string[] {
    const refs: string[] = [];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (typeof value !== "string") continue;
      // Match keys like phase-a-shipped-commits / target-commit / phase-a-base-commit.
      if (!/commits?$/.test(key)) continue;
      // Comma- or whitespace-separated 7+ char hex tokens are the heuristic.
      const tokens = value.split(/[\s,]+/).filter((t) => /^[0-9a-f]{7,40}$/i.test(t));
      refs.push(...tokens);
    }
    // Dedup while preserving order.
    return Array.from(new Set(refs));
  }

  private mapStatus(raw: string | undefined): SliceStatus {
    if (!raw) return "draft";
    const normalized = raw.toLowerCase().trim();
    if (STATUS_TO_BUCKET[normalized]) return STATUS_TO_BUCKET[normalized];
    // Heuristic fallbacks.
    if (normalized.includes("done") || normalized.includes("ship") || normalized.includes("close")) return "done";
    if (normalized.includes("block") || normalized.includes("park")) return "blocked";
    if (normalized.includes("draft") || normalized.includes("pending")) return "draft";
    return "active";
  }

  private matchQitems(sliceName: string, railItem: string | null, missionId: string | null): string[] {
    // V0.3.1 slice 17 founder-walk-workspace-state-correctness (walk item 3): the previous implementation unioned substring matches on
    // [sliceName, railItem, missionId]. The missionId term over-matched
    // — every qitem tagged `mission:<id>` appeared under EVERY slice in
    // that mission. Fix: when typed `slice:<name>` tag rows exist for
    // this slice, the missionId substring term is dropped from the
    // union; the typed tag is the authoritative slice membership signal.
    // Substring fallback (including the missionId term) is preserved for
    // slices whose qitem corpus pre-dates the typed-tag convention so
    // legacy mission-aware workspaces don't regress.
    const ids = new Set<string>();
    try {
      // 1. Typed-tag matches: tags JSON contains `slice:<sliceName>` literal.
      // Both the `"slice:..."` JSON-array form and the comma-separated
      // form (legacy CLI tags) are caught by a wildcard on the slice id.
      let typedTagMatchCount = 0;
      try {
        const rows = this.db.prepare(
          `SELECT qitem_id FROM queue_items WHERE tags LIKE ? LIMIT 500`,
        ).all(`%slice:${sliceName}%`) as Array<{ qitem_id: string }>;
        for (const r of rows) ids.add(r.qitem_id);
        typedTagMatchCount = rows.length;
      } catch {
        // queue_items present but `tags` column missing (older test
        // harness): fall through to substring path with full term set.
      }

      // 2. Substring matches. Terms are chosen so the missionId term
      // is INCLUDED only when no typed-tag rows exist (legacy
      // compatibility); otherwise the slice-specific terms drive
      // matching. In mission-folder workspaces, railItem defaults to
      // missionId when no explicit rail item is authored, so the typed-tag
      // branch must not blindly keep that fallback or mission-only qitems
      // leak back into every slice in the mission.
      const substringTerms = (typedTagMatchCount > 0
        ? [sliceName, railItem === missionId ? null : railItem]
        : [sliceName, railItem, missionId]
      ).filter((v): v is string => !!v);
      for (const term of Array.from(new Set(substringTerms))) {
        try {
          const rows = this.db.prepare(
            `SELECT qitem_id FROM queue_items WHERE body LIKE ? OR tags LIKE ? LIMIT 500`,
          ).all(`%${term}%`, `%${term}%`) as Array<{ qitem_id: string }>;
          for (const r of rows) ids.add(r.qitem_id);
        } catch {
          const rows = this.db.prepare(
            `SELECT qitem_id FROM queue_items WHERE body LIKE ? LIMIT 500`,
          ).all(`%${term}%`) as Array<{ qitem_id: string }>;
          for (const r of rows) ids.add(r.qitem_id);
        }
      }
    } catch {
      // queue_items table absent (test harness without the migration); return empty.
      return [];
    }
    // V0.3.1 slice 17 walk item 10 — forward-fix #1. Sort qitemIds DESC
    // by ts_created so the slice-detail Queue tab renders newest first
    // (HG-5). The ScopePages.ScopeQueueRollup frontend sort still runs
    // as a belt-and-suspenders measure for code paths that bypass this
    // helper, but the backend is the authoritative consistency point.
    // Fallback to qitem-id lex DESC when ts_created is unavailable (the
    // id encodes the timestamp prefix `qitem-YYYYMMDDHHMMSS-...`).
    const idsArr = Array.from(ids);
    if (idsArr.length <= 1) return idsArr;
    try {
      const placeholders = idsArr.map(() => "?").join(",");
      const tsRows = this.db.prepare(
        `SELECT qitem_id, ts_created FROM queue_items WHERE qitem_id IN (${placeholders})`,
      ).all(...idsArr) as Array<{ qitem_id: string; ts_created: string | null }>;
      const tsByQitemId = new Map<string, string>();
      for (const r of tsRows) if (r.ts_created) tsByQitemId.set(r.qitem_id, r.ts_created);
      idsArr.sort((a, b) => {
        const tsA = tsByQitemId.get(a) ?? a;
        const tsB = tsByQitemId.get(b) ?? b;
        if (tsA === tsB) return 0;
        return tsA < tsB ? 1 : -1; // DESC
      });
    } catch {
      // Sort failure (e.g. ts_created column absent): fall back to
      // qitem-id lex DESC. id format encodes the timestamp so this
      // still yields newest-first in practice.
      idsArr.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    }
    return idsArr;
  }

  private findProofPacket(sliceName: string): SliceProofPacket | null {
    if (!this.dogfoodEvidenceRoot) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dogfoodEvidenceRoot, { withFileTypes: true });
    } catch {
      return null;
    }

    // Match strategy: token-based. Tokenize slice name on `-`, drop
    // trailing `vN` version tokens (real proof dirs typically don't
    // include the version suffix), then a dir matches if every remaining
    // token appears as a hyphen-bounded substring of the dir name. This
    // handles real-world dir-naming where phase indicators land at the
    // front (e.g. `pl005-phase-a-mission-control-queue-observability-...`)
    // even though the slice folder uses suffix form
    // (`mission-control-queue-observability-phase-a`). Latest mtime wins.
    const sliceTokens = sliceName.split("-").filter((t) => t.length > 0 && !/^v\d+$/.test(t));
    const matches: { dirent: fs.Dirent; mtime: number }[] = [];
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const dirTokenSet = new Set(dirent.name.split(/[-._]/).filter((t) => t.length > 0));
      const allTokensPresent = sliceTokens.every((t) => dirTokenSet.has(t));
      if (!allTokensPresent) continue;
      try {
        const st = fs.statSync(path.join(this.dogfoodEvidenceRoot, dirent.name));
        matches.push({ dirent, mtime: st.mtimeMs });
      } catch {
        // skip
      }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.mtime - a.mtime);
    const winner = matches[0]!;
    const absPath = path.join(this.dogfoodEvidenceRoot, winner.dirent.name);
    return this.scanProofPacket(absPath, winner.dirent.name, winner.mtime);
  }

  private scanProofPacket(absPath: string, dirName: string, mtimeMs: number): SliceProofPacket {
    const markdownFiles: { rel: string; mtime: number }[] = [];
    const screenshots: string[] = [];
    const videos: string[] = [];
    const traces: string[] = [];

    const walk = (dir: string, relPrefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, rel);
          continue;
        }
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        if (lower.endsWith(".md")) {
          try {
            const st = fs.statSync(full);
            markdownFiles.push({ rel, mtime: st.mtimeMs });
          } catch {
            markdownFiles.push({ rel, mtime: 0 });
          }
        } else if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp")) {
          screenshots.push(rel);
        } else if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov")) {
          videos.push(rel);
        } else if (lower.endsWith(".zip") && rel.includes("trace")) {
          traces.push(rel);
        }
      }
    };

    walk(absPath, "");
    markdownFiles.sort((a, b) => b.mtime - a.mtime);

    return {
      dirName,
      absPath,
      markdownFiles: markdownFiles.map((m) => m.rel),
      screenshots: screenshots.sort(),
      videos: videos.sort(),
      traces: traces.sort(),
      mtime: new Date(mtimeMs).toISOString(),
    };
  }

  private computeLastActivity(slicePath: string, qitemIds: string[], proofPacket: SliceProofPacket | null): string | null {
    let maxMs = 0;
    try {
      const st = fs.statSync(slicePath);
      maxMs = Math.max(maxMs, st.mtimeMs);
    } catch {
      // ignore
    }
    if (qitemIds.length > 0) {
      try {
        const placeholders = qitemIds.map(() => "?").join(",");
        const row = this.db.prepare(
          `SELECT MAX(ts_updated) AS mx FROM queue_items WHERE qitem_id IN (${placeholders})`
        ).get(...qitemIds) as { mx: string | null } | undefined;
        if (row?.mx) {
          const ms = Date.parse(row.mx);
          if (!Number.isNaN(ms)) maxMs = Math.max(maxMs, ms);
        }
      } catch {
        // ignore (queue_items absent)
      }
    }
    if (proofPacket) {
      const ms = Date.parse(proofPacket.mtime);
      if (!Number.isNaN(ms)) maxMs = Math.max(maxMs, ms);
    }
    return maxMs > 0 ? new Date(maxMs).toISOString() : null;
  }

  private listSliceFiles(slicePath: string): string[] {
    try {
      return fs.readdirSync(slicePath, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }
}

// --- frontmatter parser (intentionally minimal; YAML lite) ---

export function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith(FRONTMATTER_DELIM)) return {};
  const rest = content.slice(FRONTMATTER_DELIM.length);
  const endIdx = rest.indexOf(`\n${FRONTMATTER_DELIM}`);
  if (endIdx === -1) return {};
  const body = rest.slice(0, endIdx);
  const out: Record<string, unknown> = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip wrapping quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** V0.3.1 slice 13 walk-item 7 — parse `workflow_spec: <name>@<version>`
 *  frontmatter into a structured ref. Returns null when the value is
 *  missing, non-string, or doesn't match the `<name>@<version>` shape.
 *  Exported so the missions route can reuse the same parser on the
 *  mission README's frontmatter. */
export function parseWorkflowSpecRef(raw: unknown): WorkflowSpecRef | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return null;
  const name = trimmed.slice(0, atIdx).trim();
  const version = trimmed.slice(atIdx + 1).trim();
  if (!name || !version) return null;
  return { name, version };
}
