// V0.3.1 slice 12 walk-item 1 — generalized scope-markdown reader.
//
// Reads `<scopePath>/<filename>` via the existing /api/files/read
// daemon route so any tab that needs to render a markdown file from a
// project scope (slice, mission, workspace) can do so through a single
// hook with allowlist-root resolution baked in.
//
// scopePath is an ABSOLUTE filesystem path (e.g.,
// /Users/x/code/substrate/.../missions/release-0.3.1 or
// /Users/x/code/substrate/.../slices/06-…). The daemon's
// /api/files/read route REQUIRES a path RELATIVE TO ONE OF THE
// REGISTERED ALLOWLIST ROOTS and rejects absolute paths outright.
//
// This hook resolves the scope's absolute path against
// /api/files/roots (cached for 60s via useFilesRoots) to find which
// root contains the scope, then issues the read with the correct
// relative path. When no allowlist root contains the scope, the hook
// returns `unavailable: true` — graceful degradation matching
// useMissionDiscovery / useSliceTimelineMarkdown precedent.
//
// Generalization of the slice-06-era useSliceTimelineMarkdown.
// useSliceTimelineMarkdown is kept exported as a thin wrapper so
// existing callsites (TimelineTab) keep working without modification.

import { useFilesRead, useFilesRoots, type AllowlistRoot } from "./useFiles.js";

export interface UseScopeMarkdownResult {
  /** Raw file content when the file exists; null otherwise. */
  content: string | null;
  isLoading: boolean;
  /** True when the file does not exist, no allowlist root contains
   *  the scope, or the read failed. Distinct from `content === null`
   *  during initial load. */
  unavailable: boolean;
  /** mtime of the file when known. */
  mtime: string | null;
  /** Diagnostic: the (root, relPath) pair the hook computed for the
   *  /api/files/read call. Exposed so integration tests can assert
   *  the production call shape (absolute → relative conversion). */
  resolved: { rootName: string; relPath: string } | null;
}

/** Returns true when `parent` is a path-prefix of `child`, treating
 *  both as absolute filesystem paths. Segment-boundary aware so
 *  `/work` is NOT a prefix of `/workspace`. */
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
export function resolveScopePathToAllowlist(
  roots: AllowlistRoot[],
  absoluteScopePath: string,
): { rootName: string; relPath: string } | null {
  // Exact match wins; otherwise deepest prefix.
  const exact = roots.find((r) => r.path.replace(/\/+$/, "") === absoluteScopePath.replace(/\/+$/, ""));
  if (exact) return { rootName: exact.name, relPath: "" };
  const prefixed = roots
    .filter((r) => isPathPrefix(r.path, absoluteScopePath))
    .sort((a, b) => b.path.length - a.path.length);
  const winner = prefixed[0];
  if (!winner) return null;
  return { rootName: winner.name, relPath: relativeUnder(winner.path, absoluteScopePath) };
}

/** Fetch `<absoluteScopePath>/<filename>` via /api/files/read with
 *  allowlist-root resolution. Returns the same shape as the slice-06
 *  useSliceTimelineMarkdown hook so callsites can swap between the two
 *  via a single mental model. */
export function useScopeMarkdown(
  absoluteScopePath: string | null,
  filename: string,
): UseScopeMarkdownResult {
  const rootsQuery = useFilesRoots();
  const rootsResp = rootsQuery.data;
  const rootsList: AllowlistRoot[] | null =
    rootsResp && "roots" in rootsResp ? rootsResp.roots : null;

  const resolved =
    absoluteScopePath && rootsList
      ? resolveScopePathToAllowlist(rootsList, absoluteScopePath)
      : null;

  const filePath = resolved
    ? resolved.relPath
      ? `${resolved.relPath}/${filename}`
      : filename
    : null;

  const readQuery = useFilesRead(
    resolved ? resolved.rootName : null,
    filePath,
  );

  if (!absoluteScopePath) {
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
