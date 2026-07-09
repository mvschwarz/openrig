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

/** OPR.0.4.6.WF2 FR-1: the closed v1 branch-key set — exactly the recorded
 *  exit enum. Growth ONLY via the step-declared-outcome-enums rail (PRD §6
 *  named deferral); never free-text, identity, or opaque evidence JSON. */
export const WORKFLOW_EXIT_KINDS = ["handoff", "waiting", "done", "failed"] as const;

/** OPR.0.4.6.WF2 FR-2: the pinnable harness value space — AGENT harnesses
 *  only. `terminal` is deliberately excluded (a terminal node is not an
 *  agent harness); Pi Agent joins in 0.4.7 as a value-space extension. */
export const WORKFLOW_AGENT_HARNESSES = ["claude-code", "codex"] as const;
export type WorkflowAgentHarness = (typeof WORKFLOW_AGENT_HARNESSES)[number];

/** OPR.0.4.6.WF2 FR-5: the structured step-level gate declaration (singular
 *  per step; arch-RULED shape — supersedes the removed `gates[]` string
 *  list). WF-2 owns the field + validation + compilation to the SHIPPED
 *  0.4.4 gate primitives; WF-5 owns gate SEMANTICS (trip conditions,
 *  escalation policy). Target kinds: a human seat session (compiles to the
 *  human-routed write path w/ summary + evidence_ref) or a declared role
 *  name (compiles to an ordinary agent-routed item to that role's seat). */
export interface WorkflowGateSpec {
  /** A human seat session (`human@kernel` form) or a declared role name. */
  target: string;
  /** Plain-language summary carried on the gate item. REQUIRED for a
   *  human target (the shipped human-route write path enforces it). */
  summary?: string;
  /** Durable evidence pointer (rides queue_items.evidence_ref, migration
   *  048). REQUIRED for a human target. */
  evidence_ref?: string;
}

export interface WorkflowRoleSpec {
  /** Skill identifiers that an agent in this role implements.
   *  DISPOSITION (WF-1 FR-9): explicitly-v2 — documentation-only;
   *  owner resolution uses preferred_targets. Validator advisory
   *  `declared_not_enforced_v1` on use. */
  skill_refs?: string[];
  /** Operator-supplied preferred session targets for this role.
   *  CONSUMED: resolveDefaultOwner / entry-owner resolution. */
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
  /** Next-hop hint structure (informs projection).
   *  OPR.0.4.6.WF2 FR-4: `mode: prefer` is REMOVED from the value space
   *  (it never had distinct behavior — identical to omitting mode); the
   *  parser rejects it with a what/why/fix migration error. */
  next_hop?: {
    mode?: "require" | "forbid";
    suggested_roles?: string[];
    /** OPR.0.4.6.WF2 FR-1: conditional-on-outcome branching — recorded
     *  exit → successor step id. Keys are the closed exit enum ONLY
     *  (BR-1 branch purity). A MAPPED exit routes to its target inside
     *  the same scribe transaction (instance stays ACTIVE); unmapped
     *  exits keep today's terminal/park behavior exactly. */
    on?: Partial<Record<WorkflowExitKind, string>>;
  };
  /** OPR.0.4.6.WF2 FR-2: pin this step to an agent harness. Owner
   *  resolution picks the first preferred_target whose node runtime
   *  matches; no match = structured routing failure (never a silent
   *  mis-route). Absent = today's preferred_targets[0] exactly. */
  harness?: WorkflowAgentHarness;
  /** OPR.0.4.6.WF2 FR-3: pin this step to a host — "local" (or absent:
   *  full execution today) or a registered hosts.yaml id. A REMOTE pin
   *  validates as language but fails loud at instantiate with the MH-3
   *  boundary error (cross-host queue routing does not exist yet);
   *  never a silent local fallback. */
  host?: string;
  /** OPR.0.4.6.WF2 FR-5: the singular structured gate declaration —
   *  see WorkflowGateSpec. Replaces the removed `gates?: string[]`. */
  gate?: WorkflowGateSpec;
}

export interface WorkflowInvariants {
  /** DISPOSITION (WF-1 FR-9): explicitly-v2 — gates nothing today.
   *  Validator advisory `declared_not_enforced_v1` on use. */
  continuation_required?: boolean;
  /** CONSUMED: projector allowed_exits enforcement (validator
   *  subset-checks step allowed_exits against this). */
  allowed_exits?: WorkflowExitKind[];
  /** DISPOSITION (WF-1 FR-9): explicitly-v2 — lineage IS always
   *  preserved via chain_of_record regardless; the flag gates
   *  nothing. Advisory on use. */
  preserve_lineage?: boolean;
  /** DISPOSITION (WF-1 FR-9): explicitly-v2 — closure IS always
   *  required by the hot-potato contract; the flag gates nothing.
   *  Advisory on use. */
  closure_required?: boolean;
}

/** DISPOSITION (WF-1 FR-9): explicitly-v2 — display-only messages,
 *  no consumer renders them yet. Advisory on use. */
export interface WorkflowClosureMessages {
  success?: string;
  degraded?: string;
  failed?: string;
}

export interface WorkflowLoopGuards {
  /** Maximum total step transitions an instance may execute.
   *  ENFORCED (WF-1 FR-6): compared at projection against the
   *  effective baseline (v1 baseline = 0); exceeding it fails the
   *  instance honestly with the guard named. Also sanctions cycles
   *  at validation (FR-7). */
  max_hops?: number;
  /** Maximum number of dynamically-spawned sub-instances.
   *  DISPOSITION (WF-1 FR-9, arch-RULED): explicitly-v2 — no
   *  spawn/fan-out seam exists in the single-frontier model;
   *  enforcement is a NAMED acceptance item of the WF-2/WF-6
   *  parallel-frontier fan-out work. Advisory on use. */
  spawn_budget?: number;
}

/** OPR.0.4.6.WF5 FR-2: the maturity-dial position value space (closed).
 *  `orchestrator` = the item routes to the declared orchestrator role's
 *  resolved seat (the v1.3 founder default); `human_only` = the item
 *  routes to the human seat FIRST and gates there (the orchestrator
 *  never auto-acts). */
export const WORKFLOW_EXCEPTION_DIAL_POSITIONS = ["orchestrator", "human_only"] as const;
export type WorkflowExceptionDialPosition = (typeof WORKFLOW_EXCEPTION_DIAL_POSITIONS)[number];

/** OPR.0.4.6.WF5 FR-2: the spec-declared exception routing (the dial's
 *  per-workflow / per-class config surface — the previously-deferred
 *  spec-declared target, UN-deferred by the v1.3 inversion). ROUTING
 *  config only: FR-1's detection classes are untouched by any value
 *  here. Absent entirely = the host-default → orchestrator-first chain. */
export interface WorkflowExceptionRoutingSpec {
  /** Per-workflow dial position (chain link 2). */
  default?: WorkflowExceptionDialPosition;
  /** The declared orchestrator ROLE (chain link 3's input) — resolved
   *  through the SAME shipped role→preferred_targets mechanism step
   *  owners use. Must name a declared role (validator graph check). */
  orchestrator_role?: string;
  /** Per-exception-class overrides (chain link 1). Keys are the closed
   *  FR-1 class set; `human_gate_trip` is intrinsically human-only and
   *  not configurable (parse-rejected). */
  classes?: Record<string, WorkflowExceptionDialPosition>;
}

export interface WorkflowSpec {
  id: string;
  version: string;
  objective?: string;
  /**
   * OPR.0.4.6.FAC1: `target.rig` is a DEFAULT, not a hardcode — the
   * instantiate-time `targetRig` param overrides it, and the effective
   * binding persists on the instance (`WorkflowInstance.boundRig`).
   * No routing path reads this field at runtime (display/label
   * surfaces only); it is kept, never removed/deprecated here.
   */
  target?: { rig?: string };
  entry?: { role?: string };
  roles: Record<string, WorkflowRoleSpec>;
  steps: WorkflowStepSpec[];
  invariants?: WorkflowInvariants;
  closure?: WorkflowClosureMessages;
  loop_guards?: WorkflowLoopGuards;
  /** OPR.0.4.6.WF5 FR-2: the maturity dial — see WorkflowExceptionRoutingSpec. */
  exception_routing?: WorkflowExceptionRoutingSpec;
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
  /** DISPOSITION (WF-1 FR-9): explicitly-v2 — an instance column no
   *  code path ever writes (always null); reserved for the POC's
   *  fallback-synthesis graduation. Not a spec key (not parseable),
   *  so no validator advisory — this JSDoc is its disposition. */
  fallbackSynthesis: string | null;
  lastContinuationDecision: Record<string, unknown> | null;
  completedAt: string | null;
  /**
   * OPR.0.4.6.WF1 FR-5: optimistic-concurrency version (migration 049).
   * Bumped by every guarded advance; a stale writer's UPDATE matches
   * zero rows and throws `instance_version_conflict` (whole txn rolls
   * back). Absorbed waiting-replays bump NOTHING (zero writes).
   */
  version: number;
  /**
   * OPR.0.4.6.WF5 FR-4 (migration 051): the recorded redrive count —
   * a first-class fact (the Step Functions redriveCount shape), never
   * inferred from the trail.
   */
  resumeCount: number;
  /**
   * OPR.0.4.6.WF5 FR-4 (migration 051): the LIVELOCK RAIL — max_hops
   * bounds each DRIVE: the projection guard compares hops accrued
   * since the LATEST instantiate (0) or resume (hopCount at resume).
   */
  hopsBaseline: number;
  /**
   * OPR.0.4.6.FAC1 (migration 052): the rig NAME this instance is
   * bound to — `targetRig ?? spec.target.rig ?? null` recorded at
   * instantiate. Role-capability resolution (tier 3) runs against
   * this rig's inventory; name→id resolves FRESH at each resolution
   * site. null = unbound = pre-FAC-1 behavior byte-identical.
   */
  boundRig: string | null;
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
