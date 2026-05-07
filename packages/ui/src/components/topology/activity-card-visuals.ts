import type { ActivityState } from "../../lib/activity-visuals.js";
import type { ActivityFlash, ActivityRingState, TopologyActivityVisual } from "../../lib/topology-activity.js";
import { cn } from "../../lib/utils.js";

export function fallbackActivityCardState(activityState: ActivityState): ActivityRingState {
  if (activityState === "running") return "active";
  if (activityState === "needs_input") return "needs_input";
  return "idle";
}

export function getActivityCardSignal(input: {
  activityRing?: TopologyActivityVisual | null;
  activityState: ActivityState;
}): { state: ActivityRingState; flash: ActivityFlash } {
  return {
    state: input.activityRing?.state ?? fallbackActivityCardState(input.activityState),
    flash: input.activityRing?.flash ?? null,
  };
}

export function getActivityCardClasses(input: {
  state: ActivityRingState;
  flash?: ActivityFlash;
  reducedMotion?: boolean;
}): string {
  return cn(
    "activity-card-surface",
    input.state === "active" && "activity-card-active",
    input.state === "needs_input" && "activity-card-needs-input",
    input.state === "blocked" && "activity-card-blocked",
    input.flash === "source" && "activity-card-source-flash",
    input.flash === "target" && "activity-card-target-flash",
    input.reducedMotion && "activity-card-reduced-motion",
  );
}
