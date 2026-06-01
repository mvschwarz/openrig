/**
 * Bundle context_packs router (Item 6 / slice-05 Checkpoint 7.3f step 2).
 *
 * Pure function. Copies context-pack directories declared in a bundle
 * manifest's context_packs[] block from the bundle's extracted tree to
 * the operator context-packs library. No daemon dependencies — fully
 * unit-testable via FsOps injection.
 *
 * Per PRD §Item 6 line 196: context_packs entries are paths to a
 * context-pack's manifest.yaml file inside the bundle. The PACK is the
 * PARENT DIRECTORY of that manifest.yaml (per context-pack-types.ts:9-10
 * and context-pack-library-service.ts:50-77: a pack is a directory whose
 * immediate children include manifest.yaml + the referenced content
 * files). The router copies that parent dir to
 * <targetContextPacksDir>/<basename(parentDir)>/ — the operator-host
 * canonical layout the live consumer scans.
 *
 * Banked degenerate-input dogfood discipline (extended from the
 * workflow_specs basename-collision + non-YAML cycles): every router
 * commit explicitly probes the failure-class edges through the live
 * consumer's contract before claiming routedCount truthful. For
 * context_packs the consumer-invisibility classes are:
 *   - Declared path basename is NOT "manifest.yaml" → consumer never
 *     scans (it looks for manifest.yaml at the pack dir root). status=
 *     not_manifest.
 *   - Two declared paths whose parent-dir basename collide → second
 *     would silently overwrite the first; status=conflict; first wins.
 *   - Source pack dir not present in bundle → status=missing (honest skip).
 *   - Source path escapes bundleRoot → status=unsafe.
 *
 * Both-sides containment (banked
 * feedback_pre_existing_trust_boundary_reuse_canonical_helper addendum):
 * source-side under bundleRoot, target-side under targetContextPacksDir
 * (target via basename so structurally safe; defensive check retained).
 *
 * /install handler integration lands at Checkpoint 7.3f step 3 with a
 * real consumer-scan() proof against the routed dir (mirror of the
 * workflow_specs scanWorkflowSpecFolder reachability proof at d81456dc).
 */

import nodePath from "node:path";

/** Filesystem injection point — real impl wraps node:fs. Tests substitute in-memory. */
export interface ContextPacksRouterFsOps {
  exists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  mkdirp: (path: string) => void;
  copyDir: (src: string, dest: string) => void;
}

/** Inputs to routeContextPacks. */
export interface RouteContextPacksInput {
  /** Absolute path to the bundle's extracted root (tmp dir from unpack). */
  bundleRoot: string;
  /** Relative paths to context-pack manifest.yaml files declared in the
   *  bundle manifest's context_packs[] block. */
  declaredContextPacks: string[];
  /** Absolute path to the operator context-packs library (per
   *  context-pack-types.ts:9-10: typically `<openrigHome>/context-packs`
   *  or a workspace-local `.openrig/context-packs`). Caller resolves. */
  targetContextPacksDir: string;
}

/** One routed context_pack (or one rejection). */
export interface RoutedContextPackRecord {
  /** Declared path from manifest.context_packs[]. */
  declaredPath: string;
  /** "routed" = pack dir copied successfully and consumer-visible.
   * "missing" = pack manifest source not in bundle (honest skip).
   * "unsafe" = source escapes bundleRoot OR target escapes
   * targetContextPacksDir (structurally impossible given basename, kept
   * defensive).
   * "not_manifest" = declared path basename is not "manifest.yaml" —
   * consumer (context-pack-library-service.scan) scans pack dirs for a
   * top-level manifest.yaml file; any other basename is invisible-by-
   * construction.
   * "not_directory" = parent of the declared manifest path is not a
   * directory in the bundle tree.
   * "conflict" = parent-dir basename collides with an earlier routed
   * pack; first wins, second flagged so routedCount stays truthful at
   * the consumer-visible boundary (banked 16ebb8af lesson). */
  status: "routed" | "missing" | "unsafe" | "not_manifest" | "not_directory" | "conflict";
  /** Where the pack landed in the target library (absolute pack dir
   *  path), if routed. */
  installedAt?: string;
  /** Human-readable detail (3-part error shape input for caller). */
  detail?: string;
}

/** Aggregate routing result. */
export interface RouteContextPacksResult {
  records: RoutedContextPackRecord[];
  routedCount: number;
  rejectedCount: number;
}

/**
 * Route each declared context_pack from the bundle tree to the operator
 * context-packs library. Per-entry safety: SOURCE containment under
 * bundleRoot + TARGET containment under targetContextPacksDir.
 * Degenerate inputs the consumer ignores (non-manifest.yaml basename;
 * parent-dir basename collisions) are caught BEFORE write so the
 * routedCount stays truthful at the consumer-visible boundary. Caller
 * writes the install audit record using the records returned here.
 */
export function routeContextPacks(
  input: RouteContextPacksInput,
  fs: ContextPacksRouterFsOps,
): RouteContextPacksResult {
  const records: RoutedContextPackRecord[] = [];
  const bundleRootResolved = nodePath.resolve(input.bundleRoot);
  const targetRootResolved = nodePath.resolve(input.targetContextPacksDir);
  fs.mkdirp(input.targetContextPacksDir);
  // Track parent-dir basenames already routed so collisions surface as
  // conflict records, not silent overwrites (banked workflow_specs lesson
  // 16ebb8af).
  const routedDirNames = new Set<string>();

  for (const declared of input.declaredContextPacks) {
    // Consumer-visibility prefilter: context-pack-library-service scans
    // pack dirs whose immediate child is manifest.yaml. Any declared path
    // whose basename isn't "manifest.yaml" routes to a dir the consumer
    // will never recognize as a pack. Reject pre-write so routedCount
    // stays truthful at the consumer-visible boundary.
    if (nodePath.basename(declared) !== "manifest.yaml") {
      records.push({
        declaredPath: declared,
        status: "not_manifest",
        detail: `context_pack '${declared}' basename is not 'manifest.yaml'; context-pack-library scans pack dirs for a top-level manifest.yaml`,
      });
      continue;
    }
    const sourceAbs = nodePath.resolve(input.bundleRoot, declared);
    // Defense-in-depth path-containment on SOURCE (mirrors skills/
    // workflow_specs routers).
    if (sourceAbs !== bundleRootResolved && !sourceAbs.startsWith(bundleRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `context_pack path '${declared}' escapes bundle workspace; rejected`,
      });
      continue;
    }
    // Manifest-file existence check (banked B1 from a0e7e0e1 guard catch):
    // the consumer (context-pack-library-service.scan, line 76) skips any
    // pack dir whose manifest.yaml is absent. A parent-dir-exists-but-
    // manifest-missing pack would route as status=routed but be invisible
    // to the consumer — false-positive routedCount class. Check the file
    // ITSELF, not just the parent, to keep routedCount truthful at the
    // consumer-visible boundary.
    if (!fs.exists(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "missing",
        detail: `context_pack manifest '${declared}' not present in bundle; skipped (consumer requires the file itself)`,
      });
      continue;
    }
    // Manifest-type check (banked B2 from d491eca9 guard catch): exists()
    // returns true for both files AND directories. If sourceAbs exists as
    // a directory (named manifest.yaml, but a dir not a file), the live
    // consumer's readFileSync(manifestPath) throws and scan() records an
    // error diagnostic instead of indexing a visible pack — false-positive
    // routedCount class. Reject pre-write so routedCount stays truthful at
    // the consumer-visible boundary.
    if (fs.isDirectory(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "not_manifest",
        detail: `context_pack manifest '${declared}' exists but is a directory, not a file; consumer requires manifest.yaml to be a readable file`,
      });
      continue;
    }
    const sourcePackDir = nodePath.dirname(sourceAbs);
    if (!fs.isDirectory(sourcePackDir)) {
      records.push({
        declaredPath: declared,
        status: "not_directory",
        detail: `context_pack parent of '${declared}' is not a directory; skipped`,
      });
      continue;
    }
    const dirName = nodePath.basename(sourcePackDir);
    // Target = <targetContextPacksDir>/<basename(parentDir)>/ (the operator-
    // host canonical layout per context-pack-types.ts:9-10).
    const targetAbs = nodePath.resolve(input.targetContextPacksDir, dirName);
    // Sanity check (basename is structurally safe but the resolve could
    // theoretically be a no-op for "" → keep the check, expected always-
    // true).
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `context_pack target path for '${declared}' escapes target context-packs library; rejected`,
      });
      continue;
    }
    if (routedDirNames.has(dirName)) {
      records.push({
        declaredPath: declared,
        status: "conflict",
        detail: `context_pack parent-dir basename '${dirName}' collides with an earlier declared path; only the first is routed (banked collision-detection lesson)`,
      });
      continue;
    }
    fs.copyDir(sourcePackDir, targetAbs);
    routedDirNames.add(dirName);
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
