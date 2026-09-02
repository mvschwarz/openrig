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

  it("keeps a pod-shaped invalid spec on the pod validator's exact diagnostic", () => {
    const podSpecWithTypo = `
version: "0.2"
name: pod-rig
operating_mod: lab
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
    const specPath = path.join(tmpDir, "pod-rig-typo.yaml");
    fs.writeFileSync(specPath, podSpecWithTypo);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    expect(() => router.route(specPath)).toThrow(
      'operating_mod: unknown key "operating_mod"; refusing the spec because normalization would otherwise discard it and alter the requested topology',
    );
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

  // ── OPR.0.4.4.11 — topology classification (guard G-1 enumerated set) ──
  // The FR-1 detection contract: `.rigtopology` extension OR a YAML document
  // with a top-level `rigs:` LIST. Extension beats sniff; no-slash
  // EXTENSIONLESS sources keep rig_name precedence byte-for-byte (FR-2).

  const TOPOLOGY_YAML = "rigs:\n  - source: ./orch.yaml\n  - source: ./workers/rig.yaml\n    host: vps-b\nconcurrency: 2\n";

  it("G1-1: bare no-slash factory.rigtopology → topology (extension beats name-detection)", () => {
    // Stub fs: the bare ref resolves relative to daemon cwd; existence is the
    // only fs fact the ext branch needs.
    const router = new UpCommandRouter({
      fsOps: { exists: () => true, readFile: () => TOPOLOGY_YAML, readHead: () => Buffer.alloc(0) },
    });
    const result = router.route("factory.rigtopology");
    expect(result).toEqual({ sourceKind: "topology", sourceRef: "factory.rigtopology" });
  });

  it("G1-2: ./factory.rigtopology path form → topology", () => {
    const p = path.join(tmpDir, "factory.rigtopology");
    fs.writeFileSync(p, TOPOLOGY_YAML);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(router.route(p).sourceKind).toBe("topology");
  });

  it("G1-3: .rigtopology with INVALID manifest content still classifies topology (declared kind binds — no rig-spec fall-through)", () => {
    const p = path.join(tmpDir, "broken.rigtopology");
    fs.writeFileSync(p, VALID_SPEC); // rig-spec content under the topology extension
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(router.route(p).sourceKind).toBe("topology");
  });

  it("G1-4: extensionless top-level-rigs file WITH slash → topology (autoDetect sniff)", () => {
    const p = path.join(tmpDir, "mytopo");
    fs.writeFileSync(p, TOPOLOGY_YAML);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(router.route(p).sourceKind).toBe("topology");
  });

  it("G1-5: no-slash EXTENSIONLESS source keeps rig_name precedence — fs is never consulted, even if a matching file exists", () => {
    const boom = () => {
      throw new Error("fs must not be touched for a no-slash extensionless source");
    };
    const router = new UpCommandRouter({ fsOps: { exists: boom, readFile: boom, readHead: boom } });
    const result = router.route("factory"); // ./factory is the explicit path escape hatch
    expect(result.sourceKind).toBe("rig_name");
  });

  it("G1-6: factory.yaml carrying a top-level rigs: list → topology (sniff BEFORE rig-spec validation)", () => {
    const p = path.join(tmpDir, "factory.yaml");
    fs.writeFileSync(p, TOPOLOGY_YAML);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(router.route(p).sourceKind).toBe("topology");
  });

  it("G1-7: yaml with rigs: list PLUS edge/routing keys still classifies topology (rejection is TOPOLOGY validation downstream, never a rig-spec error)", () => {
    const p = path.join(tmpDir, "edgy.yaml");
    fs.writeFileSync(p, TOPOLOGY_YAML + "edges:\n  - from: a\n    to: b\n");
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(router.route(p).sourceKind).toBe("topology");
  });

  it("G1-8: invalid yaml WITHOUT rigs: keeps the existing rig-spec error surface byte-unchanged", () => {
    const p = path.join(tmpDir, "invalid.yaml");
    fs.writeFileSync(p, "just: nonsense\n");
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(() => router.route(p)).toThrow(/Source is YAML but not a valid rig spec/);
  });

  it("G1-9: rigs: as a NON-list does not sniff topology — flows to existing yaml handling", () => {
    const p = path.join(tmpDir, "rigsmap.yaml");
    fs.writeFileSync(p, "rigs:\n  a: 1\n");
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    // Not a topology by contract (list required; .rigtopology is the escape
    // hatch) — the existing rig-spec validation owns the error.
    expect(() => router.route(p)).toThrow(/not a valid rig spec/);
  });
});
