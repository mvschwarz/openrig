/**
 * Maps restore node result status to Tailwind text color class.
 * These are DIFFERENT from node runtime statuses (running/idle/exited/detached).
 * Restore statuses: resumed, checkpoint_written, fresh_no_checkpoint, failed.
 */
export function getRestoreStatusColorClass(status: string): string {
  switch (status) {
    case "resumed":
      return "text-primary";
    case "checkpoint_written":
      return "text-primary";
    case "fresh_no_checkpoint":
      return "text-foreground-muted";
    case "failed":
      return "text-destructive";
    default:
      return "text-foreground-muted";
  }
}
