import type { WorkflowStepSpec } from "./workflow-types.js";

/** Gate packets retain their own summaries; call this only for ordinary packets. */
export function workflowRunSummary(title: string | null | undefined, step: WorkflowStepSpec): string | undefined {
  return title ? `${title} — ${step.label ?? step.id}` : undefined;
}
