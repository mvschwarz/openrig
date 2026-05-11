// Workflows in Spec Library + Activation Lens v0 — workflow scanner.
//
// SpecLibraryService knows how to classify rig + agent YAML files. This
// scanner adds workflow_specs as a third library kind by reading
// directly from the workflow_specs SQLite cache (PL-004 Phase D) +
// re-parsing each cached row to extract the per-step routing for the
// review payload's topology graph.
//
// The cache is the single source of truth for which workflow_specs the
// daemon has seen — both built-in starters (seeded at startup by
// loadStarterWorkflowSpecs) and
// operator-authored specs at workspace paths that the workspace-
// surface reconciliation contract has read through. Reading from the
// cache (rather than re-walking directories) means: no new env config,
// no duplicate parse logic, and the scanner stays consistent with
// `rig workflow specs` (same rows, same source-of-truth).
//
// Built-in detection: a row's `source_path` is "built in" iff it falls
// under the daemon's workflowBuiltinSpecsDir (the same `path.sep`
// boundary check used by /api/workflow/specs).

import * as path from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkflowSpec } from "./workflow-types.js";
import type { WorkflowSpecCache } from "./workflow-spec-cache.js";

export interface SpecLibraryWorkflowEntry {
  id: string;
  kind: "workflow";
  name: string;
  version: string;
  /** "builtin" when source_path is under workflowBuiltinSpecsDir; else "user_file". */
  sourceType: "builtin" | "user_file";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  summary?: string;
  /** True iff sourcePath is under the daemon's bundled built-in dir. */
  isBuiltIn: boolean;
  /** Cheap counts surfaced in the row summary line. */
  rolesCount: number;
  stepsCount: number;
  terminalTurnRule: string;
  targetRig: string | null;
  /**
   * Slice 11 (workflow-spec-folder-discovery) — diagnostic state.
   * "valid" rows have parsed payload and are operable.
   * "error" rows came from a malformed YAML in the workflows folder
   * scan; Library UI renders them with error styling and surfaces
   * the errorMessage so the operator can fix the file in place.
   */
  status: "valid" | "error";
  /** Populated only when status === "error" — concrete parse/validate diagnostic. */
  errorMessage: string | null;
}

export interface SpecLibraryWorkflowReview {
  kind: "workflow";
  name: string;
  version: string;
  purpose: string | null;
  targetRig: string | null;
  terminalTurnRule: string;
  rolesCount: number;
  stepsCount: number;
  isBuiltIn: boolean;
  sourcePath: string;
  cachedAt: string;
  /** Topology graph projection: nodes from `roles`, edges derived from
   *  each step's next_hop.suggested_roles → next-step ids. Same shape
   *  Slice Story View v1 uses for its Topology tab — consumers reuse
   *  the same UI primitives for rendering. */
  topology: {
    nodes: Array<{
      stepId: string;
      role: string;
      objective: string | null;
      preferredTarget: string | null;
      isEntry: boolean;
      isTerminal: boolean;
    }>;
    edges: Array<{
      fromStepId: string;
      toStepId: string;
      routingType: "direct";
    }>;
  };
  /** Per-step list rendered below the graph. */
  steps: Array<{
    stepId: string;
    role: string;
    objective: string | null;
    allowedExits: string[];
    /** Resolved destinations from next_hop.suggested_roles → step ids. */
    allowedNextSteps: Array<{ stepId: string; role: string }>;
  }>;
}

export interface ScanWorkflowSpecsOpts {
  db: Database.Database;
  /** Absolute path to the daemon's bundled builtin starter dir;
   *  null/undefined → no isBuiltIn detection (all rows render as user_file). */
  workflowBuiltinSpecsDir: string | null;
}

interface SpecRow {
  spec_id: string;
  name: string;
  version: string;
  purpose: string | null;
  target_rig: string | null;
  roles_json: string;
  steps_json: string;
  coordination_terminal_turn_rule: string;
  source_path: string;
  source_hash: string;
  cached_at: string;
  // Slice 11 — diagnostic columns from migration 040. May be missing
  // when the test harness applies only the 033 schema; treat absence
  // as status='valid', error_message=null to preserve back-compat.
  status?: string;
  error_message?: string | null;
}

export function scanWorkflowSpecs(opts: ScanWorkflowSpecsOpts): SpecLibraryWorkflowEntry[] {
  let rows: SpecRow[] = [];
  try {
    rows = opts.db.prepare(
      `SELECT * FROM workflow_specs ORDER BY name, version`,
    ).all() as SpecRow[];
  } catch {
    // workflow_specs table absent (test harness without the migration):
    // empty library. Same graceful degradation as Slice Story View
    // v0's slice indexer.
    return [];
  }

  const out: SpecLibraryWorkflowEntry[] = [];
  for (const row of rows) {
    const status: "valid" | "error" = row.status === "error" ? "error" : "valid";
    const isBuiltIn = opts.workflowBuiltinSpecsDir
      ? isUnderDir(row.source_path, opts.workflowBuiltinSpecsDir)
      : false;

    // Slice 11 — diagnostic rows render without parsed payload. Use the
    // file basename as the row label (already stored in name by
    // writeDiagnostic) and zero counts; errorMessage carries the reason.
    if (status === "error") {
      out.push({
        // Diagnostic rows don't have stable name+version (version is
        // empty when YAML couldn't be parsed); the library id falls
        // back to source_path so the UI can route uniquely.
        id: `workflow:error:${row.source_path}`,
        kind: "workflow",
        name: row.name,
        version: row.version,
        sourceType: isBuiltIn ? "builtin" : "user_file",
        sourcePath: row.source_path,
        relativePath: row.source_path,
        updatedAt: row.cached_at,
        summary: row.error_message ?? undefined,
        isBuiltIn,
        rolesCount: 0,
        stepsCount: 0,
        terminalTurnRule: row.coordination_terminal_turn_rule || "hot_potato",
        targetRig: null,
        status: "error",
        errorMessage: row.error_message ?? null,
      });
      continue;
    }

    let roles: WorkflowSpec["roles"];
    let steps: WorkflowSpec["steps"];
    try {
      roles = JSON.parse(row.roles_json) as WorkflowSpec["roles"];
      steps = JSON.parse(row.steps_json) as WorkflowSpec["steps"];
    } catch {
      // Malformed JSON in cache — skip with no entry; the daemon's
      // /api/workflow/specs surface will surface the row anyway.
      continue;
    }
    out.push({
      // Stable id derived from name+version so the SpecLibrary's review
      // endpoint can resolve workflow entries the same way it resolves
      // rig/agent entries by id.
      id: workflowLibraryId(row.name, row.version),
      kind: "workflow",
      name: row.name,
      version: row.version,
      sourceType: isBuiltIn ? "builtin" : "user_file",
      sourcePath: row.source_path,
      relativePath: row.source_path,
      updatedAt: row.cached_at,
      summary: row.purpose ?? undefined,
      isBuiltIn,
      rolesCount: Object.keys(roles ?? {}).length,
      stepsCount: Array.isArray(steps) ? steps.length : 0,
      terminalTurnRule: row.coordination_terminal_turn_rule || "hot_potato",
      targetRig: row.target_rig,
      status: "valid",
      errorMessage: null,
    });
  }
  return out;
}

export function getWorkflowReview(opts: ScanWorkflowSpecsOpts & { name: string; version: string }): SpecLibraryWorkflowReview | null {
  let row: SpecRow | undefined;
  try {
    row = opts.db.prepare(
      `SELECT * FROM workflow_specs WHERE name = ? AND version = ?`,
    ).get(opts.name, opts.version) as SpecRow | undefined;
  } catch {
    return null;
  }
  if (!row) return null;

  let roles: WorkflowSpec["roles"];
  let steps: WorkflowSpec["steps"];
  try {
    roles = JSON.parse(row.roles_json) as WorkflowSpec["roles"];
    steps = JSON.parse(row.steps_json) as WorkflowSpec["steps"];
  } catch {
    return null;
  }

  const isBuiltIn = opts.workflowBuiltinSpecsDir
    ? isUnderDir(row.source_path, opts.workflowBuiltinSpecsDir)
    : false;

  // Project the topology — same shape as Slice Story View v1 uses.
  const stepByRole = new Map<string, typeof steps[0]>();
  for (const step of steps ?? []) {
    if (!stepByRole.has(step.actor_role)) stepByRole.set(step.actor_role, step);
  }
  const entryRole = (row as unknown as { entry_role?: string }).entry_role
    ?? steps?.[0]?.actor_role;
  const entryStepId = entryRole ? stepByRole.get(entryRole)?.id : undefined;

  const topologyNodes = (steps ?? []).map((step) => {
    const roleSpec = (roles as Record<string, { preferred_targets?: string[] }>)[step.actor_role] ?? {};
    return {
      stepId: step.id,
      role: step.actor_role,
      objective: step.objective ?? null,
      preferredTarget: roleSpec.preferred_targets?.[0] ?? null,
      isEntry: step.id === entryStepId,
      isTerminal: !(step.next_hop?.suggested_roles?.length),
    };
  });

  const topologyEdges: SpecLibraryWorkflowReview["topology"]["edges"] = [];
  for (const step of steps ?? []) {
    for (const role of step.next_hop?.suggested_roles ?? []) {
      const target = stepByRole.get(role);
      if (!target) continue;
      topologyEdges.push({ fromStepId: step.id, toStepId: target.id, routingType: "direct" });
    }
  }

  const stepDetails: SpecLibraryWorkflowReview["steps"] = (steps ?? []).map((step) => ({
    stepId: step.id,
    role: step.actor_role,
    objective: step.objective ?? null,
    allowedExits: [...(step.allowed_exits ?? [])],
    allowedNextSteps: (step.next_hop?.suggested_roles ?? [])
      .map((role) => {
        const target = stepByRole.get(role);
        return target ? { stepId: target.id, role } : null;
      })
      .filter((x): x is { stepId: string; role: string } => x !== null),
  }));

  return {
    kind: "workflow",
    name: row.name,
    version: row.version,
    purpose: row.purpose,
    targetRig: row.target_rig,
    terminalTurnRule: row.coordination_terminal_turn_rule || "hot_potato",
    rolesCount: Object.keys(roles ?? {}).length,
    stepsCount: (steps ?? []).length,
    isBuiltIn,
    sourcePath: row.source_path,
    cachedAt: row.cached_at,
    topology: { nodes: topologyNodes, edges: topologyEdges },
    steps: stepDetails,
  };
}

export function workflowLibraryId(name: string, version: string): string {
  return `workflow:${name}:${version}`;
}

export function parseWorkflowLibraryId(id: string): { name: string; version: string } | null {
  if (!id.startsWith("workflow:")) return null;
  const rest = id.slice("workflow:".length);
  // version may be numeric or an arbitrary string; split on the LAST `:`.
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return null;
  return { name: rest.slice(0, lastColon), version: rest.slice(lastColon + 1) };
}

function isUnderDir(childPath: string, parentDir: string): boolean {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentDir);
  if (child === parent) return false;
  const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(parentWithSep);
}

// =================================================================
// Slice 11 (release-0.3.1 workflow-spec-folder-discovery)
// =================================================================
//
// scanWorkflowSpecFolder — filesystem walk that turns workspace.specs_root/
// workflows/ into an installable user primitive. The Library route calls
// this opportunistically on each list request (OQ-3 decision); valid YAML
// gets cached via WorkflowSpecCache.readThrough (existing path), invalid
// YAML gets cached via writeDiagnostic (slice 11 path), and files that
// disappear since the last scan get removed via removeBySourcePath
// (OQ-4 decision; deletion + audit log).
//
// OQ-3 mtime check: a file is skipped when its mtime is <= the cache row's
// cached_at (no parse work needed). Otherwise it's re-parsed via the cache
// (which itself hashes the content and returns the prior row when the
// hash matches — second layer of skip for content-stable files whose
// mtime nonetheless advanced, e.g., touch).

export interface ScanWorkflowSpecFolderOpts {
  /** SQLite handle (used for direct lookups). */
  db: Database.Database;
  /** Cache handle for readThrough / writeDiagnostic / removeBySourcePath. */
  cache: WorkflowSpecCache;
  /** Absolute path to the workspace's workflows folder
   *  (typically `<workspace.specs_root>/workflows`). Missing folder
   *  → empty scan summary; not an error. */
  folder: string;
  /** Daemon's bundled builtin starter dir; used to skip removal logic
   *  for built-in rows (the scanner only owns the folder it walks). */
  builtinDir: string | null;
}

export interface ScanWorkflowSpecFolderResult {
  /** Total YAML/YML files found in folder. */
  scanned: number;
  /** Files parsed + cached successfully on this scan. */
  valid: number;
  /** Files that failed parse/validate; recorded as diagnostic rows. */
  errors: number;
  /** Cache rows removed because their source_path no longer exists. */
  removed: number;
  /** Files skipped via mtime check (unchanged since last scan). */
  skipped: number;
}

function isWorkflowYamlFile(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

export function scanWorkflowSpecFolder(
  opts: ScanWorkflowSpecFolderOpts,
): ScanWorkflowSpecFolderResult {
  const result: ScanWorkflowSpecFolderResult = {
    scanned: 0,
    valid: 0,
    errors: 0,
    removed: 0,
    skipped: 0,
  };
  if (!existsSync(opts.folder)) return result;

  let entries: string[] = [];
  try {
    entries = readdirSync(opts.folder);
  } catch {
    return result;
  }

  const seenPaths = new Set<string>();
  for (const entry of entries) {
    if (!isWorkflowYamlFile(entry)) continue;
    const filePath = path.join(opts.folder, entry);
    let mtimeMs = 0;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    seenPaths.add(filePath);
    result.scanned += 1;

    // mtime check (OQ-3): if the cache has a row at this source_path
    // whose cached_at is at or after the file's mtime, the file is
    // unchanged since last scan — skip the re-parse work entirely.
    //
    // Compare at second-resolution because some filesystems (HFS+, FAT)
    // round mtime down to whole seconds while cached_at carries ms
    // precision; without this floor a freshly-written file whose mtime
    // is `T - 999ms` would always look "newer" than its cached_at at
    // exactly `T` and never skip.
    const cachedAt = opts.db
      .prepare(`SELECT cached_at FROM workflow_specs WHERE source_path = ?`)
      .get(filePath) as { cached_at: string } | undefined;
    if (cachedAt) {
      const cachedAtMs = Date.parse(cachedAt.cached_at);
      const cachedAtSec = Math.floor(cachedAtMs / 1000);
      const mtimeSec = Math.floor(mtimeMs / 1000);
      if (Number.isFinite(cachedAtMs) && cachedAtSec >= mtimeSec) {
        result.skipped += 1;
        continue;
      }
    }

    // Parse + validate via cache. If readThrough throws (parse or
    // validation error), record a diagnostic row keyed by source_path
    // so the Library UI can render the error inline.
    try {
      opts.cache.readThrough(filePath);
      result.valid += 1;
    } catch (err) {
      // Diagnostic: hash the raw content best-effort so we can detect
      // edits that fix the error (mtime alone is fine; this is for
      // bookkeeping). Use the empty string when content is unreadable.
      const message = err instanceof Error ? err.message : String(err);
      let sourceHash = "";
      try {
        sourceHash = createHash("sha256").update(readFileSync(filePath, "utf-8")).digest("hex");
      } catch {
        // unreadable / disappeared between stat and read; treat as
        // empty hash so the next scan re-evaluates
        sourceHash = "";
      }
      opts.cache.writeDiagnostic({
        sourcePath: filePath,
        sourceHash,
        errorMessage: message,
      });
      result.errors += 1;
    }
  }

  // OQ-4 deletion: cache rows whose source_path lives under the scanned
  // folder AND whose file is no longer present on disk get removed. We
  // scope the removal by source_path prefix to avoid touching built-in
  // rows or rows the scanner doesn't own (e.g., other workflows folders).
  const folderPrefix = opts.folder.endsWith(path.sep) ? opts.folder : `${opts.folder}${path.sep}`;
  const cachedUnderFolder = opts.db
    .prepare(`SELECT source_path FROM workflow_specs WHERE source_path LIKE ?`)
    .all(`${folderPrefix}%`) as Array<{ source_path: string }>;
  for (const { source_path } of cachedUnderFolder) {
    if (seenPaths.has(source_path)) continue;
    const removed = opts.cache.removeBySourcePath(source_path);
    if (removed > 0) result.removed += removed;
  }

  return result;
}
