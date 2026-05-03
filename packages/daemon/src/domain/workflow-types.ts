// PL-004 Phase D: Workflow Runtime shared types.
//
// Reverse-engineered from POC `workflow-runtime-v0/lib/workflow-runtime.rb`
// and POC fixture YAMLs (`workflow-runtime-v0/tests/fixtures/*.yaml`).
//
// Phase D scope is the v1 minimum: spec parsing, instance creation,
// step projection, append-only step trail. Multi-hop chaining +
// gate-return-sweep + complex routing tables are graduations
// (per PRD § Risks "Workflow runtime over-engineered").

export type WorkflowExitKind = "handoff" | "waiting" | "done" | "failed";

export interface WorkflowRoleSpec {
  /** Skill identifiers that an agent in this role implements. */
  skill_refs?: string[];
  /** Operator-supplied preferred session targets for this role. */
  preferred_targets?: string[];
}

export interface WorkflowStepSpec {
  /** Stable step identifier within the workflow (e.g., "produce"). */
  id: string;
  /** Role name; resolved against `roles` map. */
  actor_role: string;
  /** Human description of the step's intent. */
  objective?: string;
  /** Allowed exit kinds for this step. Subset of WorkflowExitKind values. */
  allowed_exits?: WorkflowExitKind[];
  /** Next-hop hint structure (informs projection). */
  next_hop?: {
    mode?: "prefer" | "require" | "forbid";
    suggested_roles?: string[];
  };
  /** Named gates the step depends on (graduation; not enforced in v1). */
  gates?: string[];
}

export interface WorkflowInvariants {
  continuation_required?: boolean;
  allowed_exits?: WorkflowExitKind[];
  preserve_lineage?: boolean;
  closure_required?: boolean;
}

export interface WorkflowClosureMessages {
  success?: string;
  degraded?: string;
  failed?: string;
}

export interface WorkflowLoopGuards {
  /** Maximum total step transitions an instance may execute. */
  max_hops?: number;
  /** Maximum number of dynamically-spawned sub-instances. */
  spawn_budget?: number;
}

export interface WorkflowSpec {
  id: string;
  version: string;
  objective?: string;
  target?: { rig?: string };
  entry?: { role?: string };
  roles: Record<string, WorkflowRoleSpec>;
  steps: WorkflowStepSpec[];
  invariants?: WorkflowInvariants;
  closure?: WorkflowClosureMessages;
  loop_guards?: WorkflowLoopGuards;
  /** Coordination terminal-turn rule; defaults to "hot_potato". */
  coordination_terminal_turn_rule?: string;
}

export type WorkflowInstanceStatus = "active" | "waiting" | "completed" | "failed";

export interface WorkflowInstance {
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  createdBySession: string;
  createdAt: string;
  status: WorkflowInstanceStatus;
  /** qitem_ids that are currently active step packets. */
  currentFrontier: string[];
  /**
   * R2 fix: durable current-step binding (which step the active
   * frontier packet represents). Set on instantiate (entry step) and
   * on handoff (next step). Cleared on terminal closure. Read by
   * WorkflowProjector instead of inferring from trail order — fixes
   * the waiting-resume "skip a step" bug. v1 supports a single active
   * frontier packet.
   */
  currentStepId: string | null;
  hopCount: number;
  fallbackSynthesis: string | null;
  lastContinuationDecision: Record<string, unknown> | null;
  completedAt: string | null;
}

export interface WorkflowStepTrailEntry {
  trailId: string;
  instanceId: string;
  stepId: string;
  stepRole: string;
  closedAt: string;
  closureReason: WorkflowExitKind;
  closureEvidence: Record<string, unknown> | null;
  actorSession: string;
  nextQitemId: string | null;
  priorQitemId: string;
}

export interface WorkflowSpecRow {
  specId: string;
  name: string;
  version: string;
  purpose: string | null;
  targetRig: string | null;
  spec: WorkflowSpec;
  coordinationTerminalTurnRule: string;
  sourcePath: string;
  sourceHash: string;
  cachedAt: string;
}
