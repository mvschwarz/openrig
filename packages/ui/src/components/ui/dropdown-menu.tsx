import * as React from "react";
import * as RadixDropdown from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

export const DropdownMenu = RadixDropdown.Root;
export const DropdownMenuTrigger = RadixDropdown.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: RadixDropdown.DropdownMenuContentProps): React.JSX.Element {
  return (
    <RadixDropdown.Portal>
      <RadixDropdown.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-[10rem] rounded-md border bg-popover p-1 shadow-md",
          className,
        )}
        {...props}
      />
    </RadixDropdown.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive = false,
  ...props
}: RadixDropdown.DropdownMenuItemProps & {
  destructive?: boolean;
}): React.JSX.Element {
  return (
    <RadixDropdown.Item
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-low",
        destructive && "text-destructive",
        className,
      )}
      {...props}
    />
  );
}

export const DropdownMenuSeparator: React.FC<{ className?: string }> = ({
  className,
}) => <RadixDropdown.Separator className={cn("my-1 h-px bg-outline-variant", className)} />;
