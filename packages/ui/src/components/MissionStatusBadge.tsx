// V1 attempt-3 Phase 3 — MissionStatusBadge per project-tree.md L132–L133 (SC-26).
//
// Status derives from `PROGRESS.md`
// frontmatter or top-level `status:` field. No daemon work; matches the
// file-system-as-truth pattern OpenRig uses for slices and missions.
// V1 takes the status as an externally-provided prop (caller resolves
// from PROGRESS.md via a dedicated hook in Phase 3+ or daemon-side
// later); renders the badge.

import * as React from "react";
import { cn } from "../lib/utils.js";

export type MissionStatus =
  | "active"
  | "paused"
  | "shipped"
  | "blocked"
  | "unknown";

export interface MissionStatusBadgeProps {
  status: MissionStatus;
  label?: string;
  className?: string;
  testId?: string;
}

const toneClass: Record<MissionStatus, string> = {
  active: "border-success text-success",
  paused: "border-stone-400 text-stone-500",
  shipped: "border-secondary text-secondary",
  blocked: "border-warning text-warning",
  unknown: "border-stone-300 text-stone-400",
};

const toneDot: Record<MissionStatus, string> = {
  active: "bg-success",
  paused: "bg-stone-400",
  shipped: "bg-secondary",
  blocked: "bg-warning",
  unknown: "bg-stone-300",
};

export function MissionStatusBadge({
  status,
  label,
  className,
  testId,
}: MissionStatusBadgeProps) {
  return (
    <span
      data-testid={testId ?? `mission-status-${status}`}
      role="status"
      aria-label={label ?? status}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 border font-mono text-[9px] uppercase tracking-wide",
        toneClass[status],
        className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", toneDot[status])} aria-hidden="true" />
      {label ?? status}
    </span>
  );
}

/**
 * Parse a mission `status:` field from PROGRESS.md frontmatter content.
 * Returns "unknown" if the file content can't be parsed or no status
 * field is found. Per project-tree.md L132–L133 — the source of truth
 * for mission status is the PROGRESS.md frontmatter.
 */
export function parseMissionStatus(progressMdContent: string | null | undefined): MissionStatus {
  if (!progressMdContent) return "unknown";
  // Match a YAML frontmatter status field at the top of the file.
  const fmMatch = progressMdContent.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch?.[1] ?? progressMdContent;
  const statusMatch = frontmatter.match(/^\s*status:\s*([a-z_-]+)\s*$/im);
  const raw = statusMatch?.[1]?.toLowerCase() ?? "";
  if (raw === "active" || raw === "in_progress" || raw === "in-progress")
    return "active";
  if (raw === "paused" || raw === "on_hold" || raw === "on-hold") return "paused";
  if (raw === "shipped" || raw === "complete" || raw === "completed" || raw === "done")
    return "shipped";
  if (raw === "blocked" || raw === "stalled") return "blocked";
  return "unknown";
}
