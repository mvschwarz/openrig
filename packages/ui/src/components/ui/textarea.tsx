import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full bg-background border border-ghost-border/50 px-4 py-3 text-base text-foreground placeholder:text-foreground-muted/40 transition-all duration-150 focus-visible:outline-none focus-visible:border-primary/40 focus-visible:shadow-[0_0_0_1px_hsl(var(--primary)/0.1)] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
