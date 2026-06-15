import nodePath from "node:path";
import type Database from "better-sqlite3";
import type { LegacyRigSpec as RigSpec } from "./types.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { LegacyRigSpecCodec as RigSpecCodec } from "./rigspec-codec.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { LegacyRigSpecSchema as RigSpecSchema } from "./rigspec-schema.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import type { BootstrapRepository } from "./bootstrap-repository.js";
import type { RuntimeVerifier } from "./runtime-verifier.js";
import type { RequirementsProbeRegistry, RequirementSpec } from "./requirements-probe.js";
import type { ExternalInstallPlanner, ExternalInstallAction } from "./external-install-planner.js";
import type { ExternalInstallExecutor, TaggedAction } from "./external-install-executor.js";
import type { PackageInstallService } from "./package-install-service.js";
import type { RigInstantiator } from "./rigspec-instantiator.js";
import type { FsOps, ResolvedPackage } from "./package-resolver.js";
import { resolvePackage, type ResolveResult } from "./package-resolve-helper.js";
import type { BootstrapStatus } from "./bootstrap-types.js";
// TODO: AS-T12 — migrate to pod-aware bundle source resolver
import type { LegacyBundleSourceResolver as BundleSourceResolver, BundleResolvedSource } from "./bundle-source-resolver.js";
import type { PodBundleSourceResolver } from "./bundle-source-resolver.js";
import { unpack } from "./bundle-archive.js";
import { parsePodBundleManifest } from "./bundle-types.js";
import os from "node:os";
import fs from "node:fs";
import { getOpenRigInstallCwdError, resolveLaunchCwd } from "./cwd-resolution.js";

/** Bootstrap mode */
export type BootstrapMode = "plan" | "apply";

/** Bootstrap options */
export interface BootstrapOptions {
  mode: BootstrapMode;
  sourceRef: string;
  sourceKind?: string;
  cwdOverride?: string;
  autoApprove?: boolean;
  approvedActionKeys?: string[];
  /** Pre-created run ID (route creates run for real-time started event) */
  runId?: string;
  /** Override install target root (required for bundle install apply) */
  targetRoot?: string;
}

/** Stage result */
export interface BootstrapStageResult {
  stage: string;
  status: "ok" | "blocked" | "skipped" | "failed";
  detail: unknown;
}

/** Full bootstrap result */
export interface BootstrapResult {
  runId: string;
  status: BootstrapStatus;
  stages: BootstrapStageResult[];
  rigId?: string;
  errors: string[];
  warnings: string[];
  /** Plan-mode action keys for reviewed approval */
  actionKeys?: string[];
}

import type { PodRigInstantiator } from "./rigspec-instantiator.js";

interface BootstrapOrchestratorDeps {
  db: Database.Database;
  bootstrapRepo: BootstrapRepository;
  runtimeVerifier: RuntimeVerifier;
  probeRegistry: RequirementsProbeRegistry;
  installPlanner: ExternalInstallPlanner;
  installExecutor: ExternalInstallExecutor;
  packageInstallService: PackageInstallService;
  rigInstantiator: RigInstantiator;
  fsOps: FsOps;
  bundleSourceResolver: BundleSourceResolver | null;
  podInstantiator?: PodRigInstantiator;
  podBundleSourceResolver?: PodBundleSourceResolver;
  serviceOrchestrator?: import("./service-orchestrator.js").ServiceOrchestrator;
  rigRepo?: import("./rig-repository.js").RigRepository;
}

/** Generates a deterministic action key for plan->apply identity */
function actionKey(actionKind: string, subjectType: string | null, subjectName: string): string {
  return `${actionKind}:${subjectType ?? ""}:${subjectName}`;
}

/**
 * Top-level bootstrap workflow. Composes all Phase 5 services into a staged pipeline.
 * Transactional by stage, not globally atomic.
 */
export class BootstrapOrchestrator {
  private deps: BootstrapOrchestratorDeps;
  private activeLocks = new Set<string>();

  /** Try to acquire the lock for a sourceRef. Returns false if already locked. */
  tryAcquire(sourceRef: string): boolean {
    const key = nodePath.resolve(sourceRef);
    if (this.activeLocks.has(key)) return false;
    this.activeLocks.add(key);
    return true;
  }

  /** Release the lock for a sourceRef. */
  release(sourceRef: string): void {
    this.activeLocks.delete(nodePath.resolve(sourceRef));
  }

  constructor(deps: BootstrapOrchestratorDeps) {
    // Same-db-handle checks
    if (deps.bootstrapRepo.db !== deps.db) throw new Error("BootstrapOrchestrator: bootstrapRepo must share the same db handle");
    if (deps.runtimeVerifier.db !== deps.db) throw new Error("BootstrapOrchestrator: runtimeVerifier must share the same db handle");
    if (deps.installExecutor.db !== deps.db) throw new Error("BootstrapOrchestrator: installExecutor must share the same db handle");
    if (deps.packageInstallService.db !== deps.db) throw new Error("BootstrapOrchestrator: packageInstallService must share the same db handle");
    this.deps = deps;
  }

  async bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
    const { mode, sourceRef, autoApprove, approvedActionKeys } = opts;
    const sourceKind = opts.sourceKind ?? "rig_spec";
    const stages: BootstrapStageResult[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    // Use pre-created run or create new one
    const run = opts.runId
      ? this.deps.bootstrapRepo.getRun(opts.runId)!
      : this.deps.bootstrapRepo.createRun(sourceKind, sourceRef);
    let seqCounter = 1;

    // --- Stage 1: RESOLVE_SPEC ---
    let spec: RigSpec;
    let specDir: string;
    let bundleSource: BundleResolvedSource | null = null;
    let bundleTempDir: string | null = null;

    if (sourceKind === "rig_bundle") {
      // Peek at bundle manifest to detect schema version
      let bundleSchemaVersion = 1;
      const peekDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-peek-"));
      try {
        await unpack(sourceRef, peekDir);
        const manifestPath = nodePath.join(peekDir, "bundle.yaml");
        if (fs.existsSync(manifestPath)) {
          const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
          const raw = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;
          if (raw && raw["schema_version"] === 2) {
            bundleSchemaVersion = 2;
          }
        }
      } catch { /* peek failed — fall through to legacy */ }
      finally { try { fs.rmSync(peekDir, { recursive: true, force: true }); } catch {} }

      if (bundleSchemaVersion === 2 && this.deps.podBundleSourceResolver) {
        let podBundleTempDir: string | null = null;
        try {
          const podSource = await this.deps.podBundleSourceResolver.resolve(sourceRef);
          const rawYaml = this.deps.fsOps.readFile(podSource.specPath);
          specDir = nodePath.dirname(podSource.specPath);
          podBundleTempDir = podSource.tempDir;
          stages.push({ stage: "resolve_spec", status: "ok", detail: { specName: podSource.manifest.name, source: "pod_bundle" } });

          try {
            // Reject service-backed bundles — services require a stable source directory
            try {
              const parsed = parsePodBundleManifest(rawYaml) as Record<string, unknown>;
              if (parsed && typeof parsed === "object" && parsed["services"] && typeof parsed["services"] === "object") {
                const msg = "Service-backed rigs cannot be launched from .rigbundle archives. The services block requires a stable source directory. Use the source directory path instead: rig up <path/to/rig.yaml>";
                stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "services_unsupported", error: msg } });
                errors.push(msg);
                this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
                return { runId: run.id, status: "failed" as BootstrapStatus, stages, errors, warnings };
              }
            } catch { /* YAML parse failure — let handlePodAwareSpec deal with it */ }

            return await this.handlePodAwareSpec(opts, run, rawYaml, specDir, stages, errors, warnings);
          } finally {
            if (podBundleTempDir) this.deps.podBundleSourceResolver.cleanup(podBundleTempDir);
          }
        } catch (err) {
          const msg = (err as Error).message;
          stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "bundle_error", error: msg } });
          errors.push(msg);
          this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
          return { runId: run.id, status: "failed", stages, errors, warnings };
        }
      }

      // Legacy v1 bundle path
      if (!this.deps.bundleSourceResolver) {
        throw new Error("BundleSourceResolver required for rig_bundle source kind");
      }
      try {
        bundleSource = await this.deps.bundleSourceResolver.resolve(sourceRef);
        bundleTempDir = bundleSource.tempDir;
        specDir = nodePath.dirname(bundleSource.specPath);
        const rawYaml = this.deps.fsOps.readFile(bundleSource.specPath);
        const raw = RigSpecCodec.parse(rawYaml);
        const validation = RigSpecSchema.validate(raw);
        if (!validation.valid) {
          stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "validation_failed", errors: validation.errors } });
          this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
          return { runId: run.id, status: "failed", stages, errors: validation.errors, warnings };
        }
        spec = this.resolveLegacyNodeCwds(RigSpecSchema.normalize(raw), specDir, opts.cwdOverride);
        stages.push({ stage: "resolve_spec", status: "ok", detail: { specName: spec.name, specVersion: spec.schemaVersion, source: "rig_bundle" } });
      } catch (err) {
        const msg = (err as Error).message;
        stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "bundle_error", error: msg } });
        errors.push(msg);
        this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
        return { runId: run.id, status: "failed", stages, errors, warnings };
      }
    } else {
      // Direct rig_spec path — detect format BEFORE legacy validation
      try {
        specDir = nodePath.dirname(nodePath.resolve(sourceRef));
        const rawYaml = this.deps.fsOps.readFile(nodePath.resolve(sourceRef));
        const raw = RigSpecCodec.parse(rawYaml) as Record<string, unknown> | null;

        // Pod-aware format detection: if has pods[], delegate to PodRigInstantiator
        if (raw && Array.isArray(raw["pods"]) && this.deps.podInstantiator) {
          return this.handlePodAwareSpec(opts, run, rawYaml, specDir, stages, errors, warnings);
        }

        // Legacy path: validate as flat-node spec
        const validation = RigSpecSchema.validate(raw);
        if (!validation.valid) {
          stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "validation_failed", errors: validation.errors } });
          this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
          return { runId: run.id, status: "failed", stages, errors: validation.errors, warnings };
        }
        spec = this.resolveLegacyNodeCwds(RigSpecSchema.normalize(raw), specDir, opts.cwdOverride);
        const cwdError = spec.nodes
          .map((node) => getOpenRigInstallCwdError(node.cwd ?? specDir, opts.cwdOverride))
          .find((error): error is string => Boolean(error));
        if (cwdError) {
          stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "invalid_cwd", error: cwdError } });
          this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
          return { runId: run.id, status: "failed", stages, errors: [cwdError], warnings };
        }
        stages.push({ stage: "resolve_spec", status: "ok", detail: { specName: spec.name, specVersion: spec.schemaVersion } });
      } catch (err) {
        const msg = (err as Error).message;
        const code = (err as NodeJS.ErrnoException).code === "ENOENT" ? "file_not_found"
          : msg.includes("YAML") || msg.includes("parse") ? "parse_error"
          : "read_error";
        stages.push({ stage: "resolve_spec", status: "failed", detail: { code, error: msg } });
        errors.push(msg);
        this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
        return { runId: run.id, status: "failed", stages, errors, warnings };
      }
    }

    // Wrap remaining stages in try/finally for bundle temp cleanup (legacy path)
    try { return await this.executeStages(opts, run, spec, specDir, bundleSource, stages, errors, warnings, seqCounter); }
    finally { if (bundleTempDir && this.deps.bundleSourceResolver) this.deps.bundleSourceResolver.cleanup(bundleTempDir); }
  }

  private async executeStages(
    opts: BootstrapOptions,
    run: { id: string },
    spec: RigSpec,
    specDir: string,
    bundleSource: BundleResolvedSource | null,
    stages: BootstrapStageResult[],
    errors: string[],
    warnings: string[],
    seqCounter: number,
  ): Promise<BootstrapResult> {
    const { mode, autoApprove, approvedActionKeys } = opts;

    // --- Stage 2: RESOLVE_PACKAGES ---
    const packageRefs = new Set<string>();
    for (const node of spec.nodes) {
      if (node.packageRefs) {
        for (const ref of node.packageRefs) {
          packageRefs.add(ref);
        }
      }
    }

    const resolvedPackages: Map<string, ResolveResult & { ok: true }> = new Map();
    const unresolvedRefs: string[] = [];

    for (const ref of packageRefs) {
      // Bundle path: lookup in packageRefMap
      if (bundleSource) {
        const bundleResolved = bundleSource.packageRefMap[ref];
        if (bundleResolved) {
          resolvedPackages.set(ref, { ok: true, resolved: bundleResolved });
          continue;
        }
        // Ref not in bundle map — try local resolution as fallback
      }

      // Check for unsupported schemes
      if (ref.includes("github:") || ref.includes("://")) {
        errors.push(`Unsupported package ref scheme: '${ref}'`);
        unresolvedRefs.push(ref);
        continue;
      }

      // Strip local: prefix if present
      const cleanRef = ref.startsWith("local:") ? ref.slice(6) : ref;
      const result = resolvePackage(cleanRef, specDir, this.deps.fsOps);
      if (result.ok) {
        resolvedPackages.set(ref, result);
      } else {
        const errMsg = result.kind === "validation" ? result.errors.join("; ") : result.error;
        errors.push(`Failed to resolve package '${ref}': ${errMsg}`);
        unresolvedRefs.push(ref);
      }
    }

    if (unresolvedRefs.length > 0) {
      stages.push({ stage: "resolve_packages", status: "blocked", detail: { unresolved: unresolvedRefs, errors } });
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors, warnings };
    }
    stages.push({ stage: "resolve_packages", status: "ok", detail: { resolved: [...resolvedPackages.keys()] } });

    // --- Stage 3: VERIFY_RUNTIMES ---
    const runtimes = new Set<string>(["tmux"]);
    for (const node of spec.nodes) {
      if (node.runtime) runtimes.add(node.runtime);
    }

    const verifications = await this.deps.runtimeVerifier.verifyAll([...runtimes]);
    const runtimeBlocked: string[] = [];

    for (const v of verifications) {
      if (mode === "apply") {
        this.deps.bootstrapRepo.journalAction(run.id, seqCounter++, "runtime_check", null, v.runtime, v.status === "verified" || v.status === "degraded" ? "completed" : "failed", {
          detailJson: JSON.stringify({ version: v.version, status: v.status, error: v.error }),
        });
      }

      if (v.status === "not_found" || v.status === "error") {
        runtimeBlocked.push(v.runtime);
      }
      if (v.status === "degraded") {
        warnings.push(`${v.runtime} is degraded but not blocking`);
      }
    }

    if (runtimeBlocked.length > 0 && mode === "apply") {
      stages.push({ stage: "verify_runtimes", status: "blocked", detail: { blocked: runtimeBlocked } });
      errors.push(`Required runtimes not found: ${runtimeBlocked.join(", ")}`);
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors, warnings };
    }
    stages.push({
      stage: "verify_runtimes",
      status: runtimeBlocked.length > 0 ? "blocked" : "ok",
      detail: { verifications: verifications.map((v) => ({ runtime: v.runtime, status: v.status })) },
    });

    // --- Stage 4: PROBE_REQUIREMENTS ---
    const requirementMap = new Map<string, RequirementSpec>();
    for (const [, resolved] of resolvedPackages) {
      const manifest = resolved.resolved.manifest;
      if (manifest.requirements?.cliTools) {
        for (const tool of manifest.requirements.cliTools) {
          const key = `cli_tool:${tool.name}`;
          if (!requirementMap.has(key)) {
            requirementMap.set(key, { name: tool.name, kind: "cli_tool", installHints: tool.installHints });
          }
        }
      }
      if (manifest.requirements?.systemPackages) {
        for (const pkg of manifest.requirements.systemPackages) {
          const key = `system_package:${pkg.name}`;
          if (!requirementMap.has(key)) {
            requirementMap.set(key, { name: pkg.name, kind: "system_package" });
          }
        }
      }
    }

    const uniqueRequirements = [...requirementMap.values()];
    const probeResults = await this.deps.probeRegistry.probeAll(uniqueRequirements);

    for (const probe of probeResults) {
      if (mode === "apply") {
        this.deps.bootstrapRepo.journalAction(run.id, seqCounter++, "requirement_check", probe.kind, probe.name, "completed", {
          detailJson: JSON.stringify({ status: probe.status, detectedPath: probe.detectedPath, version: probe.version }),
        });
      }
    }

    stages.push({
      stage: "probe_requirements",
      status: "ok",
      detail: {
        probed: probeResults.length,
        results: probeResults.map((p) => ({
          name: p.name,
          kind: p.kind,
          status: p.status,
          version: p.version,
          detectedPath: p.detectedPath,
        })),
      },
    });

    // --- Stage 5: BUILD_INSTALL_PLAN ---
    const installPlan = this.deps.installPlanner.planInstalls(probeResults);

    // Check for manual_only blocking
    const hasManualOnly = installPlan.manualOnly.length > 0;

    // Build action keys for plan output
    const allActionKeys: string[] = installPlan.actions.map((a) =>
      actionKey("external_install", a.kind, a.requirementName)
    );

    stages.push({
      stage: "build_install_plan",
      status: hasManualOnly ? "blocked" : "ok",
      detail: {
        autoApprovable: installPlan.autoApprovable.length,
        manualOnly: installPlan.manualOnly.length,
        alreadyInstalled: installPlan.alreadyInstalled.length,
        actions: installPlan.actions.map((a) => ({
          key: actionKey("external_install", a.kind, a.requirementName),
          requirementName: a.requirementName,
          classification: a.classification,
          commandPreview: a.commandPreview,
          provider: a.provider,
        })),
      },
    });

    // *** PLAN MODE STOPS HERE ***
    if (mode === "plan") {
      return { runId: run.id, status: "planned", stages, errors, warnings, actionKeys: allActionKeys };
    }

    // --- APPLY MODE: Check manual_only blocks ---
    if (hasManualOnly) {
      errors.push(`${installPlan.manualOnly.length} manual-only requirements cannot be auto-installed: ${installPlan.manualOnly.map((a) => a.requirementName).join(", ")}`);
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors, warnings };
    }

    // --- Stage 6: EXECUTE_EXTERNAL_INSTALLS ---
    const taggedActions: TaggedAction[] = installPlan.actions.map((a) => {
      const key = actionKey("external_install", a.kind, a.requirementName);
      let approved = false;
      if (autoApprove && a.classification === "auto_approvable") {
        approved = true;
      } else if (approvedActionKeys?.includes(key)) {
        approved = true;
      }
      return { action: a, approved };
    });

    // Warn for unknown approved keys
    if (approvedActionKeys) {
      const validKeys = new Set(taggedActions.map((t) => actionKey("external_install", t.action.kind, t.action.requirementName)));
      for (const key of approvedActionKeys) {
        if (!validKeys.has(key)) {
          warnings.push(`Unknown approved action key ignored: '${key}'`);
        }
      }
    }

    // Block if external installs exist but none are approved
    const anyApproved = taggedActions.some((t) => t.approved);
    const hasActionableInstalls = taggedActions.some((t) => t.action.classification !== "manual_only" && t.action.commandPreview);
    if (hasActionableInstalls && !anyApproved) {
      errors.push("External installs require approval. Use --yes for auto-approvable actions, or provide approvedActionKeys.");
      stages.push({ stage: "execute_external_installs", status: "blocked", detail: { reason: "no approval provided" } });
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors, warnings };
    }

    const execSummary = await this.deps.installExecutor.execute(run.id, taggedActions, seqCounter);
    seqCounter += taggedActions.length;

    const hasExecFailures = execSummary.failed.length > 0;
    stages.push({
      stage: "execute_external_installs",
      status: hasExecFailures ? "failed" : "ok",
      detail: { completed: execSummary.completed.length, failed: execSummary.failed.length, skipped: execSummary.skipped.length },
    });

    // --- Stage 7: INSTALL_PACKAGES ---
    let packageInstallFailed = false;
    for (const [ref, resolved] of resolvedPackages) {
      const runtimesForRef = new Set<string>();
      for (const node of spec.nodes) {
        if (node.packageRefs?.includes(ref) && node.runtime) {
          runtimesForRef.add(node.runtime);
        }
      }
      // Install once per runtime that references this package
      const runtimes = runtimesForRef.size > 0 ? [...runtimesForRef] : ["claude-code"];
      for (const rt of runtimes) {
        const runtime = rt as "claude-code" | "codex";
        const outcome = this.deps.packageInstallService.install({
          resolved: resolved.resolved,
          targetRoot: opts.targetRoot ?? specDir,
          runtime,
          allowMerge: true,
          bootstrapId: run.id,
          fsOps: this.deps.fsOps,
        });

        this.deps.bootstrapRepo.journalAction(run.id, seqCounter++, "package_install", runtime, resolved.resolved.manifest.name, outcome.ok ? "completed" : "failed", {
          detailJson: JSON.stringify(outcome),
        });

        if (!outcome.ok) {
          errors.push(`Package install failed for '${ref}' (${runtime}): ${outcome.message}`);
          packageInstallFailed = true;
        }
      }
    }

    stages.push({
      stage: "install_packages",
      status: packageInstallFailed ? "failed" : "ok",
      detail: { installed: resolvedPackages.size },
    });

    // --- Stage 8: IMPORT_RIG ---
    // Skip rig import if package installs failed — a rig without its packages is broken
    if (packageInstallFailed) {
      errors.push("Rig import skipped due to package install failures");
      stages.push({ stage: "import_rig", status: "skipped", detail: { reason: "package install failures" } });
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors, warnings };
    }

    const instantiateOutcome = await this.deps.rigInstantiator.instantiate(spec);

    this.deps.bootstrapRepo.journalAction(run.id, seqCounter++, "rig_import", null, spec.name, instantiateOutcome.ok ? "completed" : "failed", {
      detailJson: JSON.stringify(instantiateOutcome),
    });

    if (!instantiateOutcome.ok) {
      errors.push(`Rig import failed: ${instantiateOutcome.code}`);
      stages.push({ stage: "import_rig", status: "failed", detail: instantiateOutcome });
      const finalStatus: BootstrapStatus = hasExecFailures || packageInstallFailed ? "partial" : "failed";
      this.deps.bootstrapRepo.updateRunStatus(run.id, finalStatus);
      return { runId: run.id, status: finalStatus, stages, errors, warnings };
    }

    stages.push({ stage: "import_rig", status: "ok", detail: instantiateOutcome.result });
    if (instantiateOutcome.result.warnings?.length) {
      warnings.push(...instantiateOutcome.result.warnings);
    }

    // --- DONE ---
    const finalStatus: BootstrapStatus = hasExecFailures || packageInstallFailed ? "partial" : "completed";
    this.deps.bootstrapRepo.updateRunStatus(run.id, finalStatus, { rigId: instantiateOutcome.result.rigId });

    return {
      runId: run.id,
      status: finalStatus,
      stages,
      rigId: instantiateOutcome.result.rigId,
      errors,
      warnings,
    };
  }

  // -- Pod-aware bootstrap path --

  private async handlePodAwareSpec(
    opts: BootstrapOptions,
    run: { id: string },
    rigSpecYaml: string,
    specDir: string,
    stages: BootstrapStageResult[],
    errors: string[],
    warnings: string[],
  ): Promise<BootstrapResult> {
    const { mode } = opts;
    const podInstantiator = this.deps.podInstantiator!;
    const rigRoot = specDir;

    if (mode === "plan") {
      // Plan mode: validate + preflight only
      const { rigPreflight } = await import("./rigspec-preflight.js");
      const { RigSpecCodec: PodCodec } = await import("./rigspec-codec.js");
      const { RigSpecSchema: PodSchema } = await import("./rigspec-schema.js");

      try {
        const raw = PodCodec.parse(rigSpecYaml);
        const validation = PodSchema.validate(raw);
        if (!validation.valid) {
          stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "validation_failed", errors: validation.errors } });
          this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
          return { runId: run.id, status: "failed", stages, errors: validation.errors, warnings };
        }
        const spec = PodSchema.normalize(raw as Record<string, unknown>);
        stages.push({ stage: "resolve_spec", status: "ok", detail: { specName: spec.name, specVersion: spec.version } });

        const { execSync } = await import("node:child_process");
        const execFn = async (cmd: string) => execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
        const preflight = await rigPreflight({ rigSpecYaml, rigRoot, cwdOverride: opts.cwdOverride, fsOps: podInstantiator["deps"].fsOps, exec: execFn });

        stages.push({
          stage: "preflight",
          status: preflight.ready ? "ok" : "blocked",
          detail: { errors: preflight.errors, warnings: preflight.warnings },
        });

        this.deps.bootstrapRepo.updateRunStatus(run.id, preflight.ready ? "planned" : "failed");
        return {
          runId: run.id,
          status: preflight.ready ? "planned" : "failed",
          stages,
          errors: preflight.errors,
          warnings: preflight.warnings,
        };
      } catch (err) {
        stages.push({ stage: "resolve_spec", status: "failed", detail: { error: (err as Error).message } });
        this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
        return { runId: run.id, status: "failed", stages, errors: [(err as Error).message], warnings };
      }
    }

    // Apply mode: full instantiation via PodRigInstantiator
    // If services exist, the prelaunch hook boots them between topology creation and node launch
    const prelaunchHook = await this.buildServicePrelaunchHook(rigSpecYaml, rigRoot, stages, errors);
    const outcome = await podInstantiator.instantiate(rigSpecYaml, rigRoot, { cwdOverride: opts.cwdOverride, prelaunchHook });

    if (!outcome.ok) {
      // OPR.0.3.2.CT — attention_required is a recoverable outcome
      // (rig + sessions preserved). Surface it distinctly from terminal
      // failure so the route can return a 3-part error pointing the
      // operator at the approve→resume path. The bootstrap run status
      // is `partial` (not `failed`) because the rig exists and is
      // operator-actionable.
      if (outcome.code === "attention_required") {
        const attentionMsg = (outcome as { message: string }).message;
        const attentionNodes = (outcome as { attentionNodes: import("./types.js").AttentionNode[] }).attentionNodes;
        stages.push({
          stage: "import_rig",
          status: "blocked",
          detail: {
            code: "attention_required",
            message: attentionMsg,
            attentionNodes,
          },
        });
        this.deps.bootstrapRepo.updateRunStatus(run.id, "partial", { rigId: (outcome as { rigId: string }).rigId });
        return {
          runId: run.id,
          status: "partial",
          stages,
          rigId: (outcome as { rigId: string }).rigId,
          errors: [attentionMsg],
          warnings,
        };
      }
      const outErrors = outcome.code === "validation_failed" || outcome.code === "preflight_failed"
        ? (outcome as { errors: string[] }).errors
        : [(outcome as { message: string }).message];
      const outWarnings = (outcome as { warnings?: string[] }).warnings ?? [];
      stages.push({ stage: "import_rig", status: "failed", detail: { code: outcome.code } });
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors: outErrors, warnings: outWarnings };
    }

    const result = outcome.result;
    const anyFailed = result.nodes.some((n) => n.status === "failed");
    const anyAttention = result.nodes.some((n) => n.status === "attention_required");

    // OPR.0.3.2.CT (guard verdict qitem-20260518082933 BLOCKER 1):
    // attention_required nodes are recoverable but NOT done — the
    // launch is partial and the operator needs the same approve→resume
    // surface the all-attention path already gets. Treating mixed
    // launched+attention as "completed" would hide the parked seat
    // behind a 201 success response. finalStatus is partial whenever
    // any node is failed OR attention_required; the import_rig stage
    // is "blocked" (not "ok") with attentionNodes detail so the route
    // can build the 3-part error from the same path the all-attention
    // case uses.
    const finalStatus: BootstrapStatus = anyFailed || anyAttention ? "partial" : "completed";

    if (anyAttention) {
      const attentionNodes: import("./types.js").AttentionNode[] = result.nodes
        .filter((n) => n.status === "attention_required")
        .map((n) => ({
          logicalId: n.logicalId,
          sessionName: n.sessionName ?? "",
          evidence: n.evidence,
          reason: n.error ?? "node awaiting attention",
        }));
      const message = `${attentionNodes.length} node${attentionNodes.length === 1 ? "" : "s"} require attention before becoming interactive (rig parked, NOT failed; approve and resume to proceed).`;
      stages.push({
        stage: "import_rig",
        status: "blocked",
        detail: {
          code: "attention_required",
          message,
          rigId: result.rigId,
          specName: result.specName,
          nodes: result.nodes,
          attentionNodes,
        },
      });
    } else {
      stages.push({
        stage: "import_rig",
        status: anyFailed ? "failed" : "ok",
        detail: { rigId: result.rigId, specName: result.specName, nodes: result.nodes },
      });
    }
    if (result.warnings?.length) {
      warnings.push(...result.warnings);
    }

    this.deps.bootstrapRepo.updateRunStatus(run.id, finalStatus);
    return {
      runId: run.id,
      status: finalStatus,
      stages,
      rigId: result.rigId,
      errors: result.nodes.filter((n) => n.error).map((n) => n.error!),
      warnings,
    };
  }

  /**
   * Build a prelaunch hook for the service gate. Returns undefined if no services
   * are configured or no ServiceOrchestrator is available.
   */
  private async buildServicePrelaunchHook(
    rigSpecYaml: string,
    rigRoot: string,
    stages: BootstrapStageResult[],
    errors: string[],
  ): Promise<((rigId: string) => Promise<{ ok: true } | { ok: false; code: string; message: string }>) | undefined> {
    if (!this.deps.serviceOrchestrator || !this.deps.rigRepo) return undefined;

    // Parse and normalize via the canonical pod-aware codec/schema path
    let normalizedSpec: import("./types.js").RigSpec;
    try {
      const { RigSpecCodec: PodCodec } = await import("./rigspec-codec.js");
      const { RigSpecSchema: PodSchema } = await import("./rigspec-schema.js");
      const raw = PodCodec.parse(rigSpecYaml);
      const validation = PodSchema.validate(raw);
      if (!validation.valid) return undefined;
      normalizedSpec = PodSchema.normalize(raw as Record<string, unknown>);
    } catch {
      return undefined;
    }

    if (!normalizedSpec.services || normalizedSpec.services.kind !== "compose") return undefined;

    const serviceOrch = this.deps.serviceOrchestrator;
    const rigRepo = this.deps.rigRepo;
    const services = normalizedSpec.services;
    const rigName = normalizedSpec.name;

    return async (rigId: string) => {
      // Persist services record for the now-created rig
      const { deriveComposeProjectName } = await import("./compose-project-name.js");
      const composeFile = nodePath.resolve(rigRoot, services.composeFile);
      const projectName = services.projectName ?? deriveComposeProjectName(rigName);

      rigRepo.setServicesRecord(rigId, {
        kind: "compose",
        specJson: JSON.stringify(services),
        rigRoot,
        composeFile,
        projectName,
      });

      // Boot services — strict health gate before any agent launch
      const bootResult = await serviceOrch.boot(rigId);

      if (!bootResult.ok) {
        errors.push(`Service boot failed: ${bootResult.error}`);
        stages.push({
          stage: "service_boot",
          status: "failed",
          detail: { code: bootResult.code, error: bootResult.error, receipt: bootResult.receipt },
        });
        // OPR.0.3.2.22 Bug 2 follow-up — serviceOrch.boot can already have
        // started compose resources before failing during status/wait. The
        // PodRigInstantiator will delete the rig record next, which cascades
        // away rig_services and the normal teardown handle — so any
        // already-started compose containers would orphan. Tear them down
        // here best-effort while the rig handle still exists. Teardown
        // errors are swallowed so they cannot mask the boot failure that
        // is the load-bearing return.
        try {
          await serviceOrch.teardown(rigId);
        } catch {
          // Best-effort. If teardown also fails, the boot-failure error
          // is what the operator needs; manual `docker compose down`
          // remains available with the compose file path from the spec.
        }
        return { ok: false, code: "service_boot_failed", message: `Service boot failed: ${bootResult.error}` };
      }

      stages.push({
        stage: "service_boot",
        status: "ok",
        detail: { receipt: bootResult.receipt, health: bootResult.health },
      });
      return { ok: true };
    };
  }

  private resolveLegacyNodeCwds(spec: RigSpec, specRoot: string, cwdOverride?: string): RigSpec {
    return {
      ...spec,
      nodes: spec.nodes.map((node) => ({
        ...node,
        cwd: resolveLaunchCwd(node.cwd, specRoot, cwdOverride),
      })),
    };
  }
}
