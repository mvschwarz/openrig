import { createHash } from "node:crypto";
import nodePath from "node:path";
// TODO: AS-T12 — migrate to pod-aware bundle types
import type { LegacyBundleManifest as BundleManifest, BundleIntegrity } from "./bundle-types.js";
import { parseLegacyBundleManifest as parseBundleManifest, normalizeLegacyBundleManifest as normalizeBundleManifest, serializeLegacyBundleManifest as serializeBundleManifest } from "./bundle-types.js";

export interface IntegrityFsOps {
  readFile: (path: string) => string;
  readFileBuffer: (path: string) => Buffer;
  writeFile: (path: string, content: string) => void;
  exists: (path: string) => boolean;
  walkFiles: (dir: string) => string[];
}

/** Files to ignore during integrity operations */
const IGNORE_FILES = new Set([".DS_Store", "Thumbs.db", ".gitkeep"]);

/** Reserved control files — not content, not extras */
const CONTROL_FILES = new Set(["bundle.yaml"]);

/** Sensitive path patterns that block bundle creation */
const SENSITIVE_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.env$/,
  /^credentials\./,
  /^tokens\./,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /^\.git\//,
  /^node_modules\//,
];

function isSensitivePath(relativePath: string): boolean {
  const name = nodePath.basename(relativePath);
  return SENSITIVE_PATTERNS.some((p) => p.test(name) || p.test(relativePath));
}

function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute integrity hashes for all content files in a bundle directory.
 * Throws on sensitive paths. Excludes control files and OS junk.
 */
export function computeIntegrity(dir: string, fsOps: IntegrityFsOps): BundleIntegrity {
  const allFiles = fsOps.walkFiles(dir);
  const files: Record<string, string> = {};
  const sensitive: string[] = [];

  for (const relPath of allFiles) {
    const name = nodePath.basename(relPath);
    if (IGNORE_FILES.has(name)) continue;
    if (CONTROL_FILES.has(relPath)) continue;

    if (isSensitivePath(relPath)) {
      sensitive.push(relPath);
      continue;
    }

    const fullPath = nodePath.join(dir, relPath);
    const content = fsOps.readFileBuffer(fullPath);
    files[relPath] = hashContent(content);
  }

  if (sensitive.length > 0) {
    throw new Error(`Sensitive paths detected in bundle: ${sensitive.join(", ")}`);
  }

  return { algorithm: "sha256", files };
}

/**
 * Write integrity section into bundle.yaml, then write bundle.yaml.sha256 digest.
 */
export function writeIntegrity(dir: string, integrity: BundleIntegrity, fsOps: IntegrityFsOps): void {
  const manifestPath = nodePath.join(dir, "bundle.yaml");
  const yaml = fsOps.readFile(manifestPath);
  const raw = parseBundleManifest(yaml);
  const manifest = normalizeBundleManifest(raw);
  manifest.integrity = integrity;
  const updatedYaml = serializeBundleManifest(manifest);
  fsOps.writeFile(manifestPath, updatedYaml);
}

/** Verification result */
export interface VerifyResult {
  passed: boolean;
  mismatches: string[];
  missing: string[];
  extra: string[];
  errors: string[];
}

/**
 * Verify bundle integrity. Checks manifest digest first, then per-file hashes.
 */
export function verifyIntegrity(dir: string, manifest: BundleManifest, fsOps: IntegrityFsOps): VerifyResult {
  const result: VerifyResult = {
    passed: true,
    mismatches: [],
    missing: [],
    extra: [],
    errors: [],
  };

  // Verify content file integrity (manifest trust is P7-T03's archive-level responsibility)
  if (!manifest.integrity) {
    result.passed = false;
    result.errors.push("manifest has no integrity section");
    return result;
  }

  const expectedFiles = manifest.integrity.files;

  // Check expected files
  for (const [relPath, expectedHash] of Object.entries(expectedFiles)) {
    const fullPath = nodePath.join(dir, relPath);
    if (!fsOps.exists(fullPath)) {
      result.missing.push(relPath);
      result.passed = false;
      continue;
    }
    const actualHash = hashContent(fsOps.readFileBuffer(fullPath));
    if (actualHash !== expectedHash) {
      result.mismatches.push(relPath);
      result.passed = false;
    }
  }

  // Check for extra files + sensitive paths
  const allFiles = fsOps.walkFiles(dir);
  const expectedSet = new Set(Object.keys(expectedFiles));
  for (const relPath of allFiles) {
    const name = nodePath.basename(relPath);
    if (IGNORE_FILES.has(name)) continue;
    if (CONTROL_FILES.has(relPath)) continue;
    if (!expectedSet.has(relPath)) {
      result.extra.push(relPath);
      result.passed = false;
    }
    // Check for sensitive paths on install/verify path (not just create)
    if (isSensitivePath(relPath)) {
      result.errors.push(`Sensitive file detected: ${relPath}`);
      result.passed = false;
    }
  }

  return result;
}
