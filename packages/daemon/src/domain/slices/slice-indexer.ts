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
import { parseScopeTags } from "./qitem-membership.js";

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
  /** OPR.0.3.2.17 — frontmatter `description` / `summary` from the
   *  slice's primary doc (README/IMPLEMENTATION-PRD/PROGRESS). Used by
   *  the storytelling adapter as the ConceptCard.oneLiner for
   *  `rawStatus === "candidate"` slices. null when absent. */
  description: string | null;
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

/** qitem-ccf87c0d — the per-generation batch membership index. Replaces the
 *  per-slice queue_items scans (353 tier-1 wildcard+ORDER-BY scans + up to 3
 *  body-LIKE scans per zero-typed slice = ~10s cold at host scale,
 *  synchronously blocking the event loop) with TWO streamed scans per
 *  generation. Semantics are byte-equivalent to the per-slice path and are
 *  pinned by test: typed-authoritative gating (VM-004), per-slice 500
 *  confirmed cap in ts_created DESC/qitem_id DESC order, term-first fallback
 *  assembly, SQL-LIKE ASCII-only case folding, %/_ wildcards spanning
 *  newline, per-term 500 cap, and the tags-column/table-absent degradations. */
interface MembershipIndex {
  /** slice name -> CONFIRMED typed qitem ids (scan order = ts DESC, id DESC; capped 500/slice). */
  typedBySlice: Map<string, string[]>;
  /** fallback term -> qitem ids in row (rowid) order, capped 500/term. */
  fallbackByTerm: Map<string, string[]>;
  /** location names the index was built from — a get() on a folder created
   *  mid-operation (not in this set) forces a rebuild so fresh folders
   *  resolve membership exactly like the per-slice path did. */
  knownSlices: Set<string>;
}

// --- SQL-LIKE-equivalent matching (qitem-ccf87c0d) -------------------------
// SQLite LIKE semantics, replicated byte-for-byte (test-pinned):
//   - ASCII-ONLY case folding (A-Z <-> a-z; æ vs Æ do NOT fold),
//   - `%` matches any run and `_` exactly ONE CHARACTER (code point) — both
//     spanning newlines and astral chars (a surrogate pair is one `_`), so
//     the translated regexes MUST compile with the `su` flags
//     (LIKE_REGEXP_FLAGS below): dotAll for newline, `u` for code-point
//     stepping. A [\s\S] translation would count UTF-16 code units and
//     miss e.g. `a😀b` against `%a_b%` (guard blocker pin).
//   - every other byte is literal (regex specials escaped).

/** The one flag set every translated LIKE regex compiles with. */
const LIKE_REGEXP_FLAGS = "su";

/** Lowercase ASCII A-Z only — never Unicode (SQLite LIKE's fold). */
function asciiFold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** qitem-18f3300d — SQLite LIKE stops matching at the first raw U+0000 in
 *  the haystack (guard-reproduced against the parent per-slice SQL; a NUL
 *  is production-reachable via POST /api/queue/create JSON bodies). Apply
 *  BEFORE asciiFold/prefilter/confirm so a term occurring only after a NUL
 *  never matches, exactly like the parent. */
function sqliteVisiblePrefix(s: string): string {
  const i = s.indexOf("\u0000");
  return i === -1 ? s : s.slice(0, i);
}

/** Translate a run of LIKE-pattern characters (%/_ wildcards, everything
 *  else literal with regex specials escaped). No anchors — callers add
 *  them only where LIKE full-match semantics diverge from contains. */
function likePatternBodyToRegExpSource(patternBody: string): string {
  let out = "";
  for (const ch of patternBody) {
    if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
  }
  return out;
}

/** qitem-18f3300d pattern-side facet — translate the FULL bound LIKE
 *  pattern for one fallback term, exactly as the parent SQL saw it:
 *  build `%<term>%` and truncate THE PATTERN at the first U+0000 (SQLite
 *  truncates patterns too — a NUL inside the term LOSES the trailing
 *  wildcard, leaving an end-anchored `%prefix`).
 *  - Untruncated pattern (the overwhelmingly common no-NUL case):
 *    `%term%` is exactly a contains-match, so the term translates
 *    UNANCHORED — a wildcard-free term compiles to a pure literal, which
 *    keeps the combined prefilter alternation on the regex engine's fast
 *    literal path (an anchored `^.*x.*$` form measured a ~80x benchmark
 *    regression: every non-matching row pays a greedy scan per branch).
 *  - Truncated pattern: LIKE full-match semantics now matter (the lost
 *    trailing `%` end-anchors the remainder), so translate the truncated
 *    pattern verbatim and anchor `^...$`.
 *  Compile with LIKE_REGEXP_FLAGS. */
function likeBoundPatternToRegExpSource(term: string): string {
  const bound = `%${term}%`;
  const pattern = sqliteVisiblePrefix(bound);
  if (pattern === bound) {
    return likePatternBodyToRegExpSource(asciiFold(term));
  }
  return "^" + likePatternBodyToRegExpSource(asciiFold(pattern)) + "$";
}

const FRONTMATTER_DELIM = "---";
const DEFAULT_CACHE_TTL_MS = 60_000;

const STATUS_TO_BUCKET: Record<string, SliceStatus> = {
  active: "active",
  "in-flight": "active",
  ratified: "active",
  "draft-pending-orch-ratification": "draft",
  draft: "draft",
  // VM-005 (release-0.4.7): the scaffold-template frontmatter status TOKEN —
  // a fresh `rig scope` slice is honestly a draft, not active (it previously
  // fell through to mapStatus's terminal default). Distinct grammar from the
  // scaffold-placeholder twin modules, which classify bracket-wrapped body
  // TEXT — a cousin of, not a home for, this frontmatter token literal.
  placeholder: "draft",
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
  // qitem-ccf87c0d — batch membership index (see MembershipIndex doc).
  private membershipIndex: MembershipIndex | null = null;
  // qitem-ccf87c0d corrective — depth of open withMembershipBatch scopes.
  private batchDepth = 0;
  // VM-005: authored mission-status sidecar cache (same TTL as the listing).
  private missionStatusCache: {
    statuses: Record<string, { authoredStatus: string | null }>;
    expiresAt: number;
  } | null = null;

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

  /** qitem-ccf87c0d corrective — the explicit COMPOSITE-OPERATION scope: a
   *  caller performing list()-plus-per-slice-get() as ONE user-visible
   *  operation (the slices route's boundToWorkflow lens, ReviewGatherer.
   *  composeMission) wraps it here so every inner list/get shares ONE
   *  membership batch instead of building one per uncached get (the 2+2N
   *  regression). Contract, pinned by test:
   *   - the OUTERMOST open never reuses a prior operation's batch (drops
   *     any existing one); the index is LAZY, so the first membership
   *     access inside the scope builds from then-current queue state —
   *     request-boundary freshness, no snapshot claim;
   *   - nested/reentrant scopes share the outermost batch;
   *   - the outermost exit ALWAYS clears (finally — exception-safe), so
   *     separate operations never share a generation;
   *   - standalone list()/get() outside any scope keep their own
   *     one-operation batch semantics unchanged (their clears are
   *     conditional on depth === 0).
   *  Synchronous by design — matches the synchronous list/get call graph. */
  withMembershipBatch<T>(fn: () => T): T {
    if (this.batchDepth === 0) this.membershipIndex = null;
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) this.membershipIndex = null;
    }
  }

  /** Drops both caches. Used by tests + by a future explicit-refresh route. */
  invalidate(): void {
    this.listingCache = null;
    this.detailCache.clear();
    this.missionStatusCache = null;
    this.membershipIndex = null;
  }

  /** VM-005 B1 (the narrow C-vii exception; arch ruling b8d91aee…) — the
   *  READ-AFTER-WRITE seam: POST /:missionId/complete writes the mission
   *  README status, and the sidecar's 60s TTL would otherwise keep serving
   *  the pre-write word to /api/slices while /api/missions/:id reads the
   *  new word from disk. This drops the WHOLE missionStatusCache blob and
   *  nothing else (listing/detail caches untouched — drop-the-blob, never
   *  full-flush: zero coherence gain and a 60s registry churn were the
   *  ruling's reasons to reject the alternatives). The sole write path
   *  calls it post-success; the next read rebuilds from disk (README =
   *  SSOT). Out-of-band file writes remain the TTL regime by design. */
  invalidateMissionStatusCache(): void {
    this.missionStatusCache = null;
  }

  /** VM-005 (release-0.4.7) — the authored mission-status sidecar for the
   *  slices list payload: one mission-README frontmatter read per indexed
   *  mission, inside the same 60s cache discipline as the listing. Keys are
   *  missions with at least one INDEXED slice (zero-slice missions have no
   *  indexed slices and never appear here — the tree's discovery walk owns
   *  that population). Read semantics are LOCKSTEP with
   *  routes/missions.ts readMissionStatus (README.md only, raw string, no
   *  enum validation, non-empty-or-null) — pinned by test. */
  missionAuthoredStatuses(): Record<string, { authoredStatus: string | null }> {
    if (!this.isReady()) return {};
    const now = Date.now();
    if (this.missionStatusCache && this.missionStatusCache.expiresAt > now) {
      return this.missionStatusCache.statuses;
    }
    const indexedMissionIds = new Set<string>();
    for (const entry of this.list()) {
      if (entry.missionId) indexedMissionIds.add(entry.missionId);
    }
    const statuses: Record<string, { authoredStatus: string | null }> = {};
    for (const root of this.sliceRoots()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (!indexedMissionIds.has(entry.name)) continue;
        if (entry.name in statuses) continue; // first root wins, matching the slice walk
        statuses[entry.name] = {
          authoredStatus: this.readMissionAuthoredStatus(path.join(root, entry.name)),
        };
      }
    }
    this.missionStatusCache = { statuses, expiresAt: now + this.cacheTtlMs };
    return statuses;
  }

  /** Lockstep twin of routes/missions.ts readMissionStatus (see the sidecar
   *  doc above; the lockstep test pins both reads agree on the same bytes). */
  private readMissionAuthoredStatus(missionPath: string): string | null {
    const readmePath = path.join(missionPath, "README.md");
    let raw: string;
    try {
      raw = fs.readFileSync(readmePath, "utf8");
    } catch {
      return null;
    }
    const fm = parseFrontmatter(raw);
    const value = fm["status"];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  list(): SliceListEntry[] {
    if (!this.isReady()) return [];
    const now = Date.now();
    if (this.listingCache && this.listingCache.expiresAt > now) {
      return this.listingCache.entries;
    }
    const locations = this.readSliceLocations();
    // ONE batch membership index serves this whole rebuild (the <=4 LIKE-
    // execution load contract), then drops so later uncached operations
    // read current queue state (qitem-18f3300d operation scoping) — unless
    // an enclosing withMembershipBatch scope owns the batch lifetime.
    let entries: SliceListEntry[];
    try {
      entries = locations.map((location) => this.toListEntry(location));
    } finally {
      if (this.batchDepth === 0) this.membershipIndex = null;
    }
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

    // Uncached get(): its own operation-scoped batch, dropped afterward so
    // the next uncached operation sees current queue state (qitem-18f3300d)
    // — unless an enclosing withMembershipBatch scope owns the batch lifetime.
    let record: SliceRecord;
    try {
      record = this.buildRecord(location);
    } finally {
      if (this.batchDepth === 0) this.membershipIndex = null;
    }
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
      // OPR.0.3.2.17 — surface frontmatter `description` (or `summary`
      // fallback) so the storytelling adapter can use it as the
      // ConceptCard.oneLiner without a separate detail fetch. The
      // detail endpoint stays the source of truth for full body
      // content; this is the short-form summary mirror.
      description: extractDescription(frontmatter),
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
    // qitem-ccf87c0d — both tiers now answer from the per-generation batch
    // membership index (TWO scans per generation instead of O(slices) scans;
    // see ensureMembershipIndex). TWO-TIER DOCTRINE unchanged: the SIGNAL
    // tier answers from canonical typed membership ONLY; this DISPLAY tier
    // carries the gated legacy substring fallback. Never promote a
    // display-tier match into a signal. (P3)
    const ids = new Set<string>();
    try {
      let index = this.ensureMembershipIndex();
      if (!index.knownSlices.has(sliceName)) {
        // Folder created mid-generation: rebuild so the fresh slice resolves
        // membership immediately (parity with the old per-slice queries).
        this.membershipIndex = null;
        index = this.ensureMembershipIndex();
      }
      // 1. Typed-tag matches (VM-004 authoritative): confirmed rows for this
      // slice, in ts_created DESC/qitem_id DESC scan order, capped at 500
      // confirmed per slice by the builder.
      const typed = index.typedBySlice.get(sliceName);
      if (typed && typed.length > 0) {
        for (const id of typed) ids.add(id);
      } else {
        // 2. Substring fallback — executes ONLY when zero CONFIRMED typed
        // rows exist (the deliberate VM-004 gating). Term-first assembly in
        // the original deduped term order [sliceName, railItem, missionId]
        // keeps equal-timestamp output byte-identical to the per-slice path
        // (the final sort below is stable on equals).
        const substringTerms = [sliceName, railItem, missionId].filter(
          (v): v is string => !!v,
        );
        for (const term of Array.from(new Set(substringTerms))) {
          const bucket = index.fallbackByTerm.get(term);
          if (bucket) for (const id of bucket) ids.add(id);
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

  /** qitem-ccf87c0d — build (or reuse) the per-generation membership index.
   *  TWO queue_items scans per generation, replacing O(slices) per-slice
   *  scans:
   *   Scan 1 (typed): `tags LIKE '%slice:%'` prefilter, ORDER BY ts_created
   *     DESC, qitem_id DESC (P2 determinism preserved), parseScopeTags as the
   *     authoritative row-level confirm; a row credits EVERY slice it tags;
   *     cap after 500 CONFIRMED per slice (never a pre-confirmation LIMIT —
   *     the B2/VM-004 rule).
   *   Scan 2 (fallback): one streamed pass over (body, tags) evaluated
   *     against the term universe of all ZERO-TYPED locations. A combined
   *     regex is a PREFILTER only; every term is then confirmed per row so
   *     overlapping terms all credit (no consuming-alternation loss). Terms
   *     use SQL-LIKE-equivalent matching (asciiFold + %/_ translation);
   *     bucket order is row (rowid) order — the same order the un-ORDERed
   *     per-term `LIMIT 500` queries returned; cap 500 per term.
   *  Degradations preserved: tags column missing -> typed tier empty + body-
   *  only fallback scan; queue_items absent -> throws to matchQitems' catch. */
  private ensureMembershipIndex(): MembershipIndex {
    // qitem-18f3300d — OPERATION-scoped, never TTL-scoped: the index lives
    // only for the duration of one public cold list() or one uncached
    // get() (the public entry points clear it), so separate uncached
    // operations always see current queue state — parent-equivalent
    // freshness — while one cold list still shares one batch.
    if (this.membershipIndex) {
      return this.membershipIndex;
    }

    const typedBySlice = new Map<string, string[]>();
    const fallbackByTerm = new Map<string, string[]>();
    const knownSlices = new Set<string>();

    // Term universe: every location's deduped [sliceName, railItem,
    // missionId], derived with the SAME helpers toListEntry/buildRecord use.
    const locations = this.readSliceLocations();
    const termsBySlice = new Map<string, string[]>();
    for (const location of locations) {
      knownSlices.add(location.name);
      const frontmatter = this.readPrimaryFrontmatter(location.slicePath);
      const railItem = this.extractRailItem(frontmatter, location.missionId);
      const terms = Array.from(new Set(
        [location.name, railItem, location.missionId].filter((v): v is string => !!v),
      ));
      termsBySlice.set(location.name, terms);
    }

    // Scan 1 — typed membership. A thrown error here (tags column missing)
    // leaves the typed map empty; a missing queue_items table throws from
    // scan 2's body-only retry too, surfacing to matchQitems' catch.
    let tagsColumnAvailable = true;
    try {
      const stmt = this.db.prepare(
        `SELECT qitem_id, tags FROM queue_items WHERE tags LIKE '%slice:%' ORDER BY ts_created DESC, qitem_id DESC`,
      );
      for (const r of stmt.iterate() as Iterable<{ qitem_id: string; tags: string | null }>) {
        for (const tagged of parseScopeTags(r.tags).slices) {
          const bucket = typedBySlice.get(tagged);
          if (!bucket) typedBySlice.set(tagged, [r.qitem_id]);
          else if (bucket.length < 500) bucket.push(r.qitem_id);
        }
      }
    } catch {
      tagsColumnAvailable = false;
    }

    // Scan 2 — fallback buckets for the zero-typed slices' term universe.
    const fallbackTerms = new Set<string>();
    for (const [slice, terms] of termsBySlice) {
      const typed = typedBySlice.get(slice);
      if (typed && typed.length > 0) continue;
      for (const term of terms) fallbackTerms.add(term);
    }
    if (fallbackTerms.size > 0) {
      try {
        const termList = Array.from(fallbackTerms);
        const matchers = termList.map((term) => ({
          term,
          re: new RegExp(likeBoundPatternToRegExpSource(term), LIKE_REGEXP_FLAGS),
        }));
        const prefilter = new RegExp(matchers.map((m) => `(?:${m.re.source})`).join("|"), LIKE_REGEXP_FLAGS);
        for (const term of termList) fallbackByTerm.set(term, []);
        const scan = tagsColumnAvailable
          ? this.db.prepare(`SELECT qitem_id, body, tags FROM queue_items`)
          : this.db.prepare(`SELECT qitem_id, body FROM queue_items`);
        for (const r of scan.iterate() as Iterable<{ qitem_id: string; body: string; tags?: string | null }>) {
          const hayBody = asciiFold(sqliteVisiblePrefix(r.body));
          const hayTags = r.tags != null ? asciiFold(sqliteVisiblePrefix(r.tags)) : null;
          if (!prefilter.test(hayBody) && !(hayTags !== null && prefilter.test(hayTags))) continue;
          for (const m of matchers) {
            if (m.re.test(hayBody) || (hayTags !== null && m.re.test(hayTags))) {
              const bucket = fallbackByTerm.get(m.term)!;
              if (bucket.length < 500) bucket.push(r.qitem_id);
            }
          }
        }
      } catch {
        // queue_items table absent entirely: empty buckets — matchQitems
        // yields [] for every slice, byte-matching the old catch path,
        // while the built index still caches (no per-call rebuild churn).
      }
    }

    this.membershipIndex = { typedBySlice, fallbackByTerm, knownSlices };
    return this.membershipIndex;
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
/**
 * OPR.0.3.2.17 — extract a short description from slice frontmatter.
 * Tries `description` first, then `summary`. Returns null when both
 * are absent or non-string. Whitespace trimmed; empty strings become
 * null so the adapter's graceful-empty fallback fires.
 */
export function extractDescription(frontmatter: Record<string, unknown>): string | null {
  for (const key of ["description", "summary"]) {
    const v = frontmatter[key];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

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
