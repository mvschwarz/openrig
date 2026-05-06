import * as React from "react";
import { cn } from "@/lib/utils";

export type StatusPipStatus =
  | "active"
  | "running"
  | "stopped"
  | "warning"
  | "error"
  | "info";

export type StatusPipVariant = "dot" | "pill";

export interface StatusPipProps {
  status: StatusPipStatus;
  label?: string;
  variant?: StatusPipVariant;
  className?: string;
  testId?: string;
}

const toneDot: Record<StatusPipStatus, string> = {
  active: "bg-success",
  running: "bg-success",
  stopped: "bg-stone-400",
  warning: "bg-warning",
  error: "bg-tertiary",
  info: "bg-secondary",
};

const tonePill: Record<StatusPipStatus, string> = {
  active: "border-success text-success",
  running: "border-success text-success",
  stopped: "border-stone-400 text-stone-500",
  warning: "border-warning text-warning",
  error: "border-tertiary text-tertiary",
  info: "border-secondary text-secondary",
};

export function StatusPip({
  status,
  label,
  variant = "dot",
  className,
  testId,
}: StatusPipProps) {
  if (variant === "pill") {
    return (
      <span
        data-testid={testId}
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 border font-mono text-[9px] uppercase tracking-wide",
          tonePill[status],
          className,
        )}
        role="status"
        aria-label={label ?? status}
      >
        <span className={cn("w-1.5 h-1.5 rounded-full", toneDot[status])} aria-hidden="true" />
        {label ?? status}
      </span>
    );
  }
  return (
    <span
      data-testid={testId}
      className={cn("inline-flex items-center gap-1.5", className)}
      role="status"
      aria-label={label ?? status}
    >
      <span className={cn("w-2 h-2 rounded-full", toneDot[status])} aria-hidden="true" />
      {label ? (
        <span className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">
          {label}
        </span>
      ) : null}
    </span>
  );
}
