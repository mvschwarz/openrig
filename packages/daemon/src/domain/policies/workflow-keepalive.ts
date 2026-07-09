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
import {
  evaluateStepDeadline,
  type WorkflowDeadlineVerdict,
} from "../workflow-deadline.js";

interface WorkflowKeepaliveContext {
  /** ULID of the workflow_instances row to keep alive. Required. */
  workflow_instance_id?: string;
  observer_session?: string;
  observer_sessions?: string[];
  /**
   * OPR.0.4.6.WF1 FR-3: set true on AUTO-ARMED jobs (see
   * workflow-keepalive-arming.ts). A deadline-gated job is QUIET while
   * the FR-2 evaluator reports healthy and sends only when a frontier
   * packet is overdue — preserving FR-2's zero-noise-on-the-happy-path
   * AC. Operator-registered jobs (flag absent) keep the shipped POC
   * always-send parity unchanged.
   */
  deadline_gated?: boolean;
}

interface InstanceRow {
  instance_id: string;
  workflow_name: string;
  workflow_version: string;
  created_by_session: string;
  status: string;
  current_frontier_json: string;
  current_step_id: string | null;
}

interface QueueOwnerRow {
  qitem_id: string;
  destination_session: string;
  state: string;
  ts_created: string;
  claimed_at: string | null;
  closure_required_at: string | null;
}

export interface WorkflowKeepaliveDeps {
  db: Database.Database;
  /** OPR.0.4.6.WF5 FR-2 class (b): when supplied, a non-healthy deadline
   *  verdict ENSURES the durable exception item at detection time as a
   *  side effect of this evaluation. The PolicyEvaluation SHAPE is
   *  untouched (send|skip|terminal stands — X5); the item is the
   *  injected helper's concern, dedup by occurrence. Failures are
   *  non-fatal to the evaluation. */
  ensureStuckExceptionItem?: import("../workflow-exception-escalation.js").EnsureStuckExceptionItem;
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
                  status, current_frontier_json, current_step_id
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

      // Resolve frontier qitem owners (+ FR-2 anchor fields) from queue_items.
      const resolvedFrontierOwners: string[] = [];
      let frontierRows: QueueOwnerRow[] = [];
      if (frontier.length > 0) {
        const placeholders = frontier.map(() => "?").join(",");
        frontierRows = db
          .prepare(
            `SELECT qitem_id, destination_session, state, ts_created, claimed_at, closure_required_at
             FROM queue_items WHERE qitem_id IN (${placeholders})`,
          )
          .all(...frontier) as QueueOwnerRow[];
        for (const r of frontierRows) resolvedFrontierOwners.push(r.destination_session);
      }

      // OPR.0.4.6.WF1 FR-2+FR-3: evaluate the step deadline (derived,
      // never stored). Deadline-gated (auto-armed) jobs stay quiet
      // while healthy; ANY job's send message carries the stuck
      // evidence + re-project steering when overdue.
      const verdict: WorkflowDeadlineVerdict = evaluateStepDeadline(
        {
          instanceId: instance.instance_id,
          status: instance.status,
          currentFrontier: frontier,
          currentStepId: instance.current_step_id,
        },
        frontierRows.map((r) => ({
          qitemId: r.qitem_id,
          state: r.state,
          destinationSession: r.destination_session,
          tsCreated: r.ts_created,
          claimedAt: r.claimed_at,
          closureRequiredAt: r.closure_required_at,
        })),
        new Date(),
      );
      if (context.deadline_gated === true && verdict.state === "healthy") {
        // Quiet skip — not recorded in watchdog history (POC parity for
        // quiet reasons); zero noise on the happy path.
        return { action: "skip", reason: "workflow_healthy_deadline_gated" };
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

      // Deadline-gated (auto-armed) jobs past the deadline steer the
      // nudge at the OVERDUE packet's owner with the stuck evidence —
      // a restored or replacement agent reads the steering and
      // re-projects; the stuck marker self-clears on recomposition
      // (FR-2 AC). Operator-registered jobs (no flag) keep the shipped
      // POC message + first-resolved-target parity EXACTLY, even when
      // a packet is overdue — their contract predates the deadline
      // model and is pinned by the shipped policy tests.
      const stuck =
        context.deadline_gated === true && verdict.state !== "healthy" && verdict.evidence
          ? verdict.evidence
          : null;
      // OPR.0.4.6.WF5 FR-2 class (b): detection-time exception item —
      // fires on ANY non-healthy verdict (gated or operator-registered
      // jobs; the operator-job MESSAGE contract below stays pinned and
      // untouched). Dedup by occurrence keeps this idempotent across
      // every keepalive cadence tick.
      if (deps.ensureStuckExceptionItem && verdict.state !== "healthy" && verdict.evidence) {
        try {
          await deps.ensureStuckExceptionItem({
            workflowName: instance.workflow_name,
            workflowVersion: instance.workflow_version,
            createdBySession: instance.created_by_session,
            verdict,
          });
        } catch {
          // Non-fatal: the nudge below still fires; the sweep/next tick
          // re-detects (the crash-surviving guarantee).
        }
      }
      const primary = stuck ? stuck.ownerSession : allSessions[0]!;
      const others = stuck
        ? allSessions.filter((s) => s !== primary)
        : allSessions.slice(1);
      const message = stuck
        ? buildStuckNudgeMessage({
            workflowName: instance.workflow_name,
            workflowVersion: instance.workflow_version,
            verdictState: verdict.state,
            evidence: stuck,
          })
        : (job.message ??
          buildKeepaliveMessage({
            workflowName: instance.workflow_name,
            workflowVersion: instance.workflow_version,
            instanceId: instance.instance_id,
            status: instance.status,
            allSessions,
          }));

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
          ...(stuck ? { deadline: { state: verdict.state, ...stuck } } : {}),
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

/**
 * OPR.0.4.6.WF1 FR-2: the overdue re-nudge. Written for a RESTORED or
 * REPLACEMENT agent with no conversational memory of the step: it names
 * the instance, the step, the packet, the anchor evidence, and the
 * exact re-project move.
 */
function buildStuckNudgeMessage(input: {
  workflowName: string;
  workflowVersion: string;
  verdictState: string;
  evidence: {
    instanceId: string;
    stepId: string | null;
    packetId: string;
    ownerSession: string;
    anchor: string;
    anchorAt: string;
    overdueBySeconds: number;
    ageSeconds: number;
  };
}): string {
  const e = input.evidence;
  return [
    `Workflow STUCK (${input.verdictState}): ${input.workflowName}@${input.workflowVersion} instance ${e.instanceId} step ${e.stepId ?? "(unknown)"} is overdue by ${Math.floor(e.overdueBySeconds / 60)}m (anchor: ${e.anchor} @ ${e.anchorAt}; packet age ${Math.floor(e.ageSeconds / 60)}m).`,
    `You own frontier packet ${e.packetId}. If you lost context: run 'rig whoami --json', read the packet with 'rig queue show ${e.packetId}', do (or verify) the step's work, then close it truthfully via 'rig workflow project --instance ${e.instanceId} --current-packet ${e.packetId} --exit <handoff|waiting|done|failed> --actor-session ${e.ownerSession}'.`,
    "Projecting normally clears the stuck state automatically - do not hand-edit any workflow state.",
    POC_KEEPALIVE_TRAILER,
  ].join("\n");
}

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
