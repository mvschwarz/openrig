import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { computeIntegrity, writeIntegrity, verifyIntegrity, type IntegrityFsOps } from "../src/domain/bundle-integrity.js";
// TODO: AS-T12 — migrate to pod-aware bundle types
import { serializeLegacyBundleManifest as serializeBundleManifest, type LegacyBundleManifest as BundleManifest } from "../src/domain/bundle-types.js";

function realFsOps(): IntegrityFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p) => fs.readFileSync(p),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    walkFiles: (dir) => {
      const results: string[] = [];
      function walk(d: string, prefix: string) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(d, entry.name), path.join(prefix, entry.name));
          else results.push(prefix ? path.join(prefix, entry.name) : entry.name);
        }
      }
      walk(dir, "");
      return results;
    },
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("Bundle integrity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-integ-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function makeManifest(integrity?: { algorithm: "sha256"; files: Record<string, string> }): BundleManifest {
    return {
      schemaVersion: 1, name: "test", version: "1.0", createdAt: "2026-01-01",
      rigSpec: "rig.yaml", packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "" }],
      integrity,
    };
  }

  // T1: Computes correct SHA-256
  it("computes correct SHA-256 for each file", () => {
    writeFile("rig.yaml", "spec content");
    writeFile("packages/pkg/SKILL.md", "skill content");

    const integrity = computeIntegrity(tmpDir, realFsOps());

    expect(integrity.algorithm).toBe("sha256");
    expect(integrity.files["rig.yaml"]).toBe(sha256("spec content"));
    expect(integrity.files["packages/pkg/SKILL.md"]).toBe(sha256("skill content"));
  });

  // T2: Integrity section written to bundle.yaml
  it("writes integrity section to existing bundle.yaml", () => {
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));
    writeFile("rig.yaml", "spec");

    const integrity = computeIntegrity(tmpDir, realFsOps());
    writeIntegrity(tmpDir, integrity, realFsOps());

    const updated = fs.readFileSync(path.join(tmpDir, "bundle.yaml"), "utf-8");
    expect(updated).toContain("integrity:");
    expect(updated).toContain("sha256");
  });

  // T3: Verifier passes on clean bundle
  it("verifier passes on clean bundle", () => {
    writeFile("rig.yaml", "spec");
    writeFile("packages/pkg/package.yaml", "name: pkg");
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));

    const integrity = computeIntegrity(tmpDir, realFsOps());
    writeIntegrity(tmpDir, integrity, realFsOps());

    const manifestWithIntegrity = { ...manifest, integrity };
    const result = verifyIntegrity(tmpDir, manifestWithIntegrity, realFsOps());

    expect(result.passed).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  // T4: Verifier fails on tampered file
  it("verifier fails on tampered file (hash mismatch)", () => {
    writeFile("rig.yaml", "original");
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));

    const integrity = computeIntegrity(tmpDir, realFsOps());
    writeIntegrity(tmpDir, integrity, realFsOps());

    // Tamper the file
    fs.writeFileSync(path.join(tmpDir, "rig.yaml"), "tampered!");

    const result = verifyIntegrity(tmpDir, { ...manifest, integrity }, realFsOps());

    expect(result.passed).toBe(false);
    expect(result.mismatches).toContain("rig.yaml");
  });

  // T5: Verifier fails on missing file
  it("verifier fails on missing file", () => {
    writeFile("rig.yaml", "spec");
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));

    const integrity = computeIntegrity(tmpDir, realFsOps());
    writeIntegrity(tmpDir, integrity, realFsOps());

    // Delete a file
    fs.unlinkSync(path.join(tmpDir, "rig.yaml"));

    const result = verifyIntegrity(tmpDir, { ...manifest, integrity }, realFsOps());

    expect(result.passed).toBe(false);
    expect(result.missing).toContain("rig.yaml");
  });

  // T6: Extra unexpected file -> passed=false
  it("verifier fails on extra unexpected file", () => {
    writeFile("rig.yaml", "spec");
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));

    const integrity = computeIntegrity(tmpDir, realFsOps());
    writeIntegrity(tmpDir, integrity, realFsOps());

    // Add an extra file after integrity was computed
    writeFile("extra-file.txt", "unexpected");

    const result = verifyIntegrity(tmpDir, { ...manifest, integrity }, realFsOps());

    expect(result.passed).toBe(false);
    expect(result.extra).toContain("extra-file.txt");
  });

  // T6b: .DS_Store ignored
  it(".DS_Store is ignored during compute and verify", () => {
    writeFile("rig.yaml", "spec");
    writeFile(".DS_Store", "junk");
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));

    const integrity = computeIntegrity(tmpDir, realFsOps());
    expect(integrity.files[".DS_Store"]).toBeUndefined();

    writeIntegrity(tmpDir, integrity, realFsOps());
    const result = verifyIntegrity(tmpDir, { ...manifest, integrity }, realFsOps());
    expect(result.passed).toBe(true);
  });

  // T7: .env -> throws (hard fail)
  it("sensitive .env file throws during compute", () => {
    writeFile("rig.yaml", "spec");
    writeFile(".env", "SECRET=bad");

    expect(() => computeIntegrity(tmpDir, realFsOps())).toThrow(/Sensitive paths/);
  });

  // T8: Empty directory -> empty integrity
  it("empty directory produces empty integrity", () => {
    const integrity = computeIntegrity(tmpDir, realFsOps());
    expect(Object.keys(integrity.files)).toHaveLength(0);
  });

});
