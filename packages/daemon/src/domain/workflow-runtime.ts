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
import {
  WorkflowProjector,
  WorkflowProjectorError,
  type ProjectStepInput,
  type ProjectStepResult,
} from "./workflow-projector.js";
import { WorkflowSpecCache, WorkflowSpecError } from "./workflow-spec-cache.js";
import { WorkflowStepTrailLog } from "./workflow-step-trail-log.js";
import {
  type SeatLivenessCheckFn,
  type ValidationResult,
  WorkflowValidator,
} from "./workflow-validator.js";
import type { WorkflowInstance, WorkflowSpecRow, WorkflowStepTrailEntry } from "./workflow-types.js";

export interface WorkflowRuntimeDeps {
  db: Database.Database;
  eventBus: EventBus;
  queueRepo: QueueRepository;
  now?: () => Date;
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
}

export interface InstantiateResult {
  instance: WorkflowInstance;
  spec: WorkflowSpecRow;
  entryQitemId: string;
  entryOwnerSession: string;
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

  constructor(deps: WorkflowRuntimeDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.queueRepo = deps.queueRepo;
    this.now = deps.now ?? (() => new Date());
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
    );
  }

  validate(specPath: string, seatLivenessCheck?: SeatLivenessCheckFn): ValidationResult {
    const specRow = this.specCache.readThrough(specPath);
    return this.validator.validate(specRow.spec, seatLivenessCheck);
  }

  /**
   * Create a workflow instance + first-step qitem. The entry qitem is
   * created in the same transaction as the instance row; subscribers
   * see the workflow.instantiated + queue.created events together.
   */
  async instantiate(input: InstantiateInput): Promise<InstantiateResult> {
    const specRow = this.specCache.readThrough(input.specPath);
    const validation = this.validator.validate(specRow.spec);
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
    const entryRole = specRow.spec.roles?.[entryStep.actor_role];
    const entryOwner =
      input.entryOwnerSession ?? entryRole?.preferred_targets?.[0] ?? null;
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
      });
      instanceId = instance.instanceId;

      // Create entry qitem in the same txn.
      const created = this.queueRepo.createWithinTransaction({
        sourceSession: input.createdBySession,
        destinationSession: entryOwner,
        body: workflowInstantiateBody({
          spec: specRow.spec,
          instanceId: instance.instanceId,
          entryStep,
          rootObjective: input.rootObjective,
        }),
        priority: "routine",
        tier: "mode2",
        tags: ["workflow", "entry", `workflow:${specRow.name}`, `instance:${instance.instanceId}`],
      });
      entryQitemId = created.qitemId;
      entryQitemDestinationSession = created.destinationSession;
      entryQitemNudge = created.nudge;
      persistedEvents.push(created.persistedEvent);

      this.instanceStore.updateFrontier(instance.instanceId, [created.qitemId], "active");

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
    };
  }

  async project(input: ProjectStepInput): Promise<ProjectStepResult> {
    return this.projector.project(input);
  }

  /**
   * Continue: idempotent inspector for the current frontier of an
   * instance. v1 is read-only — returns the current state. POC's
   * mechanical advance is folded into project() for v1; continue() is
   * the audit/inspect entrypoint.
   */
  continue(instanceId: string): {
    instance: WorkflowInstance;
    trail: WorkflowStepTrailEntry[];
  } {
    const instance = this.instanceStore.getByIdOrThrow(instanceId);
    const trail = this.trailLog.listForInstance(instanceId);
    return { instance, trail };
  }
}

function workflowInstantiateBody(input: {
  spec: { id: string; version: string };
  instanceId: string;
  entryStep: { id: string; actor_role: string; objective?: string };
  rootObjective: string;
}): string {
  const lines = [
    `### Workflow entry: ${input.spec.id}@${input.spec.version} step ${input.entryStep.id}`,
    "",
    `Workflow instance: ${input.instanceId}`,
    `Entry step: ${input.entryStep.id} (${input.entryStep.actor_role})`,
    "",
    `Root objective: ${input.rootObjective}`,
  ];
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
