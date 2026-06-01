/**
 * Bundle workflow_specs router (Item 6 / slice-05 Checkpoint 7.3e step 2).
 *
 * Pure function. Copies workflow spec YAML files declared in a bundle
 * manifest's workflow_specs[] block from the bundle's extracted tree to the
 * operator workflow-specs library. No daemon dependencies — fully
 * unit-testable via FsOps injection.
 *
 * Mirrors the bundle-skills-router pattern (file-paths, single-file copy
 * preserving directory layout, leading-prefix strip). Per orch-ratified
 * Candidate A on Item-6 completeness: workflow_specs is the 3rd v0
 * cross-primitive kind (after skills + plugins). Source primitive
 * reachable on main (WorkflowSpecCache + workflow-runtime + scanner).
 *
 * Safety (banked feedback_pre_existing_trust_boundary_reuse_canonical_helper
 * addendum): both-sides containment — declared source path must stay
 * inside bundleRoot; resolved target path (after leading "workflows/"
 * strip) must stay inside targetWorkflowSpecsDir. The leading-prefix
 * strip can promote intermediate ../ segments that bypass source check
 * but escape target.
 *
 * Honest-scoping: missing source files surface as warnings in the
 * result (NOT thrown errors) so the install lifecycle can continue
 * with what's available. Same as bundle-skills-router.
 *
 * /install handler integration lands at Checkpoint 7.3e step 3.
 */

import nodePath from "node:path";

/** Filesystem injection point — real impl wraps node:fs. Tests substitute in-memory. */
export interface WorkflowSpecsRouterFsOps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  mkdirp: (path: string) => void;
}

/** Inputs to routeWorkflowSpecs. */
export interface RouteWorkflowSpecsInput {
  /** Absolute path to the bundle's extracted root (tmp dir from unpack). */
  bundleRoot: string;
  /** Relative workflow_spec paths declared in the manifest's workflow_specs[] block. */
  declaredWorkflowSpecs: string[];
  /** Absolute path to the operator workflow-specs library (default ~/.openrig/workflow-specs). */
  targetWorkflowSpecsDir: string;
}

/** One routed workflow_spec (or one rejection). */
export interface RoutedWorkflowSpecRecord {
  /** Declared path from manifest.workflow_specs[]. */
  declaredPath: string;
  /** "routed" = copied successfully; "missing" = source not in bundle;
   * "unsafe" = source escapes bundleRoot OR target escapes
   * targetWorkflowSpecsDir after leading-prefix strip. */
  status: "routed" | "missing" | "unsafe";
  /** Where the workflow_spec landed in the target library (absolute path), if routed. */
  installedAt?: string;
  /** Human-readable detail (3-part error shape input for caller). */
  detail?: string;
}

/** Aggregate routing result. */
export interface RouteWorkflowSpecsResult {
  records: RoutedWorkflowSpecRecord[];
  routedCount: number;
  rejectedCount: number;
}

/**
 * Route each declared workflow_spec from the bundle tree to the operator
 * workflow-specs library. Per-entry safety: BOTH source path (under
 * bundleRoot) AND target path (under targetWorkflowSpecsDir, post leading-
 * prefix strip) are containment-checked. Banked both-sides-trust-boundary
 * lesson applied. Caller writes the install audit record using the records
 * returned here.
 */
export function routeWorkflowSpecs(
  input: RouteWorkflowSpecsInput,
  fs: WorkflowSpecsRouterFsOps,
): RouteWorkflowSpecsResult {
  const records: RoutedWorkflowSpecRecord[] = [];
  const bundleRootResolved = nodePath.resolve(input.bundleRoot);
  const targetRootResolved = nodePath.resolve(input.targetWorkflowSpecsDir);
  fs.mkdirp(input.targetWorkflowSpecsDir);

  for (const declared of input.declaredWorkflowSpecs) {
    const sourceAbs = nodePath.resolve(input.bundleRoot, declared);
    // Defense-in-depth path-containment on SOURCE (mirrors skills router
    // pattern; the manifest validator already rejects unsafe paths via
    // isRelativeSafePath but we re-check here in case the input bypassed
    // validation upstream).
    if (sourceAbs !== bundleRootResolved && !sourceAbs.startsWith(bundleRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `workflow_spec path '${declared}' escapes bundle workspace; rejected`,
      });
      continue;
    }
    if (!fs.exists(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "missing",
        detail: `workflow_spec source '${declared}' not present in bundle; skipped`,
      });
      continue;
    }
    // Target path mirrors the declared path under the target workflow-specs
    // directory. Strip the leading "workflows/" prefix if present so the
    // target dir is the root of the operator's workflow-specs tree (analogue
    // of the skills router "skills/" strip).
    const declaredTrimmed = declared.startsWith("workflows/") ? declared.slice("workflows/".length) : declared;
    const targetAbs = nodePath.resolve(input.targetWorkflowSpecsDir, declaredTrimmed);
    // Defense-in-depth path-containment on TARGET (banked both-sides-of-
    // trust-boundary lesson; mirror of bundle-skills-router B1 repair
    // 595e9550). Leading prefix strip can promote a relative segment that
    // looks safe under bundleRoot (e.g. "workflows/../outside/spec.yaml"
    // passes source-containment because bundleRoot may contain
    // "outside/spec.yaml", but stripping yields "../outside/spec.yaml" which
    // would escape targetWorkflowSpecsDir). Reject if the target resolves
    // outside the target library.
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `workflow_spec target path for '${declared}' escapes target workflow-specs library; rejected`,
      });
      continue;
    }
    fs.mkdirp(nodePath.dirname(targetAbs));
    const content = fs.readFile(sourceAbs);
    fs.writeFile(targetAbs, content);
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
