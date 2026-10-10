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

  const outDir = nodePath.dirname(outputPath);
  if (outDir && !fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Collect all files in deterministic order (alphabetical)
  const allFiles = walkFilesSync(stagingDir).sort();

  // Pack with deterministic settings
  await tar.create(
    {
      gzip: { level: 9 },
      file: outputPath,
      cwd: stagingDir,
      portable: true, // Omits machine-specific owner metadata
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
 * Normalize a tar entry path for safety checks: Windows backslashes to
 * forward slashes so a `..\\escape` or `C:\\…` entry cannot slip past a
 * POSIX-only check.
 */
export function normalizeArchiveEntryPath(entryPath: string): string {
  return entryPath.replace(/\\/g, "/");
}

/**
 * The single unsafe-entry verdict shared by bundle extraction and inspection.
 * Returns a human-readable reason when the entry must be refused, or `null`
 * when the entry is safe. Rejects symlinks/hardlinks, POSIX-absolute and
 * Windows drive-absolute paths, and dot-dot traversal (POSIX or backslash).
 *
 * One source of truth: `unpack()` and the `/api/bundles/inspect` route both
 * call this so a bundle cannot be refused by one and reported safe by the
 * other. The labels (`SymbolicLink:`, `absolute path:`, `path traversal:`)
 * are part of the refusal contract.
 */
export function unsafeArchiveEntryReason(entryPath: string, entryType?: string): string | null {
  if (entryType === "SymbolicLink" || entryType === "Link") {
    return `${entryType}: ${entryPath}`;
  }
  const normalizedPath = normalizeArchiveEntryPath(entryPath);
  if (normalizedPath.startsWith("/") || /^[a-zA-Z]:/.test(normalizedPath)) {
    return `absolute path: ${entryPath}`;
  }
  if (normalizedPath.split("/").some((segment) => segment === "..")) {
    return `path traversal: ${entryPath}`;
  }
  return null;
}

/**
 * Pre-scan an archive and return every unsafe entry reason (empty when clean).
 * Shared by `unpack()` and the `/api/bundles/inspect` route so both apply the
 * same boundary before any extraction happens.
 */
export async function collectUnsafeArchiveEntries(archivePath: string): Promise<string[]> {
  const unsafeEntries: string[] = [];
  await tar.list({
    file: archivePath,
    onReadEntry: (entry) => {
      const reason = unsafeArchiveEntryReason(entry.path, entry.type);
      if (reason) unsafeEntries.push(reason);
    },
  });
  return unsafeEntries;
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
  const unsafeEntries = await collectUnsafeArchiveEntries(archivePath);

  if (unsafeEntries.length > 0) {
    throw new Error(`Unsafe archive entries rejected: ${unsafeEntries.join("; ")}`);
  }

  // Step 3: Extract (safe — pre-scanned and defensively filtered)
  fs.mkdirSync(outputDir, { recursive: true });
  await tar.extract({
    file: archivePath,
    cwd: outputDir,
    filter: (p, entry) => {
      if ("isSymbolicLink" in entry && typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) return false;
      const type = "type" in entry ? (entry as { type?: string }).type : undefined;
      return unsafeArchiveEntryReason(p, type) === null;
    },
  });

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
