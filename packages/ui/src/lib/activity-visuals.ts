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

import type { AgentActivitySummary, SeatIdentityVerdictSummary } from "../hooks/useNodeInventory.js";

export type ActivityState = "running" | "needs_input" | "idle" | "unknown";

/**
 * OPR.0.4.3.19 — a liveness identity verdict of `mismatch`/`pane_missing`
 * down-ranks the seat away from any active/running rendering (the process in
 * the pane is not the registered seat: dead, orphaned, or squatted).
 * `verified`, `tmux_unavailable`, and an absent verdict leave the projection
 * unchanged. Mirrors the daemon `identityVerdictDownranksRunning` gate so the
 * backend and the UI agree on what "no false-green" means.
 */
export function identityVerdictDownranksRunning(
  verdict: SeatIdentityVerdictSummary | null | undefined,
): boolean {
  return verdict?.verdict === "mismatch" || verdict?.verdict === "pane_missing";
}

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

export type ActivitySource = "hook" | "terminal_activity" | "pane_heuristic" | "none";

export interface ActivityStateResult {
  state: ActivityState;
  source: ActivitySource;
}

export function getActivityState(
  activity: AgentActivitySummary | null | undefined,
  terminalActive?: boolean | null,
  identityVerdict?: SeatIdentityVerdictSummary | null,
): ActivityState {
  return getActivityStateWithSource(activity, terminalActive, identityVerdict).state;
}

export function getActivityStateWithSource(
  activity: AgentActivitySummary | null | undefined,
  terminalActive?: boolean | null,
  identityVerdict?: SeatIdentityVerdictSummary | null,
): ActivityStateResult {
  // OPR.0.4.3.19 — the identity verdict overrides output-derived activity. A
  // mismatched/dead pane must NEVER render active/running, even when the
  // (orphan's) tmux output makes terminalActive true — that was the visible
  // false-green. Checked FIRST, before hook/terminal-activity signals.
  if (identityVerdictDownranksRunning(identityVerdict)) {
    return { state: "needs_input", source: "none" };
  }

  const isFreshHook = activity
    && activity.evidenceSource === "runtime_hook"
    && activity.state !== "unknown"
    && !activity.stale
    && !activity.fallback;

  if (isFreshHook) {
    return { state: activity!.state, source: "hook" };
  }
  if (activity?.state === "needs_input" && activity.evidenceSource === "pane_heuristic") {
    return { state: "needs_input", source: "pane_heuristic" };
  }
  if (terminalActive === true) return { state: "running", source: "terminal_activity" };
  if (terminalActive === false) return { state: "idle", source: "terminal_activity" };
  if (activity && activity.state !== "unknown" && activity.evidenceSource === "pane_heuristic") {
    return { state: activity.state, source: "pane_heuristic" };
  }
  if (activity && activity.state !== "unknown") {
    return { state: activity.state, source: "none" };
  }
  return { state: "unknown", source: "none" };
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

export function getTimeInState(activity: AgentActivitySummary | null | undefined): { seconds: number; label: string } | null {
  if (!activity) return null;
  const ts = activity.eventAt ?? activity.sampledAt;
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  return { seconds, label: formatDuration(seconds) };
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function isHookGradeNeedsInput(result: ActivityStateResult): boolean {
  return result.state === "needs_input" && result.source === "hook";
}

export interface ActivityRollup {
  working: number;
  idle: number;
  needsInput: number;
  needsInputHookGrade: number;
  unknown: number;
  total: number;
}

export function computeActivityRollup(
  items: Array<{ activity: AgentActivitySummary | null | undefined; terminalActive?: boolean | null }>,
): ActivityRollup {
  const rollup: ActivityRollup = { working: 0, idle: 0, needsInput: 0, needsInputHookGrade: 0, unknown: 0, total: items.length };
  for (const item of items) {
    const result = getActivityStateWithSource(item.activity, item.terminalActive);
    switch (result.state) {
      case "running": rollup.working++; break;
      case "idle": rollup.idle++; break;
      case "needs_input":
        rollup.needsInput++;
        if (result.source === "hook") rollup.needsInputHookGrade++;
        break;
      case "unknown": rollup.unknown++; break;
    }
  }
  return rollup;
}

export function formatRollupLabel(rollup: ActivityRollup): string {
  const parts: string[] = [];
  if (rollup.working > 0) parts.push(`${rollup.working} working`);
  if (rollup.idle > 0) parts.push(`${rollup.idle} idle`);
  if (rollup.needsInputHookGrade > 0) parts.push(`${rollup.needsInputHookGrade} needs you`);
  const paneNeedsInput = rollup.needsInput - rollup.needsInputHookGrade;
  if (paneNeedsInput > 0) parts.push(`${paneNeedsInput} needs input (activity-grade)`);
  if (rollup.unknown > 0) parts.push(`${rollup.unknown} unknown`);
  return parts.join(" · ") || "no seats";
}
