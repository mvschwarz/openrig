import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export type EmptyStateVariant = "minimal" | "card";

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface EmptyStateProps {
  icon?: React.ReactNode;
  label: string;
  /** Optional new-design title; falls back to `label` when omitted. */
  title?: string;
  description?: React.ReactNode;
  action?: EmptyStateAction;
  variant?: EmptyStateVariant;
  className?: string;
  testId?: string;
}

function ActionButton({ action, testId }: { action: EmptyStateAction; testId?: string }) {
  const actionTestId = testId ? `${testId}-action` : undefined;
  if (action.href) {
    return (
      <Button asChild size="sm">
        <a href={action.href} data-testid={actionTestId}>
          {action.label}
        </a>
      </Button>
    );
  }
  return (
    <Button size="sm" onClick={action.onClick} data-testid={actionTestId}>
      {action.label}
    </Button>
  );
}

export function EmptyState({
  icon,
  label,
  title,
  description,
  action,
  variant = "minimal",
  className,
  testId,
}: EmptyStateProps) {
  const body = (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-12 gap-2",
        className,
      )}
      data-testid={testId}
    >
      {icon ? (
        <div
          className="rounded-lg bg-surface-low p-3 text-on-surface-variant"
          aria-hidden="true"
        >
          {typeof icon === "string" ? <span className="text-2xl">{icon}</span> : icon}
        </div>
      ) : null}
      <div className="text-sm font-semibold text-on-surface">
        {title ?? label}
      </div>
      {description ? (
        <div className="text-sm text-on-surface-variant max-w-md">{description}</div>
      ) : null}
      {action ? (
        <div className="pt-2">
          <ActionButton action={action} testId={testId} />
        </div>
      ) : null}
    </div>
  );

  if (variant === "card") {
    return (
      <div className="rounded-lg border bg-surface-lowest shadow-sm">
        {body}
      </div>
    );
  }
  return body;
}
