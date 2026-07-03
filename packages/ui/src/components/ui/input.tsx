import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-11 w-full border border-outline-variant/55 bg-surface-lowest/85 px-4 py-2 text-base text-foreground placeholder:text-foreground-muted/60 transition-colors duration-150 focus-visible:outline-none focus-visible:border-on-surface/35 focus-visible:ring-2 focus-visible:ring-on-surface/10 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
