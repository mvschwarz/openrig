import * as React from "react";
import { cn } from "@/lib/utils";

export function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className={cn("rounded border bg-surface-low px-1.5 font-mono text-[11px] text-on-surface-variant")}>
      {children}
    </kbd>
  );
}
