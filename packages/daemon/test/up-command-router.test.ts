import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { UpCommandRouter } from "../src/domain/up-command-router.js";

const VALID_SPEC = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

const BUNDLE_MANIFEST = `
schema_version: 1
name: my-bundle
version: "0.1.0"
created_at: "2026-01-01T00:00:00Z"
rig_spec: rig.yaml
packages:
  - name: pkg
    version: "1.0"
    path: packages/pkg
    original_source: local:./pkg
integrity:
  algorithm: sha256
  files:
    rig.yaml: ${"a".repeat(64)}
`.trim();

const PKG_MANIFEST = `
schema_version: 1
name: my-pkg
version: "1.0.0"
summary: A package
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
`.trim();

function realFsOps() {
  return {
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    readHead: (p: string, bytes: number) => {
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, 0);
      fs.closeSync(fd);
      return buf;
    },
  };
}

describe("UpCommandRouter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-router-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // T1: .yaml -> rig_spec
  it(".yaml file routes to rig_spec", () => {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, VALID_SPEC);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    const result = router.route(specPath);

    expect(result.sourceKind).toBe("rig_spec");
    expect(result.sourceRef).toBe(specPath);
  });

  // T2: .rigbundle -> rig_bundle
  it(".rigbundle file routes to rig_bundle", () => {
    const bundlePath = path.join(tmpDir, "test.rigbundle");
    // Write a gzip file (minimal valid gzip)
    fs.writeFileSync(bundlePath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    const result = router.route(bundlePath);

    expect(result.sourceKind).toBe("rig_bundle");
  });

  // T3: Unknown extension -> error
  it("unknown extension throws with helpful message", () => {
    const txtPath = path.join(tmpDir, "readme.txt");
    fs.writeFileSync(txtPath, "just text");
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    expect(() => router.route(txtPath)).toThrow(/not a valid rig spec|Unable to determine/);
  });

  // T4: Missing file -> error
  it("missing file throws", () => {
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    expect(() => router.route("/nonexistent/file.yaml")).toThrow(/Source not found/);
  });

  // T5a: Extensionless valid rig spec -> rig_spec
  it("extensionless valid rig spec auto-detected as rig_spec", () => {
    const noExtPath = path.join(tmpDir, "myrig");
    fs.writeFileSync(noExtPath, VALID_SPEC);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    const result = router.route(noExtPath);

    expect(result.sourceKind).toBe("rig_spec");
  });

  // T5b: Extensionless gzip -> rig_bundle
  it("extensionless gzip file auto-detected as rig_bundle", () => {
    const noExtPath = path.join(tmpDir, "mybundle");
    fs.writeFileSync(noExtPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    const result = router.route(noExtPath);

    expect(result.sourceKind).toBe("rig_bundle");
  });

  // T5c: bundle.yaml with .yaml extension -> helpful error
  it("bundle.yaml routed via .yaml extension gives helpful error", () => {
    const bundleYaml = path.join(tmpDir, "bundle.yaml");
    fs.writeFileSync(bundleYaml, BUNDLE_MANIFEST);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    expect(() => router.route(bundleYaml)).toThrow(/bundle manifest/i);
  });

  // T5d: package.yaml with .yaml extension -> helpful error
  it("package.yaml routed via .yaml extension gives helpful error", () => {
    const pkgYaml = path.join(tmpDir, "package.yaml");
    fs.writeFileSync(pkgYaml, PKG_MANIFEST);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    expect(() => router.route(pkgYaml)).toThrow(/package manifest/i);
  });

  // T6: Returns correct type
  it("returns RouteResult with correct shape", () => {
    const specPath = path.join(tmpDir, "spec.yml");
    fs.writeFileSync(specPath, VALID_SPEC);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    const result = router.route(specPath);

    expect(result).toHaveProperty("sourceKind");
    expect(result).toHaveProperty("sourceRef");
    expect(["rig_spec", "rig_bundle"]).toContain(result.sourceKind);
  });

  // AS-T08b: dual-format acceptance — pod-aware rig spec accepted
  it("routes pod-aware rig spec as rig_spec", () => {
    const podSpec = `
version: "0.2"
name: pod-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();
    const specPath = path.join(tmpDir, "pod-rig.yaml");
    fs.writeFileSync(specPath, podSpec);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    const result = router.route(specPath);
    expect(result.sourceKind).toBe("rig_spec");
  });

  // AS-T08b: legacy rig spec still accepted
  it("still routes legacy rig spec as rig_spec", () => {
    const specPath = path.join(tmpDir, "legacy.yaml");
    fs.writeFileSync(specPath, VALID_SPEC);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    const result = router.route(specPath);
    expect(result.sourceKind).toBe("rig_spec");
  });

  // NS-T06: rig name detection
  it("bare name without / or extension → rig_name", () => {
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    const result = router.route("auth-feats");
    expect(result.sourceKind).toBe("rig_name");
    expect(result.sourceRef).toBe("auth-feats");
  });

  it("name with .yaml extension → NOT rig_name (file path)", () => {
    const specPath = path.join(tmpDir, "auth.yaml");
    fs.writeFileSync(specPath, VALID_SPEC);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    const result = router.route(specPath);
    expect(result.sourceKind).toBe("rig_spec");
  });

  it("path with / → NOT rig_name", () => {
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(() => router.route("/tmp/nonexistent")).toThrow(/Source not found/);
  });
});
