import os from "node:os";
import fs from "node:fs";
import nodePath from "node:path";
import { unpack } from "./bundle-archive.js";
// TODO: AS-T12 — migrate to pod-aware bundle types
import { parseLegacyBundleManifest as parseBundleManifest, validateLegacyBundleManifest as validateBundleManifest, normalizeLegacyBundleManifest as normalizeBundleManifest, type LegacyBundleManifest as BundleManifest } from "./bundle-types.js";
import { resolvePackage } from "./package-resolve-helper.js";
import { isPathInsideRoot } from "./cwd-resolution.js";
import type { ResolvedPackage, FsOps } from "./package-resolver.js";

/** Result of resolving a bundle for bootstrap consumption */
export interface BundleResolvedSource {
  specPath: string;
  resolvedPackages: ResolvedPackage[];
  /** Map from original ref (as it appears in rig spec package_refs) to resolved package */
  packageRefMap: Record<string, ResolvedPackage>;
  manifest: BundleManifest;
  tempDir: string;
}

/**
 * Resolves a .rigbundle archive into bootstrap-compatible sources.
 * Extracts, verifies, parses manifest, maps vendored packages.
 */
// TODO: AS-T12 — migrate to pod-aware bundle source resolver
export class LegacyBundleSourceResolver {
  private fsOps: FsOps;

  constructor(deps: { fsOps: FsOps }) {
    this.fsOps = deps.fsOps;
  }

  /**
   * Resolve a bundle archive into bootstrap-compatible sources.
   * Caller must call cleanup(tempDir) after use.
   */
  async resolve(bundlePath: string): Promise<BundleResolvedSource> {
    const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigbundle-"));

    try {
      // Extract + verify (archive digest + content integrity)
      await unpack(bundlePath, tempDir);

      // Parse bundle manifest
      const manifestPath = nodePath.join(tempDir, "bundle.yaml");
      if (!fs.existsSync(manifestPath)) {
        throw new Error("Extracted bundle missing bundle.yaml");
      }
      const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
      const raw = parseBundleManifest(manifestYaml);

      // Validate manifest (path safety via isRelativeSafePath in validateBundleManifest)
      const validation = validateBundleManifest(raw, { requireIntegrity: false });
      if (!validation.valid) {
        throw new Error(`Invalid bundle manifest: ${validation.errors.join("; ")}`);
      }

      const manifest = normalizeBundleManifest(raw);

      // Locate rig spec — ensure resolved path stays within tempDir
      const specPath = nodePath.resolve(tempDir, manifest.rigSpec);
      if (!isPathInsideRoot(specPath, tempDir)) {
        throw new Error(`Rig spec path '${manifest.rigSpec}' escapes bundle workspace`);
      }
      if (!fs.existsSync(specPath)) {
        throw new Error(`Rig spec '${manifest.rigSpec}' not found in bundle`);
      }

      // Resolve vendored packages
      const resolvedPackages: ResolvedPackage[] = [];
      const packageRefMap: Record<string, ResolvedPackage> = {};

      for (const entry of manifest.packages) {
        // Ensure package path stays within tempDir
        const vendoredDir = nodePath.resolve(tempDir, entry.path);
        if (!isPathInsideRoot(vendoredDir, tempDir)) {
          throw new Error(`Package path '${entry.path}' escapes bundle workspace`);
        }
        const result = resolvePackage(vendoredDir, undefined, this.fsOps);

        if (!result.ok) {
          const errMsg = result.kind === "validation" ? result.errors.join("; ") : result.error;
          throw new Error(`Failed to resolve vendored package '${entry.name}': ${errMsg}`);
        }

        resolvedPackages.push(result.resolved);

        // Map all original refs to this resolved package
        packageRefMap[entry.originalSource] = result.resolved;
        if (entry.originalSources) {
          for (const src of entry.originalSources) {
            packageRefMap[src] = result.resolved;
          }
        }
        // Also map by vendored path (for local resolution)
        packageRefMap[entry.path] = result.resolved;
        packageRefMap[`./${entry.path}`] = result.resolved;
      }

      return { specPath, resolvedPackages, packageRefMap, manifest, tempDir };
    } catch (err) {
      // Clean up on failure
      this.cleanup(tempDir);
      throw err;
    }
  }

  /** Remove the temp extraction directory. */
  cleanup(tempDir: string): void {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

// -- Pod-aware bundle source resolver (AgentSpec reboot) --

import { parsePodBundleManifest, validatePodBundleManifest, type PodBundleManifest } from "./bundle-types.js";

/** Result of resolving a pod-aware bundle */
export interface PodBundleResolvedSource {
  specPath: string;
  manifest: PodBundleManifest;
  tempDir: string;
}

/**
 * Resolves a pod-aware .rigbundle archive (schemaVersion 2).
 * Extracts, verifies manifest shape, returns paths for downstream resolution.
 */
export class PodBundleSourceResolver {
  async resolve(bundlePath: string): Promise<PodBundleResolvedSource> {
    const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "podbundle-"));

    try {
      // Safe unpack with digest/symlink/integrity verification
      await unpack(bundlePath, tempDir);

      const manifestPath = nodePath.join(tempDir, "bundle.yaml");
      if (!fs.existsSync(manifestPath)) {
        throw new Error("Bundle missing bundle.yaml manifest");
      }

      const raw = parsePodBundleManifest(fs.readFileSync(manifestPath, "utf-8"));
      const validation = validatePodBundleManifest(raw);
      if (!validation.valid) {
        throw new Error(`Invalid pod bundle manifest: ${validation.errors.join("; ")}`);
      }

      const m = raw as Record<string, unknown>;
      const manifest: PodBundleManifest = {
        schemaVersion: 2,
        name: m["name"] as string,
        version: m["version"] as string,
        createdAt: m["created_at"] as string,
        rigSpec: m["rig_spec"] as string,
        agents: (m["agents"] as Array<Record<string, unknown>>).map((a) => ({
          name: a["name"] as string,
          version: a["version"] as string,
          path: a["path"] as string,
          originalRef: (a["original_ref"] as string) ?? "",
          hash: a["hash"] as string,
          importEntries: Array.isArray(a["import_entries"])
            ? (a["import_entries"] as Array<Record<string, unknown>>).map((ie) => ({
                name: ie["name"] as string,
                version: ie["version"] as string,
                path: ie["path"] as string,
                originalRef: (ie["original_ref"] as string) ?? "",
                hash: ie["hash"] as string,
              }))
            : [],
        })),
        cultureFile: m["culture_file"] as string | undefined,
      };

      const specPath = nodePath.join(tempDir, manifest.rigSpec);
      if (!fs.existsSync(specPath)) {
        throw new Error(`Bundle missing rig spec at ${manifest.rigSpec}`);
      }

      return { specPath, manifest, tempDir };
    } catch (err) {
      this.cleanup(tempDir);
      throw err;
    }
  }

  cleanup(tempDir: string): void {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Copy an extracted (already verified) pod bundle into a stable target root so
 * the rig launched from it keeps a live spec dir, agent refs and `cwd: "."`
 * after the temp extraction is removed.
 *
 * Refuses — writing nothing — when any bundle file would land on a path in the
 * target that holds different content (or a directory). Identical files are
 * left as they are, so re-installing the same bundle into the same target works.
 */
export function materializePodBundle(
  extractedDir: string,
  targetRoot: string,
): { ok: true } | { ok: false; conflicts: string[] } {
  const files: string[] = [];
  (function walk(dir: string, prefix: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? nodePath.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) walk(nodePath.join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  })(extractedDir, "");

  const conflicts = new Set<string>();
  for (const rel of files) {
    const dest = nodePath.join(targetRoot, rel);
    const stat = fs.statSync(dest, { throwIfNoEntry: false });
    if (!stat) {
      // A missing file is fine unless the nearest existing parent is not a directory.
      let parent = nodePath.dirname(dest);
      while (parent.length > targetRoot.length && !fs.existsSync(parent)) parent = nodePath.dirname(parent);
      if (parent.length > targetRoot.length && !fs.statSync(parent).isDirectory()) {
        conflicts.add(nodePath.relative(targetRoot, parent));
      }
      continue;
    }
    if (!stat.isFile() || !fs.readFileSync(dest).equals(fs.readFileSync(nodePath.join(extractedDir, rel)))) {
      conflicts.add(rel);
    }
  }
  if (conflicts.size > 0) return { ok: false, conflicts: [...conflicts] };

  for (const rel of files) {
    const dest = nodePath.join(targetRoot, rel);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
    fs.copyFileSync(nodePath.join(extractedDir, rel), dest);
  }
  return { ok: true };
}
