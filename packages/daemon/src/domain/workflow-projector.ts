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
import { exceedsMaxHops, MAX_HOPS_BASELINE_V1 } from "./workflow-deadline.js";
import { isHumanSeatSession } from "./human-route-enforcer.js";
import { selectRoleSeat } from "./workflow-role-resolver.js";
import {
  roleResolutionContext,
  tryResolveRoleByCapability,
  type RoleResolutionContext,
} from "./workflow-role-context.js";
import { classifyFailedInstance, classifyGateTrip, workflowExceptionTags } from "./workflow-exception.js";
import { newQitemId } from "./queue-repository.js";
import { resolveExceptionRoute } from "./workflow-exception-router.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import {
  disarmWorkflowKeepalive,
  ensureWorkflowKeepaliveArmed,
} from "./workflow-keepalive-arming.js";

/**
 * OPR.0.4.6.WF2 FR-2: canonical-session → node runtime column lookup
 * (the harness-pin reconciliation source). Latest session row wins
 * (the node-inventory join discipline). null = not a managed node.
 * Shared by the projector (projection-time pins) and the runtime
 * facade (instantiate-time static pin checks).
 */
export function nodeRuntimeOf(db: Database.Database, session: string): string | null {
  const row = db
    .prepare(
      `SELECT n.runtime FROM nodes n
         JOIN sessions s ON s.node_id = n.id
        WHERE s.session_name = ?
        ORDER BY s.id DESC LIMIT 1`,
    )
    .get(session) as { runtime: string | null } | undefined;
  return row?.runtime ?? null;
}

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
  /**
   * OPR.0.4.6.WF1 FR-5: true when this call was an ABSORBED
   * waiting-replay — an exact full-closure-intent duplicate of the
   * stored decision. Zero writes happened; the stored first outcome is
   * what this result reflects.
   */
  absorbedReplay?: boolean;
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
    /** OPR.0.4.6.WF1 FR-3: optional — arms/disarms the per-instance keepalive in-txn. */
    private readonly watchdogJobsRepo?: WatchdogJobsRepository,
    /** OPR.0.4.6.WF5 FR-2: the maturity-dial inputs, injected at startup
     *  (the validateRig precedent — the projector never reads config
     *  itself). hostDefault is read LIVE per exception (dial flips apply
     *  to future items only). Absent = engine defaults (orchestrator-
     *  first chain with the human@host never-lost fallback). */
    private readonly exceptionDial?: {
      hostDefault: () => "orchestrator" | "human_only" | null;
      humanFallbackSeat: string;
    },
  ) {}

  private nodeRuntimeOf(session: string): string | null {
    return nodeRuntimeOf(this.db, session);
  }

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
    // OPR.0.4.6.WF2 FR-1: the recorded exit participates — a MAPPED exit
    // resolves to its branch target (deterministic: same (spec, step,
    // exit) → same target); unmapped exits fall through to the exact
    // structural semantics shipped today.
    const branchTargetId = currentStep.next_hop?.on?.[input.exit];
    const branchRouted = branchTargetId !== undefined;
    const nextStep = resolveNextStep(spec, currentStep, input.exit);
    if (branchRouted && !nextStep) {
      // Validator guarantees branch targets exist at validate/instantiate;
      // this guards a stale cached spec drifting under a live instance.
      throw new WorkflowProjectorError(
        "branch_target_missing",
        `step "${currentStep.id}" maps exit "${input.exit}" to step "${branchTargetId}" but the spec ${spec.id}@${spec.version} has no such step. Re-validate the spec file.`,
        { instanceId: instance.instanceId, stepId: currentStep.id, exit: input.exit, branchTargetId },
      );
    }
    // A route happens on a structural handoff OR any branch-mapped exit
    // (the ONE WF-2 engine extension: language-driven routing through
    // the same transactional scribe).
    const willRoute = branchRouted || input.exit === "handoff";

    // FR-5 (G3): the waiting-replay ABSORPTION check. `waiting`
    // deliberately KEEPS the closed packet on the frontier (the
    // keepalive wakes the parked owner off it), so a replayed waiting
    // project passes the frontier guard — before this slice it
    // double-wrote the trail. Absorption closes the hole under the
    // guard-ratified FULL CLOSURE-INTENT IDENTITY (G-WF1-1): the replay
    // is absorbed (ZERO writes, the stored first outcome returned) ONLY
    // when EVERY field that can change observable queue/trail/decision
    // state matches the stored decision exactly. ANY mismatch is a NEW
    // legitimate decision (re-park-with-new-reason) recorded honestly
    // through the normal write path below — never absorbed, never
    // rejected. Terminal-exit replays stay the distinct frontier 409
    // above (FR-1c).
    if (input.exit === "waiting" && instance.status === "waiting") {
      const absorbed = matchesStoredWaitingDecision(
        instance,
        input,
        currentStep.id,
        this.trailLog,
      );
      if (absorbed) {
        return {
          instance,
          closurePriorPacketId: input.currentPacketId,
          closureReason: "waiting",
          nextQitemId: null,
          nextOwnerSession: null,
          nextStepId: null,
          emittedEventTypes: [],
          absorbedReplay: true,
        };
      }
    }

    // FR-6 (G4): enforce loop_guards.max_hops at projection time — this
    // makes migration 034's "enforced at projection time" comment TRUE.
    // A handoff that would exceed the guard is converted into an HONEST
    // structured failure: the packet still closes (BR-3 shapes), the
    // instance fails with the guard named in trail + event evidence,
    // and no next qitem is minted — never an unbounded hop loop, never
    // a silent stop, never a parked potato. The owner's requested exit
    // was validated against allowed_exits ABOVE; the conversion below
    // is engine-authored (guard enforcement), not an owner exit, so it
    // deliberately bypasses allowed_exits.
    // The comparison runs against an EFFECTIVE BASELINE (arch N1):
    // v1 pins baseline = MAX_HOPS_BASELINE_V1 (0); WF-5 FR-4's resume
    // later amends the baseline so each redrive gets one bounded window.
    // OPR.0.4.6.WF2: the guard fires on ANY route (structural handoff OR
    // a branch-mapped exit) — branch edges create the canonical
    // remediation cycles, and an advance is an advance. Guard precedence
    // is BEFORE branch resolution takes effect: a tripped guard is a
    // terminal honest failure, never a routed branch.
    const maxHops = spec.loop_guards?.max_hops;
    // OPR.0.4.6.WF5 FR-4 (the livelock rail): the baseline is the
    // instance's recorded hops_baseline — 0 for never-resumed instances
    // (byte-identical to the v1 constant), hopCount-at-resume after a
    // redrive, so each sanctioned drive gets exactly one bounded window.
    const maxHopsTripped =
      willRoute &&
      exceedsMaxHops(instance.hopCount, instance.hopsBaseline ?? MAX_HOPS_BASELINE_V1, maxHops);
    const effectiveExit: WorkflowExitKind = maxHopsTripped ? "failed" : input.exit;
    const effectiveResultNote = maxHopsTripped
      ? `max_hops_exceeded: hop ${instance.hopCount + 1} would exceed loop_guards.max_hops=${maxHops}`
      : input.resultNote;
    // The route actually happens only when the guard did not trip.
    const routes = willRoute && !maxHopsTripped;
    let effectiveClosureEvidence = maxHopsTripped
      ? {
          ...(input.closureEvidence ?? {}),
          max_hops_guard: {
            code: "max_hops_exceeded",
            maxHops,
            hopCount: instance.hopCount,
            attemptedHop: instance.hopCount + 1,
          },
        }
      : input.closureEvidence;
    // OPR.0.4.6.WF2 FR-1 (arch PIN 1): the taken branch is recorded
    // ADDITIVELY in the trail row's structured evidence JSON (and in
    // last_continuation_decision below) — NEVER in closure_reason (a
    // closed Phase-A enum + kept hot-potato contract).
    if (routes && branchRouted && nextStep) {
      effectiveClosureEvidence = {
        ...(effectiveClosureEvidence ?? {}),
        branch_taken: { exit: input.exit, target: nextStep.id },
      };
    }

    const evaluatedAt = this.now().toISOString();

    // OPR.0.4.6.FAC1: the bound-rig resolution context — LAZY (building
    // it reads nothing; the snapshot materializes only if tier-3 role
    // resolution actually runs, which is strictly AFTER the frontier +
    // absorption guards above returned/threw for replays — guard B1's
    // zero-inventory-reads-on-replays pin holds by construction).
    // undefined for unbound instances (tier 3 does not exist for them).
    const roleCtx = roleResolutionContext(this.db, instance.boundRig);

    let nextQitemId: string | null = null;
    let nextOwnerSession: string | null = null;
    let nextStepId: string | null = null;
    type PostCommitNudge = { destinationSession: string; nudge: boolean | undefined };
    let nextQitemCreatePostCommit: PostCommitNudge | null = null;
    // OPR.0.4.6.WF5 FR-2 class (a): the exception item's post-commit nudge
    // (delivery is best-effort; the durable item is the guarantee).
    let exceptionItemPostCommit: (PostCommitNudge & { qitemId: string }) | null = null;
    const persistedEvents: PersistedEvent[] = [];

    const txn = this.db.transaction(() => {
      // 1. Resolve next owner BEFORE closing prior so closure_target is set.
      // OPR.0.4.6.WF2: owner resolution runs for ANY route (structural
      // handoff or branch-mapped exit). A gated target step compiles to
      // the gate destination instead of the step's role owner (FR-5).
      let resolvedNextOwner: string | null = null;
      let gateCompile: GateCompileResult | null = null;
      if (routes) {
        if (!nextStep) {
          throw new WorkflowProjectorError(
            "no_next_step",
            `workflow instance ${instance.instanceId} reached terminal step "${currentStep.id}" but exit was handoff; use exit=done for terminal steps or extend the spec with a next step`,
            { instanceId: instance.instanceId, currentStepId: currentStep.id },
          );
        }
        if (nextStep.gate) {
          gateCompile = compileGate(spec, nextStep, (s) => this.nodeRuntimeOf(s), roleCtx);
          resolvedNextOwner = gateCompile.destinationSession;
        } else if (input.nextOwnerSession) {
          reconcileExplicitOwnerHarness(nextStep, input.nextOwnerSession, (s) =>
            this.nodeRuntimeOf(s),
          );
          resolvedNextOwner = input.nextOwnerSession;
        } else {
          const owner = resolveDefaultOwner(spec, nextStep, (s) => this.nodeRuntimeOf(s), roleCtx);
          if (!owner) {
            throw new WorkflowProjectorError(
              "next_owner_unresolved",
              `cannot resolve next owner for step "${nextStep.id}" (role "${nextStep.actor_role}"); supply nextOwnerSession explicitly or add preferred_targets to the role in the spec`,
              { instanceId: instance.instanceId, nextStepId: nextStep.id, nextRole: nextStep.actor_role },
            );
          }
          resolvedNextOwner = owner;
        }
      }

      // 2. R1 fix (guard blocker 1): close the current packet via Phase A's
      // QueueRepository.updateWithinTransaction. This validates closure
      // (Phase A hot-potato strict-rejection invariants), persists closure
      // metadata (closure_reason, closure_target, handed_off_to / blocked_on),
      // appends queue_transitions, and emits queue.updated — all inside this
      // outer transaction. The Phase A closure authority is preserved.
      const closure = workflowExitToQueueClosure(
        { ...input, exit: effectiveExit, resultNote: effectiveResultNote },
        resolvedNextOwner,
      );
      const queueUpdate = this.queueRepo.updateWithinTransaction({
        qitemId: input.currentPacketId,
        actorSession: input.actorSession,
        viaWorkflowVerb: true,
        state: closure.state,
        closureReason: closure.closureReason,
        closureTarget: closure.closureTarget ?? undefined,
        handedOffTo: closure.handedOffTo,
        blockedOn: closure.blockedOn,
        transitionNote: closure.transitionNote,
      });
      persistedEvents.push(queueUpdate.persistedEvent);

      // 3. If this close routes (structural handoff OR branch-mapped
      // exit): create the next-step qitem in the same txn. A gated
      // target compiles to the gate item (FR-5) — the SHIPPED write
      // path (tier/summary/evidence_ref) — instead of an ordinary
      // step packet; the instance then PARKS (status ladder below).
      let createdNext: { qitemId: string; persistedEvent: PersistedEvent; destinationSession: string; nudge: boolean | undefined } | null = null;
      if (routes && nextStep && resolvedNextOwner) {
        nextOwnerSession = resolvedNextOwner;
        nextStepId = nextStep.id;
        // OPR.0.4.6.FAC1 (arch-endorsed): the ADDITIVE owner_resolution
        // trail evidence — which tier resolved this routing decision
        // (the branch_taken precedent; structured evidence JSON, NEVER
        // closure_reason). Makes the determinism proofs readable and
        // gives trace a rendering cell.
        effectiveClosureEvidence = {
          ...(effectiveClosureEvidence ?? {}),
          owner_resolution: {
            mode: gateCompile
              ? "gate"
              : input.nextOwnerSession
                ? "explicit"
                : (spec.roles?.[nextStep.actor_role]?.preferred_targets ?? []).length > 0
                  ? "preferred_targets"
                  : "role",
            role: nextStep.actor_role,
            ...(instance.boundRig ? { boundRig: instance.boundRig } : {}),
            seat: resolvedNextOwner,
          },
        };
        // OPR.0.4.6.WF5 FR-1 class (c) (guard code-review fold): a HUMAN
        // gate reach IS the exception, and the WF-2 compiled item IS the
        // attention item (no second item ever) — so the class-(c)
        // exception identity rides THIS packet's tags. The packet id is
        // PREALLOCATED so occurrence:<gatePacketId> exists at create
        // (identity queryable from birth — arch cell-2). Handler-role
        // gates stay negative (deterministic handoffs, not exceptions).
        const gateQitemId = gateCompile ? newQitemId() : undefined;
        const gateException =
          gateCompile && gateQitemId
            ? classifyGateTrip({
                workflowName: instance.workflowName,
                instanceId: instance.instanceId,
                gatedStepId: nextStep.id,
                gateKind: gateCompile.kind,
                gatePacketId: gateQitemId,
                parkOn: gateCompile.parkOn,
              })
            : null;
        createdNext = this.queueRepo.createWithinTransaction({
          qitemId: gateQitemId,
          sourceSession: input.actorSession,
          destinationSession: resolvedNextOwner,
          body: workflowHandoffBody({
            spec,
            instance,
            currentStep,
            nextStep,
            actorSession: input.actorSession,
            resultNote: effectiveResultNote,
            gate: gateCompile,
          }),
          priority: "routine",
          tier: gateCompile?.tier ?? "mode2",
          tags: [
            "workflow",
            gateCompile ? "gate" : "handoff",
            `workflow:${spec.id}`,
            `instance:${instance.instanceId}`,
            ...(gateException ? workflowExceptionTags(gateException.identity).filter((t) => !t.startsWith("workflow:") && !t.startsWith("instance:")) : []),
          ],
          summary: gateCompile?.summary ?? undefined,
          evidenceRef: gateCompile?.evidenceRef ?? undefined,
          chainOfRecord: [input.currentPacketId],
        });
        nextQitemId = createdNext.qitemId;
        nextQitemCreatePostCommit = {
          destinationSession: createdNext.destinationSession,
          nudge: createdNext.nudge,
        };
        // OPR.0.4.6.WF2 FR-5 (guard blocker 1): a HUMAN gate packet PARKS
        // in the same txn — state=blocked, blocked_on=<human seat> — the
        // exact leg-1 shape the shipped `rig queue resolve` verb acts on
        // (validateHumanPark enforces summary + evidence_ref here, carried
        // from create). Resolve unparks it for the step owner to resume.
        if (gateCompile?.parkOn) {
          const parked = this.queueRepo.updateWithinTransaction({
            qitemId: createdNext.qitemId,
            actorSession: input.actorSession,
            state: "blocked",
            closureReason: "blocked_on",
            closureTarget: gateCompile.parkOn,
            blockedOn: gateCompile.parkOn,
            transitionNote: `workflow gate: parked on ${gateCompile.parkOn} pending sign-off`,
          });
          persistedEvents.push(parked.persistedEvent);
        }
      }

      // OPR.0.4.6.WF1 FR-1 proof seam (ACK Rev-2, reviewer-approved
      // shape): an env-gated hold INSIDE the transaction, between the
      // queue close / next-qitem create and the trail append, giving
      // the fr1-midtxn-process-kill VM proof a deterministic window to
      // SIGKILL the daemon mid-transaction. Default off/absent = zero
      // effect (test-only; never set in production). Synchronous by
      // design — better-sqlite3 transactions are sync.
      const holdMs = Number(process.env.OPENRIG_TEST_WF_TXN_HOLD_MS ?? 0);
      if (holdMs > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
      }

      // 4. Append step trail entry (prior + next ids).
      this.trailLog.record({
        instanceId: instance.instanceId,
        stepId: currentStep.id,
        stepRole: currentStep.actor_role,
        closedAt: evaluatedAt,
        closureReason: effectiveExit,
        closureEvidence: effectiveClosureEvidence ?? null,
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
      if (nextQitemId) {
        // OPR.0.4.6.WF2: a ROUTED close (structural handoff OR a
        // branch-mapped exit — including a mapped `waiting`) moves the
        // frontier to the new packet. Checked FIRST so a mapped waiting
        // routes instead of re-parking the closed packet.
        nextFrontier = [...remainingFrontier, nextQitemId];
      } else if (effectiveExit === "waiting") {
        // Unrouted waiting: keep the closed packet on frontier; the
        // watchdog uses it to wake the owner.
        nextFrontier = [...remainingFrontier, input.currentPacketId];
      } else {
        nextFrontier = remainingFrontier;
      }
      // R1 fix (guard blocker 2a): exit=failed sets status=failed, NOT
      // completed. Emits workflow.failed instead of workflow.completed.
      // OPR.0.4.6.WF2: a ROUTED close keeps the instance ACTIVE bound to
      // the route target (the branch execution contract) — UNLESS the
      // target step is GATED, in which case the instance parks honestly
      // (`waiting`) on the gate item until resolve/close continues it.
      // Non-routed exits keep today's ladder byte-identically.
      let nextStatus: WorkflowInstance["status"];
      let completedAt: string | null = null;
      if (routes) {
        nextStatus = gateCompile ? "waiting" : "active";
      } else if (effectiveExit === "waiting") {
        nextStatus = "waiting";
      } else if (effectiveExit === "failed") {
        nextStatus = "failed";
        completedAt = evaluatedAt;
      } else if (nextFrontier.length === 0) {
        nextStatus = "completed";
        completedAt = evaluatedAt;
      } else {
        nextStatus = "active";
      }
      // R2 fix: set durable current_step_id transition.
      //   routed (handoff or branch) → route target step
      //   waiting (unrouted)         → preserve (resume on same packet/step)
      //   done / failed (unrouted)   → clear (terminal)
      let currentStepIdUpdate: "preserve" | "clear" | string;
      if (routes && nextStep) {
        currentStepIdUpdate = nextStep.id;
      } else if (effectiveExit === "waiting") {
        currentStepIdUpdate = "preserve";
      } else {
        // done or failed
        currentStepIdUpdate = "clear";
      }
      this.instanceStore.updateFrontier(instance.instanceId, nextFrontier, nextStatus, {
        // A branch route IS an advance (arch PIN 2): it bumps the hop
        // count and the FR-5 version guard under the identical
        // discipline as the linear path.
        bumpHopCount: routes,
        lastContinuationDecision: {
          exit: effectiveExit,
          actorSession: input.actorSession,
          closedPacket: input.currentPacketId,
          nextPacket: nextQitemId,
          resultNote: effectiveResultNote ?? null,
          blockedOn: input.blockedOn ?? null,
          currentStep: currentStep.id,
          // OPR.0.4.6.WF2 FR-1 (arch PIN 1): ADDITIVE branch-taken
          // record — null on every non-branch close.
          branchTaken: routes && branchRouted && nextStep ? nextStep.id : null,
        },
        completedAt,
        currentStepId: currentStepIdUpdate,
        // FR-5: the optimistic-concurrency guard — this write commits
        // only if no other writer advanced the instance since our read;
        // a stale writer throws instance_version_conflict and the whole
        // scribe transaction rolls back.
        expectedVersion: instance.version,
      });

      // 5b. OPR.0.4.6.WF1 FR-3: keepalive arm/disarm INSIDE the scribe
      // txn. A handoff ensures the per-instance job is armed (idempotent
      // — also heals pre-WF-1 instances on their first post-upgrade
      // hop); a terminal status disarms it (no orphaned watchdog
      // noise). Waiting keeps the job armed — the keepalive wakes the
      // parked owner. Plain INSERT/UPDATE, verified txn-composable.
      if (this.watchdogJobsRepo) {
        if (routes && resolvedNextOwner) {
          // Any route arms the keepalive for the new owner — including a
          // gate park (waiting keeps the job armed; it wakes the parked
          // gate target exactly like any parked owner).
          ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
            instanceId: instance.instanceId,
            targetSession: resolvedNextOwner,
            registeredBySession: input.actorSession,
          });
        } else if (nextStatus === "completed" || nextStatus === "failed") {
          disarmWorkflowKeepalive(
            this.watchdogJobsRepo,
            instance.instanceId,
            `workflow_${nextStatus}`,
          );
        }
      }

      // 6. Persist workflow events within the same txn.
      persistedEvents.push(
        this.eventBus.persistWithinTransaction({
          type: "workflow.step_closed",
          instanceId: instance.instanceId,
          stepId: currentStep.id,
          closureReason: effectiveExit,
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
            reason: effectiveResultNote ?? "workflow_step_failed",
          }),
        );
        // OPR.0.4.6.WF5 FR-2 class (a): the exception attention item is
        // BORN IN THIS TRANSACTION — if this commit lands, the item
        // exists; if anything throws, instance failure AND item roll
        // back together. There is NO window where the instance is
        // failed and no item exists (the load-bearing never-lost AC,
        // target-independent at every dial position — hold-onto 1).
        const exception = classifyFailedInstance({
          instance: { ...instance, status: "failed" },
          failedStepId: currentStep.id,
          failedPacketId: input.currentPacketId,
          failureReason: effectiveResultNote ?? null,
        });
        if (exception) {
          const route = resolveExceptionRoute({
            exceptionClass: exception.identity.exceptionClass,
            spec,
            hostDialDefault: this.exceptionDial?.hostDefault() ?? null,
            // FAC-1 (arch Q3 — routing uniformity, bounded): declared
            // preferred_targets stay the override; a bound instance's
            // orchestrator-role dial position falls through to a
            // NON-THROWING capability pick on the bound rig (null →
            // the router's human@host never-lost fallback — exception
            // routing never fails a close). Fresh decision per episode;
            // not a replay concern.
            resolveRoleTarget: (role) =>
              spec.roles?.[role]?.preferred_targets?.[0] ??
              tryResolveRoleByCapability(roleCtx, role),
            humanFallbackSeat: this.exceptionDial?.humanFallbackSeat ?? "human@host",
          });
          const evidenceRef = `rig workflow trace ${instance.instanceId}`;
          const itemBody =
            `WORKFLOW EXCEPTION (${exception.identity.exceptionClass})\n` +
            `workflow: ${instance.workflowName} v${instance.workflowVersion}\n` +
            `instance: ${instance.instanceId}\n` +
            `step: ${currentStep.id} (role ${currentStep.actor_role})\n` +
            `reason: ${exception.reason}\n` +
            `evidence: ${evidenceRef}\n` +
            `resolve: diagnose via the trace above, then \`rig workflow resume ${instance.instanceId} [--decision <text>]\` re-drives from this step (completed steps never re-run).`;
          const createExceptionItem = (destination: string, tier: string) =>
            this.queueRepo.createWithinTransaction({
              sourceSession: input.actorSession,
              destinationSession: destination,
              body: itemBody,
              priority: "urgent",
              tier,
              tags: workflowExceptionTags(exception.identity),
              summary: exception.reason,
              evidenceRef,
              chainOfRecord: [input.currentPacketId],
            });
          let createdException;
          try {
            createdException = createExceptionItem(route.destinationSession, route.tier);
          } catch {
            // THE NEVER-LOST WRITE-GATE FALLBACK: a routed destination the
            // queue's destination gate rejects (e.g. a spec-declared
            // target that is not a live session) must not lose the
            // exception OR fail the close — re-route human@host (always
            // validates: the destination gate special-cases human seats)
            // with the human-routed tier. Any failure of THIS create is a
            // real storage error and propagates: the whole close rolls
            // back rather than committing an item-less failure.
            createdException = createExceptionItem(
              this.exceptionDial?.humanFallbackSeat ?? "human@host",
              "human-gate",
            );
          }
          persistedEvents.push(createdException.persistedEvent);
          exceptionItemPostCommit = {
            qitemId: createdException.qitemId,
            destinationSession: createdException.destinationSession,
            nudge: createdException.nudge,
          };
        }
      }
    });

    txn();

    // Post-commit fan-out: notify subscribers + nudge next owner.
    for (const e of persistedEvents) {
      this.eventBus.notifySubscribers(e);
    }
    // OPR.0.4.6.WF5 FR-2: best-effort nudge for the exception item (the
    // shipped non-fatal delivery pattern — the durable item is the
    // guarantee, the nudge is a courtesy).
    const excPost = exceptionItemPostCommit as (PostCommitNudge & { qitemId: string }) | null;
    if (excPost) {
      await this.queueRepo.maybeNudge(excPost.qitemId, excPost.destinationSession, excPost.nudge);
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
      closureReason: effectiveExit,
      nextQitemId,
      nextOwnerSession,
      nextStepId,
      emittedEventTypes: persistedEvents.map((e) => e.type),
    };
  }
}

/**
 * OPR.0.4.6.WF1 FR-5 (G-WF1-1, guard-ratified): the FULL
 * CLOSURE-INTENT IDENTITY predicate for waiting-replay absorption.
 * Every field that can change observable queue/trail/decision state
 * must match the stored decision exactly:
 *   exit=waiting · closedPacket · currentStep · actorSession ·
 *   resultNote (null ≡ absent) · blockedOn (normalized to the
 *   EFFECTIVE blocker — the shipped `external-gate` default applied
 *   before comparison, workflowExitToQueueClosure:waiting) ·
 *   closureEvidence (deep-equal against the stored TRAIL row's
 *   evidence, since that is where evidence lands).
 * Plus instance.status === waiting (checked by the caller).
 */
function matchesStoredWaitingDecision(
  instance: WorkflowInstance,
  input: ProjectStepInput,
  currentStepId: string,
  trailLog: WorkflowStepTrailLog,
): boolean {
  const stored = instance.lastContinuationDecision;
  if (!stored) return false;
  if (stored.exit !== "waiting") return false;
  if (stored.closedPacket !== input.currentPacketId) return false;
  if (stored.currentStep !== currentStepId) return false;
  if (stored.actorSession !== input.actorSession) return false;
  const storedNote = (stored.resultNote as string | null | undefined) ?? null;
  const inputNote = input.resultNote ?? null;
  if (storedNote !== inputNote) return false;
  const storedBlocker =
    ((stored.blockedOn as string | null | undefined) ?? null) ?? "external-gate";
  const inputBlocker = input.blockedOn ?? "external-gate";
  if (storedBlocker !== inputBlocker) return false;
  // closureEvidence lands in the trail row, not the decision — compare
  // against the most recent waiting close of this exact packet.
  const trail = trailLog.listForInstance(instance.instanceId);
  const storedRow = trail.find(
    (t) => t.priorQitemId === input.currentPacketId && t.closureReason === "waiting",
  );
  if (!storedRow) return false;
  return isDeepEqual(storedRow.closureEvidence ?? null, input.closureEvidence ?? null);
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    isDeepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
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
 * Resolve the next step. OPR.0.4.6.WF2 FR-1: when a `recordedExit` is
 * supplied AND the step's `next_hop.on` maps it, the MAPPED target wins
 * (the deterministic branch — same (spec, step, exit) → same target,
 * every time). Otherwise the structural default: the spec-authored
 * `next_hop.suggested_roles` edge, then declaration order.
 *
 * EXPORTED (OPR.0.4.6.WF1 FR-7): this is THE single routing seam —
 * the validator's reachability/cycle analysis runs over these exact
 * semantics (never a parallel re-implementation). The validator calls
 * it WITHOUT an exit for the structural default path and unions the
 * branch edges explicitly — one routing truth, no semantic fork.
 */
export function resolveNextStep(
  spec: WorkflowSpec,
  currentStep: WorkflowStepSpec,
  recordedExit?: WorkflowExitKind,
): WorkflowStepSpec | null {
  const mappedTargetId = recordedExit
    ? currentStep.next_hop?.on?.[recordedExit]
    : undefined;
  if (mappedTargetId !== undefined) {
    return spec.steps.find((s) => s.id === mappedTargetId) ?? null;
  }
  if (currentStep.next_hop?.mode === "forbid") return null;
  for (const role of currentStep.next_hop?.suggested_roles ?? []) {
    const target = spec.steps.find((s) => s.actor_role === role);
    if (target) return target;
  }
  if (currentStep.next_hop?.mode === "require") return null;
  const idx = spec.steps.findIndex((s) => s.id === currentStep.id);
  if (idx === -1) return null;
  return spec.steps[idx + 1] ?? null;
}

/**
 * OPR.0.4.6.FAC1 — resolve a ROLE to a live capable seat on the bound
 * rig, or throw LOUD-WITH-CANDIDATES (BR-5). The structured details
 * carry every evaluated candidate with its named disqualifier
 * (`not_live(lifecycleState=x)` / `runtime_mismatch(has≠needs)` /
 * `role_not_declared` / `adopted_seat_not_role_resolvable_v1`) so the
 * operator OR the WF-5 exception orchestrator can act; the
 * zero-candidate case gets its own named message. Thrown BEFORE any
 * side effect (the :199-221 validation-before-mutation discipline);
 * never a spawn, never auto-add_member, never a dead-seat route.
 */
function resolveRoleOnBoundRig(
  roleName: string,
  harness: string | undefined,
  roleCtx: RoleResolutionContext,
  stepId: string,
): string {
  const candidates = roleCtx.candidatesForRig();
  if (candidates === null) {
    throw new WorkflowProjectorError(
      "bound_rig_not_found",
      `cannot resolve role "${roleName}" for step "${stepId}": the instance's bound rig "${roleCtx.boundRig}" no longer resolves to a registered rig (torn down mid-run?). Recreate/import the rig under the same name, or instantiate a fresh run bound elsewhere.`,
      { stepId, role: roleName, boundRig: roleCtx.boundRig },
    );
  }
  const result = selectRoleSeat({ role: roleName, harness, candidates });
  if (result.seat) return result.seat;
  const declaring = result.disqualified.filter((c) => c.facts.role === roleName);
  if (declaring.length === 0) {
    throw new WorkflowProjectorError(
      "next_owner_unresolved",
      `cannot resolve role "${roleName}" for step "${stepId}" (no seats on rig "${roleCtx.boundRig}" declare role "${roleName}"). Add a member with role ${roleName} to rig ${roleCtx.boundRig} via rig add, declare role on an existing member, or add preferred_targets to the role in the spec.`,
      {
        stepId,
        role: roleName,
        boundRig: roleCtx.boundRig,
        candidates: result.disqualified,
      },
    );
  }
  throw new WorkflowProjectorError(
    "next_owner_unresolved",
    `cannot resolve a live capable seat for role "${roleName}" for step "${stepId}" on rig "${roleCtx.boundRig}". Candidates: ${declaring
      .map((c) => `${c.coordinate ?? c.logicalId} → ${c.disqualifier}`)
      .join(", ")}. Start/repair a role seat (see rig ps), add a member with role ${roleName} via rig add, or add preferred_targets to the role.`,
    {
      stepId,
      role: roleName,
      boundRig: roleCtx.boundRig,
      candidates: result.disqualified,
    },
  );
}

/**
 * Resolve a default owner for a step. v1 picks the first declared
 * preferred_target. OPR.0.4.6.WF2 FR-2: a step with a `harness:` pin
 * picks the first preferred_target whose node runtime matches the pin
 * instead; no match is a STRUCTURED routing failure naming the pin and
 * each candidate's actual runtime — never a silent mis-route to the
 * wrong harness. `runtimeOf` resolves a canonical session name to its
 * node's runtime column (null = not a managed node / unknown).
 *
 * OPR.0.4.6.FAC1: gains the optional bound-rig context — see the tier
 * comment in the body. Tier order (P2-6, guard-BLOCKING on deviation):
 *   1. explicit input.nextOwnerSession (caller-reconciled)
 *   2. gate compile (the caller branches there first)
 *   3. declared preferred_targets — TODAY'S path byte-for-byte
 *   4. NEW: role capability on the bound rig (no targets + bound only)
 *   5. null → the shipped next_owner_unresolved at the caller.
 *
 * Returns null only for the unpinned no-targets UNBOUND case (caller
 * must supply nextOwnerSession explicitly — unchanged v1 behavior).
 */
export function resolveDefaultOwner(
  spec: WorkflowSpec,
  step: WorkflowStepSpec,
  runtimeOf?: (session: string) => string | null,
  /** OPR.0.4.6.FAC1: the bound-rig resolution context. Present only for
   *  BOUND instances at LIVE resolution sites (projection next-step,
   *  gate compile, entry, resume) — never at the eager instantiate loop
   *  (guard B1: no eager live resolution of future steps). */
  roleCtx?: RoleResolutionContext,
): string | null {
  const role = spec.roles?.[step.actor_role];
  const targets = role?.preferred_targets ?? [];
  // OPR.0.4.6.FAC1 TIER 3 (the ONLY new tier; order is sacred — P2-6):
  // declared preferred_targets above stay TODAY'S code path
  // byte-for-byte and are NEVER liveness/inventory-filtered. Capability
  // resolution activates exclusively when the role declares ZERO
  // targets AND the instance is bound to a rig. Unbound no-target
  // behavior below stays byte-identical (null / "(none declared)").
  if (targets.length === 0 && roleCtx) {
    return resolveRoleOnBoundRig(step.actor_role, step.harness, roleCtx, step.id);
  }
  if (!step.harness) return targets[0] ?? null;
  if (!runtimeOf) {
    // Defense-in-depth: a pinned step must never resolve without
    // runtime awareness (that would be exactly the silent mis-route
    // FR-2 forbids). Production call sites always supply runtimeOf.
    throw new WorkflowProjectorError(
      "harness_pin_unverifiable",
      `step "${step.id}" pins harness "${step.harness}" but no runtime lookup is available to reconcile it — refusing to resolve an owner blind.`,
      { stepId: step.id, harness: step.harness },
    );
  }
  const candidates = targets.map((t) => ({ session: t, runtime: runtimeOf(t) }));
  const match = candidates.find((c) => c.runtime === step.harness);
  if (match) return match.session;
  throw new WorkflowProjectorError(
    "harness_pin_unsatisfied",
    `step "${step.id}" pins harness "${step.harness}" but no preferred_target of role "${step.actor_role}" runs it. Candidates: ${
      candidates.length === 0
        ? "(none declared)"
        : candidates.map((c) => `${c.session} → ${c.runtime ?? "unknown"}`).join(", ")
    }. Add a ${step.harness} seat to the role's preferred_targets, or change/remove the pin.`,
    {
      stepId: step.id,
      harness: step.harness,
      candidates: candidates.map((c) => ({ session: c.session, runtime: c.runtime })),
    },
  );
}

/**
 * OPR.0.4.6.WF2 FR-2: reconcile an EXPLICIT owner override against a
 * step's harness pin. An operator-supplied owner whose runtime does not
 * match the pin is rejected loud — an explicit override must never
 * silently defeat a declared pin.
 */
export function reconcileExplicitOwnerHarness(
  step: WorkflowStepSpec,
  explicitOwner: string,
  runtimeOf: (session: string) => string | null,
): void {
  if (!step.harness) return;
  const actual = runtimeOf(explicitOwner);
  if (actual !== step.harness) {
    throw new WorkflowProjectorError(
      "harness_pin_unsatisfied",
      `step "${step.id}" pins harness "${step.harness}" but the explicitly supplied owner ${explicitOwner} runs ${actual ?? "unknown (not a managed node)"}. Supply a ${step.harness} seat or change/remove the pin.`,
      { stepId: step.id, harness: step.harness, explicitOwner, actualRuntime: actual },
    );
  }
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

/**
 * OPR.0.4.6.WF2 FR-5: the gate compiler — a declared step-level gate
 * resolves to LIVE 0.4.4 machinery by target kind. HUMAN target (the
 * shipped human-seat predicate) → a human-routed item (tier
 * `human-gate`) carrying the summary + evidence_ref the shipped write
 * path enforces, resolved by the shipped `resolve` verb. HANDLER-ROLE
 * target → an ordinary agent-routed item to the declared role's
 * resolved seat (no human-only enforcement fields forced on it). WF-2
 * builds the socket; WF-5 owns gate SEMANTICS.
 */
export interface GateCompileResult {
  destinationSession: string;
  /** Reserved for a future tier override; undefined = caller's default tier. */
  tier: string | undefined;
  summary: string | null;
  evidenceRef: string | null;
  kind: "human" | "handler-role";
  /** HUMAN targets: the human seat the packet parks blocked_on (the leg-1
   *  park the shipped `rig queue resolve` verb acts on — guard blocker 1:
   *  resolve requires state=blocked + human-seat blocked_on, so the gate
   *  item is created for the STEP OWNER and parked on the human, never
   *  minted as an unresolvable pending human-destined item). null for
   *  handler-role gates (ordinary agent routing, no park-on-human). */
  parkOn: string | null;
}

export function compileGate(
  spec: WorkflowSpec,
  gatedStep: WorkflowStepSpec,
  runtimeOf: (session: string) => string | null,
  /** OPR.0.4.6.FAC1: bound-rig context — threads capability resolution
   *  into BOTH gate paths (guard B3: the human-gate OWNER path and the
   *  handler-role DESTINATION branch are different code paths and each
   *  must carry it). Absent = shipped behavior byte-identical. */
  roleCtx?: RoleResolutionContext,
): GateCompileResult {
  const gate = gatedStep.gate;
  if (!gate) {
    throw new WorkflowProjectorError(
      "gate_missing",
      `compileGate called for step "${gatedStep.id}" which declares no gate`,
      { stepId: gatedStep.id },
    );
  }
  if (isHumanSeatSession(gate.target)) {
    // Defense-in-depth: the validator requires these at validate time;
    // the shipped human-park write path (validateHumanPark at the
    // blocked_on transition) enforces them again at park.
    if (!gate.summary || !gate.evidence_ref) {
      throw new WorkflowProjectorError(
        "gate_human_fields_missing",
        `step "${gatedStep.id}" gates on human seat ${gate.target} but is missing ${!gate.summary ? "summary" : "evidence_ref"} — a human-parked item requires both (the shipped human-route contract).`,
        { stepId: gatedStep.id, target: gate.target },
      );
    }
    // The packet belongs to the gated step's ROLE OWNER (the seat that
    // does the work once the human signs off) and PARKS blocked_on the
    // human seat — the exact leg-1 shape `rig queue resolve` unparks.
    // FAC-1 (guard B3 row 2a): the owner resolves through the full tier
    // stack — a bound instance's role-only gated step gets a rig-local
    // owner by capability.
    const owner = resolveDefaultOwner(spec, gatedStep, runtimeOf, roleCtx);
    if (!owner) {
      throw new WorkflowProjectorError(
        "gate_owner_unresolved",
        `step "${gatedStep.id}" gates on human seat ${gate.target} but its role "${gatedStep.actor_role}" declares no preferred_targets — the parked packet has no owner to resume after resolve. Add preferred_targets to the role.`,
        { stepId: gatedStep.id, target: gate.target, role: gatedStep.actor_role },
      );
    }
    return {
      destinationSession: owner,
      tier: undefined,
      summary: gate.summary,
      evidenceRef: gate.evidence_ref,
      kind: "human",
      parkOn: gate.target,
    };
  }
  const role = spec.roles?.[gate.target];
  if (!role) {
    throw new WorkflowProjectorError(
      "gate_target_unresolved",
      `step "${gatedStep.id}" gates on "${gate.target}" which is neither a human seat session nor a role declared in workflow.roles. Declare the role or use a human seat session (human@kernel form).`,
      { stepId: gatedStep.id, target: gate.target },
    );
  }
  const handlerTargets = role.preferred_targets ?? [];
  if (handlerTargets.length === 0) {
    // OPR.0.4.6.FAC1 (guard B3 row 2b — the branch that would silently
    // stay old-style if unthreaded): declared preferred_targets remain
    // the override tier byte-identically; when the handler role has NO
    // targets AND the instance is bound, the handler seat resolves by
    // capability on the bound rig (the step's harness pin binds the
    // ACTUAL routed destination — the WF-2 rev1-r2 contract); otherwise
    // the shipped loud failure stands.
    if (roleCtx) {
      const seat = resolveRoleOnBoundRig(gate.target, gatedStep.harness, roleCtx, gatedStep.id);
      return {
        destinationSession: seat,
        tier: undefined,
        summary: gate.summary ?? null,
        evidenceRef: gate.evidence_ref ?? null,
        kind: "handler-role",
        parkOn: null,
      };
    }
    throw new WorkflowProjectorError(
      "gate_handler_unresolved",
      `step "${gatedStep.id}" gates on handler role "${gate.target}" but that role declares no preferred_targets — the gate item has no seat to route to. Add preferred_targets to the role.`,
      { stepId: gatedStep.id, target: gate.target },
    );
  }
  // OPR.0.4.6.WF2 (rev1-r2 blocker): the step's harness pin binds the
  // packet's ACTUAL routed destination — for a handler gate, the handler
  // seat. FR-2's contract ("never a silent mis-route to the wrong
  // harness") admits no gated bypass: a pinned gated step routes to the
  // first handler preferred_target whose node runtime matches, or fails
  // structured naming the pin and every candidate's runtime.
  let seat: string;
  if (gatedStep.harness) {
    const candidates = handlerTargets.map((t) => ({ session: t, runtime: runtimeOf(t) }));
    const match = candidates.find((c) => c.runtime === gatedStep.harness);
    if (!match) {
      throw new WorkflowProjectorError(
        "harness_pin_unsatisfied",
        `step "${gatedStep.id}" pins harness "${gatedStep.harness}" and gates on handler role "${gate.target}", but no preferred_target of that role runs it. Candidates: ${candidates.map((c) => `${c.session} → ${c.runtime ?? "unknown"}`).join(", ")}. Add a ${gatedStep.harness} seat to the handler role's preferred_targets, or change/remove the pin.`,
        {
          stepId: gatedStep.id,
          harness: gatedStep.harness,
          gateTarget: gate.target,
          candidates: candidates.map((c) => ({ session: c.session, runtime: c.runtime })),
        },
      );
    }
    seat = match.session;
  } else {
    seat = handlerTargets[0]!;
  }
  return {
    destinationSession: seat,
    tier: undefined,
    summary: gate.summary ?? null,
    evidenceRef: gate.evidence_ref ?? null,
    kind: "handler-role",
    parkOn: null,
  };
}

function workflowHandoffBody(input: {
  spec: WorkflowSpec;
  instance: WorkflowInstance;
  currentStep: WorkflowStepSpec;
  nextStep: WorkflowStepSpec;
  actorSession: string;
  resultNote: string | undefined;
  gate?: GateCompileResult | null;
}): string {
  const lines = [
    input.gate
      ? `### Workflow gate: ${input.spec.id}@${input.spec.version} step ${input.nextStep.id}`
      : `### Workflow handoff: ${input.spec.id}@${input.spec.version} step ${input.nextStep.id}`,
    "",
    `Workflow instance: ${input.instance.instanceId}`,
    `Prior step: ${input.currentStep.id} (${input.currentStep.actor_role}) closed by ${input.actorSession}`,
    `This step: ${input.nextStep.id} (${input.nextStep.actor_role})`,
  ];
  if (input.gate) {
    lines.push(
      `Gate: ${input.gate.kind === "human" ? "human sign-off" : "handler-role check"} — the workflow is PARKED (waiting) until this item is resolved/closed; the flow then continues from this step.`,
    );
    if (input.gate.summary) lines.push(`Ask: ${input.gate.summary}`);
    if (input.gate.evidenceRef) lines.push(`Evidence: ${input.gate.evidenceRef}`);
  }
  if (input.nextStep.objective) {
    lines.push(`Objective: ${input.nextStep.objective}`);
  }
  if (input.resultNote) {
    lines.push("", `Prior step note: ${input.resultNote}`);
  }
  return lines.join("\n");
}
