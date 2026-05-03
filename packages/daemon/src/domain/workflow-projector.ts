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
    // R2 fix (guard blocker 1): read durable current_step_id from instance
    // rather than inferring "last_trail_step + 1". Reused-frontier packets
    // (waiting then resume) now correctly resume the SAME step.
    const currentStep = resolveCurrentStep(spec, instance);
    if (!currentStep) {
      throw new WorkflowProjectorError(
        "current_step_unknown",
        `workflow instance ${instance.instanceId} has no resolvable current step (current_step_id=${JSON.stringify(instance.currentStepId)}). The instance may be in a terminal state, or the spec ${spec.id}@${spec.version} may have changed shape mid-instance.`,
        { instanceId: instance.instanceId, currentStepId: instance.currentStepId, frontier: instance.currentFrontier },
      );
    }

    // R2 fix (guard blocker 2): enforce currentStep.allowed_exits at
    // projection time. POC contract: an exit not in the step's
    // allowed_exits is rejected with a structured error and NO state
    // mutation. Validation happens BEFORE any side effect (queue close,
    // trail append, frontier update, event persist). When allowed_exits
    // is omitted on the step, no enforcement (operator opted out at
    // spec authoring time).
    if (
      currentStep.allowed_exits &&
      currentStep.allowed_exits.length > 0 &&
      !currentStep.allowed_exits.includes(input.exit)
    ) {
      throw new WorkflowProjectorError(
        "exit_not_allowed",
        `step "${currentStep.id}" allows exits ${JSON.stringify(currentStep.allowed_exits)}; got "${input.exit}". Either close with a permitted exit, or amend the spec.`,
        {
          instanceId: instance.instanceId,
          stepId: currentStep.id,
          attemptedExit: input.exit,
          allowedExits: currentStep.allowed_exits,
        },
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
      // 1. Resolve next owner BEFORE closing prior so closure_target is set.
      let resolvedNextOwner: string | null = null;
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
        resolvedNextOwner = owner;
      }

      // 2. R1 fix (guard blocker 1): close the current packet via Phase A's
      // QueueRepository.updateWithinTransaction. This validates closure
      // (Phase A hot-potato strict-rejection invariants), persists closure
      // metadata (closure_reason, closure_target, handed_off_to / blocked_on),
      // appends queue_transitions, and emits queue.updated — all inside this
      // outer transaction. The Phase A closure authority is preserved.
      const closure = workflowExitToQueueClosure(input, resolvedNextOwner);
      const queueUpdate = this.queueRepo.updateWithinTransaction({
        qitemId: input.currentPacketId,
        actorSession: input.actorSession,
        state: closure.state,
        closureReason: closure.closureReason,
        closureTarget: closure.closureTarget ?? undefined,
        handedOffTo: closure.handedOffTo,
        blockedOn: closure.blockedOn,
        transitionNote: closure.transitionNote,
      });
      persistedEvents.push(queueUpdate.persistedEvent);

      // 3. If exit is handoff: create next-step qitem in same txn.
      let createdNext: { qitemId: string; persistedEvent: PersistedEvent; destinationSession: string; nudge: boolean | undefined } | null = null;
      if (input.exit === "handoff" && nextStep && resolvedNextOwner) {
        nextOwnerSession = resolvedNextOwner;
        nextStepId = nextStep.id;
        createdNext = this.queueRepo.createWithinTransaction({
          sourceSession: input.actorSession,
          destinationSession: resolvedNextOwner,
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

      // 4. Append step trail entry (prior + next ids).
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

      // 5. Update instance frontier + status.
      // R1 fix (guard blocker 2b): on exit=waiting, PRESERVE the closed
      // packet on the frontier. workflow-keepalive treats waiting as
      // eligible and resolves owners from current_frontier_json; removing
      // the packet would leave a single-packet waiting workflow with no
      // owner to wake.
      const remainingFrontier = instance.currentFrontier.filter(
        (id) => id !== input.currentPacketId,
      );
      let nextFrontier: string[];
      if (input.exit === "waiting") {
        // Keep the closed packet on frontier; the watchdog uses it to wake the owner.
        nextFrontier = [...remainingFrontier, input.currentPacketId];
      } else if (nextQitemId) {
        nextFrontier = [...remainingFrontier, nextQitemId];
      } else {
        nextFrontier = remainingFrontier;
      }
      // R1 fix (guard blocker 2a): exit=failed sets status=failed, NOT
      // completed. Emits workflow.failed instead of workflow.completed.
      let nextStatus: WorkflowInstance["status"];
      let completedAt: string | null = null;
      if (input.exit === "waiting") {
        nextStatus = "waiting";
      } else if (input.exit === "failed") {
        nextStatus = "failed";
        completedAt = evaluatedAt;
      } else if (nextFrontier.length === 0) {
        nextStatus = "completed";
        completedAt = evaluatedAt;
      } else {
        nextStatus = "active";
      }
      // R2 fix: set durable current_step_id transition.
      //   handoff       → next step
      //   waiting       → preserve (resume on same packet still on same step)
      //   done / failed → clear (terminal)
      let currentStepIdUpdate: "preserve" | "clear" | string;
      if (input.exit === "handoff" && nextStep) {
        currentStepIdUpdate = nextStep.id;
      } else if (input.exit === "waiting") {
        currentStepIdUpdate = "preserve";
      } else {
        // done or failed
        currentStepIdUpdate = "clear";
      }
      this.instanceStore.updateFrontier(instance.instanceId, nextFrontier, nextStatus, {
        bumpHopCount: input.exit === "handoff",
        lastContinuationDecision: {
          exit: input.exit,
          actorSession: input.actorSession,
          closedPacket: input.currentPacketId,
          nextPacket: nextQitemId,
          resultNote: input.resultNote ?? null,
          blockedOn: input.blockedOn ?? null,
          currentStep: currentStep.id,
        },
        completedAt,
        currentStepId: currentStepIdUpdate,
      });

      // 6. Persist workflow events within the same txn.
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
      if (createdNext && nextStep && resolvedNextOwner) {
        persistedEvents.push(createdNext.persistedEvent);
        persistedEvents.push(
          this.eventBus.persistWithinTransaction({
            type: "workflow.next_qitem_projected",
            instanceId: instance.instanceId,
            nextQitemId: createdNext.qitemId,
            nextOwner: createdNext.destinationSession,
            nextStepId: nextStep.id,
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
      } else if (nextStatus === "failed") {
        persistedEvents.push(
          this.eventBus.persistWithinTransaction({
            type: "workflow.failed",
            instanceId: instance.instanceId,
            workflowName: instance.workflowName,
            reason: input.resultNote ?? "workflow_step_failed",
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
 * R2 fix (guard blocker 1): resolve the current step from durable
 * instance.currentStepId, NOT from trail order. The previous trail-based
 * inference produced wrong results for reused-frontier packets:
 * waiting → resume on same packet would skip a step, because the
 * waiting close wrote a trail row that the next inference treated as
 * "last step + 1".
 *
 * Falls back to the entry step ONLY when current_step_id is null
 * (instantiate didn't set it; defense-in-depth, not the production
 * path).
 *
 * Multi-active-frontier instances (parallel steps) remain a graduation;
 * v1 supports a single active frontier packet, so a single
 * current_step_id column suffices.
 */
function resolveCurrentStep(
  spec: WorkflowSpec,
  instance: WorkflowInstance,
): WorkflowStepSpec | null {
  if (instance.currentStepId) {
    return spec.steps.find((s) => s.id === instance.currentStepId) ?? null;
  }
  // Defense-in-depth: instance lacks current_step_id. Fall back to
  // entry step (matches behavior of pre-R2 instances if any survive).
  const entryRole = spec.entry?.role;
  return (
    spec.steps[0] ??
    (entryRole ? spec.steps.find((s) => s.actor_role === entryRole) ?? null : null) ??
    null
  );
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

/**
 * R1 fix (guard blocker 1): translate a workflow exit into the Phase A
 * queue closure shape (state + closure_reason + closure_target +
 * handed_off_to / blocked_on metadata). Phase A's hot-potato closure
 * validation enforces the rules:
 *   - state=done requires closure_reason from CLOSURE_REASONS
 *   - handed_off_to / blocked_on / escalation also require closure_target
 *
 * Mappings:
 *   handoff → state=handed-off, closure_reason=handed_off_to,
 *             closure_target+handed_off_to=<next-owner>
 *   waiting → state=blocked, closure_reason=blocked_on,
 *             closure_target+blocked_on=<blocker>
 *   done    → state=done, closure_reason=no-follow-on
 *   failed  → state=done, closure_reason=denied (workflow status=failed
 *             is set separately on the instance row)
 */
function workflowExitToQueueClosure(
  input: ProjectStepInput,
  resolvedNextOwner: string | null,
): {
  state: "handed-off" | "blocked" | "done";
  closureReason: string;
  closureTarget: string | null;
  handedOffTo?: string;
  blockedOn?: string;
  transitionNote: string;
} {
  switch (input.exit) {
    case "handoff": {
      if (!resolvedNextOwner) {
        // Defense-in-depth — projector validates this earlier and throws
        // next_owner_unresolved, so this branch is unreachable in practice.
        throw new WorkflowProjectorError(
          "next_owner_unresolved",
          "handoff exit requires a resolved next owner before queue closure",
        );
      }
      return {
        state: "handed-off",
        closureReason: "handed_off_to",
        closureTarget: resolvedNextOwner,
        handedOffTo: resolvedNextOwner,
        transitionNote: `workflow handoff to ${resolvedNextOwner}`,
      };
    }
    case "waiting": {
      const blocker = input.blockedOn ?? "external-gate";
      return {
        state: "blocked",
        closureReason: "blocked_on",
        closureTarget: blocker,
        blockedOn: blocker,
        transitionNote: `workflow waiting on ${blocker}`,
      };
    }
    case "done": {
      return {
        state: "done",
        closureReason: "no-follow-on",
        closureTarget: null,
        transitionNote: input.resultNote
          ? `workflow done: ${input.resultNote}`
          : "workflow done",
      };
    }
    case "failed": {
      return {
        state: "done",
        closureReason: "denied",
        closureTarget: input.resultNote ?? "workflow_step_failed",
        transitionNote: input.resultNote
          ? `workflow failed: ${input.resultNote}`
          : "workflow failed",
      };
    }
  }
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
