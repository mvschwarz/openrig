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
import { pack, unpack, verifyArchiveDigest, collectUnsafeArchiveEntries, unsafeArchiveEntryReason } from "../domain/bundle-archive.js";
import { resolvePackage } from "../domain/package-resolve-helper.js";
import {
  compareSpecToLive, topologyFromRigSpec, topologyFromLiveLogicalIds, bundleExportWarning,
  topologyFromLegacyRigSpec, topologyFromLiveNodeIds, type ConformanceResult,
} from "../domain/spec-live-conformance.js";
import { LegacyRigSpecCodec } from "../domain/rigspec-codec.js";
import { LegacyRigSpecSchema } from "../domain/rigspec-schema.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { parseLegacyBundleManifest as parseBundleManifest, normalizeLegacyBundleManifest as normalizeBundleManifest, serializePodBundleManifest, parsePodBundleManifest, validatePodBundleManifest, validateLegacyBundleManifest, normalizeProvenanceBlock, normalizeBundleSource, normalizeCompatibilityBlock, isRelativeSafePath } from "../domain/bundle-types.js";
import type { PodBundleManifest, BundleProvenance, BundleCompatibility, BundlePluginReference } from "../domain/bundle-types.js";
import { detectBundleConflicts, type BundleConflict } from "../domain/bundle-conflict-detector.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { BundleAuditReader, BundleAuditWriter, type BundleAuditFsOps, type BundleAuditRecord } from "../domain/bundle-audit.js";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { routingFailureWarnings, type BundleContentRouting } from "../domain/bundle-content-routing.js";
import { configurationId, packageDigest } from "../domain/bundle-identity.js";
import { vendorContextPackDir } from "../domain/bundle-carried-context-pack.js";
import { vendorProjectDir } from "../domain/bundle-carried-project.js";
import { getDaemonVersion } from "../domain/daemon-version.js";
import { inspectBundleBehaviour } from "../domain/bundle-behaviour-inspect.js";
import type { BundleBehaviour } from "../domain/bundle-behaviour.js";
import { assertShippableSubstance } from "../domain/agent-resolver.js";

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
  const source = normalizeBundleSource(p["source"]);
  if (source) result.source = source;
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

/**
 * Build B — compare the spec about to be exported against the RUNNING rig of the same name.
 *
 * The assembler copies the spec text VERBATIM into the bundle and never reads the live DB, so a rig
 * expanded at runtime (nothing writes the spec back) exports as the smaller, stale topology in
 * complete silence. This says the delta out loud.
 *
 * Returns null — and the caller then says nothing at all — when there is genuinely nothing to
 * report: no repo, a spec whose rig is not running (authoring a NEW rig is not drift), or agreement.
 * Reporting only: never mutates, never blocks, never throws into the export path.
 */
export function describeSpecLiveDrift(rawParsed: unknown, rigRepo: RigRepository | undefined): string | null {
  try {
    const result = assessSpecLiveDrift(rawParsed, rigRepo);
    return result ? bundleExportWarning(result) : null;
  } catch {
    // REPORTING contract, deliberately different from the enforcement one below: a banner must never
    // be the reason an export fails. Enforcement cannot afford this and does not share it.
    return null;
  }
}

/**
 * The same comparison as `describeSpecLiveDrift`, returned STRUCTURED rather than as a sentence.
 *
 * Null means there is genuinely nothing to compare: no repository, a spec with no `name:`, a shape
 * that is neither pod-aware nor legacy, or no rig of that name on record. Those are all honest
 * absences of a comparison.
 *
 * A REPOSITORY OR QUERY FAILURE IS NOT ONE OF THEM AND PROPAGATES. The reporting helper above may
 * swallow it, because the worst case there is a missing banner. Enforcement may not: translating a
 * failed DB read into "no drift" would let the export proceed on the strength of a comparison that
 * never happened, which is the fail-open this guard exists to remove. Callers fail closed.
 */
export function assessSpecLiveDrift(rawParsed: unknown, rigRepo: RigRepository | undefined): ConformanceResult | null {
  if (!rigRepo) return null;
  const spec = rawParsed as { name?: unknown; pods?: unknown; nodes?: unknown } | null;
  const rigName = typeof spec?.name === "string" ? spec.name : "";
  if (!rigName) return null;
  // Pod-aware and legacy specs both reach this endpoint and both ship the same wrong artifact.
  // One comparator, two readers — the format only decides how ids are read, never what "drift"
  // means.
  const isPodAware = Array.isArray(spec?.pods);
  const isLegacy = !isPodAware && Array.isArray(spec?.nodes);
  if (!isPodAware && !isLegacy) return null;
  const rig = rigRepo.listRigs().find((r) => r.name === rigName);
  if (!rig) return null;
  const rows = rigRepo.db
    .prepare("SELECT logical_id FROM nodes WHERE rig_id = ?")
    .all(rig.id) as Array<{ logical_id: string | null }>;
  const liveIds = rows.map((r) => r.logical_id);
  return isPodAware
    ? compareSpecToLive(topologyFromRigSpec(spec as never), topologyFromLiveLogicalIds(liveIds))
    : compareSpecToLive(topologyFromLegacyRigSpec(spec as never), topologyFromLiveNodeIds(liveIds));
}

/**
 * Does this spec describe a different rig than the one on record — in EITHER direction?
 *
 * An earlier revision refused only the drop direction, on the reasoning that a spec declaring MORE
 * than is live is a bundle whose job is to bring the rest up. That was wrong, and the reason is what
 * the DB rows actually are: `nodes` is the rig's PERSISTED topology, not a list of currently-running
 * sessions. A restore that brings up seats the spec never declared produces a different rig just as
 * surely as one that drops them. Direction is not the test; disagreement is. `--allow-drift` is the
 * honest way through for an operator who means it.
 */
export function specDivergesFromLive(result: ConformanceResult | null): boolean {
  return result ? !result.conforms : false;
}

/** The refusal an operator can act on: what disagrees, and the way through. */
export function bundleExportRefusal(result: ConformanceResult): string {
  return [
    `Refusing to bundle: this spec does not describe the rig it names — ${result.message}.`,
    `The bundle would instantiate ${result.spec.pods} pods/${result.spec.seats} seats, which is not`,
    `the topology on record for this rig.`,
    `Update the spec to match, or pass --allow-drift to bundle it as-is (the divergence is then`,
    `stamped into the bundle's provenance so the artifact carries its own caveat).`,
  ].join(" ");
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
    realpath: (p) => fs.realpathSync(p),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p) => fs.readFileSync(p),
    fileMode: (p) => fs.statSync(p).mode & 0o777,
    writeFile: (p, c, mode) => {
      fs.writeFileSync(p, c);
      if (mode !== undefined) fs.chmodSync(p, mode);
    },
    exists: (p) => fs.existsSync(p),
    listFiles: (dir, onReadError) => {
      const files: string[] = [];
      const walk = (directory: string, prefix: string): void => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
        catch (error) { if (onReadError?.(directory, error)) return; throw error; }
        for (const entry of entries) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(nodePath.join(directory, entry.name), relative);
          else files.push(relative);
        }
      };
      walk(dir, "");
      return files;
    },
  };
}

/** Item 4 / slice-05 Checkpoint 5.2: real BundleAuditFsOps backed by node:fs. */
function auditFsOps(): BundleAuditFsOps {
  return {
    appendFile: (p, c) => fs.appendFileSync(p, c, "utf-8"),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  };
}

/**
 * Audit file path resolved at call time via getDefaultOpenRigPath
 * ("bundle-audit.jsonl"). Function-level read (no module-level constant)
 * so OPENRIG_HOME env changes between requests / tests are honored.
 */
function bundleAuditPath(): string {
  return getDefaultOpenRigPath("bundle-audit.jsonl");
}

/**
 * Item 4 / slice-05 Checkpoint 5.3: append a bundle install audit record.
 * Best-effort — audit failures are logged via the eventBus shape but never
 * fail the install response (the install already happened or failed; the
 * audit is a side-channel record). bundleManifest is optional; when present,
 * provenance.source_host is mirrored into the record.
 */
function writeInstallAudit(opts: {
  bundlePath: string;
  outcome: "success" | "failed" | "partial";
  targetRigId?: string;
  targetRigName?: string;
  cliVersion?: string;
  bundleManifest?: Record<string, unknown>;
  routingFailures?: Array<{ kind: string; error: string }>;
}): void {
  try {
    const writer = new BundleAuditWriter({
      opts: { auditPath: bundleAuditPath() },
      fsOps: auditFsOps(),
    });
    const provenance = normalizeProvenanceBlock(opts.bundleManifest?.["provenance"]);
    const record: BundleAuditRecord = {
      installedAt: new Date().toISOString(),
      bundlePath: opts.bundlePath,
      outcome: opts.outcome,
    };
    if (opts.targetRigId) record.targetRigId = opts.targetRigId;
    if (opts.targetRigName) record.targetRigName = opts.targetRigName;
    if (opts.cliVersion) record.cliVersion = opts.cliVersion;
    record.daemonVersion = getDaemonVersion();
    if (provenance?.sourceHost) record.sourceHost = provenance.sourceHost;
    if (opts.routingFailures?.length) record.routingFailures = opts.routingFailures;
    writer.append(record);
  } catch {
    // Audit-write failure is side-channel; never fail the install response.
    // Future enhancement: surface via eventBus (out of scope this commit).
  }
}

/**
 * Item 6 / slice-05 Checkpoint 7.5 (QA-20260601 A2 repair): consume an
 * author-supplied bundle.yaml at the source root and vendor the
 * declared cross-primitive content into the staging tree. Runs AFTER
 * the assembler has built staging (rig.yaml + agents/) and BEFORE
 * computeIntegrity so the vendored content lands in the integrity
 * manifest.
 *
 * Auto-detect contract (per orch ruling, no new CLI flag): if a
 * bundle.yaml exists at the source root, parse it and consume the 5
 * cross-primitive fields (skills, plugins, workflow_specs,
 * context_packs, agent_images). Provenance + compatibility stay
 * request-body-only (caller-controlled at create time). If no
 * bundle.yaml at source root, no-op (existing behavior unchanged).
 *
 * Vendor semantics:
 * - Each declared path is resolved relative to source root.
 * - Both-sides containment: source path under sourceRoot, target path
 *   under staging (banked
 *   feedback_pre_existing_trust_boundary_reuse_canonical_helper
 *   addendum applied through 7.3a-g).
 * - Symlinks are FOLLOWED at create time and written as regular files
 *   to the staging tree (tar safety; banked pre-existing-trust-
 *   boundary lesson — never include a symlink entry in an archive).
 * - Skills at skills/<name>/SKILL.md carry their whole skill directory;
 *   other skill entries and workflow_specs keep their single-file shape.
 *   Plugins + context_packs (manifest.yaml path → parent
 *   dir) + agent_images are dir paths (recursive copy with symlink
 *   dereference).
 * - Throws on missing source path / path-containment violation /
 *   realpath escape (banked 79a89d40 B1: lexical containment alone is
 *   insufficient — symlinks under sourceRoot can target outside content;
 *   each declared path is realpath-validated, and dir vendoring pre-
 *   walks the tree with lstat to catch nested symlink escapes). The
 *   /create route's outer catch returns 500 with the message; if this
 *   maps poorly to operator UX, a follow-up can wrap to 400.
 *
 * Returns the cross-primitive blocks to populate on the manifest the
 * assembler returned. The /create route writes the manifest AFTER
 * populating these fields so the built bundle.yaml carries them
 * for the install side to route from.
 */
interface AuthorBundleCrossPrimitives {
  skills?: string[];
  plugins?: BundlePluginReference[];
  workflowSpecs?: string[];
  contextPacks?: string[];
  agentImages?: string[];
}

function consumeAuthorBundleYaml(sourceRoot: string, staging: string): AuthorBundleCrossPrimitives {
  const authorBundlePath = nodePath.join(sourceRoot, "bundle.yaml");
  if (!fs.existsSync(authorBundlePath)) return {};
  // Canonicalize sourceRoot before vendoring (banked 79a89d40 B1 guard
  // catch: lexical containment + dereference allows symlinks under
  // sourceRoot to escape). realpath the root once; every declared path's
  // realpath must stay within this boundary.
  const sourceRootReal = fs.realpathSync(sourceRoot);
  const stagingResolved = nodePath.resolve(staging);

  /** Realpath-contain check: the actual file/dir behind `absPath` (after
   * symlink resolution) must live under sourceRootReal. Catches symlinks
   * whose targets escape the source tree even when the lexical path is
   * inside sourceRoot. Throws on escape. */
  const assertSourceRealContained = (absPath: string, kindLabel: string, declared: string): string => {
    let realPath: string;
    try {
      realPath = fs.realpathSync(absPath);
    } catch (err) {
      throw new Error(`author bundle ${kindLabel} '${declared}' does not exist in source: ${(err as Error).message}`);
    }
    if (realPath !== sourceRootReal && !realPath.startsWith(sourceRootReal + nodePath.sep)) {
      throw new Error(`author bundle ${kindLabel} '${declared}' resolves outside bundle source root (symlink escape); rejected`);
    }
    return realPath;
  };

  /** Pre-walk a directory tree with lstat; for every symlink encountered,
   * realpath-check containment under sourceRootReal. Regular files and
   * dirs need no special check (they're inherently contained — the
   * problem class is symlinks escaping). Throws on any escape. */
  const assertNoSymlinkEscapeInTree = (dirAbs: string, kindLabel: string, declared: string): void => {
    const stack: string[] = [dirAbs];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        // Unreadable dir — skip; cpSync will surface the failure if material
        continue;
      }
      for (const entry of entries) {
        const entryAbs = nodePath.join(cur, entry.name);
        if (entry.isSymbolicLink()) {
          // Realpath the symlink target; reject if escapes sourceRootReal
          let entryReal: string;
          try {
            entryReal = fs.realpathSync(entryAbs);
          } catch (err) {
            throw new Error(`author bundle ${kindLabel} '${declared}' has unreadable symlink at '${nodePath.relative(sourceRootReal, entryAbs)}': ${(err as Error).message}`);
          }
          if (entryReal !== sourceRootReal && !entryReal.startsWith(sourceRootReal + nodePath.sep)) {
            throw new Error(`author bundle ${kindLabel} '${declared}' contains nested symlink at '${nodePath.relative(sourceRootReal, entryAbs)}' escaping bundle source root; rejected`);
          }
          // If the symlink target is a directory under sourceRoot, walk it
          // (cpSync with dereference:true will follow it; we need to
          // validate any nested symlinks too)
          try {
            const st = fs.statSync(entryReal);
            if (st.isDirectory()) stack.push(entryReal);
          } catch { /* unreadable — skip */ }
        } else if (entry.isDirectory()) {
          stack.push(entryAbs);
        }
      }
    }
  };

  const authorYaml = fs.readFileSync(authorBundlePath, "utf-8");
  const authorParsed = parsePodBundleManifest(authorYaml) as Record<string, unknown>;
  const result: AuthorBundleCrossPrimitives = {};

  const vendorFile = (declared: string, kindLabel: string): void => {
    if (!isRelativeSafePath(declared)) throw new Error(`author bundle ${kindLabel} path '${declared}' is not safe`);
    const sourceAbs = nodePath.resolve(sourceRootReal, declared);
    // Lexical containment + realpath containment (banked 79a89d40 B1)
    if (sourceAbs !== sourceRootReal && !sourceAbs.startsWith(sourceRootReal + nodePath.sep)) {
      throw new Error(`author bundle ${kindLabel} path '${declared}' escapes bundle source root`);
    }
    if (!fs.existsSync(sourceAbs)) throw new Error(`author bundle ${kindLabel} '${declared}' does not exist in source`);
    assertSourceRealContained(sourceAbs, kindLabel, declared);
    const targetAbs = nodePath.resolve(staging, declared);
    if (!targetAbs.startsWith(stagingResolved + nodePath.sep)) {
      throw new Error(`author bundle ${kindLabel} target '${declared}' escapes staging`);
    }
    // readFileSync follows the symlink; we already validated its realpath
    // stays in sourceRootReal. Write as regular file (tar safety).
    const content = fs.readFileSync(sourceAbs);
    assertShippableSubstance([{ path: declared, bytes: content }]);
    fs.mkdirSync(nodePath.dirname(targetAbs), { recursive: true });
    fs.writeFileSync(targetAbs, content);
  };
  const vendorDir = (declared: string, kindLabel: string): void => {
    if (!isRelativeSafePath(declared)) throw new Error(`author bundle ${kindLabel} path '${declared}' is not safe`);
    const sourceAbs = nodePath.resolve(sourceRootReal, declared);
    if (sourceAbs !== sourceRootReal && !sourceAbs.startsWith(sourceRootReal + nodePath.sep)) {
      throw new Error(`author bundle ${kindLabel} path '${declared}' escapes bundle source root`);
    }
    if (!fs.existsSync(sourceAbs)) throw new Error(`author bundle ${kindLabel} '${declared}' does not exist in source`);
    // Realpath-validate the declared dir itself (catches symlink-to-outside-dir)
    const sourceReal = assertSourceRealContained(sourceAbs, kindLabel, declared);
    // Pre-walk the realpath-resolved dir to catch nested symlink escapes
    // before cpSync dereferences anything
    assertNoSymlinkEscapeInTree(sourceReal, kindLabel, declared);
    const sources: Array<{ path: string; bytes: Buffer }> = [];
    const collectSources = (current: string, prefix: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = nodePath.join(current, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) collectSources(child, relativePath);
        else if (entry.isSymbolicLink() && fs.statSync(child).isDirectory()) {
          collectSources(fs.realpathSync(child), relativePath);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          sources.push({ path: nodePath.join(declared, relativePath), bytes: fs.readFileSync(child) });
        }
      }
    };
    collectSources(sourceReal, "");
    assertShippableSubstance(sources);
    const targetAbs = nodePath.resolve(staging, declared);
    if (!targetAbs.startsWith(stagingResolved + nodePath.sep)) {
      throw new Error(`author bundle ${kindLabel} target '${declared}' escapes staging`);
    }
    fs.mkdirSync(nodePath.dirname(targetAbs), { recursive: true });
    // dereference: true → symlinks followed (now validated safe) and
    // written as regular files for tar safety
    fs.cpSync(sourceAbs, targetAbs, { recursive: true, dereference: true });
  };

  // A portable skill includes its helpers/references. Retain the legacy
  // single-file payload contract outside the discovered skills/<name> tree.
  const rawSkills = authorParsed["skills"];
  if (Array.isArray(rawSkills) && rawSkills.length > 0) {
    const skills = rawSkills.filter((s): s is string => typeof s === "string" && s.length > 0);
    for (const declared of skills) {
      vendorFile(declared, "skill");
      if (/^skills\/[^/]+\/SKILL\.md$/.test(declared)) vendorDir(nodePath.dirname(declared), "skill");
    }
    if (skills.length > 0) result.skills = skills;
  }

  // plugins[] — dir paths via source.path
  const rawPlugins = authorParsed["plugins"];
  if (Array.isArray(rawPlugins) && rawPlugins.length > 0) {
    const plugins: BundlePluginReference[] = [];
    for (const entry of rawPlugins) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const p = entry as Record<string, unknown>;
      const s = p["source"];
      if (typeof p["id"] !== "string" || !p["id"]) continue;
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const src = s as Record<string, unknown>;
      if (src["kind"] !== "local" || typeof src["path"] !== "string" || !src["path"]) continue;
      vendorDir(src["path"], `plugin '${p["id"]}'`);
      plugins.push({ id: p["id"], source: { kind: "local", path: src["path"] } });
    }
    if (plugins.length > 0) result.plugins = plugins;
  }

  // workflow_specs[] — file paths
  const rawWorkflowSpecs = authorParsed["workflow_specs"];
  if (Array.isArray(rawWorkflowSpecs) && rawWorkflowSpecs.length > 0) {
    const workflowSpecs = rawWorkflowSpecs.filter((s): s is string => typeof s === "string" && s.length > 0);
    for (const declared of workflowSpecs) vendorFile(declared, "workflow_spec");
    if (workflowSpecs.length > 0) result.workflowSpecs = workflowSpecs;
  }

  // context_packs[] — manifest.yaml paths; vendor the parent dir
  const rawContextPacks = authorParsed["context_packs"];
  if (Array.isArray(rawContextPacks) && rawContextPacks.length > 0) {
    const contextPacks = rawContextPacks.filter((s): s is string => typeof s === "string" && s.length > 0);
    for (const declared of contextPacks) {
      const parentRel = nodePath.dirname(declared);
      if (parentRel === ".") continue; // declared at root; nothing meaningful to vendor
      vendorDir(parentRel, `context_pack parent of '${declared}'`);
    }
    if (contextPacks.length > 0) result.contextPacks = contextPacks;
  }

  // agent_images[] — dir paths
  const rawAgentImages = authorParsed["agent_images"];
  if (Array.isArray(rawAgentImages) && rawAgentImages.length > 0) {
    const agentImages = rawAgentImages.filter((s): s is string => typeof s === "string" && s.length > 0);
    for (const declared of agentImages) vendorDir(declared, "agent_image");
    if (agentImages.length > 0) result.agentImages = agentImages;
  }

  return result;
}

/** Scan the exact finalized tree that will be packed, including generated files. */
function assertShippableStagingTree(staging: string): void {
  const sources: Array<{ path: string; bytes: Buffer }> = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        sources.push({
          path: nodePath.relative(staging, absolute).split(nodePath.sep).join("/"),
          bytes: fs.readFileSync(absolute),
        });
      } else {
        throw new Error(`Public artifact substance refusal: unsupported staged entry '${nodePath.relative(staging, absolute)}'`);
      }
    }
  };
  walk(staging);
  assertShippableSubstance(sources);
}

/** Describe this artifact; inspecting an older archive never substitutes the current daemon's version. */
function bundleBuildIdentity(manifest: { provenance?: BundleProvenance; configuration?: { id: string }; integrity?: { files: Record<string, string> }; assembler?: { openrigVersion: string; commit?: string } }, archiveHash: string | null) {
  return {
    source: manifest.provenance?.source ?? null,
    configurationId: manifest.configuration?.id ?? null,
    packageDigest: manifest.integrity ? packageDigest(manifest.integrity.files) : null,
    archiveHash,
    assembler: manifest.assembler ?? null,
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
  // `rig bundle create --context-pack <dir>`: packs to carry from anywhere the author names, by manifest name
  const contextPackDirs = Array.isArray(body["contextPackDirs"])
    ? (body["contextPackDirs"] as unknown[]).filter((d): d is string => typeof d === "string" && d.length > 0)
    : [];
  // `rig bundle create --project-dir <dir>`: the project this rig works in (project.yaml and its files)
  const projectDir = typeof body["projectDir"] === "string" && body["projectDir"] ? body["projectDir"] : undefined;
  // `rig bundle create --preset/--seat`: the configuration the CLI staged, recorded in the manifest (outside the package digest)
  const rawConfiguration = body["configuration"] as { id?: unknown; preset?: unknown } | undefined;
  const configuration = rawConfiguration && typeof rawConfiguration.id === "string"
    ? { id: rawConfiguration.id, ...(typeof rawConfiguration.preset === "string" ? { preset: rawConfiguration.preset } : {}) }
    : undefined;

  const allowDrift = body["allowDrift"] === true;

  // Item 1 / slice-05: build provenance from request body + inject daemonVersion server-side
  const rawProvenance = body["provenance"] as Record<string, unknown> | undefined;
  if (rawProvenance?.source !== undefined && !normalizeBundleSource(rawProvenance.source)) return c.json({ error: "Invalid GitHub bundle source identity" }, 400);
  const clientProvenance = provenanceFromRequestBody(rawProvenance);
  let provenance: BundleProvenance | undefined = clientProvenance
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

    // VALIDATE BEFORE ASSESSING. A malformed spec has no trustworthy topology to compare, and a
    // drift 409 raised on one would blame the rig for what is actually a broken file — sending the
    // operator to reconcile a topology when the real answer is "this spec does not parse". Schema
    // errors keep their existing 400 and return before the guard ever runs.
    if (isPodAware) {
      const podValidation = RigSpecSchema.validate(rawParsed);
      if (!podValidation.valid) return c.json({ error: "Invalid pod-aware rig spec", errors: podValidation.errors }, 400);
    } else {
      const legacyValidation = LegacyRigSpecSchema.validate(rawParsed);
      if (!legacyValidation.valid) return c.json({ error: "Invalid rig spec", errors: legacyValidation.errors }, 400);
    }

    // The bundle carries the SPEC verbatim and never consults the live DB, so when a rig's persisted
    // topology has moved (no code path writes the spec back) an export ships a DIFFERENT rig than the
    // one on record. Build B made that delta sayable; saying it on a 201 was not enough. A .rigbundle
    // is a recovery artifact, and a warning stapled to a success is read at the one moment it is
    // least affordable — so any non-conforming topology refuses here.
    //
    // This throws rather than returning null when the repository read itself fails, and that is the
    // point: an enforcement path that swallows a DB error would report "no drift" and export, which
    // is the fail-OPEN this guard exists to remove. It fails closed through the 500 below.
    const drift = assessSpecLiveDrift(rawParsed, getDeps(c).rigRepo);
    const driftWarning = drift ? bundleExportWarning(drift) : null;
    if (driftWarning) console.warn(`[bundle-create] ${driftWarning}`);

    if (specDivergesFromLive(drift) && !allowDrift) {
      return c.json({ error: bundleExportRefusal(drift!) }, 409);
    }

    // Overridden: the operator says they mean it, so the divergence rides INTO the artifact. An HTTP
    // warning dies with the terminal that printed it; whoever restores this bundle months from now
    // reads the manifest, and it must not present as a faithful snapshot of the rig.
    if (driftWarning && allowDrift) {
      const stamp = `EXPORTED WITH --allow-drift: ${driftWarning}`;
      provenance = {
        ...(provenance ?? { daemonVersion: getDaemonVersion() }),
        notes: provenance?.notes ? `${provenance.notes} | ${stamp}` : stamp,
      };
    }

    if (isPodAware) {
      // Pod-aware bundle creation
      // Validated above, before the drift guard ran.
      const effectiveRigRoot = rigRoot ? nodePath.resolve(rigRoot) : nodePath.dirname(nodePath.resolve(specPath));
      const tmpStaging = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pod-bundle-create-"));
      try {
        const assembler = new PodBundleAssembler({ fsOps: podAssemblerFsOps() });
        const result = assembler.assemble({ rigRoot: effectiveRigRoot, rigSpecPath: nodePath.resolve(specPath), outputDir: tmpStaging, bundleName, bundleVersion, provenance, compatibility });

        // Item 6 / Checkpoint 7.5 (QA-20260601 A2 repair): auto-detect
        // author bundle.yaml at the rig source root; vendor declared
        // cross-primitive content into staging + carry the fields onto
        // the manifest. computeIntegrity below covers the vendored content.
        const authorPrimitives = consumeAuthorBundleYaml(effectiveRigRoot, tmpStaging);
        if (authorPrimitives.skills) result.manifest.skills = authorPrimitives.skills;
        if (authorPrimitives.plugins) result.manifest.plugins = authorPrimitives.plugins;
        if (authorPrimitives.workflowSpecs) result.manifest.workflowSpecs = authorPrimitives.workflowSpecs;
        if (authorPrimitives.contextPacks) result.manifest.contextPacks = authorPrimitives.contextPacks;
        if (authorPrimitives.agentImages) result.manifest.agentImages = authorPrimitives.agentImages;
        const actualMapping: Record<string, string> = {};
        for (const pod of RigSpecSchema.normalize(rawParsed as Record<string, unknown>).pods) {
          for (const member of pod.members) actualMapping[`${pod.id}.${member.id}`] = member.runtime;
        }
        const actualConfigurationId = configurationId(actualMapping);
        if (configuration && configuration.id !== actualConfigurationId) return c.json({ error: "Configuration ID does not match the packaged rig spec" }, 400);
        result.manifest.configuration = { id: actualConfigurationId, ...(configuration?.preset ? { preset: configuration.preset } : {}) };
        result.manifest.assembler = { openrigVersion: getDaemonVersion() };
        const carriedPacks = contextPackDirs.map((dir) => vendorContextPackDir(nodePath.resolve(dir), tmpStaging));
        if (carriedPacks.length > 0) result.manifest.contextPacks = [...(result.manifest.contextPacks ?? []), ...carriedPacks];
        if (projectDir) result.manifest.project = vendorProjectDir(nodePath.resolve(projectDir), tmpStaging);

        const integrity = computeIntegrity(tmpStaging, integrityFsOps());
        result.manifest.integrity = integrity;
        fs.writeFileSync(nodePath.join(tmpStaging, "bundle.yaml"), serializePodBundleManifest(result.manifest), "utf-8");

        assertShippableStagingTree(tmpStaging);
        const archiveHash = await pack(tmpStaging, nodePath.resolve(outputPath));
        eventBus.emit({ type: "bundle.created", bundleName, bundleVersion, archiveHash });
        const warning = [driftWarning, ...(result.warnings ?? [])].filter(Boolean).join("; ");
        return c.json({ ...bundleBuildIdentity(result.manifest, archiveHash), bundleName, bundleVersion, archiveHash, schemaVersion: 2, agents: result.manifest.agents.length, ...(warning ? { warning } : {}) }, 201);
      } finally {
        fs.rmSync(tmpStaging, { recursive: true, force: true });
      }
    }

    // Legacy bundle creation
    // Validated above, before the drift guard ran.
    if (contextPackDirs.length > 0) {
      return c.json({ error: "--context-pack needs a pod-aware rig spec (one with pods:)" }, 400);
    }
    if (projectDir) {
      return c.json({ error: "--project-dir needs a pod-aware rig spec (one with pods:)" }, 400);
    }
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

      manifest.assembler = { openrigVersion: getDaemonVersion() };
      // Item 6 / Checkpoint 7.5 (QA-20260601 A2 repair, legacy path mirror):
      // auto-detect author bundle.yaml in source dir; vendor + carry
      // cross-primitive fields before integrity. Re-serialize bundle.yaml
      // since the assembler already wrote one without these fields.
      const legacyAuthorPrimitives = consumeAuthorBundleYaml(specDir, tmpStaging);
      const hasLegacyPrimitives = legacyAuthorPrimitives.skills || legacyAuthorPrimitives.plugins ||
        legacyAuthorPrimitives.workflowSpecs || legacyAuthorPrimitives.contextPacks || legacyAuthorPrimitives.agentImages;
      if (hasLegacyPrimitives || manifest.assembler) {
        if (legacyAuthorPrimitives.skills) manifest.skills = legacyAuthorPrimitives.skills;
        if (legacyAuthorPrimitives.plugins) manifest.plugins = legacyAuthorPrimitives.plugins;
        if (legacyAuthorPrimitives.workflowSpecs) manifest.workflowSpecs = legacyAuthorPrimitives.workflowSpecs;
        if (legacyAuthorPrimitives.contextPacks) manifest.contextPacks = legacyAuthorPrimitives.contextPacks;
        if (legacyAuthorPrimitives.agentImages) manifest.agentImages = legacyAuthorPrimitives.agentImages;
        const { serializeLegacyBundleManifest } = await import("../domain/bundle-types.js");
        fs.writeFileSync(nodePath.join(tmpStaging, "bundle.yaml"), serializeLegacyBundleManifest(manifest), "utf-8");
      }

      const integrity = computeIntegrity(tmpStaging, integrityFsOps());
      writeIntegrity(tmpStaging, integrity, integrityFsOps());
      manifest.integrity = integrity;

      assertShippableStagingTree(tmpStaging);
      const archiveHash = await pack(tmpStaging, nodePath.resolve(outputPath));
      eventBus.emit({ type: "bundle.created", bundleName, bundleVersion, archiveHash });
      return c.json({ ...bundleBuildIdentity(manifest, archiveHash), bundleName, bundleVersion, archiveHash, packages: manifest.packages.length, ...(driftWarning ? { warning: driftWarning } : {}) }, 201);
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
  let archiveHash: string | null = null;
  try {
    const dr = verifyArchiveDigest(bundlePath);
    digestValid = dr.valid;
    archiveHash = dr.actual;
  } catch { /* missing digest = invalid */ }

  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-inspect-"));
  try {
    // Extract with the SAME shared safety pre-scan that unpack() uses, but without
    // content integrity verification (inspect must be able to REPORT a broken
    // bundle rather than refuse it). One source of truth: collectUnsafeArchiveEntries
    // rejects symlinks/hardlinks, POSIX-absolute and Windows drive-absolute paths,
    // and dot-dot traversal (POSIX or backslash). Previously this route hand-rolled a
    // weaker scan that missed drive-letter and backslash-traversal entries, so an
    // archive unpack() refuses could be reported safe by inspect.
    const unsafeEntries = await collectUnsafeArchiveEntries(bundlePath);
    if (unsafeEntries.length > 0) {
      return c.json({ error: `Unsafe archive entries: ${unsafeEntries.join("; ")}`, digestValid }, 200);
    }
    const tar = await import("tar");
    await tar.extract({
      file: bundlePath,
      cwd: tmpDir,
      // Same defensive filter unpack() applies: even if the pre-scan above were
      // bypassed, no unsafe entry is written.
      filter: (p, entry) => {
        if ("isSymbolicLink" in entry && typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) return false;
        const type = "type" in entry ? (entry as { type?: string }).type : undefined;
        return unsafeArchiveEntryReason(p, type) === null;
      },
    });

    const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
    if (!fs.existsSync(manifestPath)) {
      return c.json({ error: "Bundle missing bundle.yaml", digestValid }, 200);
    }
    const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
    const rawParsed = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;
    const describeBehaviour = (identity: ReturnType<typeof bundleBuildIdentity>, filesVerified: boolean): BundleBehaviour => {
      const generator = { openrigVersion: getDaemonVersion() };
      const source = identity.source ? { ...identity.source } : null;
      try {
        return inspectBundleBehaviour(tmpDir, { manifest: rawParsed, ...identity, source, generator, digestValid, filesVerified });
      } catch {
        return {
          schema: "openrig.bundle-behaviour/v1", state: "not_generated",
          identity: { source, configurationId: identity.configurationId, packageDigest: identity.packageDigest, assembler: identity.assembler, generator, integrity: { digestValid, filesVerified } },
          reason: "The archive's behaviour could not be described.", localInspectCommand: "rig bundle inspect <archive> --json",
        };
      }
    };

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
        configuration: typeof (rawParsed["configuration"] as { id?: unknown } | undefined)?.id === "string"
          ? rawParsed["configuration"] as { id: string; preset?: string } : undefined,
        assembler: typeof (rawParsed["assembler"] as { openrigVersion?: unknown } | undefined)?.openrigVersion === "string"
          ? rawParsed["assembler"] as { openrigVersion: string; commit?: string } : undefined,
        // Item 2 / slice-05: surface compatibility normalized to camelCase
        // (same single-contract reason as provenance above). v1 already
        // surfaces via the normalizer at the end of this handler.
        compatibility: normalizeCompatibilityBlock(rawParsed["compatibility"]),
        // Item 6 / Checkpoint 7.5 / QA-20260601 C1 repair: surface the 5
        // cross-primitive blocks normalized to camelCase so /inspect's
        // contract carries the same shape v1's normalizer already
        // surfaces. Raw YAML keys are snake_case; expose camelCase to
        // match the rest of the v2 inspect contract.
        skills: Array.isArray(rawParsed["skills"])
          ? (rawParsed["skills"] as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined,
        plugins: Array.isArray(rawParsed["plugins"])
          ? (rawParsed["plugins"] as Array<Record<string, unknown>>).filter((p) => p && typeof p === "object")
          : undefined,
        workflowSpecs: Array.isArray(rawParsed["workflow_specs"])
          ? (rawParsed["workflow_specs"] as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined,
        contextPacks: Array.isArray(rawParsed["context_packs"])
          ? (rawParsed["context_packs"] as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined,
        agentImages: Array.isArray(rawParsed["agent_images"])
          ? (rawParsed["agent_images"] as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined,
        project: rawParsed["project"] && typeof rawParsed["project"] === "object" && !Array.isArray(rawParsed["project"])
          ? rawParsed["project"] as { id: string; path: string }
          : undefined,
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
      const identity = bundleBuildIdentity(podManifest, archiveHash);
      const behaviour = describeBehaviour(identity, integrityResult.passed);
      return c.json({ ...identity, manifest: podManifest, digestValid, integrityResult, behaviour }, 200);
    }

    const manifest = normalizeBundleManifest(parseBundleManifest(manifestYaml));
    const integrityResult = manifest.integrity
      ? verifyIntegrity(tmpDir, manifest, integrityFsOps())
      : { passed: false, mismatches: [], missing: [], extra: [], errors: ["no integrity section"] };
    const identity = bundleBuildIdentity(manifest, archiveHash);
    const behaviour = describeBehaviour(identity, integrityResult.passed);
    return c.json({ ...identity, manifest, digestValid, integrityResult, behaviour }, 200);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// GET /api/bundles/history — Item 4 / slice-05 Checkpoint 5.2
// Returns the install audit JSONL records (optionally filtered by rig name
// and / or since timestamp). Read-only — no audit-write side effects.
// Empty audit file returns []. Reader fails-open on malformed JSONL lines
// (forward-compat with future record-shape evolutions).
bundleRoutes.get("/history", async (c) => {
  const rig = c.req.query("rig");
  const since = c.req.query("since");
  const reader = new BundleAuditReader({
    opts: { auditPath: bundleAuditPath() },
    fsOps: auditFsOps(),
  });
  const records = reader.list({
    rig: typeof rig === "string" && rig.length > 0 ? rig : undefined,
    since: typeof since === "string" && since.length > 0 ? since : undefined,
  });
  return c.json({ records, total: records.length }, 200);
});

// POST /api/bundles/install — reuses full bootstrap lifecycle
bundleRoutes.post("/install", async (c) => {
  const { bootstrapOrchestrator, bootstrapRepo, eventBus, rigRepo } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const bundlePath = typeof body["bundlePath"] === "string" ? body["bundlePath"] : "";
  const plan = body["plan"] === true;
  const autoApprove = body["autoApprove"] === true;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : undefined;
  const cwdOverride = typeof body["cwdOverride"] === "string" ? body["cwdOverride"] : undefined;
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
        mode: "plan", sourceRef: bundlePath, sourceKind: "rig_bundle", cwdOverride,
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
      autoApprove, targetRoot, cwdOverride, runId: run.id,
    });

    if (result.status === "completed" || result.status === "partial") {
      // A pod-aware (v2) bundle routes its declared skills, plugins, workflow
      // specs, context packs and agent images in bootstrap's pre-launch hook,
      // before any seat launches, and reports the outcome on the result. A
      // legacy v1 bundle has no hook, so it keeps routing after a completed
      // install. Routing never fails the install; failures are reported in
      // routingFailures and the audit.
      const { bundleRouting, ...bootstrapResult } = result;
      const routing: BundleContentRouting | undefined = bundleRouting
        ?? (result.status === "completed" ? await bootstrapOrchestrator.routeBundleContents(bundlePath) : undefined);
      // The hook already put its failures in warnings; the legacy fallback adds its own here.
      const warnings = bundleRouting ? (result.warnings ?? []) : [...(result.warnings ?? []), ...routingFailureWarnings(routing)];
      const responseBody = routing ? { ...bootstrapResult, ...routing, warnings } : { ...bootstrapResult, warnings };
      if (result.status === "completed") {
        eventBus.emit({ type: "bootstrap.completed", runId: result.runId, rigId: result.rigId!, sourceRef: bundlePath });
      } else {
        const ok = result.stages.filter((s: { status: string }) => s.status === "ok").length;
        const fail = result.stages.filter((s: { status: string }) => s.status === "failed" || s.status === "blocked").length;
        eventBus.emit({ type: "bootstrap.partial", runId: result.runId, sourceRef: bundlePath, rigId: result.rigId, completed: ok, failed: fail });
      }
      writeInstallAudit({
        bundlePath, outcome: result.status === "completed" ? "success" : "partial", targetRigId: result.rigId,
        targetRigName: installMeta?.rigName, cliVersion: clientCliVersion,
        bundleManifest: installMeta?.bundleManifest,
        routingFailures: routing?.routingFailures,
      });
      return c.json(responseBody, result.status === "completed" ? 201 : 200);
    }
    eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef: bundlePath, error: result.errors[0] ?? "failed" });
    // The pre-launch hook may have routed contents before a later failure; the result carries what it did.
    writeInstallAudit({
      bundlePath, outcome: "failed",
      targetRigName: installMeta?.rigName, cliVersion: clientCliVersion,
      bundleManifest: installMeta?.bundleManifest,
      routingFailures: result.bundleRouting?.routingFailures,
    });
    const hasBlocked = result.stages.some((s: { status: string }) => s.status === "blocked");
    return c.json(result, hasBlocked ? 409 : 500);
  } catch (err) {
    bootstrapRepo.updateRunStatus(run.id, "failed");
    eventBus.emit({ type: "bootstrap.failed", runId: run.id, sourceRef: bundlePath, error: (err as Error).message });
    writeInstallAudit({
      bundlePath, outcome: "failed",
      targetRigName: installMeta?.rigName, cliVersion: clientCliVersion,
      bundleManifest: installMeta?.bundleManifest,
    });
    return c.json({ runId: run.id, status: "failed", error: (err as Error).message }, 500);
  }
  } finally { bootstrapOrchestrator.release(bundlePath); }
});
