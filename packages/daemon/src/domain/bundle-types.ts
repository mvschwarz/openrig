import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** A package entry in the bundle manifest */
export interface BundlePackageEntry {
  name: string;
  version: string;
  path: string;
  originalSource: string;
  /** All original source refs when deduped from multiple inputs */
  originalSources?: string[];
}

/** Integrity section with per-file checksums */
export interface BundleIntegrity {
  algorithm: "sha256";
  files: Record<string, string>;
}

/** The bundle.yaml manifest */
export interface BundleManifest {
  schemaVersion: number;
  name: string;
  version: string;
  createdAt: string;
  rigSpec: string;
  packages: BundlePackageEntry[];
  integrity?: BundleIntegrity;
}

/** Validation options */
interface ValidateOptions {
  requireIntegrity?: boolean;
}

/**
 * Check if a path is a safe archive-relative path.
 * Rejects: absolute paths, ../ traversal, backslashes, dot segments (./, bare .),
 * empty segments (//), empty string.
 */
export function isRelativeSafePath(p: string): boolean {
  if (!p || p.length === 0) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/** Validate a raw parsed bundle manifest */
export function validateBundleManifest(
  raw: unknown,
  opts?: ValidateOptions,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const requireIntegrity = opts?.requireIntegrity ?? true;

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["manifest must be an object"] };
  }

  const m = raw as Record<string, unknown>;

  if (m["schema_version"] !== 1) errors.push("schema_version must be 1");
  if (typeof m["name"] !== "string" || !m["name"]) errors.push("name is required");
  if (typeof m["version"] !== "string" || !m["version"]) errors.push("version is required");

  // rig_spec path
  if (typeof m["rig_spec"] !== "string" || !m["rig_spec"]) {
    errors.push("rig_spec path is required");
  } else if (!isRelativeSafePath(m["rig_spec"] as string)) {
    errors.push(`rig_spec path is not a safe relative path: '${m["rig_spec"]}'`);
  }

  // packages
  if (!Array.isArray(m["packages"]) || m["packages"].length === 0) {
    errors.push("packages must be a non-empty array");
  } else {
    for (let i = 0; i < m["packages"].length; i++) {
      const pkg = m["packages"][i] as Record<string, unknown>;
      if (typeof pkg["name"] !== "string" || !pkg["name"]) errors.push(`packages[${i}].name is required`);
      if (typeof pkg["version"] !== "string" || !pkg["version"]) errors.push(`packages[${i}].version is required`);
      if (typeof pkg["path"] !== "string" || !pkg["path"]) {
        errors.push(`packages[${i}].path is required`);
      } else if (!isRelativeSafePath(pkg["path"] as string)) {
        errors.push(`packages[${i}].path is not a safe relative path: '${pkg["path"]}'`);
      }
    }
  }

  // integrity (optional unless requireIntegrity)
  if (requireIntegrity) {
    if (!m["integrity"] || typeof m["integrity"] !== "object") {
      errors.push("integrity section is required");
    } else {
      const integrity = m["integrity"] as Record<string, unknown>;
      if (integrity["algorithm"] !== "sha256") errors.push("integrity.algorithm must be 'sha256'");
      if (!integrity["files"] || typeof integrity["files"] !== "object" || Object.keys(integrity["files"] as object).length === 0) {
        errors.push("integrity.files must be a non-empty object");
      } else {
        for (const key of Object.keys(integrity["files"] as object)) {
          if (!isRelativeSafePath(key)) {
            errors.push(`integrity.files key is not a safe relative path: '${key}'`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Parse bundle.yaml YAML string to unknown */
export function parseBundleManifest(yaml: string): unknown {
  return parseYaml(yaml);
}

/** Normalize raw parsed manifest to typed BundleManifest */
export function normalizeBundleManifest(raw: unknown): BundleManifest {
  const m = raw as Record<string, unknown>;
  const pkgs = (m["packages"] as Array<Record<string, unknown>>).map((p) => {
    const entry: BundlePackageEntry = {
      name: p["name"] as string,
      version: p["version"] as string,
      path: p["path"] as string,
      originalSource: (p["original_source"] as string) ?? "",
    };
    if (Array.isArray(p["original_sources"])) {
      entry.originalSources = p["original_sources"] as string[];
    }
    return entry;
  });

  const result: BundleManifest = {
    schemaVersion: (m["schema_version"] as number) ?? 1,
    name: m["name"] as string,
    version: m["version"] as string,
    createdAt: (m["created_at"] as string) ?? new Date().toISOString(),
    rigSpec: m["rig_spec"] as string,
    packages: pkgs,
  };

  if (m["integrity"] && typeof m["integrity"] === "object") {
    const integ = m["integrity"] as Record<string, unknown>;
    result.integrity = {
      algorithm: "sha256",
      files: (integ["files"] as Record<string, string>) ?? {},
    };
  }

  return result;
}

/** Serialize a BundleManifest to YAML */
export function serializeBundleManifest(manifest: BundleManifest): string {
  const doc: Record<string, unknown> = {
    schema_version: manifest.schemaVersion,
    name: manifest.name,
    version: manifest.version,
    created_at: manifest.createdAt,
    rig_spec: manifest.rigSpec,
    packages: manifest.packages.map((p) => ({
      name: p.name,
      version: p.version,
      path: p.path,
      original_source: p.originalSource,
      ...(p.originalSources && p.originalSources.length > 1 ? { original_sources: p.originalSources } : {}),
    })),
  };

  if (manifest.integrity) {
    doc["integrity"] = {
      algorithm: manifest.integrity.algorithm,
      files: manifest.integrity.files,
    };
  }

  return stringifyYaml(doc);
}
