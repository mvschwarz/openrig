// Slice 09 — recommended per-mode defaults + per-mode default scope.
//
// Component 3 — Recommended Per-Mode Defaults (the 6×7 matrix).
// Component 4 — Recommended Default Scopes Per Mode.
//
// "RECOMMENDED, operator-overridable per field" — these are the
// fall-back values the CLI / HTTP set route applies when the operator
// invokes a bare mode (e.g., `rig policy set debug`) without
// specifying individual fields. Operator-supplied per-field overrides
// merge over the defaults.

import type {
  AutonomyScope,
  ConcurrencyLimit,
  EscalationThreshold,
  HeartbeatCadence,
  InspectionDepth,
  OperatorContextMode,
  OperatorContextScope,
  PermissionPromptPosture,
  UpdateDetail,
} from "./rig-policy-types.js";

/**
 * The seven per-mode setting defaults (Component 3 §Recommended
 * Per-Mode Defaults). Mirrors the convention table verbatim.
 *
 * `scope` is NOT included here — per-mode default scope lives in
 * RECOMMENDED_DEFAULT_SCOPE below, since the convention treats it
 * separately (Component 4 §Recommended Default Scopes Per Mode).
 *
 * `expiry_or_stale_rule` and `evidence_citation` are not part of the
 * 6×7 matrix; the daemon applies a conservative default for the
 * former (`re_confirm_on_long_gap` — convention Q3 leaves the numeric
 * for Mode 2; the rule kind is the v0 conservative choice) and the
 * latter is operator-provided per invocation.
 */
export interface RecommendedModeDefaults {
  autonomy_scope: AutonomyScope;
  heartbeat_cadence: HeartbeatCadence;
  inspection_depth: InspectionDepth;
  update_detail: UpdateDetail;
  escalation_threshold: EscalationThreshold;
  concurrency_limit: ConcurrencyLimit;
  permission_prompt_posture: PermissionPromptPosture;
}

export const RECOMMENDED_MODE_DEFAULTS: Record<OperatorContextMode, RecommendedModeDefaults> = {
  sleep: {
    autonomy_scope: "pre_approved_only",
    heartbeat_cadence: "sparse",
    inspection_depth: "normal",
    update_detail: "compact",
    escalation_threshold: "blocker_only",
    concurrency_limit: "serial",
    permission_prompt_posture: "batch_for_human",
  },
  desk: {
    autonomy_scope: "full_autonomy_within_workstream",
    heartbeat_cadence: "normal",
    inspection_depth: "normal",
    update_detail: "normal",
    escalation_threshold: "normal",
    concurrency_limit: "unlimited", // "normal" in the convention table; v0 maps "normal" concurrency to unlimited (the existing OpenRig default — agents fan out per workstream-mode discipline)
    permission_prompt_posture: "normal",
  },
  mobile: {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "normal",
    inspection_depth: "surface",
    update_detail: "compact",
    escalation_threshold: "low",
    concurrency_limit: "unlimited",
    permission_prompt_posture: "batch_for_human",
  },
  away: {
    autonomy_scope: "pre_approved_only",
    heartbeat_cadence: "sparse",
    inspection_depth: "normal",
    update_detail: "compact",
    escalation_threshold: "blocker_only",
    concurrency_limit: "serial",
    permission_prompt_posture: "batch_for_human",
  },
  focus: {
    autonomy_scope: "full_autonomy_within_workstream",
    heartbeat_cadence: "normal",
    inspection_depth: "normal",
    update_detail: "compact",
    escalation_threshold: "blocker_only",
    concurrency_limit: "unlimited",
    permission_prompt_posture: "batch_for_human",
  },
  debug: {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "fast",
    inspection_depth: "forensic",
    update_detail: "verbose",
    escalation_threshold: "low",
    concurrency_limit: "serial",
    permission_prompt_posture: "normal",
  },
};

/**
 * Component 4 — Recommended Default Scopes Per Mode.
 *
 * Used during restate-and-confirm: when the operator's invocation
 * omits an explicit scope, the agent restates with this recommendation
 * and awaits confirmation/correction. The operator's confirmation is
 * authoritative.
 */
export const RECOMMENDED_DEFAULT_SCOPE: Record<OperatorContextMode, OperatorContextScope> = {
  sleep: "global_host",
  away: "global_host",
  desk: "global_host",
  mobile: "global_host",
  focus: "workstream",
  debug: "qitem",
};

/**
 * Conservative default for `expiry_or_stale_rule`. Per convention Q3,
 * the numeric threshold is deferred to a Mode 2 helper slice;
 * `re_confirm_on_long_gap` is the rule kind selected here as the
 * safest default (it prompts re-confirmation rather than silent
 * continuation when the operator has been away for an extended
 * period).
 *
 * Operators may override per-binding via the `expiry_or_stale_rule`
 * field of the OperatorContextModeRecord; v0 does not auto-tune the
 * threshold.
 */
export const DEFAULT_STALE_RULE: "re_confirm_on_long_gap" = "re_confirm_on_long_gap";
