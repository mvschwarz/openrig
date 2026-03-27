import fs from "node:fs";
import nodePath from "node:path";
import { Hono } from "hono";
import type { EventBus } from "../domain/event-bus.js";
import type { BootstrapOrchestrator } from "../domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "../domain/bootstrap-repository.js";
import { BundleAssembler, type AssemblerFsOps } from "../domain/bundle-assembler.js";
import { computeIntegrity, writeIntegrity, verifyIntegrity, type IntegrityFsOps } from "../domain/bundle-integrity.js";
import { pack, unpack, verifyArchiveDigest } from "../domain/bundle-archive.js";
import { resolvePackage } from "../domain/package-resolve-helper.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { parseBundleManifest, normalizeBundleManifest } from "../domain/bundle-types.js";
import type { FsOps } from "../domain/package-resolver.js";

export const bundleRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    eventBus: c.get("eventBus" as never) as EventBus,
    bootstrapOrchestrator: c.get("bootstrapOrchestrator" as never) as BootstrapOrchestrator,
    bootstrapRepo: c.get("bootstrapRepo" as never) as BootstrapRepository,
  };
}

function realFsOps(): FsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    listFiles: (dir) => {
      const r: string[] = [];
      function walk(d: string, prefix: string) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(nodePath.join(d, e.name), prefix ? `${prefix}/${e.name}` : e.name);
          else r.push(prefix ? `${prefix}/${e.name}` : e.name);
        }
      }
      walk(dir, "");
      return r;
    },
  };
}

function assemblerFsOps(): AssemblerFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    copyDir: (s, d) => fs.cpSync(s, d, { recursive: true }),
  };
}

function integrityFsOps(): IntegrityFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p) => fs.readFileSync(p),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    walkFiles: (dir) => realFsOps().listFiles!(dir),
  };
}

// POST /api/bundles/create
bundleRoutes.post("/create", async (c) => {
  const { eventBus } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const specPath = typeof body["specPath"] === "string" ? body["specPath"] : "";
  const bundleName = typeof body["bundleName"] === "string" ? body["bundleName"] : "";
  const bundleVersion = typeof body["bundleVersion"] === "string" ? body["bundleVersion"] : "";
  const outputPath = typeof body["outputPath"] === "string" ? body["outputPath"] : "";
  const includePackages = Array.isArray(body["includePackages"]) ? body["includePackages"] as string[] : undefined;

  if (!specPath || !bundleName || !bundleVersion || !outputPath) {
    return c.json({ error: "specPath, bundleName, bundleVersion, and outputPath are required" }, 400);
  }

  try {
    // Read spec and collect package_refs
    const specYaml = fs.readFileSync(nodePath.resolve(specPath), "utf-8");
    const raw = RigSpecCodec.parse(specYaml);
    const validation = RigSpecSchema.validate(raw);
    if (!validation.valid) return c.json({ error: "Invalid rig spec", errors: validation.errors }, 400);
    const spec = RigSpecSchema.normalize(raw);

    const specDir = nodePath.dirname(nodePath.resolve(specPath));
    const allRefs = new Set<string>();
    for (const node of spec.nodes) {
      if (node.packageRefs) for (const ref of node.packageRefs) allRefs.add(ref);
    }

    // Determine which refs to bundle
    const refsToBundle = includePackages ?? [...allRefs];

    // Validate coverage: included must cover all spec refs
    if (includePackages) {
      const includedSet = new Set(includePackages);
      const missing = [...allRefs].filter((r) => !includedSet.has(r));
      if (missing.length > 0) {
        return c.json({ error: "Provided packages do not cover all rig spec package_refs", missing }, 400);
      }
    }

    // Resolve packages
    const fsOps = realFsOps();
    const packages = [];
    for (const ref of refsToBundle) {
      const cleanRef = ref.startsWith("local:") ? ref.slice(6) : ref;
      const result = resolvePackage(cleanRef, specDir, fsOps);
      if (!result.ok) {
        const errMsg = result.kind === "validation" ? result.errors.join("; ") : result.error;
        return c.json({ error: `Failed to resolve package '${ref}': ${errMsg}` }, 400);
      }
      packages.push({
        name: result.resolved.manifest.name,
        version: result.resolved.manifest.version,
        sourcePath: result.resolved.sourceRef,
        originalSource: ref,
        manifestHash: result.resolved.manifestHash,
      });
    }

    // Assemble
    const tmpStaging = fs.mkdtempSync(nodePath.join(require("os").tmpdir(), "bundle-create-"));
    try {
      const assembler = new BundleAssembler({ fsOps: assemblerFsOps() });
      const manifest = assembler.assemble({
        specPath: nodePath.resolve(specPath), packages, outputDir: tmpStaging, bundleName, bundleVersion,
      });

      // Integrity
      const integrity = computeIntegrity(tmpStaging, integrityFsOps());
      writeIntegrity(tmpStaging, integrity, integrityFsOps());

      // Pack
      const archiveHash = await pack(tmpStaging, nodePath.resolve(outputPath));

      eventBus.emit({ type: "bundle.created", bundleName, bundleVersion, archiveHash });

      return c.json({ bundleName, bundleVersion, archiveHash, packages: manifest.packages.length }, 201);
    } finally {
      fs.rmSync(tmpStaging, { recursive: true, force: true });
    }
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /api/bundles/inspect
bundleRoutes.post("/inspect", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const bundlePath = typeof body["bundlePath"] === "string" ? body["bundlePath"] : "";

  if (!bundlePath) return c.json({ error: "bundlePath is required" }, 400);

  let digestValid = false;
  try {
    const dr = verifyArchiveDigest(bundlePath);
    digestValid = dr.valid;
  } catch { /* missing digest = invalid */ }

  const tmpDir = fs.mkdtempSync(nodePath.join(require("os").tmpdir(), "bundle-inspect-"));
  try {
    // Extract with safety pre-scan (same as unpack) but without content integrity verification
    const tar = await import("tar");
    const unsafeEntries: string[] = [];
    await tar.list({
      file: bundlePath,
      onReadEntry: (entry) => {
        const p = entry.path;
        const t = entry.type;
        if (t === "SymbolicLink" || t === "Link") unsafeEntries.push(`${t}: ${p}`);
        if (p.startsWith("/")) unsafeEntries.push(`absolute: ${p}`);
        if (p.split("/").some((s: string) => s === "..")) unsafeEntries.push(`traversal: ${p}`);
      },
    });
    if (unsafeEntries.length > 0) {
      return c.json({ error: `Unsafe archive entries: ${unsafeEntries.join("; ")}`, digestValid }, 200);
    }
    await tar.extract({ file: bundlePath, cwd: tmpDir });

    const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
    if (!fs.existsSync(manifestPath)) {
      return c.json({ error: "Bundle missing bundle.yaml", digestValid }, 200);
    }
    const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
    const manifest = normalizeBundleManifest(parseBundleManifest(manifestYaml));
    const integrityResult = manifest.integrity
      ? verifyIntegrity(tmpDir, manifest, integrityFsOps())
      : { passed: false, mismatches: [], missing: [], extra: [], errors: ["no integrity section"] };
    return c.json({ manifest, digestValid, integrityResult }, 200);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// POST /api/bundles/install — reuses full bootstrap lifecycle
bundleRoutes.post("/install", async (c) => {
  const { bootstrapOrchestrator, bootstrapRepo, eventBus } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const bundlePath = typeof body["bundlePath"] === "string" ? body["bundlePath"] : "";
  const plan = body["plan"] === true;
  const autoApprove = body["autoApprove"] === true;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : undefined;

  if (!bundlePath) return c.json({ error: "bundlePath is required" }, 400);
  if (!plan && !targetRoot) return c.json({ error: "targetRoot is required for apply mode" }, 400);

  // Concurrency lock
  if (!bootstrapOrchestrator.tryAcquire(bundlePath)) {
    return c.json({ error: "Bundle install already in progress", code: "conflict" }, 409);
  }

  try {
  if (plan) {
    // Plan mode: no run lifecycle
    try {
      const result = await bootstrapOrchestrator.bootstrap({
        mode: "plan", sourceRef: bundlePath, sourceKind: "rig_bundle",
      });
      if (result.status === "planned") {
        eventBus.emit({ type: "bootstrap.planned", runId: result.runId, sourceRef: bundlePath, stages: result.stages.length });
        return c.json(result, 200);
      }
      // Plan failed — structured mapping (same as bootstrap plan route)
      eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef: bundlePath, error: result.errors[0] ?? "plan failed" });
      const failedStage = result.stages.find((s: { status: string; detail?: unknown }) => s.status === "failed" || s.status === "blocked");
      let httpStatus: number = 500;
      if (failedStage) {
        if (failedStage.status === "blocked") httpStatus = 409;
        else if (failedStage.stage === "resolve_spec") {
          const detail = failedStage.detail as { code?: string } | undefined;
          if (detail?.code === "file_not_found" || detail?.code === "parse_error" || detail?.code === "validation_failed" || detail?.code === "bundle_error") httpStatus = 400;
        }
      }
      return c.json(result, httpStatus as 400 | 409 | 500);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  // Apply mode: full run lifecycle with bootstrap.started
  const run = bootstrapRepo.createRun("rig_bundle", bundlePath);
  bootstrapRepo.updateRunStatus(run.id, "running");
  eventBus.emit({ type: "bootstrap.started", runId: run.id, sourceRef: bundlePath });

  try {
    const result = await bootstrapOrchestrator.bootstrap({
      mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle",
      autoApprove, targetRoot, runId: run.id,
    });

    if (result.status === "completed") {
      eventBus.emit({ type: "bootstrap.completed", runId: result.runId, rigId: result.rigId!, sourceRef: bundlePath });
      return c.json(result, 201);
    }
    if (result.status === "partial") {
      const ok = result.stages.filter((s: { status: string }) => s.status === "ok").length;
      const fail = result.stages.filter((s: { status: string }) => s.status === "failed" || s.status === "blocked").length;
      eventBus.emit({ type: "bootstrap.partial", runId: result.runId, sourceRef: bundlePath, rigId: result.rigId, completed: ok, failed: fail });
      return c.json(result, 200);
    }
    eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef: bundlePath, error: result.errors[0] ?? "failed" });
    const hasBlocked = result.stages.some((s: { status: string }) => s.status === "blocked");
    return c.json(result, hasBlocked ? 409 : 500);
  } catch (err) {
    bootstrapRepo.updateRunStatus(run.id, "failed");
    eventBus.emit({ type: "bootstrap.failed", runId: run.id, sourceRef: bundlePath, error: (err as Error).message });
    return c.json({ runId: run.id, status: "failed", error: (err as Error).message }, 500);
  }
  } finally { bootstrapOrchestrator.release(bundlePath); }
});
