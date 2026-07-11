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

// VM-005 (release-0.4.7): "unknown" is deleted — mission status is never
// genuinely unknowable (every derivation input is known), so every state
// names an honest word. New known states: idle (slices exist, nothing
// currently moving, not all done) · empty (zero slices — a tree-only word
// by construction) · draft (all-draft mission). Labels/tones are
// founder-relabelable with zero logic change.
export type MissionStatus =
  | "active"
  | "paused"
  | "shipped"
  | "blocked"
  | "idle"
  | "empty"
  | "draft";

export interface MissionStatusBadgeProps {
  status: MissionStatus;
  label?: string;
  className?: string;
  testId?: string;
}

const toneClass: Record<MissionStatus, string> = {
  active: "border-success text-success",
  paused: "border-outline text-on-surface-variant",
  shipped: "border-secondary text-secondary",
  blocked: "border-warning text-warning",
  idle: "border-outline-variant text-on-surface-variant",
  empty: "border-outline-variant text-on-surface-variant",
  draft: "border-outline text-on-surface-variant",
};

const toneDot: Record<MissionStatus, string> = {
  active: "bg-success",
  paused: "bg-outline-variant",
  shipped: "bg-secondary",
  blocked: "bg-warning",
  idle: "bg-surface-highest",
  empty: "bg-surface-highest",
  draft: "bg-outline-variant",
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
 * field is found.
 *
 * VM-005: this PROGRESS.md family widens its OWN return locally — "unknown"
 * is no longer a MissionStatus (chip surfaces go through the reconciled
 * home in project-mission-state.ts). SC-26's "PROGRESS.md is the source of
 * truth for mission status" is SUPERSEDED for mission-status CHIPS by
 * VM-005 FR-1 (authored README frontmatter wins); it survives scoped to
 * the Progress tab/rail, which this parser family still serves.
 */
export function parseMissionStatus(
  progressMdContent: string | null | undefined,
): MissionStatus | "unknown" {
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
