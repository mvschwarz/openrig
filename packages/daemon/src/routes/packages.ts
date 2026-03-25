import fs from "node:fs";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { PackageRepository } from "../domain/package-repository.js";
import type { InstallRepository } from "../domain/install-repository.js";
import type { InstallEngine } from "../domain/install-engine.js";
import type { InstallVerifier } from "../domain/install-verifier.js";
import { parseManifest, validateManifest, normalizeManifest, type PackageManifest } from "../domain/package-manifest.js";
import { InstallPlanner } from "../domain/install-planner.js";
import { detectConflicts } from "../domain/conflict-detector.js";
import { applyPolicy } from "../domain/install-policy.js";
import type { ResolvedPackage, FsOps } from "../domain/package-resolver.js";
import type { EngineFsOps } from "../domain/install-engine.js";

export const packagesRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    packageRepo: c.get("packageRepo" as never) as PackageRepository,
    installRepo: c.get("installRepo" as never) as InstallRepository,
    installEngine: c.get("installEngine" as never) as InstallEngine,
    installVerifier: c.get("installVerifier" as never) as InstallVerifier,
  };
}

type ResolveResult =
  | { ok: true; resolved: ResolvedPackage }
  | { ok: false; kind: "resolution"; error: string }
  | { ok: false; kind: "validation"; errors: string[] };

/**
 * Two-step resolve: find manifest file, then parse+validate separately.
 * Keeps resolution errors (missing file) distinct from validation errors (bad schema).
 */
function resolvePackage(sourceRef: string, cwd: string | undefined, fsOps: FsOps): ResolveResult {
  const absoluteRef = nodePath.isAbsolute(sourceRef)
    ? sourceRef
    : nodePath.resolve(cwd ?? process.cwd(), sourceRef);
  const manifestPath = nodePath.join(absoluteRef, "package.yaml");

  if (!fsOps.exists(manifestPath)) {
    return { ok: false, kind: "resolution", error: `No package.yaml found at ${manifestPath}` };
  }

  let rawYaml: string;
  try {
    rawYaml = fsOps.readFile(manifestPath);
  } catch (err) {
    return { ok: false, kind: "resolution", error: (err as Error).message };
  }

  let raw: unknown;
  try {
    raw = parseManifest(rawYaml);
  } catch (err) {
    return { ok: false, kind: "resolution", error: (err as Error).message };
  }

  const validation = validateManifest(raw);
  if (!validation.valid) {
    return { ok: false, kind: "validation", errors: validation.errors };
  }

  const manifest = normalizeManifest(raw) as PackageManifest;
  const manifestHash = createHash("sha256").update(rawYaml).digest("hex");

  return {
    ok: true,
    resolved: {
      sourceKind: "local_path",
      sourceRef: absoluteRef,
      manifest,
      manifestHash,
      rawManifestYaml: rawYaml,
    },
  };
}

function realFsOps(): FsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
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
    },
  });
});

// POST /api/packages/plan
packagesRoutes.post("/plan", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";
  const cwd = typeof body["cwd"] === "string" ? body["cwd"] : undefined;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : "";
  const runtime = (body["runtime"] === "codex" ? "codex" : "claude-code") as "claude-code" | "codex";
  const roleName = typeof body["roleName"] === "string" ? body["roleName"] : undefined;

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

  const planner = new InstallPlanner(fsOps);
  const plan = planner.plan(result.resolved, targetRoot, runtime, { roleName });
  const refined = detectConflicts(plan, fsOps);

  return c.json({
    packageName: refined.packageName,
    packageVersion: refined.packageVersion,
    entries: refined.entries,
    actionable: refined.actionable.length,
    deferred: refined.deferred.length,
    conflicts: refined.conflicts.length,
    noOps: refined.noOps.length,
  });
});

// POST /api/packages/install
packagesRoutes.post("/install", async (c) => {
  const { packageRepo, installEngine, installVerifier } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";
  const cwd = typeof body["cwd"] === "string" ? body["cwd"] : undefined;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : "";
  const runtime = (body["runtime"] === "codex" ? "codex" : "claude-code") as "claude-code" | "codex";
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
  const planner = new InstallPlanner(fsOps);
  const plan = planner.plan(resolved, targetRoot, runtime, { roleName });
  const refined = detectConflicts(plan, fsOps);

  // Check for content-level conflicts
  if (refined.conflicts.length > 0) {
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
    return c.json({
      error: "No entries approved by policy",
      code: "policy_rejected",
      rejected: policyResult.rejected,
    }, 422);
  }

  // Dedup package record
  const existing = packageRepo.findByNameVersion(resolved.manifest.name, resolved.manifest.version);
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
    return c.json({ error: (err as Error).message, code: "apply_error" }, 500);
  }

  // Verify
  const verification = installVerifier.verify(result.installId);
  if (!verification.passed) {
    return c.json({
      error: "Post-apply verification failed",
      code: "verification_failed",
      installId: result.installId,
      verification,
    }, 500);
  }

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

  try {
    const result = installEngine.rollback(installId);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
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

// GET /api/packages/:packageId/installs
packagesRoutes.get("/:packageId/installs", (c) => {
  const { installRepo } = getDeps(c);
  const packageId = c.req.param("packageId")!;
  return c.json(installRepo.listInstalls(packageId));
});
