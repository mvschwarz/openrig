import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <div className={cn("animate-pulse rounded-md bg-surface-mid", className)} />;
}
