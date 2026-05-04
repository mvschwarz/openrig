// PL-019: shared activity-state visual mapping. Used by both RigNode (graph
// dot) and Explorer (tree-row icon) so the operator sees one consistent
// palette across surfaces. Design guidance from orch (2026-05-04):
//
//   running     warm green/teal static + very subtle slow pulse
//   needs_input amber, the one state that catches the eye
//   idle        calm cool static (blue-gray), no motion
//   unknown     desaturated gray, no motion
//
// startupStatus (failed / attention_required) is a separate signal and stays
// surfaced via the existing ATTN/FAILED badges on RigNode — activity color
// answers "is this agent working?", startup color answers "did this agent
// boot?". They are not the same question.

import type { AgentActivitySummary } from "../hooks/useNodeInventory.js";

export type ActivityState = "running" | "needs_input" | "idle" | "unknown";

const ACTIVITY_LABELS: Record<ActivityState, string> = {
  running: "running",
  needs_input: "needs input",
  idle: "idle",
  unknown: "unknown",
};

// Tailwind utility classes — chosen to fit the existing stone/emerald
// palette already in use across RigNode and Explorer rather than adding a
// new brand. running uses emerald-500 (warm green); needs_input uses
// amber-500 (the eye-catcher); idle uses slate-400 (cool blue-gray); unknown
// uses stone-300 (desaturated, ignorable).
const ACTIVITY_BG_CLASSES: Record<ActivityState, string> = {
  running: "bg-emerald-500",
  needs_input: "bg-amber-500",
  idle: "bg-slate-400",
  unknown: "bg-stone-300",
};

const ACTIVITY_TEXT_CLASSES: Record<ActivityState, string> = {
  running: "text-emerald-600",
  needs_input: "text-amber-600",
  idle: "text-slate-500",
  unknown: "text-stone-400",
};

export function getActivityState(activity: AgentActivitySummary | null | undefined): ActivityState {
  if (!activity) return "unknown";
  return activity.state;
}

export function getActivityLabel(state: ActivityState): string {
  return ACTIVITY_LABELS[state];
}

export function getActivityBgClass(state: ActivityState): string {
  return ACTIVITY_BG_CLASSES[state];
}

export function getActivityTextClass(state: ActivityState): string {
  return ACTIVITY_TEXT_CLASSES[state];
}

// Subtle slow pulse for running (~2s cycle, low-amplitude opacity). Only
// running animates; needs_input gets a static stronger color (the brief is
// explicit that needs_input is the one that catches the eye, but we keep it
// non-flashing so it doesn't compete with itself).
export function getActivityAnimationClass(state: ActivityState): string {
  if (state === "running") return "activity-pulse-running";
  return "";
}

// Staleness badge threshold: anything beyond ~30s of staleness gets a small
// muted indicator, since stale activity samples can mislead. Driver picks
// the threshold; PL-019 plans for ~30s as the operator-perceptible boundary.
const STALENESS_THRESHOLD_SECONDS = 30;

export function isActivityStale(activity: AgentActivitySummary | null | undefined): boolean {
  if (!activity) return false;
  // staleness may not be wired by every probe path; fall back to delta from
  // sampledAt if it is missing.
  if (typeof activity.staleness === "number") {
    return activity.staleness > STALENESS_THRESHOLD_SECONDS;
  }
  if (!activity.sampledAt) return false;
  const sampled = Date.parse(activity.sampledAt);
  if (Number.isNaN(sampled)) return false;
  const ageSeconds = (Date.now() - sampled) / 1000;
  return ageSeconds > STALENESS_THRESHOLD_SECONDS;
}

// Short ULID tail for hover hints. Full id stays available in the drawer.
export function shortQitemTail(qitemId: string): string {
  if (qitemId.length <= 8) return qitemId;
  return qitemId.slice(-8);
}
