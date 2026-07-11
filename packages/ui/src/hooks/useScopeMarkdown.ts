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

import { useFilesRead, useFilesRoots, FilesReadError, type AllowlistRoot } from "./useFiles.js";

export type ScopeMarkdownState =
  | "idle"
  | "unresolved"
  | "absent"
  | "read_error"
  | "content";

export interface UseScopeMarkdownResult {
  /** Raw file content when the file exists; null otherwise. */
  content: string | null;
  isLoading: boolean;
  /** True when the file does not exist, no allowlist root contains
   *  the scope, or the read failed. Distinct from `content === null`
   *  during initial load.
   *
   *  R1 (release-0.4.7): now a DERIVED back-compat field
   *  (`state !== "content" && !isLoading`) — every pre-R1 consumer that
   *  branches on `unavailable` sees byte-identical true/false. Branch on
   *  `state` for the honest three-way distinction. */
  unavailable: boolean;
  /** mtime of the file when known. */
  mtime: string | null;
  /** Diagnostic: the (root, relPath) pair the hook computed for the
   *  /api/files/read call. Exposed so integration tests can assert
   *  the production call shape (absolute → relative conversion). */
  resolved: { rootName: string; relPath: string } | null;
  /** R1 (release-0.4.7) — the discriminated read outcome, so a consumer
   *  can stop collapsing three different truths into one `unavailable`
   *  flag: `unresolved` (no allowlist root contains the scope path —
   *  a config/root problem) | `absent` (the file is genuinely missing,
   *  404) | `read_error` (the read failed / infra, NOT an empty file) |
   *  `content` (read ok) | `idle`.
   *
   *  P1 pin (arch ruling): `idle` means *caller-gated, never looked*
   *  (remote gate / no scope selected) — it is NOT a statement about the
   *  file. That the copy tier of THIS slice renders `idle` like `absent`
   *  is a **copy-tier decision, not a semantic equivalence**; the
   *  distinction must stay expressible in the type (the ProofTab-remote
   *  follow-up is the live case that needs it).
   *
   *  `state` is only meaningful when `isLoading` is false: while a fetch
   *  is in flight the outcome is not yet determined (it reports `idle`
   *  as a benign placeholder) — consumers MUST gate on `isLoading` before
   *  branching on `state`. */
  state: ScopeMarkdownState;
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
  opts?: { enabled?: boolean },
): UseScopeMarkdownResult {
  // OPR.0.4.6.MH2 guard-B1 — /api/files/* is local-only: a null/disabled
  // scope path must issue ZERO file requests (roots included), not merely
  // render unavailable. Remote-selected surfaces pass null paths and/or
  // enabled:false; the query below never fires for them.
  const enabled = (opts?.enabled ?? true) && absoluteScopePath !== null;
  const rootsQuery = useFilesRoots({ enabled });
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

  // R1 (release-0.4.7): classify the read outcome into a discriminated
  // `state`; `unavailable` is DERIVED from it (`state !== "content" &&
  // !isLoading`) so every pre-R1 consumer sees byte-identical true/false at
  // every one of the sites below. content / mtime / resolved are set exactly
  // as before per branch.
  let state: ScopeMarkdownState;
  let content: string | null = null;
  let mtime: string | null = null;
  let resolvedOut: { rootName: string; relPath: string } | null = null;
  let isLoading = false;

  if (!absoluteScopePath) {
    // caller gated — no scope selected / remote selection (the query never fired)
    state = "idle";
  } else if (rootsQuery.isError) {
    // G7: a roots-fetch failure is INFRA, not a mis-config — it must NOT
    // masquerade as `unresolved`/config copy (the slice's core principle, one
    // level up). rootsList is null here ⇒ pre-R1 this fell through to the
    // `!resolved` branch and rendered as config/unresolved.
    state = "read_error";
  } else if (rootsQuery.isLoading) {
    state = "idle"; // in-flight; not meaningful until !isLoading
    isLoading = true;
  } else if (!resolved) {
    // roots loaded, but no allowlist root contains the scope path (incl. roots:[])
    state = "unresolved";
  } else if (readQuery.isLoading) {
    state = "idle"; // in-flight
    isLoading = true;
    resolvedOut = resolved;
  } else if (readQuery.isError) {
    // the daemon's status signal, finally consumed (via FilesReadError.code):
    // 404 → absent, 400/bad_path → the config class, anything else → infra.
    const err = readQuery.error;
    state =
      err instanceof FilesReadError
        ? err.code === "absent"
          ? "absent"
          : err.code === "bad_path"
            ? "unresolved"
            : "read_error"
        : "read_error";
    resolvedOut = resolved;
  } else if (!readQuery.data) {
    // a 200 with no payload is not absence
    state = "read_error";
    resolvedOut = resolved;
  } else {
    state = "content";
    content = readQuery.data.content ?? null;
    mtime = readQuery.data.mtime ?? null;
    resolvedOut = resolved;
  }

  return {
    content,
    isLoading,
    unavailable: state !== "content" && !isLoading,
    mtime,
    resolved: resolvedOut,
    state,
  };
}
