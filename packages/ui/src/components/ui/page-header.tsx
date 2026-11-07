import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  testId?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  meta,
  testId = "page-header",
}: PageHeaderProps): React.JSX.Element {
  return (
    <header data-testid={testId} className={cn("flex flex-wrap justify-between items-start gap-x-4 gap-y-3 pb-6")}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-on-surface">{title}</h1>
        {meta ? <div className="mt-1 flex flex-wrap items-center gap-2">{meta}</div> : null}
        {description ? (
          <p className="mt-1 text-sm text-on-surface-variant">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
