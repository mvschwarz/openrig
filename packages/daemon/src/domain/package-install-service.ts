import type { PackageRepository } from "./package-repository.js";
import type { InstallRepository } from "./install-repository.js";
import type { InstallEngine, InstallResult } from "./install-engine.js";
import type { InstallVerifier } from "./install-verifier.js";
import type { ResolvedPackage, FsOps } from "./package-resolver.js";
import { InstallPlanner } from "./install-planner.js";
import { detectConflicts } from "./conflict-detector.js";
import { applyPolicy } from "./install-policy.js";

export type PackageInstallOutcome =
  | { ok: true; installId: string; packageId: string; applied: number; deferred: number }
  | { ok: false; code: "conflict_blocked"; message: string }
  | { ok: false; code: "policy_rejected"; message: string }
  | { ok: false; code: "manifest_hash_mismatch"; message: string }
  | { ok: false; code: "apply_error"; message: string }
  | { ok: false; code: "verification_failed"; message: string };

interface PackageInstallOpts {
  resolved: ResolvedPackage;
  targetRoot: string;
  runtime: "claude-code" | "codex";
  roleName?: string;
  allowMerge?: boolean;
  bootstrapId?: string;
  fsOps: FsOps;
}

interface PackageInstallServiceDeps {
  packageRepo: PackageRepository;
  installRepo: InstallRepository;
  installEngine: InstallEngine;
  installVerifier: InstallVerifier;
}

/**
 * Reusable package install pipeline. Composes resolve -> plan -> detect -> policy -> dedup -> apply -> verify.
 * Used by both the packages route and the bootstrap orchestrator.
 */
export class PackageInstallService {
  readonly db: import("better-sqlite3").Database;
  private packageRepo: PackageRepository;
  private installEngine: InstallEngine;
  private installVerifier: InstallVerifier;

  constructor(deps: PackageInstallServiceDeps) {
    this.db = deps.packageRepo.db;
    if (deps.installRepo.db !== this.db) throw new Error("PackageInstallService: installRepo must share the same db handle");
    this.packageRepo = deps.packageRepo;
    this.installEngine = deps.installEngine;
    this.installVerifier = deps.installVerifier;
  }

  /**
   * Run the full install pipeline for a single resolved package.
   */
  install(opts: PackageInstallOpts): PackageInstallOutcome {
    const { resolved, targetRoot, runtime, roleName, allowMerge, bootstrapId, fsOps } = opts;

    // Plan + detect conflicts
    const planner = new InstallPlanner(fsOps);
    const plan = planner.plan(resolved, targetRoot, runtime, { roleName });
    const refined = detectConflicts(plan, fsOps);

    // Check for content-level conflicts
    if (refined.conflicts.length > 0) {
      return { ok: false, code: "conflict_blocked", message: `${refined.conflicts.length} unresolved conflicts` };
    }

    // Apply policy
    const policyResult = applyPolicy(refined, { allowMerge: allowMerge ?? false });

    if (policyResult.approved.length === 0) {
      return { ok: false, code: "policy_rejected", message: "No entries approved by policy" };
    }

    // Dedup package record
    const existing = this.packageRepo.findByNameVersion(resolved.manifest.name, resolved.manifest.version);
    if (existing && existing.manifestHash !== resolved.manifestHash) {
      return { ok: false, code: "manifest_hash_mismatch", message: `Package already registered with different content` };
    }
    const pkg = existing ?? this.packageRepo.createPackage({
      name: resolved.manifest.name,
      version: resolved.manifest.version,
      sourceKind: resolved.sourceKind,
      sourceRef: resolved.sourceRef,
      manifestHash: resolved.manifestHash,
      summary: resolved.manifest.summary,
    });

    // Apply
    let result: InstallResult;
    try {
      result = this.installEngine.apply(policyResult, refined, pkg.id, targetRoot, bootstrapId);
    } catch (err) {
      return { ok: false, code: "apply_error", message: (err as Error).message };
    }

    // Verify
    const verification = this.installVerifier.verify(result.installId);
    if (!verification.passed) {
      return { ok: false, code: "verification_failed", message: "Post-apply verification failed" };
    }

    return {
      ok: true,
      installId: result.installId,
      packageId: pkg.id,
      applied: result.applied.length,
      deferred: result.deferred.length,
    };
  }
}
