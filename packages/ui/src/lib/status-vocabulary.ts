export type StatusTone = "success" | "running" | "warning" | "danger" | "info" | "neutral";

export interface StatusPresentation {
  tone: StatusTone;
  label: string;
}

/** Map any raw OpenRig state string to one tone + one sentence-case label. */
export function presentStatus(raw: string | null | undefined): StatusPresentation {
  const key = (raw ?? "").trim().toLowerCase();
  if (!key) return { tone: "neutral", label: "Unknown" };
  const hit = TABLE[key];
  if (hit) return hit;
  const label = key.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  return { tone: "neutral", label };
}

export const TABLE: Record<string, StatusPresentation> = {
  running: { tone: "running", label: "Running" },
  active: { tone: "running", label: "Active" },
  ready: { tone: "success", label: "Ready" },
  done: { tone: "success", label: "Done" },
  shipped: { tone: "success", label: "Shipped" },
  clean: { tone: "success", label: "Healthy" },
  partial: { tone: "warning", label: "Partly running" },
  degraded: { tone: "warning", label: "Degraded" },
  recoverable: { tone: "warning", label: "Recoverable" },
  pending: { tone: "info", label: "Starting" },
  draft: { tone: "neutral", label: "Draft" },
  idle: { tone: "neutral", label: "Idle" },
  stopped: { tone: "neutral", label: "Stopped" },
  blocked: { tone: "danger", label: "Blocked" },
  failed: { tone: "danger", label: "Failed" },
  error: { tone: "danger", label: "Error" },
  attention_required: { tone: "danger", label: "Needs attention" },
  "needs-input": { tone: "danger", label: "Needs input" },
  needs_input: { tone: "danger", label: "Needs input" },
  unknown: { tone: "neutral", label: "Unknown" },
};

export const TONE_CLASSES: Record<StatusTone, { dot: string; badge: string }> = {
  success: { dot: "bg-success", badge: "bg-success/10 text-success" },
  running: {
    dot: "bg-success animate-pulse motion-reduce:animate-none",
    badge: "bg-success/10 text-success",
  },
  warning: { dot: "bg-warning", badge: "bg-warning/15 text-on-surface" },
  danger: { dot: "bg-destructive", badge: "bg-destructive/10 text-destructive" },
  info: { dot: "bg-brand", badge: "bg-brand/10 text-brand" },
  neutral: { dot: "bg-outline", badge: "bg-surface-mid text-on-surface-variant" },
};
