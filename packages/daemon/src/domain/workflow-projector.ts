// PL-004 Phase D: workflow projector — transactional-scribe contract.
//
// LOAD-BEARING. The single most important Phase D contract.
//
// Per PRD § L4 + audit row 16: every code path that closes a
// `workflow_instances.current_frontier` qitem AND every code path that
// creates the next-step qitem MUST happen inside the SAME daemon-managed
// transaction. If two separate transactions can be observed, that is a
// contract violation. Lost handoffs are impossible by design.
//
// Composition (one db.transaction):
//   1. Verify spec + instance + current packet are consistent.
//   2. Resolve next step from spec (one-hop default per PRD).
//   3. Update queue_items: close current packet (handoff/waiting/done).
//   4. Create next-step queue item via QueueRepository.createWithinTransaction.
//   5. Append workflow_step_trails entry with prior + next ids.
//   6. Update workflow_instances frontier + status.
//   7. Persist workflow.* events (step_closed, next_qitem_projected, completed).
//
// All in one db.transaction. If any step throws, all rollback. After
// commit, fan out events to subscribers + nudge next owner.

import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { QueueRepository } from "./queue-repository.js";
import type { PersistedEvent } from "./types.js";
import type { WorkflowInstanceStore } from "./workflow-instance-store.js";
import type { WorkflowSpecCache } from "./workflow-spec-cache.js";
import type { WorkflowStepTrailLog } from "./workflow-step-trail-log.js";
import type {
  WorkflowExitKind,
  WorkflowInstance,
  WorkflowSpec,
  WorkflowStepSpec,
} from "./workflow-types.js";

export class WorkflowProjectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowProjectorError";
  }
}

export interface ProjectStepInput {
  instanceId: string;
  /** The qitem being closed (must be in instance.currentFrontier). */
  currentPacketId: string;
  /** What kind of exit closes this packet. */
  exit: WorkflowExitKind;
  /** Free-form closure result text (POC: --result). */
  resultNote?: string;
  /** For waiting exits: the blocker reference (qitem id, gate name). */
  blockedOn?: string;
  /** Operator-supplied evidence for the closure record (audit). */
  closureEvidence?: Record<string, unknown>;
  /** Session that closed the packet (owner-as-author). */
  actorSession: string;
  /**
   * Optional explicit override for the next-step destination session.
   * When omitted, the projector resolves from the next step's
   * actor_role + role.preferred_targets[]. Required when no
   * preferred_targets are declared OR none are operator-resolvable.
   */
  nextOwnerSession?: string;
}

export interface ProjectStepResult {
  instance: WorkflowInstance;
  closurePriorPacketId: string;
  closureReason: WorkflowExitKind;
  /** null on terminal closures (waiting / done / failed / no-successor). */
  nextQitemId: string | null;
  /** null on terminal closures. */
  nextOwnerSession: string | null;
  /** null on terminal closures. */
  nextStepId: string | null;
  /** Composite fired events (step_closed + optional next_qitem_projected + optional completed). */
  emittedEventTypes: string[];
}

export class WorkflowProjector {
  constructor(
    private readonly db: Database.Database,
    private readonly eventBus: EventBus,
    private readonly queueRepo: QueueRepository,
    private readonly instanceStore: WorkflowInstanceStore,
    private readonly trailLog: WorkflowStepTrailLog,
    private readonly specCache: WorkflowSpecCache,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Close the current packet AND create/project the next-step packet
   * IN THE SAME TRANSACTION. The load-bearing transactional-scribe
   * call site.
   */
  async project(input: ProjectStepInput): Promise<ProjectStepResult> {
    const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
    if (instance.status !== "active" && instance.status !== "waiting") {
      throw new WorkflowProjectorError(
        "instance_not_active",
        `workflow instance ${instance.instanceId} has status ${instance.status}; only active|waiting instances accept project`,
        { instanceId: instance.instanceId, status: instance.status },
      );
    }
    if (!instance.currentFrontier.includes(input.currentPacketId)) {
      throw new WorkflowProjectorError(
        "packet_not_on_frontier",
        `qitem ${input.currentPacketId} is not in workflow instance ${instance.instanceId} frontier ${JSON.stringify(instance.currentFrontier)}; either the packet is already closed or belongs to a different instance`,
        { instanceId: instance.instanceId, currentPacketId: input.currentPacketId, frontier: instance.currentFrontier },
      );
    }
    const specRow = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
    if (!specRow) {
      throw new WorkflowProjectorError(
        "spec_not_cached",
        `workflow spec ${instance.workflowName}@${instance.workflowVersion} is not in the spec cache. Re-run validate to refresh the cache.`,
        { workflowName: instance.workflowName, workflowVersion: instance.workflowVersion },
      );
    }
    const spec = specRow.spec;

    // Look up the qitem being closed to identify the current step.
    const currentPacket = this.queueRepo.getById(input.currentPacketId);
    if (!currentPacket) {
      throw new WorkflowProjectorError(
        "packet_not_found",
        `qitem ${input.currentPacketId} not found in queue_items`,
        { currentPacketId: input.currentPacketId },
      );
    }
    const currentStep = inferCurrentStep(spec, instance, this.trailLog);
    if (!currentStep) {
      throw new WorkflowProjectorError(
        "current_step_unknown",
        `workflow instance ${instance.instanceId} cannot infer the current step from spec ${spec.id}@${spec.version} + trail; check that the trail is consistent and that the spec has not changed shape mid-instance`,
        { instanceId: instance.instanceId, frontier: instance.currentFrontier },
      );
    }

    // Determine next step (one-hop default; multi-hop is graduation).
    const nextStep = resolveNextStep(spec, currentStep);

    const evaluatedAt = this.now().toISOString();

    let nextQitemId: string | null = null;
    let nextOwnerSession: string | null = null;
    let nextStepId: string | null = null;
    type PostCommitNudge = { destinationSession: string; nudge: boolean | undefined };
    let nextQitemCreatePostCommit: PostCommitNudge | null = null;
    const persistedEvents: PersistedEvent[] = [];

    const txn = this.db.transaction(() => {
      // 1. Close the current packet via direct UPDATE inside this txn.
      this.db
        .prepare(
          `UPDATE queue_items SET state = ?, ts_updated = ? WHERE qitem_id = ?`,
        )
        .run(
          input.exit === "handoff" ? "handed-off" : input.exit === "waiting" ? "blocked" : "done",
          evaluatedAt,
          input.currentPacketId,
        );

      // 2. If exit is handoff: create next-step qitem in same txn.
      let createdNext: { qitemId: string; persistedEvent: PersistedEvent; destinationSession: string; nudge: boolean | undefined } | null = null;
      if (input.exit === "handoff") {
        if (!nextStep) {
          throw new WorkflowProjectorError(
            "no_next_step",
            `workflow instance ${instance.instanceId} reached terminal step "${currentStep.id}" but exit was handoff; use exit=done for terminal steps or extend the spec with a next step`,
            { instanceId: instance.instanceId, currentStepId: currentStep.id },
          );
        }
        const owner = input.nextOwnerSession ?? resolveDefaultOwner(spec, nextStep);
        if (!owner) {
          throw new WorkflowProjectorError(
            "next_owner_unresolved",
            `cannot resolve next owner for step "${nextStep.id}" (role "${nextStep.actor_role}"); supply nextOwnerSession explicitly or add preferred_targets to the role in the spec`,
            { instanceId: instance.instanceId, nextStepId: nextStep.id, nextRole: nextStep.actor_role },
          );
        }
        nextOwnerSession = owner;
        nextStepId = nextStep.id;
        createdNext = this.queueRepo.createWithinTransaction({
          sourceSession: input.actorSession,
          destinationSession: owner,
          body: workflowHandoffBody({
            spec,
            instance,
            currentStep,
            nextStep,
            actorSession: input.actorSession,
            resultNote: input.resultNote,
          }),
          priority: "routine",
          tier: "mode2",
          tags: ["workflow", "handoff", `workflow:${spec.id}`, `instance:${instance.instanceId}`],
          chainOfRecord: [input.currentPacketId],
        });
        nextQitemId = createdNext.qitemId;
        nextQitemCreatePostCommit = {
          destinationSession: createdNext.destinationSession,
          nudge: createdNext.nudge,
        };
      }

      // 3. Append step trail entry (prior + next ids).
      this.trailLog.record({
        instanceId: instance.instanceId,
        stepId: currentStep.id,
        stepRole: currentStep.actor_role,
        closedAt: evaluatedAt,
        closureReason: input.exit,
        closureEvidence: input.closureEvidence ?? null,
        actorSession: input.actorSession,
        nextQitemId,
        priorQitemId: input.currentPacketId,
      });

      // 4. Update instance frontier + status.
      const remainingFrontier = instance.currentFrontier.filter(
        (id) => id !== input.currentPacketId,
      );
      const nextFrontier = nextQitemId ? [...remainingFrontier, nextQitemId] : remainingFrontier;
      let nextStatus: WorkflowInstance["status"];
      let completedAt: string | null = null;
      if (input.exit === "waiting") {
        nextStatus = "waiting";
      } else if (nextFrontier.length === 0) {
        nextStatus = "completed";
        completedAt = evaluatedAt;
      } else {
        nextStatus = "active";
      }
      this.instanceStore.updateFrontier(instance.instanceId, nextFrontier, nextStatus, {
        bumpHopCount: input.exit === "handoff",
        lastContinuationDecision: {
          exit: input.exit,
          actorSession: input.actorSession,
          closedPacket: input.currentPacketId,
          nextPacket: nextQitemId,
          resultNote: input.resultNote ?? null,
        },
        completedAt,
      });

      // 5. Persist workflow events within the same txn.
      persistedEvents.push(
        this.eventBus.persistWithinTransaction({
          type: "workflow.step_closed",
          instanceId: instance.instanceId,
          stepId: currentStep.id,
          closureReason: input.exit,
          actorSession: input.actorSession,
          priorQitemId: input.currentPacketId,
        }),
      );
      if (createdNext) {
        // Persist queue.created event (created within QueueRepository.createWithinTransaction).
        persistedEvents.push(createdNext.persistedEvent);
        persistedEvents.push(
          this.eventBus.persistWithinTransaction({
            type: "workflow.next_qitem_projected",
            instanceId: instance.instanceId,
            nextQitemId: createdNext.qitemId,
            nextOwner: createdNext.destinationSession,
            nextStepId: nextStep!.id,
          }),
        );
      }
      if (nextStatus === "completed") {
        persistedEvents.push(
          this.eventBus.persistWithinTransaction({
            type: "workflow.completed",
            instanceId: instance.instanceId,
            workflowName: instance.workflowName,
          }),
        );
      }
    });

    txn();

    // Post-commit fan-out: notify subscribers + nudge next owner.
    for (const e of persistedEvents) {
      this.eventBus.notifySubscribers(e);
    }
    const postCommit = nextQitemCreatePostCommit as PostCommitNudge | null;
    if (nextQitemId && postCommit) {
      await this.queueRepo.maybeNudge(
        nextQitemId,
        postCommit.destinationSession,
        postCommit.nudge,
      );
    }

    const updatedInstance = this.instanceStore.getByIdOrThrow(instance.instanceId);
    return {
      instance: updatedInstance,
      closurePriorPacketId: input.currentPacketId,
      closureReason: input.exit,
      nextQitemId,
      nextOwnerSession,
      nextStepId,
      emittedEventTypes: persistedEvents.map((e) => e.type),
    };
  }
}

/**
 * Infer the current step from the trail. v1 uses a simple rule:
 *   - If trail is empty → entry step is the current step.
 *   - Else → the step after the most recently-trailed step.
 *
 * Multi-active-frontier instances (parallel steps) are a graduation;
 * v1 always has at most one active frontier packet at a time.
 */
function inferCurrentStep(
  spec: WorkflowSpec,
  instance: WorkflowInstance,
  trailLog: WorkflowStepTrailLog,
): WorkflowStepSpec | null {
  const trail = trailLog.listForInstance(instance.instanceId, 1);
  if (trail.length === 0) {
    const entryRole = spec.entry?.role;
    return spec.steps[0] ?? (entryRole ? spec.steps.find((s) => s.actor_role === entryRole) ?? null : null) ?? null;
  }
  const lastStepId = trail[0]!.stepId;
  const idx = spec.steps.findIndex((s) => s.id === lastStepId);
  if (idx === -1) return null;
  return spec.steps[idx + 1] ?? null;
}

/**
 * Resolve the next step. v1 = one-hop continuity (the next step in
 * declaration order). Multi-hop chaining via `next_hop.suggested_roles`
 * is a graduation feature per PRD § Risks "Workflow runtime over-engineered".
 */
function resolveNextStep(spec: WorkflowSpec, currentStep: WorkflowStepSpec): WorkflowStepSpec | null {
  const idx = spec.steps.findIndex((s) => s.id === currentStep.id);
  if (idx === -1) return null;
  return spec.steps[idx + 1] ?? null;
}

/**
 * Resolve a default owner for a step. v1 picks the first declared
 * preferred_target. Returns null if none declared (caller must supply
 * nextOwnerSession explicitly).
 */
function resolveDefaultOwner(spec: WorkflowSpec, step: WorkflowStepSpec): string | null {
  const role = spec.roles?.[step.actor_role];
  const targets = role?.preferred_targets ?? [];
  return targets[0] ?? null;
}

function workflowHandoffBody(input: {
  spec: WorkflowSpec;
  instance: WorkflowInstance;
  currentStep: WorkflowStepSpec;
  nextStep: WorkflowStepSpec;
  actorSession: string;
  resultNote: string | undefined;
}): string {
  const lines = [
    `### Workflow handoff: ${input.spec.id}@${input.spec.version} step ${input.nextStep.id}`,
    "",
    `Workflow instance: ${input.instance.instanceId}`,
    `Prior step: ${input.currentStep.id} (${input.currentStep.actor_role}) closed by ${input.actorSession}`,
    `This step: ${input.nextStep.id} (${input.nextStep.actor_role})`,
  ];
  if (input.nextStep.objective) {
    lines.push(`Objective: ${input.nextStep.objective}`);
  }
  if (input.resultNote) {
    lines.push("", `Prior step note: ${input.resultNote}`);
  }
  return lines.join("\n");
}
