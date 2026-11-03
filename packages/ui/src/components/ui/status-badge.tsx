import * as React from "react";
import { cn } from "@/lib/utils";
import { presentStatus, TONE_CLASSES } from "@/lib/status-vocabulary";

export interface StatusBadgeProps {
  status: string | null | undefined;
  label?: string;
  className?: string;
  testId?: string;
}

export function StatusBadge({ status, label, className, testId }: StatusBadgeProps): React.JSX.Element {
  const presented = presentStatus(status);
  const tone = TONE_CLASSES[presented.tone];
  return (
    <span
      data-testid={testId}
      data-tone={presented.tone}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        tone.badge,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} aria-hidden="true" />
      {label ?? presented.label}
    </span>
  );
}

export interface StatusDotProps {
  status: string | null | undefined;
  className?: string;
  title?: string;
}

export function StatusDot({ status, className, title }: StatusDotProps): React.JSX.Element {
  const presented = presentStatus(status);
  const tone = TONE_CLASSES[presented.tone];
  return (
    <span
      role="img"
      aria-label={presented.label}
      title={title ?? presented.label}
      data-tone={presented.tone}
      className={cn("inline-block h-2 w-2 rounded-full", tone.dot, className)}
    />
  );
}
