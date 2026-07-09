// PL-004 Phase D: workflow runtime facade.
//
// Coordinates spec cache + validator + instance store + projector +
// trail log into the four high-level operations:
//   - validate(specPath)
//   - instantiate(specPath, rootObjective, createdBySession)
//   - project(...)  (delegates to projector)
//   - continue(instanceId)  (idempotent advance; v1 = read-only inspector)
//
// Pattern mirrors Phase B's ProjectClassifier facade shape.

import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { QueueRepository } from "./queue-repository.js";
import type { PersistedEvent } from "./types.js";
import {
  type CreateWorkflowInstanceInput,
  WorkflowInstanceStore,
  WorkflowInstanceError,
} from "./workflow-instance-store.js";
import { resolveExceptionRoute, type ExceptionRoute } from "./workflow-exception-router.js";
import { classifyGateTrip, workflowExceptionTags } from "./workflow-exception.js";
import { newQitemId } from "./queue-repository.js";
import type { WorkflowExceptionClass } from "./workflow-exception.js";
import {
  WorkflowProjector,
  WorkflowProjectorError,
  compileGate,
  nodeRuntimeOf,
  reconcileExplicitOwnerHarness,
  resolveDefaultOwner,
  type GateCompileResult,
  type ProjectStepInput,
  type ProjectStepResult,
} from "./workflow-projector.js";
import { loadHostRegistry } from "./hosts/hosts-registry-reader.js";
import type { HostRegistryLookupFn } from "./workflow-validator.js";
import { WorkflowSpecCache, WorkflowSpecError } from "./workflow-spec-cache.js";
import { WorkflowStepTrailLog } from "./workflow-step-trail-log.js";
import {
  type SeatLivenessCheckFn,
  type ValidationResult,
  WorkflowValidator,
} from "./workflow-validator.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import { disarmWorkflowKeepalive, ensureWorkflowKeepaliveArmed } from "./workflow-keepalive-arming.js";
import { evaluateStepDeadline, type WorkflowDeadlineVerdict } from "./workflow-deadline.js";
import {
  rigDeclaresRole,
  rigMemberExists,
  roleResolutionContext,
  tryResolveRoleByCapability,
} from "./workflow-role-context.js";
import { isHumanSeatSession } from "./human-route-enforcer.js";
import { parseSessionName } from "./session-name.js";
import type { WorkflowInstance, WorkflowSpecRow, WorkflowStepTrailEntry } from "./workflow-types.js";

export interface WorkflowRuntimeDeps {
  db: Database.Database;
  eventBus: EventBus;
  queueRepo: QueueRepository;
  now?: () => Date;
  /**
   * OPR.0.4.6.WF1 FR-3: when supplied, instantiate + handoff
   * projections auto-arm the per-instance workflow-keepalive watchdog
   * job INSIDE the scribe transaction, and terminal exits disarm it.
   * Optional so tests / embedders without the watchdog subsystem keep
   * working; startup wires the real repository.
   */
  watchdogJobsRepo?: WatchdogJobsRepository;
  /**
   * OPR.0.4.6.WF5 FR-2: the maturity-dial inputs (injected at startup —
   * the projector never reads config itself). hostDefault is read LIVE
   * per exception; absent = the orchestrator-first engine default with
   * the human@host never-lost fallback.
   */
  exceptionDial?: {
    hostDefault: () => "orchestrator" | "human_only" | null;
    humanFallbackSeat: string;
  };
}

export interface InstantiateInput {
  specPath: string;
  rootObjective: string;
  createdBySession: string;
  /**
   * Override default entry-step owner. v1 falls back to spec
   * preferred_targets[0] for the entry step's role.
   */
  entryOwnerSession?: string;
  /**
   * OPR.0.4.6.FAC1 (AC-1): the rig this instance binds to. Overrides
   * the spec's `target.rig` DEFAULT; the effective binding
   * (`targetRig ?? spec.target.rig ?? null`) persists as
   * `WorkflowInstance.boundRig` and scopes role-capability resolution.
   * Absent AND no spec default = unbound (today's behavior).
   */
  targetRig?: string;
}

export interface InstantiateResult {
  instance: WorkflowInstance;
  spec: WorkflowSpecRow;
  entryQitemId: string;
  entryOwnerSession: string;
  /**
   * OPR.0.4.6.FAC1 (arch ruling 2026-07-07, target-rig zero-regression):
   * loud instantiate-time advisories. Non-fatal notices the operator MUST
   * see. TWO producers into this one list: (1) the spec-default degrade —
   * when a spec's `target.rig` DEFAULT (provenance = spec author's hint,
   * not an operator `--rig` demand) names an unregistered rig, the
   * instance degrades to UNBOUND (routes via preferred_targets,
   * byte-identical pre-FAC-1) with an advisory here rather than a
   * hard-fail; (2) the OPR.0.4.6.FAC3 member-exists probe — a declared
   * preferred_target naming a registered rig but a nonexistent member.
   * Always present (empty when nothing to say); route + CLI surface it
   * loudly.
   */
  advisories: string[];
}

export class WorkflowRuntime {
  readonly specCache: WorkflowSpecCache;
  readonly instanceStore: WorkflowInstanceStore;
  readonly trailLog: WorkflowStepTrailLog;
  readonly validator: WorkflowValidator;
  readonly projector: WorkflowProjector;

  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly queueRepo: QueueRepository;
  private readonly now: () => Date;
  private readonly watchdogJobsRepo: WatchdogJobsRepository | undefined;
  private readonly exceptionDial?: WorkflowRuntimeDeps["exceptionDial"];

  constructor(deps: WorkflowRuntimeDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.queueRepo = deps.queueRepo;
    this.now = deps.now ?? (() => new Date());
    this.watchdogJobsRepo = deps.watchdogJobsRepo;
    this.exceptionDial = deps.exceptionDial;
    this.specCache = new WorkflowSpecCache(this.db, this.now);
    this.instanceStore = new WorkflowInstanceStore(this.db, this.now);
    this.trailLog = new WorkflowStepTrailLog(this.db);
    this.validator = new WorkflowValidator();
    this.projector = new WorkflowProjector(
      this.db,
      this.eventBus,
      this.queueRepo,
      this.instanceStore,
      this.trailLog,
      this.specCache,
      this.now,
      this.watchdogJobsRepo,
      deps.exceptionDial,
    );
  }

  /**
   * OPR.0.4.6.WF5 FR-2: resolve the maturity dial for a CACHED spec —
   * the class-(b) detection paths (sweep/keepalive) call this through
   * the startup-injected closure. null = spec not cached (the caller's
   * never-lost fallback applies). Uses the SAME preferred_targets[0]
   * string-pick as step-owner resolution (arch Seam-A uniformity).
   */
  resolveExceptionRouteFor(
    workflowName: string,
    workflowVersion: string,
    exceptionClass: WorkflowExceptionClass,
    /** OPR.0.4.6.FAC1 (arch Q3): the instance's bound rig — dial
     *  position 3 (orchestrator-role) then resolves capability-aware
     *  on that rig when the role declares no preferred_targets.
     *  Absent/null = the shipped fleet-blind string-pick only. */
    boundRig?: string | null,
  ): ExceptionRoute | null {
    const specRow = this.specCache.getByNameVersion(workflowName, workflowVersion);
    if (!specRow) return null;
    const spec = specRow.spec;
    const roleCtx = roleResolutionContext(this.db, boundRig ?? null);
    return resolveExceptionRoute({
      exceptionClass,
      spec,
      hostDialDefault: this.exceptionDial?.hostDefault() ?? null,
      resolveRoleTarget: (role) =>
        spec.roles?.[role]?.preferred_targets?.[0] ??
        tryResolveRoleByCapability(roleCtx, role),
      humanFallbackSeat: this.exceptionDial?.humanFallbackSeat ?? "human@host",
    });
  }

  /**
   * OPR.0.4.6.WF2 FR-3: the production host-registry probe for the
   * validator — built on the daemon hosts-registry reader (read-only
   * twin of the CLI registry). An unreadable/missing registry reports
   * every id as unregistered with an empty id list (fail-loud at the
   * validator's host_not_registered issue, never a silent pass).
   */
  private hostRegistryLookup: HostRegistryLookupFn = (hostId: string) => {
    const loaded = loadHostRegistry();
    if (!loaded.ok) return { registered: false, registeredIds: [] };
    const ids = loaded.registry.hosts.map((h) => h.id);
    return { registered: ids.includes(hostId), registeredIds: ids };
  };

  validate(specPath: string, seatLivenessCheck?: SeatLivenessCheckFn): ValidationResult {
    const specRow = this.specCache.readThrough(specPath);
    return this.validator.validate(specRow.spec, seatLivenessCheck, this.hostRegistryLookup);
  }

  /**
   * Create a workflow instance + first-step qitem. The entry qitem is
   * created in the same transaction as the instance row; subscribers
   * see the workflow.instantiated + queue.created events together.
   */
  async instantiate(input: InstantiateInput): Promise<InstantiateResult> {
    // OPR.0.3.3.04.1 (AC-3 reachability): a fresh operator runs
    // `workflow instantiate <discovered-name>` (e.g. `conveyor`), not a hidden
    // file path. Resolve the identifier against the seeded spec cache BY NAME
    // first (using the cache's already-resolved stored sourcePath), falling back
    // to treating it as a literal sourcePath only when no named spec matches (an
    // operator-authored spec at an explicit path). Before this, instantiate fed
    // the bare name straight to readThrough -> spec_file_missing.
    const resolvedSpecPath = this.specCache.resolveSourcePathByName(input.specPath) ?? input.specPath;
    const specRow = this.specCache.readThrough(resolvedSpecPath);
    const validation = this.validator.validate(specRow.spec, undefined, this.hostRegistryLookup);
    if (!validation.ok) {
      throw new WorkflowProjectorError(
        "spec_invalid",
        `cannot instantiate: spec ${specRow.name}@${specRow.version} has ${validation.issues.filter((i) => i.severity === "error").length} validation error(s); run validate to inspect`,
        { specPath: input.specPath, issues: validation.issues },
      );
    }
    const entryStep = specRow.spec.steps[0];
    if (!entryStep) {
      throw new WorkflowProjectorError(
        "spec_no_steps",
        `cannot instantiate: spec ${specRow.name}@${specRow.version} has no steps[]`,
        { specPath: input.specPath },
      );
    }

    // OPR.0.4.6.WF2 FR-3: THE v1 execution boundary (the slice-11
    // pattern). A REMOTE host pin is legal LANGUAGE (it validated
    // above) but fails loud HERE — the queue is local-only until MH-3
    // (cross-host queue routing); minting a qitem into a queue that
    // cannot route it, or silently running the step locally, are both
    // forbidden. Checked for EVERY step at instantiate (the earliest
    // knowable moment — a mid-run surprise would strand the instance).
    for (const step of specRow.spec.steps) {
      if (step.host && step.host !== "local") {
        throw new WorkflowProjectorError(
          "host_pin_remote_unsupported",
          `cannot instantiate: step "${step.id}" pins host "${step.host}". Remote-step execution requires MH-3 (cross-host queue routing), which has not shipped — the queue is local-only today. Workaround: run that step's seat on this host (host: local, or drop the pin), or wait for MH-3.`,
          { specPath: input.specPath, stepId: step.id, host: step.host, boundary: "MH-3" },
        );
      }
    }

    // OPR.0.4.6.FAC1 (AC-1) + arch ruling 2026-07-07 (target-rig
    // zero-regression, "Option A refined by PROVENANCE"): resolve the
    // instance's rig binding by SPLITTING on the provenance of the rig
    // name, because the two sources carry different intent:
    //
    //   - Operator `input.targetRig` (explicit `--rig X`) is AUTHORITATIVE:
    //     an explicit instantiation demand. Unknown X → `bound_rig_unknown`
    //     HARD-FAIL, loud, before any mutation (unchanged built behavior).
    //   - Spec-default `spec.target.rig` is ADVISORY: the spec author's
    //     default HINT, authored under the pre-FAC-1 regime where the field
    //     was IGNORED at runtime (display-only). Unknown → DEGRADE to
    //     UNBOUND + a LOUD advisory (not silent, not a hard-fail). This
    //     preserves AC-1 zero-regression for shipped/example specs (e.g.
    //     `conveyor` declares `target.rig: conveyor` AND routes every step
    //     via preferred_targets — degrading to unbound routes exactly as
    //     pre-FAC-1). A spec that genuinely needs a bound rig still fails
    //     loudly, per-step, at the right granularity (entry →
    //     `entry_owner_unresolved` at instantiate; later role-only step →
    //     `next_owner_unresolved` at projection). Nothing degrades to
    //     silence — it degrades to per-step honest failure with a heads-up.
    //   - Neither set → unbound (byte-identical today's behavior).
    //
    // name→id re-resolves fresh at each later resolution site, so a rig
    // vanishing mid-run fails loud there (WF-5 catches it).
    const registeredRigNames = (): string[] =>
      (this.db.prepare(`SELECT DISTINCT name FROM rigs ORDER BY name`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
    const rigIsRegistered = (name: string): boolean =>
      this.db.prepare(`SELECT id FROM rigs WHERE name = ? LIMIT 1`).get(name) !== undefined;

    const advisories: string[] = [];
    let boundRig: string | null;
    if (input.targetRig != null) {
      // AUTHORITATIVE path: honor the operator's explicit demand or fail loud.
      if (!rigIsRegistered(input.targetRig)) {
        const registered = registeredRigNames();
        throw new WorkflowProjectorError(
          "bound_rig_unknown",
          `cannot instantiate: target rig "${input.targetRig}" is not a registered rig on this daemon. Registered rigs: ${
            registered.length > 0 ? registered.join(", ") : "(none)"
          }. Check \`rig ps\`, create/import the rig first, or instantiate with a different --rig.`,
          { specPath: input.specPath, targetRig: input.targetRig, registeredRigs: registered },
        );
      }
      boundRig = input.targetRig;
    } else if (specRow.spec.target?.rig != null) {
      // ADVISORY path: the spec author's DEFAULT hint. Unknown → degrade
      // to unbound with a loud advisory (never a hard-fail on a default).
      const specDefaultRig = specRow.spec.target.rig;
      if (!rigIsRegistered(specDefaultRig)) {
        const registered = registeredRigNames();
        boundRig = null;
        advisories.push(
          `workflow spec default target.rig "${specDefaultRig}" is not a registered rig on this daemon — instantiating UNBOUND. ` +
            `Steps route via their declared preferred_targets; any role-only step (no preferred_targets) will fail per-role at the right time ` +
            `(entry at instantiate, later steps at projection). Pass --rig <name> to bind explicitly. ` +
            `Registered rigs: ${registered.length > 0 ? registered.join(", ") : "(none)"}.`,
        );
      } else {
        boundRig = specDefaultRig;
      }
    } else {
      boundRig = null;
    }

    // OPR.0.4.6.WF2 FR-2: static harness-pin reconciliation for EVERY
    // pinned step at instantiate (the earliest knowable moment against
    // current inventory); projection re-checks at each route (runtimes
    // can change mid-flight).
    //
    // OPR.0.4.6.FAC1 (ARCH Q2 = GUARD B1, binding): this eager loop
    // does NO live role resolution and RECORDS NOTHING. It keeps the
    // shipped harness/preferred-target reconciliation for steps whose
    // role DECLARES targets (spec-only facts — sound to check now); a
    // BOUND instance's role-only step (zero declared targets) is
    // deliberately SKIPPED here — a factory rig warms up, and that
    // step's liveness is its own projection-time concern where
    // loud-with-candidates + WF-5 own the failure. The structural
    // zero-role-coverage check below is the only instantiate-time
    // hard-fail for role-only steps. Unbound specs keep today's
    // behavior byte-identically (a pinned no-target step still fails
    // "(none declared)" at instantiate — nothing could ever resolve it).
    const runtimeOf = (session: string) => nodeRuntimeOf(this.db, session);
    const declaredTargetsOf = (roleName: string): number =>
      (specRow.spec.roles?.[roleName]?.preferred_targets ?? []).length;
    for (const step of specRow.spec.steps) {
      if (step.harness) {
        // rev1-r2 blocker fix: gated steps are NOT excluded — a pinned
        // gated step reconciles through its gate compile (human gates
        // resolve the step owner pin-aware; handler gates match the pin
        // against the handler role's targets). Both throw
        // harness_pin_unsatisfied when no candidate matches.
        if (step.gate) {
          const gateIsHuman = isHumanSeatSession(step.gate.target);
          const gateRoleTargets = gateIsHuman
            ? declaredTargetsOf(step.actor_role)
            : declaredTargetsOf(step.gate.target);
          if (boundRig !== null && gateRoleTargets === 0) continue; // role-only on a bound rig: projection resolves
          compileGate(specRow.spec, step, runtimeOf);
        } else if (!(step === entryStep && input.entryOwnerSession)) {
          if (boundRig !== null && declaredTargetsOf(step.actor_role) === 0) continue;
          resolveDefaultOwner(specRow.spec, step, runtimeOf);
        }
      }
    }

    // OPR.0.4.6.FAC1 (ARCH Q2): the STRUCTURAL role-coverage check for
    // a BOUND instance — hard-fail ONLY when a step's role (or a
    // handler-gate's target role) with zero declared preferred_targets
    // is declared by ZERO seats on the bound rig, at ANY lifecycle
    // state. Existence, not liveness: catches typos and missing role
    // attributes at instantiate WITHOUT eager live resolution. The
    // entry step is included — it resolves live below anyway, but a
    // structural miss reads better as this named error.
    if (boundRig !== null) {
      for (const step of specRow.spec.steps) {
        const rolesToCover: string[] = [];
        if (declaredTargetsOf(step.actor_role) === 0) rolesToCover.push(step.actor_role);
        if (step.gate && !isHumanSeatSession(step.gate.target) && declaredTargetsOf(step.gate.target) === 0) {
          rolesToCover.push(step.gate.target);
        }
        for (const roleName of rolesToCover) {
          if (!rigDeclaresRole(this.db, boundRig, roleName)) {
            throw new WorkflowProjectorError(
              "bound_rig_role_uncovered",
              `cannot instantiate: step "${step.id}" needs role "${roleName}" but NO seat on rig "${boundRig}" declares that role (at any lifecycle state). Add a member with role ${roleName} to rig ${boundRig} (rig add), declare role: ${roleName} on an existing member, or add preferred_targets to the role in the spec. (A declared-but-not-yet-running seat is fine — liveness is checked when the step projects.)`,
              { specPath: input.specPath, stepId: step.id, role: roleName, boundRig },
            );
          }
        }
      }
    }

    // OPR.0.4.6.FAC3 (FR-5): the member-exists instantiate ADVISORY —
    // catch a mis-routed destination (a typo'd/stale member on a rig
    // this daemon DOES know) loudly at the earliest knowable moment,
    // never silently orphaned. ADVISORY-NEVER-DENY: instantiate always
    // proceeds, and the queue transport gate stays rig-exists-only —
    // hardening it to member-exists would gate EVERY queue write and
    // break legitimate non-managed destinations (adopted seats, human
    // seats, MH-3-forwarded items). A read-only pre-txn pass over
    // spec-declared targets; sync SQL only.
    //
    // Scope = roles REFERENCED BY STEPS (actor_role + a handler gate's
    // target role — the same reference set the structural coverage
    // check above walks): the advisory must name a declaring step, and
    // an unreferenced role's targets never route. Skip order per the
    // queue-gate archetype: human-seat classifier BEFORE parse (the
    // identical predicate the transport uses) → non-canonical
    // (raw/adopted destinations are legitimate; the inventory cannot
    // vouch for them) → unregistered rig (the transport already rejects
    // those loudly at queue-write — no double advisory) → member probe
    // (existence at ANY lifecycle state/kind; liveness is projection's
    // business). ONE aggregated advisory per unique unknown target,
    // naming every declaring step/role pair.
    {
      const unknownTargets = new Map<
        string,
        { rig: string; declaredBy: Array<{ stepId: string; role: string }> }
      >();
      const seenPairs = new Set<string>();
      const probeRoleTargets = (roleName: string, stepId: string): void => {
        for (const target of specRow.spec.roles?.[roleName]?.preferred_targets ?? []) {
          if (isHumanSeatSession(target)) continue;
          const parsed = parseSessionName(target);
          if (parsed.kind !== "canonical") continue;
          if (!rigIsRegistered(parsed.rig)) continue;
          let memberExists: boolean;
          try {
            memberExists = rigMemberExists(this.db, parsed.rig, target);
          } catch {
            // ADVISORY-NEVER-THROW (VM-caught, run-1): the probe rides the
            // full inventory projection, which can error on a
            // partial-schema DB (e.g. a test fixture without the snapshots
            // table). A probe error means the inventory cannot vouch
            // EITHER way — skip silently; an advisory path must never be
            // able to fail the instantiate.
            continue;
          }
          if (memberExists) continue;
          const pairKey = JSON.stringify([target, stepId, roleName]);
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);
          const entry = unknownTargets.get(target) ?? { rig: parsed.rig, declaredBy: [] };
          entry.declaredBy.push({ stepId, role: roleName });
          unknownTargets.set(target, entry);
        }
      };
      for (const step of specRow.spec.steps) {
        probeRoleTargets(step.actor_role, step.id);
        if (step.gate && !isHumanSeatSession(step.gate.target)) {
          probeRoleTargets(step.gate.target, step.id);
        }
      }
      for (const [target, { rig, declaredBy }] of unknownTargets) {
        const declares = declaredBy
          .map((d) => `step "${d.stepId}" (role "${d.role}")`)
          .join(", ");
        advisories.push(
          `preferred target "${target}" names rig "${rig}" (registered) but NO member of that rig has this coordinate — declared by ${declares}. ` +
            `Work routed there will not be claimed; it will surface as a stuck exception. ` +
            `Check the member name against \`rig ps\`, or add the member to rig "${rig}".`,
        );
      }
    }

    // OPR.0.4.6.WF2 FR-5: a gated ENTRY step compiles to the gate item
    // (human-routed or handler-routed) and the instance parks waiting
    // from birth — same socket as a mid-flow gate.
    // OPR.0.4.6.FAC1 (ARCH Q2/call-site row 3): the ENTRY step gets
    // FULL live resolution at instantiate and is RECORDED — the entry
    // packet is actually created now (the first routing decision), so
    // this is resolve-once, not eager pre-resolution. A tier-3 failure
    // here re-throws under the entry error code, candidates preserved.
    const entryRoleCtx = roleResolutionContext(this.db, boundRig);
    let entryGate: GateCompileResult | null;
    let entryOwner: string | null;
    try {
      entryGate = entryStep.gate
        ? compileGate(specRow.spec, entryStep, runtimeOf, entryRoleCtx)
        : null;
      if (entryGate) {
        entryOwner = entryGate.destinationSession;
      } else if (input.entryOwnerSession) {
        reconcileExplicitOwnerHarness(entryStep, input.entryOwnerSession, runtimeOf);
        entryOwner = input.entryOwnerSession;
      } else {
        entryOwner = resolveDefaultOwner(specRow.spec, entryStep, runtimeOf, entryRoleCtx);
      }
    } catch (err) {
      if (err instanceof WorkflowProjectorError && err.code === "next_owner_unresolved") {
        // entry_owner_unresolved SPEAKS CANDIDATES: same structured
        // details, the entry site's error-code contract preserved.
        throw new WorkflowProjectorError(
          "entry_owner_unresolved",
          `cannot instantiate: ${err.message}`,
          { specPath: input.specPath, entryStepId: entryStep.id, entryRole: entryStep.actor_role, ...(err.details ?? {}) },
        );
      }
      throw err;
    }
    if (!entryOwner) {
      throw new WorkflowProjectorError(
        "entry_owner_unresolved",
        `cannot instantiate: entry step "${entryStep.id}" (role "${entryStep.actor_role}") has no preferred_targets and no entryOwnerSession was supplied`,
        { specPath: input.specPath, entryStepId: entryStep.id, entryRole: entryStep.actor_role },
      );
    }

    const createdAt = this.now().toISOString();
    let entryQitemId: string | undefined;
    let entryQitemDestinationSession: string | undefined;
    let entryQitemNudge: boolean | undefined;
    let instanceId: string | undefined;
    const persistedEvents: PersistedEvent[] = [];

    const txn = this.db.transaction(() => {
      const instance = this.instanceStore.create({
        workflowName: specRow.name,
        workflowVersion: specRow.version,
        createdBySession: input.createdBySession,
        initialFrontier: [],
        // R2 fix: set durable current_step_id at instantiate so the
        // projector resolves the correct step on the first project()
        // call without any trail-based inference.
        currentStepId: entryStep.id,
        // OPR.0.4.6.FAC1: the resolved rig binding persists with the
        // instance row (same txn as the entry packet).
        boundRig,
      });
      instanceId = instance.instanceId;

      // Create entry qitem in the same txn (gate-aware: a gated entry
      // rides the shipped human-route / handler-route write path).
      // OPR.0.4.6.WF5 FR-1 class (c) (guard code-review fold — the entry
      // twin of the projector's mid-flow stamp): a HUMAN-gated ENTRY
      // carries the class-(c) exception identity on the WF-2 item
      // itself, occurrence = the preallocated packet id. Handler-role
      // entries stay negative.
      const entryGateQitemId = entryGate ? newQitemId() : undefined;
      const entryGateException =
        entryGate && entryGateQitemId
          ? classifyGateTrip({
              workflowName: specRow.name,
              instanceId: instance.instanceId,
              gatedStepId: entryStep.id,
              gateKind: entryGate.kind,
              gatePacketId: entryGateQitemId,
              parkOn: entryGate.parkOn,
            })
          : null;
      const created = this.queueRepo.createWithinTransaction({
        qitemId: entryGateQitemId,
        sourceSession: input.createdBySession,
        destinationSession: entryOwner,
        body: workflowInstantiateBody({
          spec: specRow.spec,
          instanceId: instance.instanceId,
          entryStep,
          rootObjective: input.rootObjective,
          gate: entryGate,
        }),
        priority: "routine",
        tier: entryGate?.tier ?? "mode2",
        tags: [
          "workflow",
          entryGate ? "gate" : "entry",
          `workflow:${specRow.name}`,
          `instance:${instance.instanceId}`,
          ...(entryGateException ? workflowExceptionTags(entryGateException.identity).filter((t) => !t.startsWith("workflow:") && !t.startsWith("instance:")) : []),
        ],
        summary: entryGate?.summary ?? undefined,
        evidenceRef: entryGate?.evidenceRef ?? undefined,
      });
      entryQitemId = created.qitemId;
      entryQitemDestinationSession = created.destinationSession;
      entryQitemNudge = created.nudge;
      persistedEvents.push(created.persistedEvent);

      // OPR.0.4.6.WF2 FR-5 (guard blocker 1): a HUMAN-gated ENTRY parks
      // in the same txn — the leg-1 blocked_on human-seat shape the
      // shipped resolve verb acts on (same as the projector's mid-flow
      // gate park).
      if (entryGate?.parkOn) {
        const parked = this.queueRepo.updateWithinTransaction({
          qitemId: created.qitemId,
          actorSession: input.createdBySession,
          state: "blocked",
          closureReason: "blocked_on",
          closureTarget: entryGate.parkOn,
          blockedOn: entryGate.parkOn,
          transitionNote: `workflow gate: parked on ${entryGate.parkOn} pending sign-off`,
        });
        persistedEvents.push(parked.persistedEvent);
      }

      this.instanceStore.updateFrontier(instance.instanceId, [created.qitemId], entryGate ? "waiting" : "active", {
        // FR-5: guarded even here — the instance was created in this
        // txn at version 0; uniformity keeps every advance guarded.
        expectedVersion: instance.version,
      });

      // FR-3: arm the per-instance keepalive INSIDE the same txn that
      // creates the entry packet (covers commit-then-crash-before-nudge
      // from the very first step).
      if (this.watchdogJobsRepo) {
        ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
          instanceId: instance.instanceId,
          targetSession: entryOwner,
          registeredBySession: input.createdBySession,
        });
      }

      persistedEvents.push(
        this.eventBus.persistWithinTransaction({
          type: "workflow.instantiated",
          instanceId: instance.instanceId,
          workflowName: specRow.name,
          workflowVersion: specRow.version,
          createdBy: input.createdBySession,
        }),
      );
    });
    txn();

    for (const e of persistedEvents) this.eventBus.notifySubscribers(e);
    if (entryQitemId && entryQitemDestinationSession) {
      await this.queueRepo.maybeNudge(entryQitemId, entryQitemDestinationSession, entryQitemNudge);
    }

    const finalInstance = this.instanceStore.getByIdOrThrow(instanceId!);
    return {
      instance: finalInstance,
      spec: specRow,
      entryQitemId: entryQitemId!,
      entryOwnerSession: entryOwner,
      advisories,
    };
  }

  async project(input: ProjectStepInput): Promise<ProjectStepResult> {
    return this.projector.project(input);
  }

  /**
   * OPR.0.4.6.WF3 FR-4 — `route`: re-target the CURRENT FRONTIER step
   * of a live instance to a new owner. THE ADJUDICATED MECHANISM
   * (arch, formal, on the advance-authority ground): CLOSE + RECREATE
   * + FRONTIER REBIND in ONE scribe transaction. Revocation is
   * STRUCTURAL: the old packet leaves the frontier inside this txn, so
   * a zombie old owner's stale `project` hits the shipped
   * `packet_not_on_frontier` 409 — zero new validation machinery on
   * the hot advance path (the weighed-and-rejected alternative).
   *
   * The observable contract (PRD FR-4 (1)-(8)):
   *   (1) owner = target after route      (5) frontier non-dangling
   *   (2) current_step_id UNCHANGED       (6) additive event detail
   *   (3) actor+reason+old→new durable    (7) pin + version guard held
   *   (4) NO forged completion closure    (8) zombie structurally 409'd
   * Route is NOT an advance: hop_count does not bump (max_hops counts
   * steps, not re-targets); BR-3 — `project` stays the sole advance.
   */
  /**
   * OPR.0.4.6.WF5 FR-4 — RESUME from where it stopped (redrive
   * semantics, the one engine extension). One scribe transaction:
   * failed → active REBOUND to the failed step, a FRESH frontier packet
   * to the step's RE-RESOLVED owner, the trail preserved and extended
   * (completed steps never re-run), the livelock rail re-baselined
   * (hops-since-resume — exactly one more bounded window), the redrive
   * count recorded, open exception items for THIS occurrence closed
   * (resolve+resume closes the occurrence; a later re-failure is a NEW
   * occurrence), keepalive re-armed, additive workflow.resumed event.
   *
   * THE ARCH PIN (plan Rev-2, binding): the owner is RE-RESOLVED
   * through the SAME resolution path projection uses
   * (resolveDefaultOwner — preferred_targets + harness reconciliation),
   * NEVER copied from the closed packet's recorded destination: a dead
   * seat is a common CAUSE of the exception, and resume is the one
   * sanctioned re-resolution point (FAC-1 R1) the binding layer later
   * upgrades uniformly.
   */
  async resume(input: {
    instanceId: string;
    decision?: string;
    actorSession: string;
  }): Promise<{
    instanceId: string;
    stepId: string;
    newPacketId: string;
    ownerSession: string;
    resumeCount: number;
    exceptionItemsClosed: number;
  }> {
    const persistedEvents: PersistedEvent[] = [];
    let result!: {
      instanceId: string;
      stepId: string;
      newPacketId: string;
      ownerSession: string;
      resumeCount: number;
      exceptionItemsClosed: number;
    };
    let nudgeTo: { qitemId: string; session: string; nudge: boolean | undefined } | null = null;

    const txn = this.db.transaction(() => {
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      if (instance.status !== "failed") {
        throw new WorkflowProjectorError(
          "instance_not_failed",
          `instance ${instance.instanceId} is ${instance.status}; resume re-drives FAILED instances only (a waiting instance resumes via the shipped project path; an active instance needs no resume)` ,
          { instanceId: instance.instanceId, status: instance.status, expectedStatus: "failed" },
        );
      }
      const specRow = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
      if (!specRow) {
        throw new WorkflowProjectorError(
          "spec_not_cached",
          `workflow spec ${instance.workflowName}@${instance.workflowVersion} is not in the spec cache; re-run validate to refresh it before resuming`,
          { workflowName: instance.workflowName, workflowVersion: instance.workflowVersion },
        );
      }
      const spec = specRow.spec;
      const decision = (instance.lastContinuationDecision ?? {}) as {
        currentStep?: string;
        closedPacket?: string;
      };
      const failedStepId = decision.currentStep;
      const failedPacketId = decision.closedPacket;
      if (!failedStepId) {
        throw new WorkflowProjectorError(
          "resume_step_unrecoverable",
          `instance ${instance.instanceId} carries no recorded failed step (pre-R2 row without lastContinuationDecision.currentStep); cannot rebind — instantiate a fresh run`,
          { instanceId: instance.instanceId },
        );
      }
      const step = spec.steps.find((st) => st.id === failedStepId);
      if (!step) {
        throw new WorkflowProjectorError(
          "resume_step_missing_from_spec",
          `failed step "${failedStepId}" no longer exists in ${instance.workflowName}@${instance.workflowVersion}; fix the spec (the cached version is authoritative for in-flight instances) or instantiate a fresh run`,
          { instanceId: instance.instanceId, stepId: failedStepId },
        );
      }

      // THE ARCH PIN: re-resolve, never copy.
      // OPR.0.4.6.FAC1 (call-site row 5): resume is the ONE sanctioned
      // re-resolution point and now runs the full tier stack — a bound
      // instance's role-only failed step re-resolves capability-aware
      // against CURRENT inventory (a dead seat is a common CAUSE of the
      // exception; the redrive picks the seat that is eligible NOW).
      const owner = resolveDefaultOwner(
        spec,
        step,
        (session) => nodeRuntimeOf(this.db, session),
        roleResolutionContext(this.db, instance.boundRig),
      );
      if (!owner) {
        throw new WorkflowProjectorError(
          "next_owner_unresolved",
          `cannot resolve an owner for failed step "${step.id}" (role "${step.actor_role}"); add preferred_targets to the role before resuming`,
          { instanceId: instance.instanceId, stepId: step.id, role: step.actor_role },
        );
      }

      // Fresh frontier packet — the redrive delivery. The --decision
      // text lands durably in the packet body (the resumer’s
      // instruction reaches the step owner).
      const created = this.queueRepo.createWithinTransaction({
        sourceSession: input.actorSession,
        destinationSession: owner,
        body:
          `WORKFLOW RESUME (redrive)\n` +
          `workflow: ${instance.workflowName} v${instance.workflowVersion}\n` +
          `instance: ${instance.instanceId}\n` +
          `step: ${step.id} (role ${step.actor_role}) — re-driven from the recorded failure; completed steps are NOT re-run\n` +
          `resumed by: ${input.actorSession} (redrive #${(instance.resumeCount ?? 0) + 1})\n` +
          (input.decision ? `decision: ${input.decision}\n` : "") +
          `history: rig workflow trace ${instance.instanceId}`,
        priority: "routine",
        tier: "mode2",
        tags: [
          "workflow",
          "resume",
          `workflow:${instance.workflowName}`,
          `instance:${instance.instanceId}`,
        ],
        chainOfRecord: failedPacketId ? [failedPacketId] : undefined,
      });
      persistedEvents.push(created.persistedEvent);
      nudgeTo = { qitemId: created.qitemId, session: created.destinationSession, nudge: created.nudge };

      // Resolve+resume CLOSES the occurrence: open exception items for
      // THIS episode close honestly with resume provenance. A later
      // re-failure mints a NEW packet id = a NEW occurrence (never
      // hidden behind this resolved past).
      let exceptionItemsClosed = 0;
      if (failedPacketId) {
        const openItems = this.db
          .prepare(
            `SELECT qitem_id FROM queue_items
             WHERE state IN ('pending','in-progress','blocked')
               AND tags LIKE ? AND tags LIKE ?`,
          )
          .all(`%"occurrence:${failedPacketId}"%`, `%"workflow-exception"%`) as Array<{
          qitem_id: string;
        }>;
        for (const row of openItems) {
          const closedItem = this.queueRepo.updateWithinTransaction({
            qitemId: row.qitem_id,
            actorSession: input.actorSession,
            state: "done",
            closureReason: "no-follow-on",
            transitionNote: `workflow resume: occurrence resolved by ${input.actorSession} redriving step ${step.id}${input.decision ? ` — ${input.decision}` : ""}`,
          });
          persistedEvents.push(closedItem.persistedEvent);
          exceptionItemsClosed += 1;
        }
      }

      // Frontier rebind + status + THE LIVELOCK RAIL: hops_baseline =
      // hopCount at resume (one fresh bounded window under the same
      // max_hops), resume_count recorded, version guard held
      // (concurrent resumes: exactly one commits).
      this.instanceStore.updateFrontier(instance.instanceId, [created.qitemId], "active", {
        currentStepId: step.id,
        expectedVersion: instance.version,
        resumeStamp: {
          resumeCount: (instance.resumeCount ?? 0) + 1,
          hopsBaseline: instance.hopCount,
        },
      });

      // Keepalive re-arm for the redriven owner (in-txn, WF-1 FR-3).
      if (this.watchdogJobsRepo) {
        ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
          instanceId: instance.instanceId,
          targetSession: owner,
          registeredBySession: input.actorSession,
        });
      }

      persistedEvents.push(
        this.eventBus.persistWithinTransaction({
          type: "workflow.resumed",
          instanceId: instance.instanceId,
          workflowName: instance.workflowName,
          stepId: step.id,
          resumedBy: input.actorSession,
          decision: input.decision ?? null,
          resumeCount: (instance.resumeCount ?? 0) + 1,
        }),
      );

      result = {
        instanceId: instance.instanceId,
        stepId: step.id,
        newPacketId: created.qitemId,
        ownerSession: owner,
        resumeCount: (instance.resumeCount ?? 0) + 1,
        exceptionItemsClosed,
      };
    });
    txn();

    for (const e of persistedEvents) {
      this.eventBus.notifySubscribers(e);
    }
    // Closure-assignment cast (the shipped post-commit idiom): TS cannot
    // track the txn-closure write, so narrow via the cast.
    const resumeNudge = nudgeTo as { qitemId: string; session: string; nudge: boolean | undefined } | null;
    if (resumeNudge) {
      await this.queueRepo.maybeNudge(resumeNudge.qitemId, resumeNudge.session, resumeNudge.nudge);
    }
    return result;
  }

  async route(input: {
    instanceId: string;
    toSession: string;
    actorSession: string;
    reason?: string;
  }): Promise<{
    instanceId: string;
    stepId: string | null;
    closedPacketId: string;
    newPacketId: string;
    fromSession: string;
    toSession: string;
    instanceStatus: WorkflowInstance["status"];
  }> {
    const persistedEvents: PersistedEvent[] = [];
    let result!: {
      instanceId: string;
      stepId: string | null;
      closedPacketId: string;
      newPacketId: string;
      fromSession: string;
      toSession: string;
      instanceStatus: WorkflowInstance["status"];
    };
    let nudgeTo: { qitemId: string; session: string; nudge: boolean | undefined } | null = null;

    const txn = this.db.transaction(() => {
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      if (instance.status !== "active" && instance.status !== "waiting") {
        throw new WorkflowProjectorError(
          "instance_not_active",
          `instance ${instance.instanceId} is ${instance.status}; only a live (active|waiting) instance can be re-routed`,
          { instanceId: instance.instanceId, status: instance.status },
        );
      }
      const oldPacketId = instance.currentFrontier[0];
      if (!oldPacketId) {
        throw new WorkflowProjectorError(
          "packet_not_found",
          `instance ${instance.instanceId} has an empty frontier; nothing to re-route`,
          { instanceId: instance.instanceId },
        );
      }
      const oldPacket = this.queueRepo.getById(oldPacketId);
      if (!oldPacket) {
        throw new WorkflowProjectorError(
          "packet_not_found",
          `frontier packet ${oldPacketId} not found`,
          { instanceId: instance.instanceId, packetId: oldPacketId },
        );
      }
      const fromSession = oldPacket.destinationSession;

      // (7) harness pin: the SAME reconciliation the projector applies
      // to explicit --next-owner overrides — an explicit route target
      // never silently defeats a declared pin.
      const specRow = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
      const step =
        instance.currentStepId && specRow
          ? specRow.spec.steps.find((s) => s.id === instance.currentStepId) ?? null
          : null;
      if (step) {
        reconcileExplicitOwnerHarness(step, input.toSession, (session) =>
          nodeRuntimeOf(this.db, session),
        );
      }

      // (3)+(4) close the old packet HONESTLY: handed_off_to with full
      // provenance in the transition — never a forged completion.
      const closed = this.queueRepo.updateWithinTransaction({
        qitemId: oldPacketId,
        actorSession: input.actorSession,
        viaWorkflowVerb: true,
        state: "handed-off",
        closureReason: "handed_off_to",
        closureTarget: input.toSession,
        handedOffTo: input.toSession,
        transitionNote: `workflow route: ${input.actorSession} re-routed step ${instance.currentStepId ?? "?"} from ${fromSession} to ${input.toSession}${input.reason ? ` — ${input.reason}` : ""}`,
      });
      persistedEvents.push(closed.persistedEvent);

      // Recreate the SAME step for the new owner (step identity is the
      // work's continuity — the qitem id is a storage artifact of the
      // append-only design). chainOfRecord threads the lineage.
      // FULL-FIDELITY FIELD CARRY (rev1-r2 BLOCKING fold): the
      // successor IS the same work item, so it keeps the source
      // packet's priority/tier/summary/evidenceRef/targetRepo — a
      // human-gated packet (blocked on a human seat) MUST keep
      // summary + evidence_ref or the shipped human-park validator
      // rejects the repark below (human_route_fields_required) and
      // the waiting-on-human class — the one route most exists for —
      // becomes un-routable.
      const created = this.queueRepo.createWithinTransaction({
        sourceSession: input.actorSession,
        destinationSession: input.toSession,
        body: oldPacket.body,
        priority: oldPacket.priority ?? "routine",
        tier: oldPacket.tier ?? "mode2",
        // OPR.0.4.6.WF5 (rev1-r2 B1 fold): the successor IS the same work
        // item — tags carry VERBATIM (+ re-route) so a routed class-(c)
        // gate item keeps its exception identity on the live frontier
        // packet (workflow-exception/step:/exception:human_gate_trip/
        // occurrence:<ORIGINAL gate packet id> — the occurrence is the
        // EPISODE, which route does not end; chainOfRecord links the
        // packet lineage). The WF-3 full-fidelity-carry lesson, extended
        // to the tag dimension.
        tags: Array.from(
          new Set([
            ...(oldPacket.tags ?? []),
            "workflow",
            "re-route",
            `workflow:${instance.workflowName}`,
            `instance:${instance.instanceId}`,
          ]),
        ),
        chainOfRecord: [oldPacketId],
        summary: oldPacket.summary ?? undefined,
        evidenceRef: oldPacket.evidenceRef ?? undefined,
        targetRepo: oldPacket.targetRepo ?? undefined,
      });
      persistedEvents.push(created.persistedEvent);
      nudgeTo = { qitemId: created.qitemId, session: created.destinationSession, nudge: created.nudge };

      // A parked (waiting) frontier packet keeps its park on the
      // successor — route changes the owner, never the recorded state.
      // summary/evidenceRef passed explicitly too (belt + suspenders
      // with the create-side carry): validateHumanPark evaluates the
      // EFFECTIVE values, so a human park re-parks with its fields
      // intact instead of throwing human_route_fields_required.
      if (oldPacket.state === "blocked" && oldPacket.blockedOn) {
        const reparked = this.queueRepo.updateWithinTransaction({
          qitemId: created.qitemId,
          actorSession: input.actorSession,
          state: "blocked",
          closureReason: "blocked_on",
          closureTarget: oldPacket.blockedOn,
          blockedOn: oldPacket.blockedOn,
          summary: oldPacket.summary ?? undefined,
          evidenceRef: oldPacket.evidenceRef ?? undefined,
          transitionNote: `workflow route: park preserved (${oldPacket.blockedOn})`,
        });
        persistedEvents.push(reparked.persistedEvent);
      }

      // (2)+(5)+(7) frontier REBIND: same step, new packet, version
      // guard held; NO hop bump (not an advance).
      this.instanceStore.updateFrontier(instance.instanceId, [created.qitemId], instance.status, {
        currentStepId: "preserve",
        expectedVersion: instance.version,
      });

      // Keepalive re-target IN-TXN (arch n3: covers route's lost-nudge
      // window — the armed job re-nudges the new owner).
      if (this.watchdogJobsRepo) {
        disarmWorkflowKeepalive(
          this.watchdogJobsRepo,
          instance.instanceId,
          `workflow route: re-targeted to ${input.toSession}`,
        );
        ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
          instanceId: instance.instanceId,
          targetSession: input.toSession,
          registeredBySession: input.actorSession,
        });
      }

      // (6) the shipped event shape {rigName, cause} extended ADDITIVELY.
      persistedEvents.push(
        this.eventBus.persistWithinTransaction({
          type: "workflow.routing_table_changed",
          // OPR.0.4.6.FAC1 (display-only): the instance's actual bound
          // rig wins over the spec's default label.
          rigName: instance.boundRig ?? specRow?.targetRig ?? "",
          cause: "workflow_route",
          instanceId: instance.instanceId,
          stepId: instance.currentStepId,
          from: fromSession,
          to: input.toSession,
        }),
      );

      result = {
        instanceId: instance.instanceId,
        stepId: instance.currentStepId,
        closedPacketId: oldPacketId,
        newPacketId: created.qitemId,
        fromSession,
        toSession: input.toSession,
        instanceStatus: instance.status,
      };
    });
    txn();

    for (const e of persistedEvents) this.eventBus.notifySubscribers(e);
    if (nudgeTo) {
      const n = nudgeTo as { qitemId: string; session: string; nudge: boolean | undefined };
      await this.queueRepo.maybeNudge(n.qitemId, n.session, n.nudge, input.actorSession);
    }
    return result;
  }

  /**
   * Continue: idempotent inspector for the current frontier of an
   * instance. v1 is read-only — returns the current state. POC's
   * mechanical advance is folded into project() for v1; continue() is
   * the audit/inspect entrypoint.
   */
  continue(instanceId: string): {
    instance: WorkflowInstanceWithDeadline;
    trail: WorkflowStepTrailEntry[];
  } {
    const instance = this.instanceStore.getByIdOrThrow(instanceId);
    const trail = this.trailLog.listForInstance(instanceId);
    return { instance: this.withDeadline(instance), trail };
  }

  /**
   * OPR.0.4.6.WF1 FR-2 COMPLETION FIXBACK (build-vs-ratified-AC debt,
   * qitem-20260706211220-279039f5): the ratified FR-2 AC requires the
   * stuck classification to be "queryable via list/show/trace … with
   * the evidence (step, owner, deadline, age)". The merged WF-1 build
   * surfaced it only through the boot sweep + keepalive nudges; this
   * closes the queryability clause by deriving the SAME evaluator
   * verdict (one threshold home — workflow-deadline.ts) at read time.
   *
   * DERIVED, NEVER STORED: recomputed per read from (instance,
   * frontier packets, now) — a normal re-projection self-clears it,
   * exactly like every other evaluator consumer. Exposes the FULL
   * classification tuple (state + evidence{step, owner, anchor,
   * anchorAt, overdueBySeconds, ageSeconds}) so BOTH consumers (WF-3's
   * status rollup and WF-5's FR-3 ▲ source) read one shape — no
   * boolean flattening, no second path.
   */
  deadlineFor(instance: WorkflowInstance): WorkflowDeadlineVerdict {
    const packets = instance.currentFrontier
      .map((id) => this.queueRepo.getById(id))
      .filter((p): p is NonNullable<typeof p> => p != null);
    return evaluateStepDeadline(instance, packets, this.now());
  }

  /** The additive read enrichment consumed by list/show/trace routes. */
  withDeadline(instance: WorkflowInstance): WorkflowInstanceWithDeadline {
    return { ...instance, deadline: this.deadlineFor(instance) };
  }

  /** List instances (optionally filtered) with the deadline verdict attached. */
  listInstancesWithDeadline(
    status?: "active" | "waiting" | "completed" | "failed",
  ): WorkflowInstanceWithDeadline[] {
    const rows = status ? this.instanceStore.listByStatus(status) : this.instanceStore.listAll();
    return rows.map((row) => this.withDeadline(row));
  }
}

/** WorkflowInstance + the derived FR-2 deadline verdict (additive read shape). */
export type WorkflowInstanceWithDeadline = WorkflowInstance & {
  deadline: WorkflowDeadlineVerdict;
};

function workflowInstantiateBody(input: {
  spec: { id: string; version: string };
  instanceId: string;
  entryStep: { id: string; actor_role: string; objective?: string };
  rootObjective: string;
  gate?: GateCompileResult | null;
}): string {
  const lines = [
    `### Workflow entry: ${input.spec.id}@${input.spec.version} step ${input.entryStep.id}`,
    "",
    `Workflow instance: ${input.instanceId}`,
    `Entry step: ${input.entryStep.id} (${input.entryStep.actor_role})`,
    "",
    `Root objective: ${input.rootObjective}`,
  ];
  if (input.gate) {
    lines.push(
      "",
      `Gate: ${input.gate.kind === "human" ? "human sign-off" : "handler-role check"} — the workflow is PARKED (waiting) until this item is resolved/closed; the flow then continues from this step.`,
    );
    if (input.gate.summary) lines.push(`Ask: ${input.gate.summary}`);
    if (input.gate.evidenceRef) lines.push(`Evidence: ${input.gate.evidenceRef}`);
  }
  if (input.entryStep.objective) {
    lines.push("", `Step objective: ${input.entryStep.objective}`);
  }
  return lines.join("\n");
}

export {
  WorkflowInstanceError,
  WorkflowProjectorError,
  WorkflowSpecError,
};
