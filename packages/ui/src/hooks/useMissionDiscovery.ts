// V1 attempt-3 Phase 5 P5-5 — Filesystem-based Project tree mission discovery.
//
// Walks `<workspace.root>/missions/` via the existing /api/files/list daemon
// route (no new daemon endpoint per SC-29). Returns the list of mission
// directories so ProjectTreeView can render them as tree nodes alongside
// (or instead of) the railItem-grouped slice fallback. Per project-tree.md
// L13–L46 the Project tree shape is workspace > mission > slice; the
// canonical mission unit is a directory under workspace.root/missions/.
//
// Resolution chain:
//   1. useSettings → workspace.root (absolute path)
//   2. useFilesRoots → list of (name, path) allowlist roots
//   3. find allowlist root whose `path` is a prefix of workspace.root
//      (exact-equal preferred; "the workspace root" is the typical
//      registration case)
//   4. compute relative path from root → workspace.root/missions
//   5. useFilesList(rootName, relPath) → mission directory entries
//
// When no suitable root is registered (operator hasn't added workspace.root
// to OPENRIG_FILES_ALLOWLIST), returns { unavailable: true } so the UI can
// degrade to the legacy railItem-grouped slice listing without crashing.

import { useFilesRoots, useFilesList } from "./useFiles.js";
import { useWorkspaceName } from "./useWorkspaceName.js";

export interface DiscoveredMission {
  /** Mission directory name (e.g., "recursive-self-improvement-v2"). */
  name: string;
  /** Allowlist root name to use with /api/files/* endpoints. */
  root: string;
  /** Path under root for this mission directory (e.g., "missions/foo"). */
  path: string;
}

export interface UseMissionDiscoveryResult {
  missions: DiscoveredMission[];
  /** True when allowlist has no root containing workspace.root. */
  unavailable: boolean;
  /** True while any underlying query is in flight. */
  isLoading: boolean;
  /** Hint text for the empty-state when unavailable. */
  hint: string | null;
}

/** Returns true when `parent` is a path-prefix of `child`, treating both as
 * absolute filesystem paths. Trailing slashes are tolerated; segment
 * boundaries enforced (so "/work" is NOT a prefix of "/workspace"). */
function isPathPrefix(parent: string, child: string): boolean {
  const p = parent.replace(/\/+$/, "");
  const c = child.replace(/\/+$/, "");
  if (c === p) return true;
  return c.startsWith(p + "/");
}

/** Compute the relative path inside a root: child = "<root>/<rel>" → "<rel>". */
function relativeUnder(rootPath: string, absChild: string): string {
  const p = rootPath.replace(/\/+$/, "");
  const c = absChild.replace(/\/+$/, "");
  if (c === p) return "";
  if (c.startsWith(p + "/")) return c.slice(p.length + 1);
  return c;
}

export function useMissionDiscovery(): UseMissionDiscoveryResult {
  const workspace = useWorkspaceName();
  const rootsQuery = useFilesRoots();
  const rootsResp = rootsQuery.data;

  // Resolution: pick the best-matching root for workspace.root, if any.
  let chosenRoot: { name: string; path: string } | null = null;
  if (workspace.root && rootsResp && "roots" in rootsResp) {
    // Exact match preferred.
    const exact = rootsResp.roots.find((r) => r.path === workspace.root);
    if (exact) {
      chosenRoot = exact;
    } else {
      // Otherwise pick the deepest root that is a prefix of workspace.root
      // (handles operator who registered ~/code as a root with workspace.root
      // = ~/code/projects/openrig-work).
      const prefixed = rootsResp.roots
        .filter((r) => workspace.root && isPathPrefix(r.path, workspace.root))
        .sort((a, b) => b.path.length - a.path.length);
      const first = prefixed[0];
      if (first) chosenRoot = first;
    }
  }

  // Compute the missions/ relative path from the chosen root.
  const missionsRelPath =
    chosenRoot && workspace.root
      ? (() => {
          const rel = relativeUnder(chosenRoot.path, workspace.root);
          return rel ? `${rel}/missions` : "missions";
        })()
      : null;

  const listQuery = useFilesList(
    chosenRoot ? chosenRoot.name : null,
    missionsRelPath,
  );

  const isLoading =
    workspace.isLoading ||
    rootsQuery.isLoading ||
    (chosenRoot !== null && listQuery.isLoading);

  // Unavailable cases:
  //   - Settings unreachable (legacy v0.2.0 daemon without /api/config).
  //   - No workspace.root configured.
  //   - No allowlist root contains workspace.root (operator must register).
  if (!workspace.settingsAvailable && !workspace.isLoading) {
    return {
      missions: [],
      unavailable: true,
      isLoading,
      hint: "Daemon does not expose /api/config (likely v0.2.0). Upgrade to v0.3.0+ for live mission discovery.",
    };
  }
  if (!workspace.root && !workspace.isLoading) {
    return {
      missions: [],
      unavailable: true,
      isLoading,
      hint: "Configure a workspace root: rig config set workspace.root <path>",
    };
  }
  if (!chosenRoot && !rootsQuery.isLoading) {
    return {
      missions: [],
      unavailable: true,
      isLoading,
      hint: `No allowlist root contains workspace.root (${workspace.root}). Set OPENRIG_FILES_ALLOWLIST=<name>:<path> to register.`,
    };
  }

  // listQuery may be in flight or errored; treat error as unavailable so the
  // UI falls back gracefully without throwing.
  if (listQuery.isError) {
    return {
      missions: [],
      unavailable: true,
      isLoading,
      hint: `Could not list ${missionsRelPath} under ${chosenRoot?.name}.`,
    };
  }

  const entries = listQuery.data?.entries ?? [];
  const missions: DiscoveredMission[] = entries
    .filter((e) => e.type === "dir")
    .map((e) => ({
      name: e.name,
      root: chosenRoot!.name,
      path: missionsRelPath ? `${missionsRelPath}/${e.name}` : e.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    missions,
    unavailable: false,
    isLoading,
    hint: null,
  };
}
