// Slice Story View v1 — slice → workflow_instance binding helper.
//
// Given a slice's qitem set, find the workflow_instance(s) that touch
// any of those qitems. Two signals (UNION):
//
//   1. workflow_step_trails.prior_qitem_id IN (slice qitems)  -- step closure
//      OR workflow_step_trails.next_qitem_id IN (slice qitems) -- step projection
//      → instance has historically touched this slice
//   2. workflow_instances.current_frontier_json LIKE '%qitemId%'
//      → instance is currently active on a slice qitem
//
// Returns the instance id(s) sorted by created_at DESC. v1 picks the
// most-recent instance when multiple bind to the slice (per PRD: "when
// a slice has more than one workflow_instance, v1 picks the most recent
// or surfaces a 'multiple instances' indicator; driver picks the exact
// UX with founder review at audit time"). The picked-most-recent
// behavior is the operator-friendly default; the multiple-instance
// indicator is exposed via the `additionalInstanceIds` field so the UI
// can surface a "+N more" hint without losing data.
//
// MVP single-host context: this query runs ad-hoc per slice detail
// fetch; not cached. The detail projector itself caches at the slice
// indexer's TTL boundary.

import type Database from "better-sqlite3";

export interface SliceWorkflowBinding {
  /** The most recent workflow_instance touching the slice's qitem set. */
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  status: string;
  currentStepId: string | null;
  /** Frontier qitem_ids parsed from the JSON column. */
  currentFrontier: string[];
  hopCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface SliceWorkflowBindingResult {
  primary: SliceWorkflowBinding | null;
  /** Other instances touching the slice; surfaced for "+N more" UI. */
  additionalInstanceIds: string[];
}

interface InstanceRow {
  instance_id: string;
  workflow_name: string;
  workflow_version: string;
  status: string;
  current_frontier_json: string;
  current_step_id: string | null;
  hop_count: number;
  created_at: string;
  completed_at: string | null;
}

export function findSliceWorkflowBinding(
  db: Database.Database,
  qitemIds: string[],
): SliceWorkflowBindingResult {
  if (qitemIds.length === 0) return { primary: null, additionalInstanceIds: [] };

  const instanceIds = new Set<string>();

  // Signal 1: trails referencing slice qitems via prior_qitem_id or next_qitem_id.
  try {
    const placeholders = qitemIds.map(() => "?").join(",");
    const trailRows = db.prepare(
      `SELECT DISTINCT instance_id FROM workflow_step_trails
       WHERE prior_qitem_id IN (${placeholders})
          OR next_qitem_id  IN (${placeholders})`
    ).all(...qitemIds, ...qitemIds) as Array<{ instance_id: string }>;
    for (const r of trailRows) instanceIds.add(r.instance_id);
  } catch {
    // workflow_step_trails absent — skip
  }

  // Signal 2: live frontier on a slice qitem (active step packet).
  // current_frontier_json is a JSON array of strings; LIKE '%"qitem"%'
  // is a cheap heuristic that matches the JSON-encoded form. False
  // positives possible if a qitem id appears as a substring of an
  // unrelated id, but ULID prefix discipline (timestamps + random) makes
  // collisions astronomically unlikely at single-host MVP scale.
  try {
    for (const qid of qitemIds) {
      const liveRows = db.prepare(
        `SELECT instance_id FROM workflow_instances
         WHERE current_frontier_json LIKE ?`
      ).all(`%${qid}%`) as Array<{ instance_id: string }>;
      for (const r of liveRows) instanceIds.add(r.instance_id);
    }
  } catch {
    // workflow_instances absent — skip
  }

  if (instanceIds.size === 0) return { primary: null, additionalInstanceIds: [] };

  // Resolve full rows; sort by created_at DESC; pick most recent as primary.
  const idList = Array.from(instanceIds);
  const idPlaceholders = idList.map(() => "?").join(",");
  let rows: InstanceRow[] = [];
  try {
    rows = db.prepare(
      `SELECT instance_id, workflow_name, workflow_version, status,
              current_frontier_json, current_step_id, hop_count,
              created_at, completed_at
         FROM workflow_instances
         WHERE instance_id IN (${idPlaceholders})
         ORDER BY created_at DESC, instance_id DESC`
    ).all(...idList) as InstanceRow[];
  } catch {
    return { primary: null, additionalInstanceIds: [] };
  }

  if (rows.length === 0) return { primary: null, additionalInstanceIds: [] };

  const primary = rowToBinding(rows[0]!);
  const additional = rows.slice(1).map((r) => r.instance_id);
  return { primary, additionalInstanceIds: additional };
}

function rowToBinding(row: InstanceRow): SliceWorkflowBinding {
  let frontier: string[] = [];
  try {
    const parsed = JSON.parse(row.current_frontier_json);
    if (Array.isArray(parsed)) frontier = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // malformed JSON — empty frontier (instance is in a degraded state;
    // the v1 UI will still render the bound workflow_name + status).
  }
  return {
    instanceId: row.instance_id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    status: row.status,
    currentStepId: row.current_step_id,
    currentFrontier: frontier,
    hopCount: row.hop_count,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
