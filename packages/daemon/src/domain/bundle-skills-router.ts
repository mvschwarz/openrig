/**
 * Bundle skills router (Item 6 / slice-05 Checkpoint 7.2).
 *
 * Pure function. Copies skill files declared in a bundle manifest's skills[]
 * block from the bundle's extracted tree to the operator skills library.
 * No daemon dependencies — fully unit-testable via FsOps injection.
 *
 * Safety: each declared skill path is treated as untrusted manifest content;
 * the helper rejects paths that escape the bundle tree (path containment
 * check mirrors the bundle-source-resolver pattern). The output target
 * directory is created via mkdirp.
 *
 * Honest-scoping: missing source files surface as warnings in the result
 * (NOT thrown errors) so the install lifecycle can continue with what's
 * available. Same for absent skills library: caller decides to skip-or-fail.
 *
 * /install handler integration lands at Checkpoint 7.3.
 */

import nodePath from "node:path";

/** Filesystem injection point — real impl wraps node:fs. Tests substitute in-memory. */
export interface SkillsRouterFsOps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  mkdirp: (path: string) => void;
}

/** Inputs to routeSkills. */
export interface RouteSkillsInput {
  /** Absolute path to the bundle's extracted root (tmp dir from unpack). */
  bundleRoot: string;
  /** Relative skill paths declared in the manifest's skills[] block. */
  declaredSkills: string[];
  /** Absolute path to the operator skills library (default ~/.openrig/skills). */
  targetSkillsDir: string;
}

/** One routed skill (or one rejection). */
export interface RoutedSkillRecord {
  /** Declared path from manifest.skills[]. */
  declaredPath: string;
  /** "routed" = copied successfully; "missing" = source not in bundle;
   * "unsafe" = escapes bundle workspace; "no_library" = target dir not
   * present and caller did not request creation (reserved for future
   * library-reachability mode). */
  status: "routed" | "missing" | "unsafe";
  /** Where the skill landed in the target library (absolute path), if routed. */
  installedAt?: string;
  /** Human-readable detail (3-part error shape input for caller). */
  detail?: string;
}

/** Aggregate routing result. */
export interface RouteSkillsResult {
  records: RoutedSkillRecord[];
  routedCount: number;
  rejectedCount: number;
}

/**
 * Route each declared skill from the bundle tree to the operator skills
 * library. Per-skill safety: resolved source path must stay inside bundleRoot;
 * skipped if missing from bundle. Caller writes the install audit record
 * (Item 4 chain) using the records returned here.
 */
export function routeSkills(input: RouteSkillsInput, fs: SkillsRouterFsOps): RouteSkillsResult {
  const records: RoutedSkillRecord[] = [];
  const bundleRootResolved = nodePath.resolve(input.bundleRoot);
  const targetRootResolved = nodePath.resolve(input.targetSkillsDir);
  fs.mkdirp(input.targetSkillsDir);

  for (const declared of input.declaredSkills) {
    const sourceAbs = nodePath.resolve(input.bundleRoot, declared);
    // Defense-in-depth path-containment on SOURCE (mirrors bundle-source-
    // resolver pattern; the manifest validator already rejects unsafe paths
    // via isRelativeSafePath but we re-check here in case the input bypassed
    // validation upstream).
    if (sourceAbs !== bundleRootResolved && !sourceAbs.startsWith(bundleRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `skill path '${declared}' escapes bundle workspace; rejected`,
      });
      continue;
    }
    if (!fs.exists(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "missing",
        detail: `skill source '${declared}' not present in bundle; skipped`,
      });
      continue;
    }
    // Target path mirrors the declared path under the target skills directory.
    // Operator's skill library inherits the bundle's directory layout for the
    // declared skills (e.g., skills/foo/SKILL.md → <target>/foo/SKILL.md);
    // strip the leading "skills/" prefix if present so the target dir is the
    // root of the operator's skill tree.
    const declaredTrimmed = declared.startsWith("skills/") ? declared.slice("skills/".length) : declared;
    const targetAbs = nodePath.resolve(input.targetSkillsDir, declaredTrimmed);
    // Defense-in-depth path-containment on TARGET (B1 repair on
    // qitem-20260518215234-f84fff45). The leading "skills/" strip can promote
    // a relative segment that looks safe under bundleRoot (e.g.
    // "skills/../outside/SKILL.md" passes source-containment because the bundle
    // tree may contain "outside/SKILL.md", but stripping yields
    // "../outside/SKILL.md" which would escape targetSkillsDir). Reject if the
    // target resolves outside the target library. Banked lesson:
    // feedback_pre_existing_trust_boundary_reuse_canonical_helper — contain
    // BOTH source and target when handling untrusted path input.
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `skill target path for '${declared}' escapes target skills library; rejected`,
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
