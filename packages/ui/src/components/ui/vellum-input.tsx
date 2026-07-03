import * as React from "react";
import { cn } from "@/lib/utils";

export interface VellumInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  testId?: string;
}

export const VellumInput = React.forwardRef<HTMLInputElement, VellumInputProps>(
  ({ className, testId, ...props }, ref) => {
    return (
      <input
        ref={ref}
        data-testid={testId}
        className={cn(
          "block w-full border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-xs text-on-surface",
          "hover:bg-background focus:border-on-surface focus:bg-surface-lowest focus:outline-none",
          "disabled:bg-surface-low disabled:text-on-surface-variant disabled:cursor-not-allowed",
          className,
        )}
        {...props}
      />
    );
  },
);
VellumInput.displayName = "VellumInput";
