/**
 * TRUST MODEL: Bundle integrity verifies self-consistency, not authenticity.
 * The sibling .sha256 detects corruption during transfer. Content hashes
 * detect tampering of individual files within the archive. Neither mechanism
 * authenticates the bundle author — an attacker who can rewrite the full
 * bundle + digest can bypass verification. Users must trust the source they
 * obtained the bundle from (same model as unsigned npm packages/Docker images).
 * Cryptographic signing (Ed25519) is a future enhancement.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import * as tar from "tar";
import { verifyIntegrity, type IntegrityFsOps } from "./bundle-integrity.js";
// TODO: AS-T12 — migrate to pod-aware bundle types
import { parseLegacyBundleManifest as parseBundleManifest, normalizeLegacyBundleManifest as normalizeBundleManifest } from "./bundle-types.js";

/**
 * Pack a staging directory into a .rigbundle archive (deterministic tar.gz).
 * Writes sibling .sha256 digest file.
 * @returns SHA-256 hex digest of the archive
 */
export async function pack(stagingDir: string, outputPath: string): Promise<string> {
  if (!outputPath.endsWith(".rigbundle")) {
    throw new Error("Output path must end with .rigbundle");
  }

  // Collect all files in deterministic order (alphabetical)
  const allFiles = walkFilesSync(stagingDir).sort();

  // Pack with deterministic settings
  await tar.create(
    {
      gzip: { level: 9 },
      file: outputPath,
      cwd: stagingDir,
      portable: true, // Normalizes uid/gid/mode
      mtime: new Date("2026-01-01T00:00:00Z"), // Fixed mtime for determinism
    },
    allFiles,
  );

  // Compute archive digest
  const archiveHash = hashFile(outputPath);
  fs.writeFileSync(`${outputPath}.sha256`, archiveHash, "utf-8");

  return archiveHash;
}

/**
 * Unpack a .rigbundle archive to a directory.
 * Requires sibling .sha256 digest file. Verifies archive integrity before extraction.
 * Rejects symlinks, hardlinks, path traversal, and absolute paths.
 * Runs content integrity verification after extraction.
 */
export async function unpack(archivePath: string, outputDir: string): Promise<void> {
  // Step 1: Verify archive-level digest
  const digestResult = verifyArchiveDigest(archivePath);
  if (!digestResult.valid) {
    throw new Error(`Archive integrity check failed: expected ${digestResult.expected}, got ${digestResult.actual}`);
  }

  // Step 2: Pre-scan archive for unsafe entries BEFORE extraction
  const unsafeEntries: string[] = [];
  await tar.list({
    file: archivePath,
    onReadEntry: (entry) => {
      const entryPath = entry.path;
      const entryType = entry.type;
      if (entryType === "SymbolicLink" || entryType === "Link") {
        unsafeEntries.push(`${entryType}: ${entryPath}`);
      }
      if (entryPath.startsWith("/")) {
        unsafeEntries.push(`absolute path: ${entryPath}`);
      }
      const segments = entryPath.split("/");
      if (segments.some((s: string) => s === "..")) {
        unsafeEntries.push(`path traversal: ${entryPath}`);
      }
    },
  });

  if (unsafeEntries.length > 0) {
    throw new Error(`Unsafe archive entries rejected: ${unsafeEntries.join("; ")}`);
  }

  // Step 3: Extract (safe — pre-scanned)
  fs.mkdirSync(outputDir, { recursive: true });
  await tar.extract({ file: archivePath, cwd: outputDir });

  // Step 3: Verify content integrity
  const manifestPath = nodePath.join(outputDir, "bundle.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Extracted archive missing bundle.yaml");
  }

  const rawYaml = fs.readFileSync(manifestPath, "utf-8");
  const raw = parseBundleManifest(rawYaml) as Record<string, unknown>;

  // Schema-version-aware integrity extraction
  const schemaVersion = raw["schema_version"] as number;
  let integrity: { algorithm: string; files: Record<string, string> } | undefined;

  if (schemaVersion === 2) {
    // Pod-aware bundle: integrity is optional in manifest
    if (raw["integrity"] && typeof raw["integrity"] === "object") {
      const integ = raw["integrity"] as Record<string, unknown>;
      integrity = { algorithm: integ["algorithm"] as string, files: (integ["files"] as Record<string, string>) ?? {} };
    }
  } else {
    // Legacy bundle: parse as v1
    const manifest = normalizeBundleManifest(raw);
    integrity = manifest.integrity;
  }

  if (!integrity) {
    throw new Error("Bundle manifest missing integrity section — cannot verify content");
  }

  {
    const fsOps: IntegrityFsOps = {
      readFile: (p) => fs.readFileSync(p, "utf-8"),
      readFileBuffer: (p) => fs.readFileSync(p),
      writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
      exists: (p) => fs.existsSync(p),
      walkFiles: (dir) => walkFilesSync(dir),
    };

    // verifyIntegrity only reads manifest.integrity — safe to cast
    const result = verifyIntegrity(outputDir, { integrity } as unknown as Parameters<typeof verifyIntegrity>[1], fsOps);
    if (!result.passed) {
      const details = [
        ...result.mismatches.map((f) => `tampered: ${f}`),
        ...result.missing.map((f) => `missing: ${f}`),
        ...result.extra.map((f) => `extra: ${f}`),
        ...result.errors,
      ];
      throw new Error(`Content integrity verification failed: ${details.join("; ")}`);
    }
  }
}

/**
 * Verify the archive-level SHA-256 digest.
 * Requires sibling .sha256 file.
 */
export function verifyArchiveDigest(archivePath: string): { valid: boolean; expected: string; actual: string } {
  const digestPath = `${archivePath}.sha256`;
  if (!fs.existsSync(digestPath)) {
    throw new Error(`Archive digest file required but missing: ${digestPath}`);
  }

  const expected = fs.readFileSync(digestPath, "utf-8").trim();
  const actual = hashFile(archivePath);

  return { valid: expected === actual, expected, actual };
}

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function walkFilesSync(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string, prefix: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(nodePath.join(d, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else {
        results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }
  walk(dir, "");
  return results;
}
