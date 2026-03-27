import nodePath from "node:path";
import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { serializeBundleManifest, type BundleManifest } from "./bundle-types.js";

export interface AssemblerFsOps {
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  mkdirp: (path: string) => void;
  writeFile: (path: string, content: string) => void;
  copyDir: (src: string, dest: string) => void;
}

export interface PackageInput {
  name: string;
  version: string;
  sourcePath: string;
  originalSource: string;
  manifestHash: string;
}

export interface AssembleOptions {
  specPath: string;
  packages: PackageInput[];
  outputDir: string;
  bundleName: string;
  bundleVersion: string;
}

/**
 * Assembles a bundle staging directory with canonical layout.
 * Generates bundle.yaml without integrity (P7-T02 adds that).
 */
export class BundleAssembler {
  private fs: AssemblerFsOps;

  constructor(deps: { fsOps: AssemblerFsOps }) {
    this.fs = deps.fsOps;
  }

  assemble(opts: AssembleOptions): BundleManifest {
    // Validate rig spec exists
    if (!this.fs.exists(opts.specPath)) {
      throw new Error(`Rig spec not found: ${opts.specPath}`);
    }

    // Validate rig spec content
    const specYaml = this.fs.readFile(opts.specPath);
    const raw = RigSpecCodec.parse(specYaml);
    const validation = RigSpecSchema.validate(raw);
    if (!validation.valid) {
      throw new Error(`Invalid rig spec: ${validation.errors.join("; ")}`);
    }

    // Deduplicate packages by name + manifestHash, preserving all original sources
    const seen = new Map<string, { pkg: PackageInput; sources: string[] }>();
    const dedupedPackages: Array<{ pkg: PackageInput; sources: string[] }> = [];
    for (const pkg of opts.packages) {
      const existing = seen.get(pkg.name);
      if (existing) {
        if (existing.pkg.manifestHash !== pkg.manifestHash) {
          throw new Error(`Duplicate package name '${pkg.name}' with different content (hash mismatch)`);
        }
        // Same name + same hash -> collect source for provenance
        if (!existing.sources.includes(pkg.originalSource)) {
          existing.sources.push(pkg.originalSource);
        }
        continue;
      }
      const entry = { pkg, sources: [pkg.originalSource] };
      seen.set(pkg.name, entry);
      dedupedPackages.push(entry);
    }

    // Validate all package source paths exist
    for (const { pkg } of dedupedPackages) {
      if (!this.fs.exists(pkg.sourcePath)) {
        throw new Error(`Package directory not found: ${pkg.sourcePath} (${pkg.name})`);
      }
    }

    // Create staging directory
    this.fs.mkdirp(opts.outputDir);

    // Copy rig spec
    this.fs.writeFile(nodePath.join(opts.outputDir, "rig.yaml"), specYaml);

    // Vendor packages
    const packageEntries: BundleManifest["packages"] = [];
    for (const { pkg, sources } of dedupedPackages) {
      const destPath = `packages/${pkg.name}`;
      const destFull = nodePath.join(opts.outputDir, destPath);
      this.fs.mkdirp(nodePath.dirname(destFull));
      this.fs.copyDir(pkg.sourcePath, destFull);
      packageEntries.push({
        name: pkg.name,
        version: pkg.version,
        path: destPath,
        originalSource: sources[0]!,
        ...(sources.length > 1 ? { originalSources: sources } : {}),
      });
    }

    // Generate manifest (no integrity — P7-T02 adds it)
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: opts.bundleName,
      version: opts.bundleVersion,
      createdAt: new Date().toISOString(),
      rigSpec: "rig.yaml",
      packages: packageEntries,
    };

    // Write bundle.yaml
    this.fs.writeFile(
      nodePath.join(opts.outputDir, "bundle.yaml"),
      serializeBundleManifest(manifest),
    );

    return manifest;
  }
}
