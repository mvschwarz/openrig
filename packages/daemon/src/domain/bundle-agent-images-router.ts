/**
 * Bundle agent_images router (Item 6 / slice-05 Checkpoint 7.3g step 2).
 *
 * Pure function. Copies agent-image directories declared in a bundle
 * manifest's agent_images[] block from the bundle's extracted tree to the
 * operator agent-images library. No daemon dependencies — fully
 * unit-testable via FsOps injection.
 *
 * Per PRD §Item 6 line 197: agent_images entries are paths to the
 * agent-image DIRECTORY (not manifest paths — distinct shape from
 * context_packs per the e7a0b253 PRD-coherent repair). The router copies
 * the declared directory to <targetAgentImagesDir>/<basename(sourceAbs)>/
 * — the operator-host canonical layout per agent-image-types.ts:9-10.
 *
 * Consumer contract (agent-image-library-service.ts:77-95): the consumer
 * walks roots whose immediate children are image DIRS, requires each
 * image dir to be a directory + contain a manifest.yaml FILE. The router
 * enforces these consumer-visibility invariants at copy time so
 * routedCount stays truthful at the consumer-visible boundary.
 *
 * All four banked router-level catches from the context_packs cycle
 * (d491eca9 + 3cd581e3 + 16ebb8af + a0e7e0e1) apply identically and are
 * built in from the first commit:
 *   1. source path containment (mirrors all sibling routers)
 *   2. sourceAbs exists + isDirectory (declared path IS the image dir)
 *   3. manifest.yaml inside exists AS A FILE (consumer requires
 *      readable manifest.yaml; rejects manifest-missing AND manifest-
 *      is-a-directory cases — file-vs-dir discrimination axis)
 *   4. basename(sourceAbs) collision detection (first wins, second
 *      flagged status=conflict)
 *
 * /install handler integration lands at Checkpoint 7.3g step 3 with a
 * real consumer-scan() proof against the routed dir (mirror of the
 * cb0bf7b9 context_packs ContextPackLibraryService.scan reachability
 * proof).
 */

import nodePath from "node:path";

/** Filesystem injection point — real impl wraps node:fs. Tests substitute in-memory. */
export interface AgentImagesRouterFsOps {
  exists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  mkdirp: (path: string) => void;
  copyDir: (src: string, dest: string) => void;
}

/** Inputs to routeAgentImages. */
export interface RouteAgentImagesInput {
  /** Absolute path to the bundle's extracted root (tmp dir from unpack). */
  bundleRoot: string;
  /** Relative paths to agent-image DIRECTORIES declared in the bundle
   *  manifest's agent_images[] block (per PRD §Item 6 line 197). */
  declaredAgentImages: string[];
  /** Absolute path to the operator agent-images library (per
   *  agent-image-types.ts:9-10: typically `<openrigHome>/agent-images/`
   *  or workspace-local `.openrig/agent-images/`). Caller resolves. */
  targetAgentImagesDir: string;
}

/** One routed agent_image (or one rejection). */
export interface RoutedAgentImageRecord {
  /** Declared path from manifest.agent_images[]. */
  declaredPath: string;
  /** "routed" = image dir copied successfully and consumer-visible.
   * "missing" = declared image dir not in bundle (honest skip).
   * "unsafe" = source escapes bundleRoot OR target escapes
   * targetAgentImagesDir (structurally impossible given basename, kept
   * defensive).
   * "not_directory" = declared path exists but is not a directory.
   * "not_manifest" = image dir exists but manifest.yaml inside is
   * absent OR is itself a directory — consumer requires a readable
   * manifest.yaml file at the image dir root.
   * "conflict" = basename collides with an earlier routed image; first
   * wins, second flagged so routedCount stays truthful at the consumer-
   * visible boundary (banked 16ebb8af lesson). */
  status: "routed" | "missing" | "unsafe" | "not_directory" | "not_manifest" | "conflict";
  /** Where the image landed in the target library (absolute image dir
   *  path), if routed. */
  installedAt?: string;
  /** Human-readable detail (3-part error shape input for caller). */
  detail?: string;
}

/** Aggregate routing result. */
export interface RouteAgentImagesResult {
  records: RoutedAgentImageRecord[];
  routedCount: number;
  rejectedCount: number;
}

/**
 * Route each declared agent_image from the bundle tree to the operator
 * agent-images library. Per-entry safety: SOURCE containment under
 * bundleRoot + TARGET containment under targetAgentImagesDir. Consumer-
 * visibility invariants (declared dir IS a directory + manifest.yaml
 * inside exists AS A FILE) enforced BEFORE write so routedCount stays
 * truthful at the consumer-visible boundary. Caller writes the install
 * audit record using the records returned here.
 */
export function routeAgentImages(
  input: RouteAgentImagesInput,
  fs: AgentImagesRouterFsOps,
): RouteAgentImagesResult {
  const records: RoutedAgentImageRecord[] = [];
  const bundleRootResolved = nodePath.resolve(input.bundleRoot);
  const targetRootResolved = nodePath.resolve(input.targetAgentImagesDir);
  fs.mkdirp(input.targetAgentImagesDir);
  // Track basenames already routed so collisions surface as conflict
  // records, not silent overwrites (banked workflow_specs +
  // context_packs lessons).
  const routedDirNames = new Set<string>();

  for (const declared of input.declaredAgentImages) {
    const sourceAbs = nodePath.resolve(input.bundleRoot, declared);
    // Defense-in-depth path-containment on SOURCE (mirrors sibling routers).
    if (sourceAbs !== bundleRootResolved && !sourceAbs.startsWith(bundleRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `agent_image path '${declared}' escapes bundle workspace; rejected`,
      });
      continue;
    }
    if (!fs.exists(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "missing",
        detail: `agent_image dir '${declared}' not present in bundle; skipped`,
      });
      continue;
    }
    if (!fs.isDirectory(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "not_directory",
        detail: `agent_image '${declared}' exists but is not a directory; consumer requires the declared path to be an image dir`,
      });
      continue;
    }
    // Manifest-file existence check (banked d491eca9 lesson on
    // context_packs): the consumer (agent-image-library-service.ts:93)
    // skips any image dir whose manifest.yaml is absent. Reject pre-write.
    const manifestPath = nodePath.join(sourceAbs, "manifest.yaml");
    if (!fs.exists(manifestPath)) {
      records.push({
        declaredPath: declared,
        status: "not_manifest",
        detail: `agent_image '${declared}' is missing manifest.yaml; consumer-invisible (agent-image-library scan requires it)`,
      });
      continue;
    }
    // Manifest-type check (banked 3cd581e3 lesson on context_packs):
    // exists() returns true for both files and directories. If manifest.yaml
    // is a directory, the consumer's readFileSync would throw and scan()
    // records an error diagnostic instead of indexing the image. Reject.
    if (fs.isDirectory(manifestPath)) {
      records.push({
        declaredPath: declared,
        status: "not_manifest",
        detail: `agent_image '${declared}' has manifest.yaml as a directory, not a file; consumer requires a readable file`,
      });
      continue;
    }
    const dirName = nodePath.basename(sourceAbs);
    const targetKey = process.platform === "win32" ? dirName.toLowerCase() : dirName;
    const targetAbs = nodePath.resolve(input.targetAgentImagesDir, dirName);
    // Sanity check (basename is structurally safe but resolve could
    // theoretically be a no-op for "" → keep the check, expected always-
    // true).
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `agent_image target path for '${declared}' escapes target agent-images library; rejected`,
      });
      continue;
    }
    if (routedDirNames.has(targetKey)) {
      records.push({
        declaredPath: declared,
        status: "conflict",
        detail: `agent_image basename '${dirName}' collides with an earlier declared path; only the first is routed (banked collision-detection lesson)`,
      });
      continue;
    }
    fs.copyDir(sourceAbs, targetAbs);
    routedDirNames.add(targetKey);
    records.push({
      declaredPath: declared,
      status: "routed",
      installedAt: targetAbs,
    });
  }

  const routedCount = records.filter((r) => r.status === "routed").length;
  const rejectedCount = records.length - routedCount;
  return { records, routedCount, rejectedCount };
}
