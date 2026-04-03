import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface WorkflowHeaderProps {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function WorkflowHeader({
  eyebrow,
  title,
  description,
  actions,
}: WorkflowHeaderProps) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">{eyebrow}</p>
        <h2 className="text-2xl font-bold uppercase tracking-[0.04em] text-stone-900 sm:text-3xl">{title}</h2>
        {description && (
          <p className="max-w-2xl text-base leading-8 text-stone-600">{description}</p>
        )}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

interface WorkflowStep {
  num: number;
  label: string;
}

interface WorkflowStepIndicatorProps {
  steps: readonly WorkflowStep[];
  currentStep: number;
  errorAtStep?: number;
  "data-testid"?: string;
}

export function WorkflowStepIndicator({
  steps,
  currentStep,
  errorAtStep = 0,
  "data-testid": testId,
}: WorkflowStepIndicatorProps) {
  const activeNum = errorAtStep || currentStep;

  return (
    <div
      className="flex flex-wrap items-center gap-2 sm:gap-3"
      data-testid={testId}
    >
      {steps.map((step, index) => {
        const isCompleted = activeNum > step.num;
        const isActive = activeNum === step.num;
        const isPending = activeNum < step.num;
        const state = isCompleted ? "done" : isActive ? "active" : "upcoming";

        return (
          <div key={step.num} className="flex items-center gap-2 sm:gap-3">
            <div
              data-testid={`step-${step.num}`}
              data-step-state={state}
              className={cn(
                "inline-flex min-h-0 items-center gap-2 border-b-2 px-1 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors",
                isCompleted && "border-primary/35 text-foreground-muted",
                isActive && "border-stone-900 text-foreground",
                isPending && "border-transparent text-foreground-muted/35",
              )}
            >
              <span className="text-[9px] tracking-[0.22em]">
                {isCompleted ? "\u2713 " : ""}
                {String(step.num).padStart(2, "0")}
              </span>
              <span className="text-[10px] leading-none tracking-[0.2em]">{step.label}</span>
            </div>
            {index < steps.length - 1 ? (
              <div
                aria-hidden="true"
                className={cn(
                  "h-px w-4 shrink-0 sm:w-6",
                  isCompleted ? "bg-primary/35" : "bg-stone-300/45",
                )}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface WorkflowSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export function WorkflowSection({
  title,
  description,
  children,
  className,
}: WorkflowSectionProps) {
  return (
    <section
      className={cn(
        "space-y-4 border border-stone-300/45 bg-[rgba(255,255,255,0.62)] p-5 shadow-[0_1px_0_rgba(255,255,255,0.95)_inset,0_10px_26px_rgba(34,34,24,0.035)] sm:p-6",
        className,
      )}
    >
      <div className="space-y-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">{title}</div>
        {description ? (
          <p className="text-base leading-8 text-stone-600">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function WorkflowSummaryGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

interface WorkflowSummaryCardProps {
  label: string;
  value: string | number;
  testId: string;
}

export function WorkflowSummaryCard({
  label,
  value,
  testId,
}: WorkflowSummaryCardProps) {
  return (
    <div className="border border-stone-300/35 bg-white/10 px-4 py-4">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-stone-500">{label}</div>
      <div data-testid={testId} className="mt-2 text-2xl font-semibold uppercase tracking-[0.04em] text-stone-900">
        {value}
      </div>
    </div>
  );
}

interface WorkflowCodePreviewProps {
  title: string;
  testId: string;
  children: ReactNode;
}

export function WorkflowCodePreview({
  title,
  testId,
  children,
}: WorkflowCodePreviewProps) {
  return (
    <WorkflowSection title={title}>
      <pre
        data-testid={testId}
        className="overflow-x-auto border border-stone-300/45 bg-white/75 p-4 text-xs leading-6 text-stone-800"
      >
        {children}
      </pre>
    </WorkflowSection>
  );
}
