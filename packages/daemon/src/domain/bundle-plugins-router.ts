/**
 * Bundle plugins router (Item 6 / slice-05 Checkpoint 7.3c).
 *
 * Pure function. Copies plugin trees declared in a bundle manifest's
 * plugins[] block from the bundle's extracted tree to the operator plugins
 * library (per-id subdir). Mirrors the bundle-skills-router pattern: FsOps
 * injection; both-sides path containment (banked
 * feedback_pre_existing_trust_boundary_reuse_canonical_helper addendum:
 * contain BOTH source AND target when handling untrusted path input);
 * missing source surfaces as status=missing; unsafe paths rejected with
 * status=unsafe.
 *
 * Per orch-ratified HYBRID decision: v0 source.kind is local only (path
 * under the bundle's extracted tree). Other kinds (external operator-host
 * paths, remote fetch) reserved for future.
 *
 * /install handler integration lands at Checkpoint 7.3d.
 */

import nodePath from "node:path";

/** Filesystem injection point — real impl wraps node:fs. Tests substitute in-memory. */
export interface PluginsRouterFsOps {
  exists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  mkdirp: (path: string) => void;
  copyDir: (src: string, dest: string) => void;
}

/** A plugin reference in the bundle manifest. Matches the daemon's BundlePluginReference shape. */
export interface PluginRoutingInput {
  id: string;
  source: { kind: "local"; path: string };
}

/** Inputs to routePlugins. */
export interface RoutePluginsInput {
  /** Absolute path to the bundle's extracted root (tmp dir from unpack). */
  bundleRoot: string;
  /** Plugin references declared in the manifest. */
  declaredPlugins: PluginRoutingInput[];
  /** Absolute path to the operator plugins library (default ~/.openrig/plugins). */
  targetPluginsDir: string;
}

/** One routed plugin (or one rejection). */
export interface RoutedPluginRecord {
  /** Plugin id from manifest.plugins[].id. */
  id: string;
  /** "routed" = directory copied; "missing" = source not in bundle; "unsafe"
   * = source or target escapes its bounding directory; "not_directory" =
   * source path is not a directory; "conflict" = duplicate native target. */
  status: "routed" | "missing" | "unsafe" | "not_directory" | "conflict";
  /** Where the plugin landed in the target library (absolute path), if routed. */
  installedAt?: string;
  /** Human-readable detail. */
  detail?: string;
}

/** Aggregate routing result. */
export interface RoutePluginsResult {
  records: RoutedPluginRecord[];
  routedCount: number;
  rejectedCount: number;
}

/**
 * Route each declared plugin from the bundle tree to the operator plugins
 * library as <targetPluginsDir>/<id>/. Per-plugin safety: BOTH source path
 * (under bundleRoot) AND target path (under targetPluginsDir) are
 * containment-checked. Banked both-sides-of-trust-boundary lesson applied.
 */
export function routePlugins(input: RoutePluginsInput, fs: PluginsRouterFsOps): RoutePluginsResult {
  const records: RoutedPluginRecord[] = [];
  const bundleRootResolved = nodePath.resolve(input.bundleRoot);
  const targetRootResolved = nodePath.resolve(input.targetPluginsDir);
  fs.mkdirp(input.targetPluginsDir);
  const nativeTargets = new Set<string>();

  for (const plugin of input.declaredPlugins) {
    if (!plugin.id || plugin.source.kind !== "local") {
      records.push({
        id: plugin.id || "(unknown)",
        status: "unsafe",
        detail: `plugin reference invalid: id required and source.kind must be 'local' (other kinds reserved for future)`,
      });
      continue;
    }
    // Source containment: source.path must resolve inside bundleRoot
    const sourceAbs = nodePath.resolve(input.bundleRoot, plugin.source.path);
    if (sourceAbs !== bundleRootResolved && !sourceAbs.startsWith(bundleRootResolved + nodePath.sep)) {
      records.push({
        id: plugin.id,
        status: "unsafe",
        detail: `plugin source path '${plugin.source.path}' escapes bundle workspace; rejected`,
      });
      continue;
    }
    if (!fs.exists(sourceAbs)) {
      records.push({
        id: plugin.id,
        status: "missing",
        detail: `plugin source '${plugin.source.path}' not present in bundle; skipped`,
      });
      continue;
    }
    if (!fs.isDirectory(sourceAbs)) {
      records.push({
        id: plugin.id,
        status: "not_directory",
        detail: `plugin source '${plugin.source.path}' is not a directory; skipped`,
      });
      continue;
    }
    // Target containment: id must produce a path inside targetPluginsDir
    const targetAbs = nodePath.resolve(input.targetPluginsDir, plugin.id);
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        id: plugin.id,
        status: "unsafe",
        detail: `plugin id '${plugin.id}' would resolve outside target plugins library; rejected`,
      });
      continue;
    }
    const targetKey = targetAbs.toLowerCase();
    if (process.platform === "win32" && nativeTargets.has(targetKey)) {
      records.push({ id: plugin.id, status: "conflict", detail: `plugin id '${plugin.id}' collides with an earlier native target; only the first is routed` });
      continue;
    }
    fs.copyDir(sourceAbs, targetAbs);
    nativeTargets.add(targetKey);
    records.push({
      id: plugin.id,
      status: "routed",
      installedAt: targetAbs,
    });
  }

  const routedCount = records.filter((r) => r.status === "routed").length;
  const rejectedCount = records.length - routedCount;
  return { records, routedCount, rejectedCount };
}
