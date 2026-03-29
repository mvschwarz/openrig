import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import * as tar from "tar";
import { pack, unpack, verifyArchiveDigest } from "../src/domain/bundle-archive.js";
// TODO: AS-T12 — migrate to pod-aware bundle types
import { serializeLegacyBundleManifest as serializeBundleManifest, type LegacyBundleManifest as BundleManifest } from "../src/domain/bundle-types.js";
import { computeIntegrity, writeIntegrity, type IntegrityFsOps } from "../src/domain/bundle-integrity.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function realIntegrityFsOps(): IntegrityFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p) => fs.readFileSync(p),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    walkFiles: (dir) => {
      const results: string[] = [];
      function walk(d: string, prefix: string) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(d, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
          else results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
        }
      }
      walk(dir, "");
      return results;
    },
  };
}

describe("Bundle archive", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-archive-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createStaging(): string {
    const staging = path.join(tmpDir, "staging");
    fs.mkdirSync(path.join(staging, "packages/pkg"), { recursive: true });
    fs.writeFileSync(path.join(staging, "rig.yaml"), "schema_version: 1\nname: test\nversion: '1.0'\nnodes:\n  - id: dev\n    runtime: claude-code\nedges: []");
    fs.writeFileSync(path.join(staging, "packages/pkg/SKILL.md"), "# Skill");

    const manifest: BundleManifest = {
      schemaVersion: 1, name: "test-bundle", version: "0.1.0",
      createdAt: "2026-01-01T00:00:00Z", rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    fs.writeFileSync(path.join(staging, "bundle.yaml"), serializeBundleManifest(manifest));

    // Add integrity
    const integrity = computeIntegrity(staging, realIntegrityFsOps());
    writeIntegrity(staging, integrity, realIntegrityFsOps());

    return staging;
  }

  // T1: Pack creates valid tar.gz
  it("pack creates valid tar.gz file", async () => {
    const staging = createStaging();
    const outputPath = path.join(tmpDir, "test.rigbundle");

    const hash = await pack(staging, outputPath);

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
  });

  // T2: Unpack extracts to correct structure
  it("unpack extracts to correct directory structure", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);

    expect(fs.existsSync(path.join(extractDir, "bundle.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, "rig.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, "packages/pkg/SKILL.md"))).toBe(true);
  });

  // T3: Round-trip
  it("round-trip: pack -> unpack -> files match", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);

    const origSkill = fs.readFileSync(path.join(staging, "packages/pkg/SKILL.md"), "utf-8");
    const extractedSkill = fs.readFileSync(path.join(extractDir, "packages/pkg/SKILL.md"), "utf-8");
    expect(extractedSkill).toBe(origSkill);
  });

  // T4: Path traversal rejected — create archive with ../ via low-level tar pack
  it("path traversal in archive entry rejected during extraction", async () => {
    // Create a staging dir with a file, then manually pack with a ../ prefix
    const malDir = path.join(tmpDir, "mal-staging");
    fs.mkdirSync(malDir, { recursive: true });
    fs.writeFileSync(path.join(malDir, "evil.txt"), "escape!");

    const malArchive = path.join(tmpDir, "mal.rigbundle");
    // Use tar.create with prefix to inject ../ into entry names
    await tar.create(
      { gzip: true, file: malArchive, cwd: malDir, prefix: "../escape" },
      ["evil.txt"],
    );

    // Write a valid .sha256 digest so we get past the digest check
    const archiveHash = createHash("sha256").update(fs.readFileSync(malArchive)).digest("hex");
    fs.writeFileSync(`${malArchive}.sha256`, archiveHash);

    await expect(unpack(malArchive, path.join(tmpDir, "out")))
      .rejects.toThrow(/Unsafe archive entry|path traversal/i);
  });

  // T4b: Symlink entry rejection
  it("symlink in archive rejected during extraction", async () => {
    // Create an archive that includes a symlink entry
    const symlinkDir = path.join(tmpDir, "sym-staging");
    fs.mkdirSync(symlinkDir, { recursive: true });
    fs.writeFileSync(path.join(symlinkDir, "real.txt"), "real content");
    fs.symlinkSync("/etc/passwd", path.join(symlinkDir, "escape-link"));

    const symArchive = path.join(tmpDir, "sym.rigbundle");
    await tar.create(
      { gzip: true, file: symArchive, cwd: symlinkDir, follow: false },
      ["real.txt", "escape-link"],
    );

    const archiveHash = createHash("sha256").update(fs.readFileSync(symArchive)).digest("hex");
    fs.writeFileSync(`${symArchive}.sha256`, archiveHash);

    await expect(unpack(symArchive, path.join(tmpDir, "out")))
      .rejects.toThrow(/Unsafe archive entry|SymbolicLink/i);
  });

  // T5: Corrupted archive -> error
  it("corrupted archive throws on unpack", async () => {
    const archivePath = path.join(tmpDir, "corrupt.rigbundle");
    fs.writeFileSync(archivePath, "not a real tar.gz");
    fs.writeFileSync(`${archivePath}.sha256`, sha256("not a real tar.gz"));

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow();
  });

  // T6: Content integrity verified after unpack
  it("content integrity verified after extraction", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // Unpack should succeed (integrity passes)
    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);
    // No error = integrity passed
  });

  // T7: Tampered file detected post-unpack
  it("tampered file in archive detected after extraction", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // Extract first
    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);

    // Tamper a file
    fs.writeFileSync(path.join(extractDir, "rig.yaml"), "tampered!");

    // Re-verification would fail (but unpack already verified — this tests the verify function)
    const { verifyIntegrity: vi2 } = await import("../src/domain/bundle-integrity.js");
    // TODO: AS-T12 — migrate to pod-aware bundle types
    const { parseLegacyBundleManifest: parseBundleManifest, normalizeLegacyBundleManifest: normalizeBundleManifest } = await import("../src/domain/bundle-types.js");
    const manifestYaml = fs.readFileSync(path.join(extractDir, "bundle.yaml"), "utf-8");
    const manifest = normalizeBundleManifest(parseBundleManifest(manifestYaml));
    const result = vi2(extractDir, manifest, realIntegrityFsOps());
    expect(result.passed).toBe(false);
    expect(result.mismatches).toContain("rig.yaml");
  });

  // T8: .rigbundle extension enforced
  it(".rigbundle extension enforced on output path", async () => {
    const staging = createStaging();
    await expect(pack(staging, path.join(tmpDir, "test.tar.gz")))
      .rejects.toThrow(/\.rigbundle/);
  });

  // T9: .sha256 sibling written during pack
  it(".sha256 sibling file written during pack", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    const hash = await pack(staging, archivePath);

    const digestPath = `${archivePath}.sha256`;
    expect(fs.existsSync(digestPath)).toBe(true);
    expect(fs.readFileSync(digestPath, "utf-8").trim()).toBe(hash);
  });

  // T10: Missing .sha256 -> unpack throws
  it("missing .sha256 throws on unpack", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // Remove the digest file
    fs.unlinkSync(`${archivePath}.sha256`);

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow(/digest file required/);
  });

  // T11: Digest mismatch -> unpack throws
  it("archive digest mismatch throws on unpack", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // Tamper the digest
    fs.writeFileSync(`${archivePath}.sha256`, "0000000000000000000000000000000000000000000000000000000000000000");

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow(/integrity check failed/);
  });

  // T12b: Missing integrity section in bundle.yaml -> unpack rejects
  it("unpack rejects archive whose bundle.yaml lacks integrity section", async () => {
    // Create staging without integrity
    const staging = path.join(tmpDir, "no-integ-staging");
    fs.mkdirSync(path.join(staging, "packages/pkg"), { recursive: true });
    fs.writeFileSync(path.join(staging, "rig.yaml"), "schema_version: 1\nname: test\nversion: '1.0'\nnodes:\n  - id: dev\n    runtime: claude-code\nedges: []");
    fs.writeFileSync(path.join(staging, "packages/pkg/SKILL.md"), "# Skill");

    const manifest: BundleManifest = {
      schemaVersion: 1, name: "no-integ", version: "0.1.0",
      createdAt: "2026-01-01T00:00:00Z", rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "" }],
      // No integrity section
    };
    fs.writeFileSync(path.join(staging, "bundle.yaml"), serializeBundleManifest(manifest));

    const archivePath = path.join(tmpDir, "no-integ.rigbundle");
    await pack(staging, archivePath);

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow(/missing integrity section/);
  });

  // T12: Deterministic output
  it("pack same content twice produces identical archives", async () => {
    const staging = createStaging();
    const out1 = path.join(tmpDir, "a.rigbundle");
    const out2 = path.join(tmpDir, "b.rigbundle");

    const hash1 = await pack(staging, out1);
    const hash2 = await pack(staging, out2);

    expect(hash1).toBe(hash2);
    expect(fs.readFileSync(out1).equals(fs.readFileSync(out2))).toBe(true);
  });
});
