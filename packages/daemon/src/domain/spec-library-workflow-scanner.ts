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
import type Database from "better-sqlite3";
import type { WorkflowSpec } from "./workflow-types.js";

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
    const isBuiltIn = opts.workflowBuiltinSpecsDir
      ? isUnderDir(row.source_path, opts.workflowBuiltinSpecsDir)
      : false;
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
