// 0.3.1 slice 06 — fetch `<slicePath>/timeline.md` via the existing
// /api/files/read daemon route so TimelineTab can render the curated
// narrative above the auto-captured event feed. Mirrors the shape of
// useMissionProgressStatus (which fetches `<missionPath>/PROGRESS.md`
// the same way) so the cache + mtime invalidation behavior stays
// consistent across markdown-as-typed-surface consumers.

import { useFilesRead } from "./useFiles.js";

export interface UseSliceTimelineMarkdownResult {
  /** Raw timeline.md content when the file exists; null when absent
   *  or unreadable. TimelineTab renders the content above the event
   *  feed when present and falls through to the standard feed when
   *  not. */
  content: string | null;
  isLoading: boolean;
  /** True when the file does not exist or the read failed. Distinct
   *  from `content === null` during initial load. */
  unavailable: boolean;
  /** mtime of timeline.md when known. */
  mtime: string | null;
}

/** Fetch `<slicePath>/timeline.md` for a slice scope. Returns a stable
 *  shape so consumers can conditionally render the curated narrative
 *  while loading / when absent. `root` + `slicePath` may be null when
 *  the scope is not yet known; the hook short-circuits cleanly in
 *  that case (no fetch, no error). */
export function useSliceTimelineMarkdown(
  root: string | null,
  slicePath: string | null,
): UseSliceTimelineMarkdownResult {
  const timelinePath = root && slicePath ? `${slicePath}/timeline.md` : null;
  const readQuery = useFilesRead(root, timelinePath);

  if (!root || !slicePath) {
    return { content: null, isLoading: false, unavailable: true, mtime: null };
  }

  if (readQuery.isLoading) {
    return { content: null, isLoading: true, unavailable: false, mtime: null };
  }

  if (readQuery.isError || !readQuery.data) {
    return { content: null, isLoading: false, unavailable: true, mtime: null };
  }

  return {
    content: readQuery.data.content ?? null,
    isLoading: false,
    unavailable: false,
    mtime: readQuery.data.mtime ?? null,
  };
}
