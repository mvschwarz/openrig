import { LegacyRigSpecCodec as RigSpecCodec } from "./rigspec-codec.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { LegacyRigSpecSchema as RigSpecSchema } from "./rigspec-schema.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec

export type SourceKind = "rig_spec" | "rig_bundle";

export interface RouteResult {
  sourceKind: SourceKind;
  sourceRef: string;
}

interface RouterFsOps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  readHead: (path: string, bytes: number) => Buffer;
}

/** Gzip magic bytes: 0x1f 0x8b */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/**
 * Routes a source path to the correct bootstrap pipeline based on
 * file extension or content-based auto-detection.
 */
export class UpCommandRouter {
  private fs: RouterFsOps;

  constructor(deps: { fsOps: RouterFsOps }) {
    this.fs = deps.fsOps;
  }

  route(sourceRef: string): RouteResult {
    if (!this.fs.exists(sourceRef)) {
      throw new Error(`Source not found: ${sourceRef}`);
    }

    // Extension-based routing
    const ext = sourceRef.split(".").pop()?.toLowerCase();
    if (ext === "rigbundle") {
      return { sourceKind: "rig_bundle", sourceRef };
    }
    if (ext === "yaml" || ext === "yml") {
      // Validate semantically — reject bundle.yaml, package.yaml, etc.
      return this.validateYamlAsRigSpec(sourceRef);
    }

    // Auto-detection fallback for extensionless files
    return this.autoDetect(sourceRef);
  }

  private validateYamlAsRigSpec(sourceRef: string): RouteResult {
    try {
      const content = this.fs.readFile(sourceRef);
      const raw = RigSpecCodec.parse(content);
      const validation = RigSpecSchema.validate(raw);
      if (validation.valid) {
        return { sourceKind: "rig_spec", sourceRef };
      }

      // Not a valid rig spec — give helpful error
      const obj = raw as Record<string, unknown> | null;
      if (obj && typeof obj === "object") {
        if ("packages" in obj && ("integrity" in obj || "rig_spec" in obj)) {
          throw new Error(`Source appears to be a bundle manifest (bundle.yaml), not a rig spec. Use 'rigged bundle install' instead.`);
        }
        if ("exports" in obj || "compatibility" in obj) {
          throw new Error(`Source appears to be a package manifest (package.yaml), not a rig spec. Use 'rigged package install' instead.`);
        }
      }

      throw new Error(`Source is YAML but not a valid rig spec: ${validation.errors[0] ?? "unknown error"}`);
    } catch (err) {
      if ((err as Error).message.includes("Source appears") || (err as Error).message.includes("Source is YAML")) {
        throw err;
      }
      throw new Error(`Failed to parse '${sourceRef}' as rig spec: ${(err as Error).message}`);
    }
  }

  private autoDetect(sourceRef: string): RouteResult {
    // Check for gzip (binary bundle)
    try {
      const head = this.fs.readHead(sourceRef, 2);
      if (head.length >= 2 && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1]) {
        return { sourceKind: "rig_bundle", sourceRef };
      }
    } catch {
      // Can't read head — try as text
    }

    // Try parsing as YAML and validating as rig spec
    try {
      const content = this.fs.readFile(sourceRef);
      const raw = RigSpecCodec.parse(content);
      const validation = RigSpecSchema.validate(raw);

      if (validation.valid) {
        return { sourceKind: "rig_spec", sourceRef };
      }

      // Valid YAML but not a rig spec — provide helpful message
      const obj = raw as Record<string, unknown> | null;
      if (obj && typeof obj === "object") {
        if ("packages" in obj && "integrity" in obj) {
          throw new Error(`Source appears to be a bundle manifest (bundle.yaml), not a rig spec. Use 'rigged bundle install' instead.`);
        }
        if ("exports" in obj || "compatibility" in obj) {
          throw new Error(`Source appears to be a package manifest (package.yaml), not a rig spec. Use 'rigged package install' instead.`);
        }
      }

      throw new Error(`Source is YAML but not a valid rig spec: ${validation.errors[0] ?? "unknown error"}. Use .yaml for rig specs or .rigbundle for bundles.`);
    } catch (err) {
      if ((err as Error).message.includes("Source appears") || (err as Error).message.includes("Source is YAML")) {
        throw err; // Re-throw our helpful messages
      }
      throw new Error(`Unable to determine source type for '${sourceRef}'. Use .yaml for rig specs or .rigbundle for bundles.`);
    }
  }
}
