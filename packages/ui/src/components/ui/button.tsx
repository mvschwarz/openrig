import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors duration-150 ease-tactical focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-inverse-surface text-background font-headline font-bold uppercase tracking-widest hover:bg-inverse-surface",
        destructive:
          "bg-tertiary text-white font-bold hover:bg-tertiary/90",
        outline:
          "border border-outline bg-transparent hover:bg-surface-low text-on-surface",
        secondary:
          "border border-on-surface bg-transparent text-on-surface font-mono text-[10px] uppercase hover:bg-inverse-surface hover:text-background",
        ghost: "text-on-surface-variant hover:bg-surface-low hover:text-on-surface",
        link: "text-secondary underline-offset-4 hover:underline",
        tactical:
          "border border-outline font-mono text-[10px] text-secondary uppercase tracking-widest hover:border-on-surface hover:text-on-surface",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3",
        lg: "h-11 px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      >
        {children}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
