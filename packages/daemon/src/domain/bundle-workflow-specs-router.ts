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
  /** Byte-for-byte copy; routed files are never decoded. */
  copyFile: (src: string, dest: string) => void;
  mkdirp: (path: string) => void;
}

/** Inputs to routeWorkflowSpecs. */
export interface RouteWorkflowSpecsInput {
  /** Absolute path to the bundle's extracted root (tmp dir from unpack). */
  bundleRoot: string;
  /** Relative workflow_spec paths declared in the manifest's workflow_specs[] block. */
  declaredWorkflowSpecs: string[];
  /**
   * Absolute path to the operator workflow-specs library that the
   * spec-library-workflow-scanner ACTUALLY reads from. **CALLER CONTRACT**:
   * this MUST be exactly
   *   `nodePath.join(ContextPackSettingsStore.resolveConfig().workspaceSpecsRoot, "workflows")`
   * — the folder discovered by `scanWorkflowSpecFolder` in
   * `packages/daemon/src/domain/spec-library-workflow-scanner.ts:320-342`
   * and exposed via `deps.workflowsFolderDir` in
   * `packages/daemon/src/startup.ts:903-916`. SettingsStore is the sole
   * authority for the actual operator-host path; do NOT hardcode a default
   * here — settings layering (env > config > workspace-default) can shift
   * the resolved root, so any literal default repeated in this comment
   * would be a drift hazard. Writing anywhere else will succeed silently
   * but be invisible to the live workflow scanner — operator dead-end.
   * The /install integration helper (Checkpoint 7.3e step 3) MUST resolve
   * this path via the SettingsStore call shown above before invoking
   * routeWorkflowSpecs.
   */
  targetWorkflowSpecsDir: string;
}

/** One routed workflow_spec (or one rejection). */
export interface RoutedWorkflowSpecRecord {
  /** Declared path from manifest.workflow_specs[]. */
  declaredPath: string;
  /** "routed" = copied successfully and scanner-visible.
   * "missing" = source not in bundle (honest skip).
   * "unsafe" = source escapes bundleRoot OR declared path has a non-YAML
   * suffix the scanner will ignore (operator-invisible-by-construction).
   * "conflict" = basename collision with an earlier routed entry — only
   * the first such declared path is written; later ones flagged so the
   * routed count stays truthful at the scanner-visible boundary (mirror
   * of the slice's broader 3-part collision-error posture). */
  status: "routed" | "missing" | "unsafe" | "conflict";
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
  // Track basenames already routed so duplicate-basename collisions (after
  // the basename-flatten) surface as conflict records rather than silent
  // overwrites with a false routedCount (banked B1 guard catch on d81456dc).
  const routedBasenames = new Set<string>();

  for (const declared of input.declaredWorkflowSpecs) {
    // Scanner-visibility prefilter: spec-library-workflow-scanner reads only
    // .yaml/.yml top-level files (spec-library-workflow-scanner.ts:366 +
    // 390-397). Non-YAML declarations would route to disk but be invisible
    // to the operator via the Library UI — false-positive class. Reject
    // here so the routedCount stays truthful at the scanner-visible
    // boundary.
    if (!/\.ya?ml$/i.test(declared)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `workflow_spec '${declared}' is not a .yaml/.yml file; scanner ignores non-YAML suffixes`,
      });
      continue;
    }
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
    // Target = top-level basename under targetWorkflowSpecsDir.
    //
    // SCANNER-REACHABILITY CONTRACT: spec-library-workflow-scanner reads
    // ONLY top-level YAML files via readdirSync(folder) + isFile() (see
    // spec-library-workflow-scanner.ts:382-397) — no recursion. Nested
    // YAML inside subdirs is INVISIBLE to the scanner and Library UI.
    // Workflow specs MUST land at the top of <workspace.specs_root>/workflows
    // to become operator-visible. Basename-only target computation enforces
    // this; preserving the bundle's directory layout would silently route
    // specs to an unscanned location.
    //
    // Side benefit: basename can never escape targetWorkflowSpecsDir
    // (nodePath.basename(any-path) is a leaf name with no separators), so
    // the "target-side escape after prefix strip" hazard banked on the
    // skills router (595e9550 B1 repair) is structurally impossible here.
    //
    // Basename collisions caught BEFORE write: see the routedBasenames
    // dedup-set + the basename-collision branch below. Two declared paths
    // sharing the same filename → first wins (status=routed), later flagged
    // status=conflict so routedCount stays truthful at the scanner-visible
    // boundary (mirror of the slice's 3-part collision-error posture).
    // Non-YAML suffixes are pre-filtered (status=unsafe) since the scanner
    // ignores non-.yaml/.yml entries entirely.
    const basename = nodePath.basename(declared);
    const targetAbs = nodePath.resolve(input.targetWorkflowSpecsDir, basename);
    // Sanity check (defensive; basename is structurally safe but the resolve
    // could in theory be a no-op for "" → keep the check, expected always-true).
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `workflow_spec target path for '${declared}' escapes target workflow-specs library; rejected`,
      });
      continue;
    }
    // Basename-collision detection: two declared paths that share a
    // basename would both target the same file after basename-flatten. Only
    // the FIRST is written; later ones surface as conflict records so the
    // routedCount equals scanner-visible specs (banked B1 guard catch on
    // d81456dc). Operator-actionable: rename the declared path or curate
    // the bundle manifest.
    if (routedBasenames.has(basename)) {
      records.push({
        declaredPath: declared,
        status: "conflict",
        detail: `workflow_spec basename '${basename}' collides with an earlier declared path; only the first is routed (basename-flatten conflict)`,
      });
      continue;
    }
    fs.copyFile(sourceAbs, targetAbs);
    routedBasenames.add(basename);
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
