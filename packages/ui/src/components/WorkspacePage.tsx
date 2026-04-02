import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface WorkspacePageProps {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}

export function WorkspacePage({ children, className, innerClassName }: WorkspacePageProps) {
  return (
    <div
      data-testid="workspace-page"
      className={cn(
        "w-full flex-1 overflow-y-auto lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]",
        className,
      )}
    >
      <div
        data-testid="workspace-page-inner"
        className={cn(
          "mx-auto w-full max-w-[960px] px-4 py-6 sm:px-6 sm:py-8 md:px-8 lg:px-10",
          innerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
