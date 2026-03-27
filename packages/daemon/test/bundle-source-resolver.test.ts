import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BundleAssembler, type AssemblerFsOps } from "../src/domain/bundle-assembler.js";
import { computeIntegrity, writeIntegrity, type IntegrityFsOps } from "../src/domain/bundle-integrity.js";
import { pack } from "../src/domain/bundle-archive.js";
import { BundleSourceResolver } from "../src/domain/bundle-source-resolver.js";
import type { FsOps } from "../src/domain/package-resolver.js";

const VALID_SPEC = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - ./packages/review-kit
edges: []
`.trim();

const VALID_PKG_MANIFEST = `
schema_version: 1
name: review-kit
version: "1.0.0"
summary: Review tools
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/deep
      name: deep-review
      supported_scopes:
        - project_shared
      default_scope: project_shared
`.trim();

function realAssemblerFsOps(): AssemblerFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    copyDir: (s, d) => fs.cpSync(s, d, { recursive: true }),
  };
}

function realIntegrityFsOps(): IntegrityFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p) => fs.readFileSync(p),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    walkFiles: (dir) => {
      const r: string[] = [];
      function walk(d: string, prefix: string) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(d, e.name), prefix ? `${prefix}/${e.name}` : e.name);
          else r.push(prefix ? `${prefix}/${e.name}` : e.name);
        }
      }
      walk(dir, "");
      return r;
    },
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
          if (e.isDirectory()) walk(path.join(d, e.name), prefix ? `${prefix}/${e.name}` : e.name);
          else r.push(prefix ? `${prefix}/${e.name}` : e.name);
        }
      }
      walk(dir, "");
      return r;
    },
  };
}

describe("BundleSourceResolver", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-resolver-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a complete .rigbundle from scratch */
  async function createBundle(opts?: { specYaml?: string; pkgManifest?: string; originalSource?: string; originalSources?: string[] }): Promise<string> {
    // Write source package
    const pkgDir = path.join(tmpDir, "src-pkg");
    fs.mkdirSync(path.join(pkgDir, "skills/deep"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.yaml"), opts?.pkgManifest ?? VALID_PKG_MANIFEST);
    fs.writeFileSync(path.join(pkgDir, "skills/deep/SKILL.md"), "# Deep Review");

    // Write rig spec
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, opts?.specYaml ?? VALID_SPEC);

    // Assemble
    const staging = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realAssemblerFsOps() });
    const manifestHash = "test-hash";

    const packages = [
      { name: "review-kit", version: "1.0.0", sourcePath: pkgDir, originalSource: opts?.originalSource ?? "github:example/review-kit@v1", manifestHash },
    ];
    if (opts?.originalSources) {
      // Add duplicate entries for dedupe testing
      for (const src of opts.originalSources.slice(1)) {
        packages.push({ name: "review-kit", version: "1.0.0", sourcePath: pkgDir, originalSource: src, manifestHash });
      }
    }

    assembler.assemble({ specPath, packages, outputDir: staging, bundleName: "test-bundle", bundleVersion: "0.1.0" });

    // Add integrity
    const integrity = computeIntegrity(staging, realIntegrityFsOps());
    writeIntegrity(staging, integrity, realIntegrityFsOps());

    // Pack
    const bundlePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, bundlePath);

    return bundlePath;
  }

  // T1: Resolves rig spec from extracted bundle
  it("resolves rig spec from extracted bundle", async () => {
    const bundlePath = await createBundle();
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    const result = await resolver.resolve(bundlePath);

    expect(fs.existsSync(result.specPath)).toBe(true);
    expect(result.specPath.endsWith("rig.yaml")).toBe(true);

    resolver.cleanup(result.tempDir);
  });

  // T2: Maps vendored packages with sourceKind='local_path'
  it("maps vendored packages to local_path resolver format", async () => {
    const bundlePath = await createBundle();
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    const result = await resolver.resolve(bundlePath);

    expect(result.resolvedPackages).toHaveLength(1);
    expect(result.resolvedPackages[0]!.sourceKind).toBe("local_path");
    expect(result.resolvedPackages[0]!.manifest.name).toBe("review-kit");

    resolver.cleanup(result.tempDir);
  });

  // T3: Invalid bundle.yaml (bad schema) -> error on resolve
  it("invalid bundle.yaml with missing required fields throws on resolve", async () => {
    // Create a raw archive with a bad bundle.yaml (missing name, version, etc.)
    const rawDir = path.join(tmpDir, "raw-bad");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, "bundle.yaml"), "schema_version: 1\n# missing everything else");
    fs.writeFileSync(path.join(rawDir, "rig.yaml"), VALID_SPEC);

    // Pack directly (skip assembler/integrity — this is a pathological bundle)
    const badBundle = path.join(tmpDir, "bad.rigbundle");
    await pack(rawDir, badBundle);

    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });
    // Should fail — either integrity (no section) or validation (bad manifest) or extraction error
    await expect(resolver.resolve(badBundle)).rejects.toThrow();
  });

  // T5: Bundle with missing rig.yaml referenced by manifest -> error
  it("bundle missing rig.yaml referenced by manifest throws on resolve", async () => {
    // Create a valid bundle, then rebuild without rig.yaml
    const rawDir = path.join(tmpDir, "raw-no-spec");
    fs.mkdirSync(path.join(rawDir, "packages/pkg"), { recursive: true });
    fs.writeFileSync(path.join(rawDir, "packages/pkg/package.yaml"), VALID_PKG_MANIFEST);
    fs.mkdirSync(path.join(rawDir, "packages/pkg/skills/deep"), { recursive: true });
    fs.writeFileSync(path.join(rawDir, "packages/pkg/skills/deep/SKILL.md"), "# Skill");
    // bundle.yaml references rig.yaml but we don't create it
    const { serializeBundleManifest } = await import("../src/domain/bundle-types.js");
    const manifest = {
      schemaVersion: 1, name: "no-spec", version: "0.1.0",
      createdAt: "2026-01-01T00:00:00Z", rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    fs.writeFileSync(path.join(rawDir, "bundle.yaml"), serializeBundleManifest(manifest));

    // Add integrity (which will NOT include rig.yaml since it doesn't exist)
    const integrity = computeIntegrity(rawDir, realIntegrityFsOps());
    writeIntegrity(rawDir, integrity, realIntegrityFsOps());

    const badBundle = path.join(tmpDir, "no-spec.rigbundle");
    await pack(rawDir, badBundle);

    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });
    await expect(resolver.resolve(badBundle)).rejects.toThrow(/not found in bundle|missing/i);
  });

  // T6: Package refs map to vendored content (including deduped refs)
  it("packageRefMap includes all original refs for deduped packages", async () => {
    const bundlePath = await createBundle({
      originalSource: "local:./a",
      originalSources: ["local:./a", "local:./b"],
    });
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    const result = await resolver.resolve(bundlePath);

    // Both original sources should map to the same resolved package
    expect(result.packageRefMap["local:./a"]).toBeDefined();
    expect(result.packageRefMap["local:./b"]).toBeDefined();
    expect(result.packageRefMap["local:./a"]!.manifest.name).toBe("review-kit");
    expect(result.packageRefMap["local:./b"]!.manifest.name).toBe("review-kit");
    // Same resolved package object
    expect(result.packageRefMap["local:./a"]).toBe(result.packageRefMap["local:./b"]);

    resolver.cleanup(result.tempDir);
  });

  // T7: Original source refs in metadata
  it("original source refs available in bundle manifest", async () => {
    const bundlePath = await createBundle({ originalSource: "github:example/review-kit@v1" });
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    const result = await resolver.resolve(bundlePath);

    expect(result.manifest.packages[0]!.originalSource).toBe("github:example/review-kit@v1");

    resolver.cleanup(result.tempDir);
  });

  // T8: Temp workspace created
  it("temp workspace created and usable", async () => {
    const bundlePath = await createBundle();
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    const result = await resolver.resolve(bundlePath);

    expect(fs.existsSync(result.tempDir)).toBe(true);
    expect(fs.existsSync(path.join(result.tempDir, "bundle.yaml"))).toBe(true);

    resolver.cleanup(result.tempDir);
    expect(fs.existsSync(result.tempDir)).toBe(false);
  });

  // T9: Failed resolution cleans up temp dir
  it("failed resolution cleans up temp dir", async () => {
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    // Count temp dirs before
    const tmpBase = os.tmpdir();
    const before = fs.readdirSync(tmpBase).filter((d) => d.startsWith("rigbundle-")).length;

    try {
      await resolver.resolve("/nonexistent.rigbundle");
    } catch {
      // Expected to throw
    }

    // No new temp dirs should remain
    const after = fs.readdirSync(tmpBase).filter((d) => d.startsWith("rigbundle-")).length;
    expect(after).toBeLessThanOrEqual(before);
  });
});
