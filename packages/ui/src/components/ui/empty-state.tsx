import * as React from "react";
import { cn } from "@/lib/utils";
import { VellumCard } from "./vellum-card";

export type EmptyStateVariant = "minimal" | "card";

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface EmptyStateProps {
  icon?: React.ReactNode;
  label: string;
  description?: React.ReactNode;
  action?: EmptyStateAction;
  variant?: EmptyStateVariant;
  className?: string;
  testId?: string;
}

function ActionButton({ action, testId }: { action: EmptyStateAction; testId?: string }) {
  const cls =
    "inline-flex items-center px-3 py-1 border border-on-surface bg-surface-lowest font-mono text-[10px] uppercase hover:bg-surface-low";
  if (action.href) {
    return (
      <a href={action.href} className={cls} data-testid={testId ? `${testId}-action` : undefined}>
        {action.label}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={action.onClick}
      className={cls}
      data-testid={testId ? `${testId}-action` : undefined}
    >
      {action.label}
    </button>
  );
}

export function EmptyState({
  icon,
  label,
  description,
  action,
  variant = "minimal",
  className,
  testId,
}: EmptyStateProps) {
  const body = (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center p-6 gap-2",
        className,
      )}
      data-testid={testId}
    >
      {icon ? (
        <div className="text-on-surface-variant" aria-hidden="true">
          {typeof icon === "string" ? <span className="text-2xl">{icon}</span> : icon}
        </div>
      ) : null}
      <div className="font-headline font-bold uppercase text-on-surface text-sm tracking-tight">
        {label}
      </div>
      {description ? (
        <div className="text-xs text-on-surface-variant max-w-prose">{description}</div>
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
      <VellumCard variant="ghost" elevation="flat" registrationMarks={false}>
        {body}
      </VellumCard>
    );
  }
  return body;
}
