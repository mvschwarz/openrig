import * as React from "react";
import { cn } from "@/lib/utils";

export interface VellumSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  testId?: string;
  children?: React.ReactNode;
}

export const VellumSelect = React.forwardRef<HTMLSelectElement, VellumSelectProps>(
  ({ className, testId, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        data-testid={testId}
        className={cn(
          "block w-full border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-xs text-on-surface",
          "hover:bg-background focus:border-on-surface focus:bg-surface-lowest focus:outline-none",
          "disabled:bg-surface-low disabled:text-on-surface-variant disabled:cursor-not-allowed",
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);
VellumSelect.displayName = "VellumSelect";
