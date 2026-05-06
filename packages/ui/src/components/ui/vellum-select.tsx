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
          "block w-full border border-stone-300 bg-white px-2 py-1 font-mono text-xs text-stone-900",
          "hover:bg-stone-50 focus:border-stone-900 focus:bg-white focus:outline-none",
          "disabled:bg-stone-100 disabled:text-stone-400 disabled:cursor-not-allowed",
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
