import type Database from "better-sqlite3";

/**
 * OPR.0.4.6.WF3 FR-6 — the frontier close-path guard's PREDICATE (pm
 * convention ruling: prevention over detection).
 *
 * THE LAYERING PIN (arch, binding, Rev-1): the queue is the lower
 * primitive and NEVER imports the workflow domain. This module is the
 * workflow domain's export; startup INJECTS the predicate into
 * QueueRepository (the `validateRig` injection precedent exactly).
 * Same functional behavior as a direct import, without the module
 * cycle the next refactor would strangle on.
 *
 * The predicate answers: is this qitem a LIVE workflow-frontier
 * packet? Null for every non-workflow qitem — the zero-friction
 * negative (non-workflow closure behavior stays byte-identical; no
 * new rejections ride this predicate for ordinary traffic).
 */

export interface WorkflowFrontierBinding {
  instanceId: string;
  workflowName: string;
}

export type WorkflowFrontierPredicate = (qitemId: string) => WorkflowFrontierBinding | null;

export function createWorkflowFrontierPredicate(db: Database.Database): WorkflowFrontierPredicate {
  return (qitemId: string): WorkflowFrontierBinding | null => {
    // current_frontier is a JSON array column; a frontier membership
    // check is a containment probe on the serialized id. Scoped to
    // LIVE instances only — terminal instances hold no frontier.
    let row: { instance_id?: string; workflow_name?: string } | undefined;
    try {
      row = db
        .prepare(
          `SELECT instance_id, workflow_name FROM workflow_instances
           WHERE status IN ('active','waiting') AND current_frontier_json LIKE ?
           LIMIT 1`,
        )
        .get(`%"${qitemId}"%`) as typeof row;
    } catch (err) {
      // Pre-workflow schemas (no workflow_instances table): nothing to
      // guard — identical to the predicate-absent posture. ONLY that
      // case is tolerated: any other SQL error (e.g. a renamed column)
      // must fail LOUD — a swallowed error here silently disables a
      // correctness guard (VM-caught: the first draft ate its own
      // wrong-column error and the guard never fired).
      if (err instanceof Error && /no such table/i.test(err.message)) return null;
      throw err;
    }
    if (!row?.instance_id) return null;
    return { instanceId: row.instance_id, workflowName: row.workflow_name ?? "(unknown)" };
  };
}
