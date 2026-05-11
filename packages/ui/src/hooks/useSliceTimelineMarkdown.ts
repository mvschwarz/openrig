// 0.3.1 slice 06 — fetch `<slicePath>/timeline.md` via the existing
// /api/files/read daemon route so TimelineTab can render the curated
// narrative above the auto-captured event feed.
//
// SliceDetail.slicePath is an ABSOLUTE filesystem path (e.g.,
// /Users/x/code/substrate/.../missions/foo/slices/06-…). The daemon's
// /api/files/read route REQUIRES a path RELATIVE TO ONE OF THE
// REGISTERED ALLOWLIST ROOTS and rejects absolute paths outright.
//
// This hook resolves the slice's absolute path against
// `/api/files/roots` (cached for 60s) to find which root contains the
// slice, then issues the read with the correct relative path. When no
// allowlist root contains the slice, the hook returns
// `unavailable: true` — graceful degradation matching the
// useMissionDiscovery precedent.

import { useFilesRead, useFilesRoots, type AllowlistRoot } from "./useFiles.js";

export interface UseSliceTimelineMarkdownResult {
  /** Raw timeline.md content when the file exists; null otherwise.
   *  TimelineTab renders the content above the event feed when
   *  present and falls through to the standard feed when not. */
  content: string | null;
  isLoading: boolean;
  /** True when the file does not exist, no allowlist root contains
   *  the slice, or the read failed. Distinct from `content === null`
   *  during initial load. */
  unavailable: boolean;
  /** mtime of timeline.md when known. */
  mtime: string | null;
  /** Diagnostic: the (root, relPath) pair the hook computed for the
   *  /api/files/read call. Exposed so integration tests can assert
   *  the production call shape (absolute → relative conversion). */
  resolved: { rootName: string; relPath: string } | null;
}

/** Returns true when `parent` is a path-prefix of `child`, treating
 *  both as absolute filesystem paths. Segment-boundary aware so
 *  `/work` is NOT a prefix of `/workspace`. Mirrors the
 *  useMissionDiscovery helper. */
function isPathPrefix(parent: string, child: string): boolean {
  const p = parent.replace(/\/+$/, "");
  const c = child.replace(/\/+$/, "");
  if (c === p) return true;
  return c.startsWith(p + "/");
}

/** Compute the path under a root: `<root>/<rel>` → `<rel>`. */
function relativeUnder(rootPath: string, absChild: string): string {
  const p = rootPath.replace(/\/+$/, "");
  const c = absChild.replace(/\/+$/, "");
  if (c === p) return "";
  if (c.startsWith(p + "/")) return c.slice(p.length + 1);
  return c;
}

/** Pick the deepest-matching allowlist root that contains the
 *  absolute path. Returns null when no root contains it. Exported
 *  for the integration test surface. */
export function resolveSlicePathToAllowlist(
  roots: AllowlistRoot[],
  absoluteSlicePath: string,
): { rootName: string; relPath: string } | null {
  // Exact match wins; otherwise deepest prefix.
  const exact = roots.find((r) => r.path.replace(/\/+$/, "") === absoluteSlicePath.replace(/\/+$/, ""));
  if (exact) return { rootName: exact.name, relPath: "" };
  const prefixed = roots
    .filter((r) => isPathPrefix(r.path, absoluteSlicePath))
    .sort((a, b) => b.path.length - a.path.length);
  const winner = prefixed[0];
  if (!winner) return null;
  return { rootName: winner.name, relPath: relativeUnder(winner.path, absoluteSlicePath) };
}

/** Fetch `<slicePath>/timeline.md` for a slice scope.
 *  `absoluteSlicePath` is the SliceDetail.slicePath value verbatim
 *  (daemon emits absolute paths). The hook handles the allowlist-root
 *  resolution + relative-path construction internally so call sites
 *  stay simple. */
export function useSliceTimelineMarkdown(
  absoluteSlicePath: string | null,
): UseSliceTimelineMarkdownResult {
  const rootsQuery = useFilesRoots();
  const rootsResp = rootsQuery.data;
  const rootsList: AllowlistRoot[] | null =
    rootsResp && "roots" in rootsResp ? rootsResp.roots : null;

  const resolved =
    absoluteSlicePath && rootsList
      ? resolveSlicePathToAllowlist(rootsList, absoluteSlicePath)
      : null;

  const timelinePath = resolved
    ? resolved.relPath
      ? `${resolved.relPath}/timeline.md`
      : "timeline.md"
    : null;

  const readQuery = useFilesRead(
    resolved ? resolved.rootName : null,
    timelinePath,
  );

  if (!absoluteSlicePath) {
    return { content: null, isLoading: false, unavailable: true, mtime: null, resolved: null };
  }

  if (rootsQuery.isLoading) {
    return { content: null, isLoading: true, unavailable: false, mtime: null, resolved: null };
  }

  if (!resolved) {
    return { content: null, isLoading: false, unavailable: true, mtime: null, resolved: null };
  }

  if (readQuery.isLoading) {
    return { content: null, isLoading: true, unavailable: false, mtime: null, resolved };
  }

  if (readQuery.isError || !readQuery.data) {
    return { content: null, isLoading: false, unavailable: true, mtime: null, resolved };
  }

  return {
    content: readQuery.data.content ?? null,
    isLoading: false,
    unavailable: false,
    mtime: readQuery.data.mtime ?? null,
    resolved,
  };
}
