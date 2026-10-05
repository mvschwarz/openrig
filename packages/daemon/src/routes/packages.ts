import fs from "node:fs";
import nodePath from "node:path";
import { Hono } from "hono";
import type { PackageRepository } from "../domain/package-repository.js";
import type { InstallRepository } from "../domain/install-repository.js";
import type { InstallEngine } from "../domain/install-engine.js";
import type { InstallVerifier } from "../domain/install-verifier.js";
import { InstallPlanner } from "../domain/install-planner.js";
import { detectConflicts } from "../domain/conflict-detector.js";
import { applyPolicy } from "../domain/install-policy.js";
import type { FsOps } from "../domain/package-resolver.js";
import type { EngineFsOps } from "../domain/install-engine.js";
import type { EventBus } from "../domain/event-bus.js";
import { resolvePackage } from "../domain/package-resolve-helper.js";

export const packagesRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    packageRepo: c.get("packageRepo" as never) as PackageRepository,
    installRepo: c.get("installRepo" as never) as InstallRepository,
    installEngine: c.get("installEngine" as never) as InstallEngine,
    installVerifier: c.get("installVerifier" as never) as InstallVerifier,
    eventBus: c.get("eventBus" as never) as EventBus,
  };
}

function realFsOps(): FsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    listFiles: (dirPath) => {
      const results: string[] = [];
      function walk(dir: string, prefix: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            walk(nodePath.join(dir, entry.name), nodePath.join(prefix, entry.name));
          } else {
            results.push(prefix ? nodePath.join(prefix, entry.name) : entry.name);
          }
        }
      }
      walk(dirPath, "");
      return results;
    },
  };
}

function realEngineFsOps(): EngineFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (src, dest) => fs.copyFileSync(src, dest),
    deleteFile: (p) => fs.unlinkSync(p),
  };
}

// POST /api/packages/validate
packagesRoutes.post("/validate", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";
  const cwd = typeof body["cwd"] === "string" ? body["cwd"] : undefined;

  if (!sourceRef) {
    return c.json({ valid: false, error: "sourceRef is required" }, 400);
  }

  const result = resolvePackage(sourceRef, cwd, realFsOps());
  if (!result.ok) {
    if (result.kind === "validation") {
      return c.json({ valid: false, errors: result.errors }, 400);
    }
    return c.json({ valid: false, error: result.error }, 400);
  }

  const m = result.resolved.manifest;
  const { eventBus } = getDeps(c);
  eventBus.emit({ type: "package.validated", packageName: m.name, valid: true });

  return c.json({
    valid: true,
    manifest: {
      name: m.name,
      version: m.version,
      summary: m.summary,
      runtimes: m.compatibility.runtimes,
      exportCounts: {
        skills: m.exports.skills?.length ?? 0,
        guidance: m.exports.guidance?.length ?? 0,
        agents: m.exports.agents?.length ?? 0,
        hooks: m.exports.hooks?.length ?? 0,
        mcp: m.exports.mcp?.length ?? 0,
      },
      roles: m.roles?.map((r) => ({ name: r.name, description: r.description })) ?? [],
      requirements: m.requirements ? {
        cliTools: m.requirements.cliTools?.map((t) => ({ name: t.name })) ?? [],
        systemPackages: m.requirements.systemPackages?.map((p) => ({ name: p.name })) ?? [],
      } : { cliTools: [], systemPackages: [] },
    },
  });
});

// POST /api/packages/plan
packagesRoutes.post("/plan", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";
  const cwd = typeof body["cwd"] === "string" ? body["cwd"] : undefined;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : "";
  const runtimeInput = typeof body["runtime"] === "string" ? body["runtime"] : "claude-code";
  if (runtimeInput !== "claude-code" && runtimeInput !== "codex") {
    return c.json({ error: `Unknown runtime: '${runtimeInput}'. Must be 'claude-code' or 'codex'` }, 400);
  }
  const runtime = runtimeInput as "claude-code" | "codex";
  const roleName = typeof body["roleName"] === "string" ? body["roleName"] : undefined;
  const allowMerge = body["allowMerge"] === true;

  if (!sourceRef || !targetRoot) {
    return c.json({ error: "sourceRef and targetRoot are required" }, 400);
  }

  const fsOps = realFsOps();
  const result = resolvePackage(sourceRef, cwd, fsOps);
  if (!result.ok) {
    if (result.kind === "validation") {
      return c.json({ error: "Invalid manifest", errors: result.errors }, 400);
    }
    return c.json({ error: result.error }, 400);
  }

  let plan, refined, policyResult;
  try {
    const planner = new InstallPlanner(fsOps);
    plan = planner.plan(result.resolved, targetRoot, runtime, { roleName });
    refined = detectConflicts(plan, fsOps);
    policyResult = applyPolicy(refined, { allowMerge });
  } catch (err) {
    return c.json({ error: (err as Error).message, code: "plan_error" }, 400);
  }

  // Build a set of approved entry keys for annotation
  const approvedKeys = new Set(policyResult.approved.map((e) => `${e.exportType}:${e.exportName}`));
  const rejectedKeys = new Set(policyResult.rejected.map((r) => `${r.entry.exportType}:${r.entry.exportName}`));
  const noOpKeys = new Set(refined.noOps.map((e) => `${e.exportType}:${e.exportName}`));
  const conflictKeys = new Set(refined.conflicts.map((e) => `${e.exportType}:${e.exportName}`));

  const annotatedEntries = refined.entries.map((e) => {
    const key = `${e.exportType}:${e.exportName}`;
    let policyStatus: string;
    if (noOpKeys.has(key)) policyStatus = "noop";
    else if (conflictKeys.has(key)) policyStatus = "conflict";
    else if (e.deferred) policyStatus = "deferred";
    else if (approvedKeys.has(key)) policyStatus = "approved";
    else if (rejectedKeys.has(key)) policyStatus = "rejected";
    else policyStatus = "unknown";
    return { ...e, policyStatus };
  });

  const { eventBus } = getDeps(c);
  eventBus.emit({
    type: "package.planned",
    packageName: refined.packageName,
    actionable: policyResult.approved.length,
    deferred: refined.deferred.length,
    conflicts: refined.conflicts.length,
  });

  return c.json({
    packageName: refined.packageName,
    packageVersion: refined.packageVersion,
    entries: annotatedEntries,
    actionable: policyResult.approved.length,
    deferred: refined.deferred.length,
    conflicts: refined.conflicts.length,
    noOps: refined.noOps.length,
    rejected: policyResult.rejected.length,
  });
});

// POST /api/packages/install
packagesRoutes.post("/install", async (c) => {
  const { packageRepo, installEngine, installVerifier } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";
  const cwd = typeof body["cwd"] === "string" ? body["cwd"] : undefined;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : "";
  const installRuntimeInput = typeof body["runtime"] === "string" ? body["runtime"] : "claude-code";
  if (installRuntimeInput !== "claude-code" && installRuntimeInput !== "codex") {
    return c.json({ error: `Unknown runtime: '${installRuntimeInput}'. Must be 'claude-code' or 'codex'` }, 400);
  }
  const runtime = installRuntimeInput as "claude-code" | "codex";
  const roleName = typeof body["roleName"] === "string" ? body["roleName"] : undefined;
  const allowMerge = body["allowMerge"] === true;

  if (!sourceRef || !targetRoot) {
    return c.json({ error: "sourceRef and targetRoot are required" }, 400);
  }

  // Resolve with structured error handling
  const fsOps = realFsOps();
  const resolveResult = resolvePackage(sourceRef, cwd, fsOps);
  if (!resolveResult.ok) {
    if (resolveResult.kind === "validation") {
      return c.json({ error: "Invalid manifest", errors: resolveResult.errors }, 400);
    }
    return c.json({ error: resolveResult.error }, 400);
  }
  const resolved = resolveResult.resolved;

  // Plan + detect conflicts
  let plan, refined;
  try {
    const planner = new InstallPlanner(fsOps);
    plan = planner.plan(resolved, targetRoot, runtime, { roleName });
    refined = detectConflicts(plan, fsOps);
  } catch (err) {
    return c.json({ error: (err as Error).message, code: "plan_error" }, 400);
  }

  const { eventBus } = getDeps(c);

  // Check for content-level conflicts
  if (refined.conflicts.length > 0) {
    eventBus.emit({ type: "package.install_failed", packageName: resolved.manifest.name, code: "conflict_blocked", message: `${refined.conflicts.length} unresolved conflicts` });
    return c.json({
      error: "Unresolved conflicts",
      code: "conflict_blocked",
      conflicts: refined.conflicts.map((e) => e.conflict!),
    }, 409);
  }

  // Apply policy
  const policyResult = applyPolicy(refined, { allowMerge });

  // If nothing approved → 422
  if (policyResult.approved.length === 0) {
    eventBus.emit({ type: "package.install_failed", packageName: resolved.manifest.name, code: "policy_rejected", message: "No entries approved by policy" });
    return c.json({
      error: "No entries approved by policy",
      code: "policy_rejected",
      rejected: policyResult.rejected,
    }, 422);
  }

  // Dedup package record — verify manifest hash matches if reusing
  const existing = packageRepo.findByNameVersion(resolved.manifest.name, resolved.manifest.version);
  if (existing && existing.manifestHash !== resolved.manifestHash) {
    eventBus.emit({ type: "package.install_failed", packageName: resolved.manifest.name, code: "manifest_hash_mismatch", message: "Package already registered with different content" });
    return c.json({
      error: `Package '${resolved.manifest.name}' v${resolved.manifest.version} already registered with different content (manifest hash mismatch)`,
      code: "manifest_hash_mismatch",
      existingHash: existing.manifestHash,
      currentHash: resolved.manifestHash,
    }, 409);
  }
  const pkg = existing ?? packageRepo.createPackage({
    name: resolved.manifest.name,
    version: resolved.manifest.version,
    sourceKind: resolved.sourceKind,
    sourceRef: resolved.sourceRef,
    manifestHash: resolved.manifestHash,
    summary: resolved.manifest.summary,
  });

  // Apply
  let result;
  try {
    result = installEngine.apply(policyResult, refined, pkg.id, targetRoot);
  } catch (err) {
    eventBus.emit({ type: "package.install_failed", packageName: resolved.manifest.name, code: "apply_error", message: (err as Error).message });
    return c.json({ error: (err as Error).message, code: "apply_error" }, 500);
  }

  // Verify
  const verification = installVerifier.verify(result.installId);
  if (!verification.passed) {
    eventBus.emit({ type: "package.install_failed", packageName: resolved.manifest.name, code: "verification_failed", message: "Post-apply verification failed" });
    return c.json({
      error: "Post-apply verification failed",
      code: "verification_failed",
      installId: result.installId,
      verification,
    }, 500);
  }

  eventBus.emit({
    type: "package.installed",
    packageName: resolved.manifest.name,
    packageVersion: resolved.manifest.version,
    installId: result.installId,
    applied: result.applied.length,
    deferred: result.deferred.length,
  });

  return c.json({
    installId: result.installId,
    packageId: pkg.id,
    packageName: resolved.manifest.name,
    applied: result.applied,
    deferred: result.deferred,
    conflicts: result.conflicts,
    verification,
    ...(policyResult.rejected.length > 0 ? { policyRejected: policyResult.rejected } : {}),
  }, 201);
});

// POST /api/packages/:installId/rollback
packagesRoutes.post("/:installId/rollback", async (c) => {
  const { installEngine, installRepo } = getDeps(c);
  const installId = c.req.param("installId")!;

  const install = installRepo.getInstall(installId);
  if (!install) {
    return c.json({ error: "Install not found" }, 404);
  }

  if (install.status !== "applied") {
    return c.json({ error: "Install is not in applied state", code: "not_applied", status: install.status }, 409);
  }

  try {
    const result = installEngine.rollback(installId);
    const { eventBus } = getDeps(c);
    eventBus.emit({ type: "package.rolledback", installId, restored: result.restored.length });
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /api/packages/summary — packages with install count + latest status
// NOTE: Must be registered before GET / to avoid route collision
packagesRoutes.get("/summary", (c) => {
  const { packageRepo } = getDeps(c);
  return c.json(packageRepo.listPackageSummaries());
});

// GET /api/packages
packagesRoutes.get("/", (c) => {
  const { packageRepo } = getDeps(c);
  return c.json(packageRepo.listPackages());
});

// GET /api/packages/installs/:installId/journal
// NOTE: Must be registered before /:packageId/installs to avoid route collision
packagesRoutes.get("/installs/:installId/journal", (c) => {
  const { installRepo } = getDeps(c);
  const installId = c.req.param("installId")!;

  const install = installRepo.getInstall(installId);
  if (!install) {
    return c.json({ error: "Install not found" }, 404);
  }

  return c.json(installRepo.getJournalEntries(installId));
});

// GET /api/packages/:packageId
// NOTE: Registered after /summary and /installs/:installId/journal to avoid collision
packagesRoutes.get("/:packageId", (c) => {
  const { packageRepo } = getDeps(c);
  const packageId = c.req.param("packageId")!;
  const pkg = packageRepo.getPackage(packageId);
  if (!pkg) {
    return c.json({ error: "Package not found" }, 404);
  }
  return c.json(pkg);
});

// GET /api/packages/:packageId/installs
packagesRoutes.get("/:packageId/installs", (c) => {
  const { installRepo } = getDeps(c);
  const packageId = c.req.param("packageId")!;
  return c.json(installRepo.listInstallSummaries(packageId));
});

// NOTE: /api/packages/validate-agentspec was moved to /api/agents/validate (agents.ts)
