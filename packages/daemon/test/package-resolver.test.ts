import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { PackageResolver, type FsOps } from "../src/domain/package-resolver.js";

const VALID_MANIFEST = `
schema_version: 1
name: test-pkg
version: 1.0.0
summary: A test package
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
`;

const INVALID_MANIFEST = `
schema_version: 1
name: test-pkg
`;

function mockFs(files: Record<string, string>): FsOps {
  files = Object.fromEntries(Object.entries(files).map(([file, contents]) => [path.resolve(file), contents]));
  return {
    readFile: vi.fn((p: string) => {
      if (files[path.resolve(p)] !== undefined) return files[path.resolve(p)]!;
      throw new Error(`ENOENT: ${p}`);
    }),
    exists: vi.fn((p: string) => path.resolve(p) in files),
  };
}

describe("PackageResolver", () => {
  // Test 1: Resolve absolute path -> finds package.yaml, parses + normalizes, correct source identity
  it("resolve absolute path -> manifest + source identity", () => {
    const fs = mockFs({
      "/packages/my-pkg/package.yaml": VALID_MANIFEST,
    });
    const resolver = new PackageResolver(fs);
    const result = resolver.resolve("/packages/my-pkg");

    expect(result.sourceKind).toBe("local_path");
    expect(result.sourceRef).toBe("/packages/my-pkg");
    expect(result.manifest.name).toBe("test-pkg");
    expect(result.manifest.version).toBe("1.0.0");
    expect(result.manifest.summary).toBe("A test package");
    expect(result.manifest.exports.skills).toHaveLength(1);
  });

  // Test 2: Resolve missing package.yaml -> error
  it("resolve path without package.yaml -> error", () => {
    const fs = mockFs({});
    const resolver = new PackageResolver(fs);

    expect(() => resolver.resolve("/packages/empty")).toThrow(/No package\.yaml found/);
  });

  // Test 3: Resolve invalid manifest -> validation error
  it("resolve path with invalid manifest -> validation error", () => {
    const fs = mockFs({
      "/packages/bad/package.yaml": INVALID_MANIFEST,
    });
    const resolver = new PackageResolver(fs);

    expect(() => resolver.resolve("/packages/bad")).toThrow(/Invalid manifest/);
  });

  // Test 4: Hash is deterministic
  it("manifest hash is deterministic (same content -> same SHA-256)", () => {
    const fs = mockFs({
      "/pkg1/package.yaml": VALID_MANIFEST,
      "/pkg2/package.yaml": VALID_MANIFEST,
    });
    const resolver = new PackageResolver(fs);

    const r1 = resolver.resolve("/pkg1");
    const r2 = resolver.resolve("/pkg2");

    expect(r1.manifestHash).toBe(r2.manifestHash);
    expect(r1.manifestHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256
  });

  // Test 9: Resolve relative path against cwd -> correct absolute sourceRef
  it("resolve relative path against cwd -> absolute sourceRef", () => {
    const fs = mockFs({
      "/home/user/code/my-pkg/package.yaml": VALID_MANIFEST,
    });
    const resolver = new PackageResolver(fs);
    const result = resolver.resolve("./my-pkg", "/home/user/code");

    expect(result.sourceKind).toBe("local_path");
    expect(result.sourceRef).toBe(path.resolve("/home/user/code/my-pkg"));
    expect(result.manifest.name).toBe("test-pkg");
  });
});
