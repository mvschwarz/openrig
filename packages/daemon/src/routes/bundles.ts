import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { Hono } from "hono";
import type { EventBus } from "../domain/event-bus.js";
import type { BootstrapOrchestrator } from "../domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "../domain/bootstrap-repository.js";
import { LegacyBundleAssembler as BundleAssembler, type AssemblerFsOps } from "../domain/bundle-assembler.js";
import { PodBundleAssembler, type PodAssemblerFsOps } from "../domain/pod-bundle-assembler.js";
import { computeIntegrity, writeIntegrity, verifyIntegrity, type IntegrityFsOps } from "../domain/bundle-integrity.js";
import { pack, unpack, verifyArchiveDigest } from "../domain/bundle-archive.js";
import { resolvePackage } from "../domain/package-resolve-helper.js";
import { LegacyRigSpecCodec } from "../domain/rigspec-codec.js";
import { LegacyRigSpecSchema } from "../domain/rigspec-schema.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { parseLegacyBundleManifest as parseBundleManifest, normalizeLegacyBundleManifest as normalizeBundleManifest, serializePodBundleManifest, parsePodBundleManifest, validatePodBundleManifest, validateLegacyBundleManifest, normalizeProvenanceBlock, normalizeCompatibilityBlock } from "../domain/bundle-types.js";
import type { PodBundleManifest, BundleProvenance, BundleCompatibility } from "../domain/bundle-types.js";
import { fileURLToPath } from "node:url";
import { detectBundleConflicts, type BundleConflict } from "../domain/bundle-conflict-detector.js";
import type { RigRepository } from "../domain/rig-repository.js";

/**
 * Read the daemon's own package.json version at call time (Item 1 / slice-05).
 * Function-level read on purpose: module-level constants would mask test
 * isolation per the audit-every-layer discipline. The read is cheap and
 * only happens on bundle create.
 */
function getDaemonVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = nodePath.join(nodePath.dirname(here), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Compare two dotted numeric version strings (semver-ish). Returns -1 if
 * a < b, 0 if equal, 1 if a > b. Non-numeric segments coerce to 0. Adequate
 * for the 0.x.y / 1.x.y range; pre-release / build metadata not interpreted.
 * Item-2 install-time version check (Checkpoint 3.3).
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map((p) => parseInt(p, 10) || 0);
  const partsB = b.split(".").map((p) => parseInt(p, 10) || 0);
  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

/** A single compatibility check failure surfaced in the 3-part error response. */
interface CompatibilityFailure {
  reason: "daemon_version_mismatch" | "cli_version_mismatch";
  required: string;
  actual: string;
  description: string;
}

/**
 * Run the install-time compatibility check (Item 2 Checkpoint 3.3). Returns
 * an array of failures (one per kind), or null if all checks pass. Missing
 * fields in compat are no-ops (daemon-only check when min_cli_version absent;
 * full pass when both absent). cliVersion undefined skips the CLI check
 * silently (pre-Item-2 CLIs don't send it; honest backward compat).
 */
function checkBundleCompatibility(
  compat: BundleCompatibility | undefined,
  daemonVersion: string,
  cliVersion: string | undefined,
): CompatibilityFailure[] | null {
  if (!compat) return null;
  const failures: CompatibilityFailure[] = [];
  if (compat.minDaemonVersion && compareVersions(daemonVersion, compat.minDaemonVersion) < 0) {
    failures.push({
      reason: "daemon_version_mismatch",
      required: compat.minDaemonVersion,
      actual: daemonVersion,
      description: `bundle requires daemon >= ${compat.minDaemonVersion}, current daemon is ${daemonVersion}`,
    });
  }
  if (compat.minCliVersion && cliVersion && compareVersions(cliVersion, compat.minCliVersion) < 0) {
    failures.push({
      reason: "cli_version_mismatch",
      required: compat.minCliVersion,
      actual: cliVersion,
      description: `bundle requires CLI >= ${compat.minCliVersion}, current CLI is ${cliVersion}`,
    });
  }
  return failures.length > 0 ? failures : null;
}

/**
 * Extract bundle.yaml manifest from a .rigbundle archive via the canonical
 * safe-extraction path (unpack from domain/bundle-archive). unpack performs
 * verifyArchiveDigest, then tar.list pre-scan rejecting symlinks / hardlinks
 * / absolute paths / dot-dot traversal, then extracts, then verifies content
 * integrity. Using unpack here keeps the install-time compat check inside the
 * existing trust boundary — raw tar.extract on an untrusted archive would
 * bypass the safety prescan (B1 regression fixed). Throws on archive / safety
 * / parse failures; the caller converts these into a 3-part 400 response.
 */
async function extractManifestForCompatCheck(bundlePath: string): Promise<Record<string, unknown>> {
  const meta = await extractInstallTimeMetadata(bundlePath);
  return meta.bundleManifest;
}

/**
 * Extract both the bundle.yaml manifest AND the rig name from the bundle's
 * rig.yaml in one safe pass (Item 3 / slice-05 Checkpoint 4.2). The /install
 * handler uses bundleManifest for the compat check (Item 2) and rigName for
 * the conflict check (Item 3). Reuses unpack — single trust boundary.
 */
async function extractInstallTimeMetadata(bundlePath: string): Promise<{
  bundleManifest: Record<string, unknown>;
  rigName: string | undefined;
}> {
  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-meta-"));
  try {
    await unpack(bundlePath, tmpDir);
    const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
    if (!fs.existsSync(manifestPath)) throw new Error("Bundle missing bundle.yaml");
    const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
    const bundleManifest = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;

    // B1 safety repair (slice-05 Checkpoint 4.2 / qitem-20260518204906): validate
    // the parsed manifest BEFORE trusting any of its fields. The validators
    // reject unsafe rig_spec values (isRelativeSafePath: no absolute, no ../,
    // no backslash, no empty segments). Schema-version-aware: v2 uses pod-aware
    // validator; everything else falls back to the v1 legacy validator. This is
    // the same trust-boundary reuse as the unpack/B1 fix in Item 2.
    const schemaVersion = bundleManifest["schema_version"];
    if (schemaVersion === 2) {
      const v2Validation = validatePodBundleManifest(bundleManifest);
      if (!v2Validation.valid) {
        throw new Error(`Invalid v2 bundle manifest: ${v2Validation.errors.join("; ")}`);
      }
    } else {
      const v1Validation = validateLegacyBundleManifest(bundleManifest, { requireIntegrity: false });
      if (!v1Validation.valid) {
        throw new Error(`Invalid v1 bundle manifest: ${v1Validation.errors.join("; ")}`);
      }
    }

    // Rig name lives in the bundle's rig.yaml (path referenced by bundle.yaml's
    // rig_spec field; defaults to rig.yaml for legacy bundles). Read + parse;
    // missing-or-malformed rig name leaves rigName undefined which the detector
    // fail-opens on (no rig name to compare).
    //
    // B1 safety repair (defense-in-depth alongside the validator above): resolve
    // rig_spec inside tmpDir and require the result to stay inside tmpDir
    // before reading, mirroring bundle-source-resolver.ts:60-63. The validator
    // should have already rejected unsafe rig_spec; this is the second line.
    let rigName: string | undefined;
    const rigSpecRel = typeof bundleManifest["rig_spec"] === "string" ? bundleManifest["rig_spec"] : "rig.yaml";
    const rigSpecPath = nodePath.resolve(tmpDir, rigSpecRel);
    const tmpDirResolved = nodePath.resolve(tmpDir);
    if (rigSpecPath !== tmpDirResolved && !rigSpecPath.startsWith(tmpDirResolved + nodePath.sep)) {
      throw new Error(`Rig spec path '${rigSpecRel}' escapes bundle workspace`);
    }
    if (fs.existsSync(rigSpecPath)) {
      try {
        const rigYaml = fs.readFileSync(rigSpecPath, "utf-8");
        const rigParsed = parsePodBundleManifest(rigYaml) as Record<string, unknown>;
        if (typeof rigParsed["name"] === "string" && rigParsed["name"].length > 0) {
          rigName = rigParsed["name"];
        }
      } catch {
        // rig.yaml malformed — leave rigName undefined; conflict check skips
      }
    }
    return { bundleManifest, rigName };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Sanitize raw compatibility from request body into a BundleCompatibility
 * object. Only known typed fields accepted; unknown fields dropped silently.
 * Returns undefined if input is missing or has no usable fields.
 */
function compatibilityFromRequestBody(raw: unknown): BundleCompatibility | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const result: BundleCompatibility = {};
  if (typeof c["minDaemonVersion"] === "string") result.minDaemonVersion = c["minDaemonVersion"];
  if (typeof c["minCliVersion"] === "string") result.minCliVersion = c["minCliVersion"];
  if (typeof c["schemaVersion"] === "number") result.schemaVersion = c["schemaVersion"];
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Normalize raw provenance from request body into a BundleProvenance object.
 * Only string fields are accepted; unknown/non-string fields are dropped
 * silently. Returns undefined if the input is missing or has no usable
 * fields. Daemon-side daemonVersion injection is the caller's responsibility.
 */
function provenanceFromRequestBody(raw: unknown): BundleProvenance | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const result: BundleProvenance = {};
  if (typeof p["sourceHost"] === "string") result.sourceHost = p["sourceHost"];
  if (typeof p["authorSession"] === "string") result.authorSession = p["authorSession"];
  if (typeof p["sourceRigId"] === "string") result.sourceRigId = p["sourceRigId"];
  if (typeof p["sourceRigName"] === "string") result.sourceRigName = p["sourceRigName"];
  if (typeof p["cliVersion"] === "string") result.cliVersion = p["cliVersion"];
  if (typeof p["notes"] === "string") result.notes = p["notes"];
  return Object.keys(result).length > 0 ? result : undefined;
}
import type { FsOps } from "../domain/package-resolver.js";

export const bundleRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    eventBus: c.get("eventBus" as never) as EventBus,
    bootstrapOrchestrator: c.get("bootstrapOrchestrator" as never) as BootstrapOrchestrator,
    bootstrapRepo: c.get("bootstrapRepo" as never) as BootstrapRepository,
    rigRepo: c.get("rigRepo" as never) as RigRepository | undefined,
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

function podAssemblerFsOps(): PodAssemblerFsOps {
  return {
    ...assemblerFsOps(),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    listFiles: (dir) => realFsOps().listFiles!(dir),
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
  const rigRoot = typeof body["rigRoot"] === "string" ? body["rigRoot"] : undefined;
  const includePackages = Array.isArray(body["includePackages"]) ? body["includePackages"] as string[] : undefined;

  // Item 1 / slice-05: build provenance from request body + inject daemonVersion server-side
  const clientProvenance = provenanceFromRequestBody(body["provenance"]);
  const provenance: BundleProvenance | undefined = clientProvenance
    ? { ...clientProvenance, daemonVersion: getDaemonVersion() }
    : undefined;

  // Item 2 / slice-05: build compatibility from request body (no server-side fields)
  const compatibility = compatibilityFromRequestBody(body["compatibility"]);

  if (!specPath || !bundleName || !bundleVersion || !outputPath) {
    return c.json({ error: "specPath, bundleName, bundleVersion, and outputPath are required" }, 400);
  }

  try {
    // Read spec and detect format
    const specYaml = fs.readFileSync(nodePath.resolve(specPath), "utf-8");
    const rawParsed = RigSpecCodec.parse(specYaml);
    const isPodAware = rawParsed && typeof rawParsed === "object" && Array.isArray((rawParsed as Record<string, unknown>).pods);

    if (isPodAware) {
      // Pod-aware bundle creation
      const podValidation = RigSpecSchema.validate(rawParsed);
      if (!podValidation.valid) return c.json({ error: "Invalid pod-aware rig spec", errors: podValidation.errors }, 400);

      const effectiveRigRoot = rigRoot ? nodePath.resolve(rigRoot) : nodePath.dirname(nodePath.resolve(specPath));
      const tmpStaging = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pod-bundle-create-"));
      try {
        const assembler = new PodBundleAssembler({ fsOps: podAssemblerFsOps() });
        const result = assembler.assemble({ rigRoot: effectiveRigRoot, rigSpecPath: nodePath.resolve(specPath), outputDir: tmpStaging, bundleName, bundleVersion, provenance, compatibility });

        const integrity = computeIntegrity(tmpStaging, integrityFsOps());
        result.manifest.integrity = integrity;
        fs.writeFileSync(nodePath.join(tmpStaging, "bundle.yaml"), serializePodBundleManifest(result.manifest), "utf-8");

        const archiveHash = await pack(tmpStaging, nodePath.resolve(outputPath));
        eventBus.emit({ type: "bundle.created", bundleName, bundleVersion, archiveHash });
        return c.json({ bundleName, bundleVersion, archiveHash, schemaVersion: 2, agents: result.manifest.agents.length }, 201);
      } finally {
        fs.rmSync(tmpStaging, { recursive: true, force: true });
      }
    }

    // Legacy bundle creation
    const validation = LegacyRigSpecSchema.validate(rawParsed);
    if (!validation.valid) return c.json({ error: "Invalid rig spec", errors: validation.errors }, 400);
    const spec = LegacyRigSpecSchema.normalize(rawParsed);

    const specDir = nodePath.dirname(nodePath.resolve(specPath));
    const allRefs = new Set<string>();
    for (const node of spec.nodes) {
      if (node.packageRefs) for (const ref of node.packageRefs) allRefs.add(ref);
    }

    const refsToBundle = includePackages ?? [...allRefs];

    if (includePackages) {
      const includedSet = new Set(includePackages);
      const missing = [...allRefs].filter((r) => !includedSet.has(r));
      if (missing.length > 0) {
        return c.json({ error: "Provided packages do not cover all rig spec package_refs", missing }, 400);
      }
    }

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

    const tmpStaging = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-create-"));
    try {
      const assembler = new BundleAssembler({ fsOps: assemblerFsOps() });
      const manifest = assembler.assemble({
        specPath: nodePath.resolve(specPath), packages, outputDir: tmpStaging, bundleName, bundleVersion, provenance, compatibility,
      });

      const integrity = computeIntegrity(tmpStaging, integrityFsOps());
      writeIntegrity(tmpStaging, integrity, integrityFsOps());

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

  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-inspect-"));
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
    const rawParsed = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;

    // Detect v2 (pod-aware) vs v1 (legacy)
    if (rawParsed && rawParsed["schema_version"] === 2) {
      const validation = validatePodBundleManifest(rawParsed);
      if (!validation.valid) {
        return c.json({ error: `Invalid v2 manifest: ${validation.errors.join("; ")}`, digestValid }, 200);
      }
      const agents = (rawParsed["agents"] as Array<Record<string, unknown>>).map((a) => ({
        name: a["name"] as string,
        version: (a["version"] as string) ?? "",
        path: a["path"] as string,
      }));
      // Extract integrity from raw manifest
      const integritySection = rawParsed["integrity"] as { algorithm?: string; files?: Record<string, string> } | undefined;
      const podManifest = {
        schemaVersion: 2 as const,
        name: rawParsed["name"] as string,
        version: rawParsed["version"] as string,
        createdAt: rawParsed["created_at"] as string,
        rigSpec: rawParsed["rig_spec"] as string,
        agents,
        integrity: integritySection ? {
          algorithm: integritySection.algorithm ?? "sha256",
          files: integritySection.files ?? {},
        } : undefined,
        // Item 1 / slice-05: surface provenance in normalized camelCase so the
        // /api/bundles/inspect contract is one shape regardless of v1 vs v2
        // (v1 path normalizes through normalizeLegacyBundleManifest below).
        // Field is optional; undefined when bundle has no provenance.
        provenance: normalizeProvenanceBlock(rawParsed["provenance"]),
        // Item 2 / slice-05: surface compatibility normalized to camelCase
        // (same single-contract reason as provenance above). v1 already
        // surfaces via the normalizer at the end of this handler.
        compatibility: normalizeCompatibilityBlock(rawParsed["compatibility"]),
      };
      const integrityCompat = integritySection ? {
        schemaVersion: 2,
        name: podManifest.name,
        version: podManifest.version,
        createdAt: podManifest.createdAt,
        rigSpec: podManifest.rigSpec,
        packages: [],
        integrity: { algorithm: "sha256" as const, files: integritySection.files ?? {} },
      } : undefined;
      const integrityResult = integrityCompat
        ? verifyIntegrity(tmpDir, integrityCompat, integrityFsOps())
        : { passed: false, mismatches: [], missing: [], extra: [], errors: ["no integrity section"] };
      return c.json({ manifest: podManifest, digestValid, integrityResult }, 200);
    }

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
  const { bootstrapOrchestrator, bootstrapRepo, eventBus, rigRepo } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const bundlePath = typeof body["bundlePath"] === "string" ? body["bundlePath"] : "";
  const plan = body["plan"] === true;
  const autoApprove = body["autoApprove"] === true;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : undefined;
  // Item 2 / slice-05 Checkpoint 3.3: install-time compatibility check inputs
  const skipVersionCheck = body["skipVersionCheck"] === true;
  const clientCliVersion = typeof body["cliVersion"] === "string" ? body["cliVersion"] : undefined;
  // Item 3 / slice-05 Checkpoint 4.2: install-time conflict check inputs
  const force = body["force"] === true;

  if (!bundlePath) return c.json({ error: "bundlePath is required" }, 400);
  if (!plan && !targetRoot) return c.json({ error: "targetRoot is required for apply mode" }, 400);

  // Concurrency lock — runs BEFORE compat check so the existing 409
  // semantic (concurrent install detection) is preserved verbatim.
  if (!bootstrapOrchestrator.tryAcquire(bundlePath)) {
    return c.json({ error: "Bundle install already in progress", code: "conflict" }, 409);
  }

  try {
  // Item 2 / slice-05 Checkpoint 3.3: install-time compatibility check
  // Runs AFTER the lock + BEFORE bootstrap delegation. Mismatch returns a
  // 3-part error and exits the lifecycle (lock releases via the outer
  // finally). Operator override via --skip-version-check (request body
  // skipVersionCheck=true).
  // Item 2 + Item 3 / slice-05: single safe extract pass yields both the
  // bundle manifest (for compat check) and the rig name (for conflict check).
  // Caller can skip the compat check via skipVersionCheck; the conflict check
  // also runs from this same extract pass unless --force bypasses it.
  let installMeta: { bundleManifest: Record<string, unknown>; rigName: string | undefined } | null = null;
  if (!skipVersionCheck || !force) {
    try {
      installMeta = await extractInstallTimeMetadata(bundlePath);
    } catch (err) {
      return c.json({
        error: "Bundle install pre-check could not run (extraction failed)",
        detail: (err as Error).message,
        resolutions: [
          "confirm the bundle path is correct and the archive is readable",
          "pass --skip-version-check and --force to bypass both pre-checks (NOT recommended unless intentional)",
        ],
      }, 400);
    }
  }

  if (!skipVersionCheck && installMeta) {
    const compatibility = normalizeCompatibilityBlock(installMeta.bundleManifest["compatibility"]);
    const failures = checkBundleCompatibility(compatibility, getDaemonVersion(), clientCliVersion);
    if (failures) {
      return c.json({
        error: "Bundle compatibility check failed",
        failures,
        resolutions: [
          "upgrade the affected runtime to the required version (recommended)",
          "use a bundle with relaxed minimum requirements",
          "pass --skip-version-check to bypass for an operator-explicit override (NOT recommended for routine use)",
        ],
      }, 400);
    }
  }

  // Item 3 / slice-05 Checkpoint 4.2: install-time conflict check
  // Runs AFTER the compat check + BEFORE bootstrap delegation. Mismatch
  // returns a 400 with the 3-part error shape (error + conflicts[] +
  // resolutions[]). Operator override via --force (request body force=true).
  // The check fails CLOSED on extraction failure (handled above) and
  // fail-OPEN on missing rig name in the bundle (no rig name to compare).
  if (!force && installMeta && rigRepo) {
    const runningRigs = rigRepo.listRigs().map((r) => ({ rigId: r.id, name: r.name }));
    const report = detectBundleConflicts({
      bundleRigName: installMeta.rigName ?? "",
      runningRigs,
    });
    if (report.hasConflicts) {
      return c.json({
        error: "Bundle install conflict check failed",
        conflicts: report.conflicts,
        resolutions: [
          "stop the conflicting running rig and re-attempt install",
          "use --force to bypass for an operator-explicit override (NOT recommended for routine use; conflicts may produce partial install state)",
        ],
      }, 400);
    }
  }

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
