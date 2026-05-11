// V0.3.1 slice 12 walk-item 1 — backward-compat shim.
//
// Historically `useSliceTimelineMarkdown(absoluteSlicePath)` fetched
// `<slicePath>/timeline.md`. Slice 12 generalized the implementation
// to `useScopeMarkdown(absoluteScopePath, filename)` so any scope
// (slice, mission, workspace) can read any markdown file through the
// same allowlist-root-aware path. This file is now a thin re-export
// shim so slice-06 TimelineTab callsites (and other code referencing
// `useSliceTimelineMarkdown` / `resolveSlicePathToAllowlist`) keep
// working without modification.

import {
  useScopeMarkdown,
  resolveScopePathToAllowlist,
  type UseScopeMarkdownResult,
} from "./useScopeMarkdown.js";

export type UseSliceTimelineMarkdownResult = UseScopeMarkdownResult;

/** Backward-compat alias for slice-06 / Phase 6 callsites. New code
 *  should call useScopeMarkdown directly with an explicit filename
 *  ("README.md" / "PROGRESS.md" / etc.). */
export function useSliceTimelineMarkdown(
  absoluteSlicePath: string | null,
): UseSliceTimelineMarkdownResult {
  return useScopeMarkdown(absoluteSlicePath, "timeline.md");
}

/** Backward-compat alias for the resolver export. */
export const resolveSlicePathToAllowlist = resolveScopePathToAllowlist;
