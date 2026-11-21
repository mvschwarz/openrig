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
import { resolveScopePathToAllowlist } from "./useScopeMarkdown.js";

export interface DiscoveredMission {
  /** Mission directory name (e.g., "release-0-3-0"). */
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

export function useMissionDiscovery(opts?: { enabled?: boolean }): UseMissionDiscoveryResult {
  // OPR.0.4.6.MH2 guard-B1 — discovery walks the LOCAL filesystem
  // (/api/files/roots + /api/files/list). Under a remote host selection
  // the caller passes enabled:false and NO file request fires (a post-hoc
  // result wrapper is not a gate — the hooks would already have fetched).
  const enabled = opts?.enabled ?? true;
  const workspace = useWorkspaceName();
  const rootsQuery = useFilesRoots({ enabled });
  const rootsResp = enabled ? rootsQuery.data : undefined;

  // Resolution: pick the best-matching root for workspace.root, if any.
  const resolved = workspace.root && rootsResp && "roots" in rootsResp
    ? resolveScopePathToAllowlist(rootsResp.roots, workspace.root) : null;
  const chosenRoot = resolved ? { name: resolved.rootName } : null;

  // Compute the missions/ relative path from the chosen root.
  const missionsRelPath =
    resolved
      ? resolved.relPath ? `${resolved.relPath}/missions` : "missions"
      : null;

  const listQuery = useFilesList(
    chosenRoot ? chosenRoot.name : null,
    missionsRelPath,
  );

  // Disabled (remote selection): honest unavailable, zero file requests
  // issued above (roots disabled ⇒ chosenRoot null ⇒ list disabled).
  if (!enabled) {
    return {
      missions: [],
      unavailable: true,
      isLoading: false,
      hint: null,
    };
  }

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
