import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
// TODO: AS-T12 — migrate to pod-aware bundle assembler
import { LegacyBundleAssembler as BundleAssembler, type AssemblerFsOps } from "../src/domain/bundle-assembler.js";
// TODO: AS-T12 — migrate to pod-aware bundle types
import { parseLegacyBundleManifest as parseBundleManifest, validateLegacyBundleManifest as validateBundleManifest, normalizeLegacyBundleManifest as normalizeBundleManifest } from "../src/domain/bundle-types.js";

const VALID_SPEC = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

function realFsOps(): AssemblerFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    copyDir: (src, dest) => fs.cpSync(src, dest, { recursive: true }),
  };
}

describe("BundleAssembler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-asm-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSpec(yaml: string = VALID_SPEC): string {
    const p = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(p, yaml);
    return p;
  }

  function writePkg(name: string, files: Record<string, string>): string {
    const dir = path.join(tmpDir, `src-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  // T1: Assembles staging dir with correct layout
  it("assembles staging dir with rig.yaml + packages/ + bundle.yaml", () => {
    const specPath = writeSpec();
    const pkgDir = writePkg("review-kit", { "package.yaml": "name: review-kit", "skills/deep/SKILL.md": "# Deep" });
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    assembler.assemble({
      specPath, outputDir, bundleName: "test-bundle", bundleVersion: "0.1.0",
      packages: [{ name: "review-kit", version: "0.1.0", sourcePath: pkgDir, originalSource: "local:./review-kit", manifestHash: "hash1" }],
    });

    expect(fs.existsSync(path.join(outputDir, "rig.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "bundle.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "packages/review-kit/package.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "packages/review-kit/skills/deep/SKILL.md"))).toBe(true);
  });

  // T2: Rig spec copied to root
  it("rig spec content copied to outputDir/rig.yaml", () => {
    const specPath = writeSpec();
    const pkgDir = writePkg("pkg", { "package.yaml": "name: pkg" });
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    assembler.assemble({
      specPath, outputDir, bundleName: "b", bundleVersion: "1.0",
      packages: [{ name: "pkg", version: "1.0", sourcePath: pkgDir, originalSource: "", manifestHash: "h" }],
    });

    expect(fs.readFileSync(path.join(outputDir, "rig.yaml"), "utf-8")).toBe(VALID_SPEC);
  });

  // T3: Package vendored as full directory
  it("package vendored as full directory with all files", () => {
    const specPath = writeSpec();
    const pkgDir = writePkg("tools", { "package.yaml": "pkg", "skills/a/SKILL.md": "A", "hooks/pre.sh": "echo hi" });
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    assembler.assemble({
      specPath, outputDir, bundleName: "b", bundleVersion: "1.0",
      packages: [{ name: "tools", version: "1.0", sourcePath: pkgDir, originalSource: "", manifestHash: "h" }],
    });

    expect(fs.readFileSync(path.join(outputDir, "packages/tools/skills/a/SKILL.md"), "utf-8")).toBe("A");
    expect(fs.readFileSync(path.join(outputDir, "packages/tools/hooks/pre.sh"), "utf-8")).toBe("echo hi");
  });

  // T4: bundle.yaml has correct package index
  it("bundle.yaml has correct package index", () => {
    const specPath = writeSpec();
    const pkgDir = writePkg("kit", { "package.yaml": "name: kit" });
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    const manifest = assembler.assemble({
      specPath, outputDir, bundleName: "my-bundle", bundleVersion: "2.0",
      packages: [{ name: "kit", version: "1.0.0", sourcePath: pkgDir, originalSource: "github:ex/kit@v1", manifestHash: "h" }],
    });

    expect(manifest.packages).toHaveLength(1);
    expect(manifest.packages[0]!.name).toBe("kit");
    expect(manifest.packages[0]!.path).toBe("packages/kit");
  });

  // T5: Original source refs preserved
  it("original source refs preserved in manifest", () => {
    const specPath = writeSpec();
    const pkgDir = writePkg("pkg", { "package.yaml": "name: pkg" });
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    const manifest = assembler.assemble({
      specPath, outputDir, bundleName: "b", bundleVersion: "1.0",
      packages: [{ name: "pkg", version: "1.0", sourcePath: pkgDir, originalSource: "github:acme/pkg@v2", manifestHash: "h" }],
    });

    expect(manifest.packages[0]!.originalSource).toBe("github:acme/pkg@v2");
  });

  // T6: Missing package directory -> throws
  it("missing package directory throws", () => {
    const specPath = writeSpec();
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    expect(() => assembler.assemble({
      specPath, outputDir, bundleName: "b", bundleVersion: "1.0",
      packages: [{ name: "ghost", version: "1.0", sourcePath: "/nonexistent/path", originalSource: "", manifestHash: "h" }],
    })).toThrow(/not found/);
  });

  // T7: Missing rig spec -> throws
  it("missing rig spec throws", () => {
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    expect(() => assembler.assemble({
      specPath: "/nonexistent/rig.yaml", outputDir, bundleName: "b", bundleVersion: "1.0",
      packages: [{ name: "pkg", version: "1.0", sourcePath: tmpDir, originalSource: "", manifestHash: "h" }],
    })).toThrow(/not found/);
  });

  // T7b: Invalid rig spec content -> throws with validation errors
  it("invalid rig spec content throws with validation errors", () => {
    const badSpec = "schema_version: 1\n# missing name, version, nodes";
    const specPath = path.join(tmpDir, "bad.yaml");
    fs.writeFileSync(specPath, badSpec);
    const pkgDir = writePkg("pkg", { "package.yaml": "name: pkg" });
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    expect(() => assembler.assemble({
      specPath, outputDir, bundleName: "b", bundleVersion: "1.0",
      packages: [{ name: "pkg", version: "1.0", sourcePath: pkgDir, originalSource: "", manifestHash: "h" }],
    })).toThrow(/Invalid rig spec/);
  });

  // T8: Multiple packages assembled
  it("multiple packages assembled in correct structure", () => {
    const specPath = writeSpec();
    const pkg1 = writePkg("alpha", { "package.yaml": "name: alpha" });
    const pkg2 = writePkg("beta", { "package.yaml": "name: beta", "skills/b/SKILL.md": "B" });
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    const manifest = assembler.assemble({
      specPath, outputDir, bundleName: "multi", bundleVersion: "1.0",
      packages: [
        { name: "alpha", version: "1.0", sourcePath: pkg1, originalSource: "", manifestHash: "h1" },
        { name: "beta", version: "2.0", sourcePath: pkg2, originalSource: "", manifestHash: "h2" },
      ],
    });

    expect(manifest.packages).toHaveLength(2);
    expect(fs.existsSync(path.join(outputDir, "packages/alpha/package.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "packages/beta/skills/b/SKILL.md"))).toBe(true);
  });

  // T9: Duplicate package names with different hash -> rejected
  it("duplicate package name with different manifestHash rejected", () => {
    const specPath = writeSpec();
    const pkg1 = writePkg("dup", { "package.yaml": "v1" });
    const pkg2 = writePkg("dup2", { "package.yaml": "v2" });
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    expect(() => assembler.assemble({
      specPath, outputDir, bundleName: "b", bundleVersion: "1.0",
      packages: [
        { name: "dup", version: "1.0", sourcePath: pkg1, originalSource: "", manifestHash: "hash-a" },
        { name: "dup", version: "2.0", sourcePath: pkg2, originalSource: "", manifestHash: "hash-b" },
      ],
    })).toThrow(/Duplicate package name.*hash mismatch/);
  });

  // T10: Identical packages deduplicated
  it("identical packages (same name + hash) deduplicated to one", () => {
    const specPath = writeSpec();
    const pkgDir = writePkg("shared", { "package.yaml": "name: shared" });
    const outputDir = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realFsOps() });

    const manifest = assembler.assemble({
      specPath, outputDir, bundleName: "b", bundleVersion: "1.0",
      packages: [
        { name: "shared", version: "1.0", sourcePath: pkgDir, originalSource: "local:./a", manifestHash: "same-hash" },
        { name: "shared", version: "1.0", sourcePath: pkgDir, originalSource: "local:./b", manifestHash: "same-hash" },
      ],
    });

    expect(manifest.packages).toHaveLength(1);
    expect(manifest.packages[0]!.name).toBe("shared");
    // Both original sources preserved in memory
    expect(manifest.packages[0]!.originalSources).toEqual(["local:./a", "local:./b"]);
    expect(manifest.packages[0]!.originalSource).toBe("local:./a");

    // Round-trip: verify on-disk bundle.yaml preserves both sources
    const diskYaml = fs.readFileSync(path.join(outputDir, "bundle.yaml"), "utf-8");
    const parsed = parseBundleManifest(diskYaml);
    const validation = validateBundleManifest(parsed, { requireIntegrity: false });
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.packages[0]!.originalSources).toEqual(["local:./a", "local:./b"]);
  });
});
