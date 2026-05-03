// PL-004 Phase D: workflow-keepalive policy (TypeScript port of POC
// `lib/policies/workflow-keepalive.mjs`, adapted to read SQLite
// workflow_instances directly per audit row 18).
//
// LOAD-BEARING: workflow-keepalive MUST read from the SQLite
// workflow_instances table only. NO filesystem read of markdown
// workflow runtime at the daemon policy layer. (Audit row 18.)
//
// POC contract preserved (semantic; mechanism switched from markdown
// frontmatter to SQLite columns):
//   - Eligibility: status === "active" || status === "waiting".
//     Else: action=terminal, reason="workflow_not_active". (POC sets
//     terminal:true on the skip; Phase C engine has a separate
//     terminal action for the same effect.)
//   - Frontier empty + no fallback target: skip with reason "empty_frontier".
//   - Resolve frontier qitem owners by querying queue_items table.
//   - Combine resolved + explicit additional targets:
//       - workflow.created_by_session
//       - context.observer_sessions[]
//       - context.observer_session
//       - job.target.session (the registered target as fallback)
//   - Send to the FIRST resolved target. v1 single-target only;
//     additional resolved owners listed in the message for routing.
//     POC's send_many is deferred (Phase C engine's PolicyEvaluation
//     contract is single-target).

import type Database from "better-sqlite3";
import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

interface WorkflowKeepaliveContext {
  /** ULID of the workflow_instances row to keep alive. Required. */
  workflow_instance_id?: string;
  observer_session?: string;
  observer_sessions?: string[];
}

interface InstanceRow {
  instance_id: string;
  workflow_name: string;
  workflow_version: string;
  created_by_session: string;
  status: string;
  current_frontier_json: string;
}

interface QueueOwnerRow {
  qitem_id: string;
  destination_session: string;
}

export interface WorkflowKeepaliveDeps {
  db: Database.Database;
}

export function makeWorkflowKeepalivePolicy(deps: WorkflowKeepaliveDeps): Policy {
  const { db } = deps;

  return {
    name: "workflow-keepalive",
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const context = job.context as WorkflowKeepaliveContext;
      const instanceId = context.workflow_instance_id;
      if (!instanceId) {
        throw Object.assign(
          new Error("workflow-keepalive: context.workflow_instance_id is required"),
          {
            code: "policy_spec_invalid",
            policy: "workflow-keepalive",
            field: "context.workflow_instance_id",
          },
        );
      }

      // Audit-row-18 critical assertion: read from SQLite only.
      const instance = db
        .prepare(
          `SELECT instance_id, workflow_name, workflow_version, created_by_session,
                  status, current_frontier_json
           FROM workflow_instances WHERE instance_id = ?`,
        )
        .get(instanceId) as InstanceRow | undefined;

      if (!instance) {
        return {
          action: "terminal",
          reason: "workflow_instance_missing",
          notes: { instanceId },
        };
      }

      const eligible = instance.status === "active" || instance.status === "waiting";
      if (!eligible) {
        return {
          action: "terminal",
          reason: "workflow_not_active",
          notes: { instanceId, status: instance.status },
        };
      }

      const frontier = (JSON.parse(instance.current_frontier_json) as string[]) ?? [];

      // Resolve frontier qitem owners from queue_items.
      const resolvedFrontierOwners: string[] = [];
      if (frontier.length > 0) {
        const placeholders = frontier.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT qitem_id, destination_session FROM queue_items WHERE qitem_id IN (${placeholders})`,
          )
          .all(...frontier) as QueueOwnerRow[];
        for (const r of rows) resolvedFrontierOwners.push(r.destination_session);
      }

      // Combine with explicit additional targets.
      const additionalTargets: string[] = [
        instance.created_by_session,
        ...((context.observer_sessions ?? []) as string[]),
        ...(context.observer_session ? [context.observer_session] : []),
        ...(job.target?.session ? [job.target.session] : []),
      ].filter(Boolean);

      const allSessions = Array.from(new Set([...resolvedFrontierOwners, ...additionalTargets]));

      if (allSessions.length === 0) {
        // POC line 113-118: skip with empty_frontier when nothing resolves.
        return { action: "skip", reason: "empty_frontier" };
      }

      const primary = allSessions[0]!;
      const others = allSessions.slice(1);
      const message =
        job.message ??
        buildKeepaliveMessage({
          workflowName: instance.workflow_name,
          workflowVersion: instance.workflow_version,
          instanceId: instance.instance_id,
          status: instance.status,
          allSessions,
        });

      return {
        action: "send",
        target: { session: primary },
        message,
        notes: {
          instanceId: instance.instance_id,
          workflowName: instance.workflow_name,
          workflowStatus: instance.status,
          frontierLength: frontier.length,
          additionalRoutingTargets: others,
        },
      };
    },
  };
}

const POC_KEEPALIVE_TRAILER =
  "Continue the current step. If the run has ended, update the workflow state honestly and manufacture the next truthful packet now. " +
  "If you think you need approval, first ask whether there is real product ambiguity or only approval theater. " +
  "Keep communications bridged, name exact blockers, and self-scout deterministic bias: " +
  "add only the minimum deterministic code required for reliable agent operation, then rely on agent judgment for routing, adaptation, and edge handling.";

function buildKeepaliveMessage(input: {
  workflowName: string;
  workflowVersion: string;
  instanceId: string;
  status: string;
  allSessions: string[];
}): string {
  const lines = [
    `Workflow keepalive: ${input.workflowName}@${input.workflowVersion} / ${input.instanceId} is still live (status: ${input.status}).`,
    POC_KEEPALIVE_TRAILER,
  ];
  if (input.allSessions.length > 1) {
    lines.push("", `Other frontier owners + observers: ${input.allSessions.slice(1).join(", ")}`);
  }
  return lines.join("\n");
}
