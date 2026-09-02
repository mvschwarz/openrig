import { LegacyRigSpecCodec as LegacyCodec } from "./rigspec-codec.js";
import { LegacyRigSpecSchema as LegacySchema } from "./rigspec-schema.js";
import { RigSpecCodec as PodCodec } from "./rigspec-codec.js";
import { RigSpecSchema as PodSchema } from "./rigspec-schema.js";
import { yamlTextHasTopLevelRigsList } from "./topology/topology-manifest.js";

export type SourceKind = "rig_spec" | "rig_bundle" | "rig_name" | "topology";

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

function isPodAwareShape(raw: unknown): boolean {
  return raw !== null
    && typeof raw === "object"
    && Array.isArray((raw as Record<string, unknown>)["pods"]);
}

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
    // Rig name detection: no '/' and no file extension → treat as existing rig name.
    // OPR.0.4.4.11 (guard G-1): `.rigtopology` counts as a file extension here,
    // so a bare `factory.rigtopology` reaches topology routing. A no-slash
    // EXTENSIONLESS source keeps rig_name precedence byte-for-byte (FR-2
    // negative AC; `./file` is the explicit path escape hatch).
    if (!sourceRef.includes("/") && !sourceRef.match(/\.(ya?ml|rigbundle|rigtopology)$/i)) {
      return { sourceKind: "rig_name", sourceRef };
    }

    if (!this.fs.exists(sourceRef)) {
      throw new Error(`Source not found: ${sourceRef}. Provide a .yaml rig spec path or a rig name to restore.`);
    }

    // Extension-based routing
    const ext = sourceRef.split(".").pop()?.toLowerCase();
    if (ext === "rigbundle") {
      return { sourceKind: "rig_bundle", sourceRef };
    }
    // OPR.0.4.4.11 (arch ruling 1): the declared extension BINDS — a
    // `.rigtopology` file failing manifest validation errors downstream AS a
    // topology; it never falls through to rig-spec parsing.
    if (ext === "rigtopology") {
      return { sourceKind: "topology", sourceRef };
    }
    if (ext === "yaml" || ext === "yml") {
      // OPR.0.4.4.11 (guard yaml fold): a YAML document with a top-level
      // `rigs:` LIST is a topology by the FR-1 detection contract — sniff
      // BEFORE rig-spec validation so a `factory.yaml` topology never dies
      // in a confusing rig-spec error. A rig spec never carries top-level
      // `rigs:`, so the sniff is unambiguous. Unreadable files flow to the
      // existing rig-spec path, which reports them unchanged.
      try {
        if (yamlTextHasTopLevelRigsList(this.fs.readFile(sourceRef))) {
          return { sourceKind: "topology", sourceRef };
        }
      } catch {
        // fall through — validateYamlAsRigSpec owns the error surface
      }
      // Validate semantically — reject bundle.yaml, package.yaml, etc.
      return this.validateYamlAsRigSpec(sourceRef);
    }

    // Auto-detection fallback for extensionless files
    return this.autoDetect(sourceRef);
  }

  private validateYamlAsRigSpec(sourceRef: string): RouteResult {
    try {
      const content = this.fs.readFile(sourceRef);

      // Try canonical pod-aware schema first
      const podRaw = PodCodec.parse(content);
      const podValidation = PodSchema.validate(podRaw);
      if (podValidation.valid) {
        return { sourceKind: "rig_spec", sourceRef };
      }
      // S7: a pod-shaped document belongs to the pod-aware validator even
      // when invalid. Falling through to legacy replaces an exact topology
      // diagnostic with the unrelated "nodes is required" error.
      if (isPodAwareShape(podRaw)) {
        throw new Error(`Source is YAML but not a valid rig spec: ${podValidation.errors[0] ?? "unknown error"}`);
      }

      // Fall back to legacy schema
      const raw = LegacyCodec.parse(content);
      const validation = LegacySchema.validate(raw);
      if (validation.valid) {
        return { sourceKind: "rig_spec", sourceRef };
      }

      // Not a valid rig spec — give helpful error
      const obj = raw as Record<string, unknown> | null;
      if (obj && typeof obj === "object") {
        if ("packages" in obj && ("integrity" in obj || "rig_spec" in obj)) {
          throw new Error(`Source appears to be a bundle manifest (bundle.yaml), not a rig spec. Use 'rig bundle install' instead.`);
        }
        if ("exports" in obj || "compatibility" in obj) {
          throw new Error(`Source appears to be a package manifest (package.yaml), not a rig spec. Use 'rig package install' instead.`);
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

    // Try parsing as YAML and validating as rig spec (canonical first, then legacy)
    try {
      const content = this.fs.readFile(sourceRef);

      // OPR.0.4.4.11 (guard G-1): extensionless PATH-form sources gain the
      // top-level `rigs:` list sniff → topology. Only reachable for path
      // forms — a no-slash extensionless source classified rig_name above
      // and never reaches autoDetect (documented precedence).
      if (yamlTextHasTopLevelRigsList(content)) {
        return { sourceKind: "topology", sourceRef };
      }

      // Try canonical pod-aware
      const podRaw = PodCodec.parse(content);
      const podVal = PodSchema.validate(podRaw);
      if (podVal.valid) {
        return { sourceKind: "rig_spec", sourceRef };
      }
      if (isPodAwareShape(podRaw)) {
        throw new Error(`Source is YAML but not a valid rig spec: ${podVal.errors[0] ?? "unknown error"}. Use .yaml for rig specs or .rigbundle for bundles.`);
      }

      // Try legacy
      const raw = LegacyCodec.parse(content);
      const validation = LegacySchema.validate(raw);
      if (validation.valid) {
        return { sourceKind: "rig_spec", sourceRef };
      }

      // Valid YAML but not a rig spec — provide helpful message
      const obj = raw as Record<string, unknown> | null;
      if (obj && typeof obj === "object") {
        if ("packages" in obj && "integrity" in obj) {
          throw new Error(`Source appears to be a bundle manifest (bundle.yaml), not a rig spec. Use 'rig bundle install' instead.`);
        }
        if ("exports" in obj || "compatibility" in obj) {
          throw new Error(`Source appears to be a package manifest (package.yaml), not a rig spec. Use 'rig package install' instead.`);
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
