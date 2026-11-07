import * as React from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export interface MetricTileProps {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  to?: string;
  testId?: string;
}

export function MetricTile({
  label,
  value,
  sublabel,
  icon: Icon,
  to,
  testId,
}: MetricTileProps): React.JSX.Element {
  const body = (
    <>
      {Icon ? <Icon className="h-4 w-4 text-on-surface-variant" /> : null}
      <div className="text-sm font-medium text-on-surface-variant">{label}</div>
      <div className="text-3xl font-semibold tabular-nums text-on-surface">{value}</div>
      {sublabel ? (
        <div className="text-xs text-on-surface-variant">{sublabel}</div>
      ) : null}
    </>
  );
  const cls = cn(
    "rounded-lg border bg-surface-lowest shadow-sm p-4 flex flex-col gap-1",
    to && "hover:bg-surface-low",
  );
  if (to) {
    return (
      <Link to={to} data-testid={testId} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <div data-testid={testId} className={cls}>
      {body}
    </div>
  );
}
