import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full border border-outline-variant/55 bg-surface-lowest/85 px-4 py-3 text-base text-on-surface font-mono placeholder:text-on-surface-variant transition-all duration-150 focus-visible:outline-none focus-visible:border-on-surface/35 focus-visible:ring-2 focus-visible:ring-on-surface/10 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
