import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import type { ActivityRingState, ActivityFlash } from "../../lib/topology-activity.js";

interface ActivityRingProps {
  as?: "div" | "span";
  state: ActivityRingState;
  flash?: ActivityFlash;
  reducedMotion?: boolean;
  children: ReactNode;
  className?: string;
  ringClassName?: string;
  testId?: string;
}

const STATE_CLASS: Record<Exclude<ActivityRingState, "idle">, string> = {
  active: "border-emerald-500/70 shadow-[0_0_0_1px_rgba(16,185,129,0.10)]",
  needs_input: "border-amber-500/80 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]",
  blocked: "border-red-600/80 shadow-[0_0_0_1px_rgba(220,38,38,0.16)]",
};

const MOTION_CLASS: Record<Exclude<ActivityRingState, "idle">, string> = {
  active: "activity-ring-active",
  needs_input: "activity-ring-needs-input",
  blocked: "activity-ring-blocked",
};

export function ActivityRing({
  as = "div",
  state,
  flash = null,
  reducedMotion = false,
  children,
  className,
  ringClassName,
  testId,
}: ActivityRingProps) {
  const Component = as;
  return (
    <Component className={cn("relative", as === "span" ? "inline-flex" : "block", className)}>
      {state !== "idle" ? (
        <span
          aria-hidden="true"
          data-testid={testId}
          data-activity-ring-state={state}
          data-activity-flash={flash ?? "none"}
          data-reduced-motion={reducedMotion ? "true" : "false"}
          className={cn(
            "pointer-events-none absolute -inset-1 rounded-[inherit] border",
            STATE_CLASS[state],
            !reducedMotion && MOTION_CLASS[state],
            flash === "source" && "activity-ring-source-flash",
            flash === "target" && "activity-ring-target-flash",
            ringClassName,
          )}
        />
      ) : null}
      {children}
    </Component>
  );
}
