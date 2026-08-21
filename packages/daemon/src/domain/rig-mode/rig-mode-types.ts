// Slice 09 — Rig Policy Primitive (OPR.0.3.2.9).
//
// Typed graduation of the operator-context-mode-system v0 doctrine. The
// convention at conventions/operator-context-mode-system/README.md is
// the FROZEN spec; types below mirror it as closed enums + a 10-field
// schema. None of these fields may be silently merged or dropped — the
// validator enforces field-set integrity.
//
// GATE-ZERO (HG-SAFE): this primitive is permission-ADJACENT but NEVER
// permission-modifying. `permission_prompt_posture` is a descriptive
// operator-set ergonomic hint. The enum below is STRUCTURALLY
// incapable of expressing auto-accept: there is no auto-accept member
// in the union, and the validator further rejects unknown values. Any
// future contributor who tries to add an auto-accept value here MUST
// also amend the permission-posture convention + safety policy in the
// FROZEN contract — review will reject otherwise.

/**
 * Component 2 — six reserved mode names. Lowercase single English
 * words; synonyms and numeric aliases (`L0`–`L3`, `operator:L<n>`)
 * are explicitly forbidden by the convention. The L0–L3 collision
 * warning at `conventions/operator-context-mode-system/README.md`
 * §"L0–L3 Collision Warning" is load-bearing.
 */
export type OperatorContextMode = "sleep" | "desk" | "mobile" | "away" | "focus" | "debug";

export const OPERATOR_CONTEXT_MODES = [
  "sleep",
  "desk",
  "mobile",
  "away",
  "focus",
  "debug",
] as const satisfies readonly OperatorContextMode[];

/**
 * Component 4 — four scopes. More-specific overrides less-specific
 * when multiple modes coexist (Scope hierarchy: qitem > workstream >
 * rig > global_host).
 */
export type OperatorContextScope = "global_host" | "rig" | "workstream" | "qitem";

export const OPERATOR_CONTEXT_SCOPES = [
  "global_host",
  "rig",
  "workstream",
  "qitem",
] as const satisfies readonly OperatorContextScope[];

/**
 * Scope specificity ranks; higher number = more specific. Used by the
 * store's effective-mode resolver. NOT operator-facing.
 */
export const SCOPE_SPECIFICITY: Record<OperatorContextScope, number> = {
  global_host: 0,
  rig: 1,
  workstream: 2,
  qitem: 3,
};

// --- 10-field schema enums ---

export type AutonomyScope =
  | "pre_approved_only"
  | "bounded_continuation"
  | "full_autonomy_within_workstream"
  | "full_autonomy";

export type HeartbeatCadence = "sparse" | "normal" | "fast";

export type InspectionDepth = "surface" | "normal" | "forensic";

export type UpdateDetail = "compact" | "normal" | "verbose";

export type EscalationThreshold = "low" | "normal" | "high" | "blocker_only";

/**
 * Component 3 — concurrency_limit. Suggested values include the enum
 * forms below + structured integer values (1..N). v0 ships the enum
 * subset for simplicity; an integer specialization can graduate via
 * Mode 1.5 amendment when fixture-backed evidence appears.
 */
export type ConcurrencyLimit = "serial" | "2" | "4" | "unlimited";

/**
 * Component 6 — Safety Policy load-bearing rule:
 *   `permission_prompt_posture` MUST NOT include auto-accept in v0 or
 *   any descendant. The safe values are exactly these three.
 *
 * The enum is STRUCTURALLY closed: no auto-accept literal exists in
 * the union. A contributor cannot "set permissionPromptPosture =
 * 'auto_accept'" because the literal isn't a member; TypeScript
 * rejects at compile time. The validator additionally rejects any
 * non-member string at runtime (defense-in-depth for inputs that
 * bypass typing — JSON file, env var, etc).
 *
 * If a future amendment proposes auto-accept, it MUST first amend
 * the permission-posture canon at
 * `conventions/permission-posture/README.md` AND the FROZEN
 * operator-context-mode safety policy. This slice and its
 * descendants reject auto-accept independently of any caller intent.
 */
export type PermissionPromptPosture =
  | "normal"
  | "batch_for_human"
  | "do_not_prompt_unless_blocked";

export const SAFE_PERMISSION_PROMPT_POSTURES = [
  "normal",
  "batch_for_human",
  "do_not_prompt_unless_blocked",
] as const satisfies readonly PermissionPromptPosture[];

/**
 * Component 4 — citation source. Free-text in v0 (operator may cite
 * `current-mode.md`, a qitem id, a chatroom topic, or a convention-only
 * declaration). Structured citations are a Mode 1.5 amendment per
 * the convention.
 */
export type EvidenceCitation = string;

/**
 * Component 4 — expiry_or_stale_rule. v0 declares the field with a
 * conservative default ("re_confirm_on_long_gap"); the numeric
 * threshold is deferred per convention Q3 to a Mode 2 helper slice.
 * The rule values below enumerate the supported re-confirmation
 * triggers. NO silent-switch value exists — drift is always a
 * question, never an auto-mode-change.
 */
export type ExpiryOrStaleRule =
  | "none"
  | "re_confirm_on_long_gap"
  | "re_confirm_on_day_boundary"
  | "re_confirm_on_observed_conflict";

export const STALE_RULES = [
  "none",
  "re_confirm_on_long_gap",
  "re_confirm_on_day_boundary",
  "re_confirm_on_observed_conflict",
] as const satisfies readonly ExpiryOrStaleRule[];

/**
 * Component 3 — the 10-field SETTINGS schema. ALL fields are required
 * by the validator; none may be merged or dropped. Reviewer field-set
 * integrity check (HG-2).
 *
 * **`mode` is NOT in this record.** Mode is the binding's identity
 * (Component 2 — the name of the named bundle); the record parameterizes
 * how that named mode shapes ergonomics. The binding wrapper
 * (OperatorContextModeBinding) carries `mode` at the top level so the
 * frozen 10-field settings record stays exactly 10 fields, as declared
 * by the convention's §Component 3 table.
 */
export interface OperatorContextModeRecord {
  autonomy_scope: AutonomyScope;
  heartbeat_cadence: HeartbeatCadence;
  inspection_depth: InspectionDepth;
  update_detail: UpdateDetail;
  escalation_threshold: EscalationThreshold;
  concurrency_limit: ConcurrencyLimit;
  permission_prompt_posture: PermissionPromptPosture;
  scope: OperatorContextScope;
  expiry_or_stale_rule: ExpiryOrStaleRule;
  evidence_citation: EvidenceCitation;
}

/**
 * A scoped binding of a mode to a target context. The store keys rows
 * by (scope, qualifier) so the same scope can hold many bindings
 * (e.g., multiple rig-scoped modes), and the effective-mode resolver
 * picks the right one for the (rig, workstream, qitem) read context.
 *
 * - `global_host` bindings have a null qualifier.
 * - `rig` bindings carry the rig id as qualifier.
 * - `workstream` bindings carry the workstream id as qualifier.
 * - `qitem` bindings carry the qitem id as qualifier.
 */
export interface OperatorContextModeBinding {
  /** Stable identifier — `${scope}:${qualifier ?? "host"}` v0. */
  id: string;
  /** Component 2 — the named mode this binding selects. Lives at the
   *  binding (not in the 10-field settings record) so the frozen
   *  Component-3 record stays exactly 10 fields. */
  mode: OperatorContextMode;
  record: OperatorContextModeRecord;
  /** Qualifier value (rigId, workstreamId, qitemId) — null when scope is global_host. */
  qualifier: string | null;
  /** ISO timestamp of last set. Used by drift-rule consumers. */
  setAt: string;
  /** Who set it. Operator-only by contract — see update authority. */
  setBy: "operator";
}

/**
 * The effective-mode read result. The resolver returns the most
 * specific binding for a (rig?, workstream?, qitem?) context, or
 * `null` when no binding exists at any matching scope.
 *
 * Per convention §"Q6 — Absent mode is unknown_posture, NOT desk":
 * callers MUST treat a null effective mode as `unknown_posture` and
 * re-confirm to a real mode explicitly. The resolver does NOT default
 * to `desk` and never invents a binding.
 */
export interface EffectiveOperatorContextMode {
  binding: OperatorContextModeBinding;
  /** Why this binding won (which scope; for debug + UI surfacing). */
  resolvedScope: OperatorContextScope;
}

/**
 * Read context for the resolver. All fields optional; the resolver
 * picks the most-specific applicable binding.
 */
export interface OperatorContextReadContext {
  rigId?: string;
  workstreamId?: string;
  qitemId?: string;
}
