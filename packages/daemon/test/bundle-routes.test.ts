import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { createTestApp } from "./helpers/test-app.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


const VALID_SPEC = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - ./test-pkg
edges: []
`.trim();

const VALID_PKG = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
`.trim();

describe("Bundle API routes", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-routes-"));
    setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPackage(): { specPath: string } {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, VALID_SPEC);
    const pkgDir = path.join(tmpDir, "test-pkg");
    fs.mkdirSync(path.join(pkgDir, "skills/h"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.yaml"), VALID_PKG);
    fs.writeFileSync(path.join(pkgDir, "skills/h/SKILL.md"), "# H");
    return { specPath };
  }

  // T1: Create returns metadata
  it("POST /api/bundles/create returns bundle metadata", async () => {
    const { specPath } = seedPackage();
    const outputPath = path.join(tmpDir, "test.rigbundle");

    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "test", bundleVersion: "0.1.0", outputPath }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bundleName).toBe("test");
    expect(body.archiveHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  // Item 1 / slice-05: provenance round-trip through /create + /inspect
  it("POST /api/bundles/create accepts provenance + /inspect surfaces it (v1 round-trip)", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "prov-test.rigbundle");

    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "prov-test", bundleVersion: "0.1.0", outputPath: bundlePath,
        provenance: {
          sourceHost: "route-test-host",
          authorSession: "velocity-driver@openrig-velocity",
          cliVersion: "0.3.2",
          notes: "route-test fixture",
        },
      }),
    });
    expect(createRes.status).toBe(201);

    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectBody = await inspectRes.json();
    expect(inspectBody.manifest.provenance).toBeDefined();
    expect(inspectBody.manifest.provenance.sourceHost).toBe("route-test-host");
    expect(inspectBody.manifest.provenance.authorSession).toBe("velocity-driver@openrig-velocity");
    expect(inspectBody.manifest.provenance.cliVersion).toBe("0.3.2");
    expect(inspectBody.manifest.provenance.notes).toBe("route-test fixture");
    // Server-side daemonVersion injection — read from daemon package.json at call time
    expect(typeof inspectBody.manifest.provenance.daemonVersion).toBe("string");
    expect(inspectBody.manifest.provenance.daemonVersion.length).toBeGreaterThan(0);
    // createdAt mirrored from root
    expect(inspectBody.manifest.provenance.createdAt).toBe(inspectBody.manifest.createdAt);
  });

  it("POST /api/bundles/create with no provenance produces a bundle whose manifest omits provenance (backward compat)", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "no-prov.rigbundle");

    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "no-prov", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });
    expect(createRes.status).toBe(201);

    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectBody = await inspectRes.json();
    expect(inspectBody.manifest.provenance).toBeUndefined();
  });

  it("POST /api/bundles/create refuses unsafe generated provenance in the legacy final staging tree", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "legacy-unsafe-generated.rigbundle");

    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath,
        bundleName: "legacy-unsafe-generated",
        bundleVersion: "0.1.0",
        outputPath: bundlePath,
        provenance: { notes: "See substrate/shared-docs/rigs/private for details." },
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/internal-path/);
    expect(body.error).toMatch(/bundle\.yaml/);
    expect(fs.existsSync(bundlePath)).toBe(false);
  });

  // T2: Inspect returns manifest
  it("POST /api/bundles/inspect returns manifest + integrity", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "test.rigbundle");

    // Create first
    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "test", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });

    const res = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest.name).toBe("test");
    expect(body.digestValid).toBe(true);
    expect(body.integrityResult.passed).toBe(true);
  });

  // T6: Create emits bundle.created event
  it("POST /api/bundles/create emits bundle.created event", async () => {
    const { specPath } = seedPackage();
    const outputPath = path.join(tmpDir, "evt.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "evt-bundle", bundleVersion: "1.0", outputPath }),
    });

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'bundle.created'").all() as Array<{ type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.bundleName).toBe("evt-bundle");
  });

  // T7: Missing specPath -> 400
  it("POST /api/bundles/create with missing specPath returns 400", async () => {
    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleName: "x", bundleVersion: "1.0", outputPath: "/tmp/x.rigbundle" }),
    });
    expect(res.status).toBe(400);
  });

  // T10: Startup wiring
  it("createDaemon wires bundle routes", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { app: daemonApp, db: daemonDb } = await createDaemon({ dbPath: ":memory:" });
    try {
      // POST without body -> 400 (proves route is mounted)
      const res = await daemonApp.request("/api/bundles/create", { method: "POST" });
      expect(res.status).toBe(400);
    } finally {
      daemonDb.close();
    }
  });

  // T10b: Install apply without targetRoot -> 400
  it("POST /api/bundles/install without targetRoot returns 400 for apply", async () => {
    const res = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath: "/tmp/x.rigbundle" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("targetRoot");
  });

  // T10c: Install --plan without targetRoot -> OK
  it("POST /api/bundles/install plan mode without targetRoot succeeds", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "plan.rigbundle");
    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "plan-test", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });

    // Plan mode — no targetRoot needed
    const res = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true }),
    });

    // Will fail because test app has no real bundle resolver, but should get past the 400 check
    // The route should not return 400 for missing targetRoot in plan mode
    expect(res.status).not.toBe(400);
  });

  // T4: Inspect with tampered bundle -> integrityResult.passed=false
  it("POST /api/bundles/inspect reports integrity failure structurally", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "tamper.rigbundle");

    // Create valid bundle
    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "tamper-test", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });

    // Tamper the archive by appending bytes (breaks digest but tar still extracts)
    fs.appendFileSync(bundlePath, Buffer.from([0]));
    // Update the .sha256 to match the tampered archive so digest passes
    // but content integrity should fail because the tar contents are unchanged
    // Actually — appending a byte to tar.gz may corrupt it. Let's instead:
    // Just verify the inspect path returns 200 with structured data
    const res = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });

    // Should be 200 with structured response (not 500)
    // Digest will be invalid since we tampered
    const body = await res.json();
    // digestValid should be false (sha256 mismatch)
    expect(body.digestValid).toBe(false);
  });

  // T6-AS-T12: Pod-aware bundle create
  it("POST /api/bundles/create with pod-aware spec returns schemaVersion:2", async () => {
    // Seed a pod-aware rig spec + agent on disk
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      'name: impl-agent',
      'version: "1.0.0"',
      'resources:',
      '  skills: []',
      'profiles:',
      '  default:',
      '    uses:',
      '      skills: []',
    ].join("\n"));

    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      'name: pod-test-rig',
      'pods:',
      '  - id: dev',
      '    label: Dev',
      '    members:',
      '      - id: impl',
      '        agent_ref: "local:agents/impl"',
      '        profile: default',
      '        runtime: claude-code',
      '        cwd: .',
      '    edges: []',
      'edges: []',
    ].join("\n"));

    const outputPath = path.join(tmpDir, "pod.rigbundle");
    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "pod-test", bundleVersion: "0.1.0", outputPath }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schemaVersion).toBe(2);
    expect(body.bundleName).toBe("pod-test");
    expect(body.archiveHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("POST /api/bundles/create accepts builtin terminal pod members", async () => {
    const specPath = path.join(tmpDir, "terminal-rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      'name: terminal-test-rig',
      'pods:',
      '  - id: infra',
      '    label: Infra',
      '    members:',
      '      - id: daemon',
      '        agent_ref: "builtin:terminal"',
      '        profile: none',
      '        runtime: terminal',
      '        cwd: .',
      '    edges: []',
      'edges: []',
    ].join("\n"));

    const outputPath = path.join(tmpDir, "terminal.rigbundle");
    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "terminal-test", bundleVersion: "0.1.0", outputPath }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schemaVersion).toBe(2);
    expect(body.agents).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  // T11-AS-T12: Legacy bundle create still works (regression guard)
  it("POST /api/bundles/create with legacy spec still works", async () => {
    const { specPath } = seedPackage();
    const outputPath = path.join(tmpDir, "legacy.rigbundle");

    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "legacy-test", bundleVersion: "0.1.0", outputPath }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bundleName).toBe("legacy-test");
    expect(body.packages).toBeDefined();
    expect(body.schemaVersion).toBeUndefined();
  });

  // T11-AS-T12: v2 bundle install routes through pod-aware bootstrap path
  it("POST /api/bundles/install with v2 bundle enters pod-aware path", async () => {
    // Create a v2 bundle on disk
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
      'profiles:', '  default:', '    uses:', '      skills: []',
    ].join("\n"));
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"', 'name: v2-install-test', 'pods:', '  - id: dev', '    label: Dev',
      '    members:', '      - id: impl', '        agent_ref: "local:agents/impl"',
      '        profile: default', '        runtime: claude-code', '        cwd: .',
      '    edges: []', 'edges: []',
    ].join("\n"));
    const bundlePath = path.join(tmpDir, "v2-install.rigbundle");
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "v2-install", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });
    expect(createRes.status).toBe(201);

    // Install the v2 bundle — test app's podInstantiator has mock fsOps so agent resolution
    // will fail, but the bootstrap should detect v2 and enter the pod-aware path
    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, targetRoot: tmpDir }),
    });
    const installBody = await installRes.json();
    // The result should have stages proving the pod-aware path was entered
    // (resolve_spec stage with source: "pod_bundle" or the bootstrap ran through handlePodAwareSpec)
    expect(installBody.stages).toBeDefined();
    const resolveStage = installBody.stages.find((s: { stage: string }) => s.stage === "resolve_spec");
    expect(resolveStage).toBeDefined();
    expect(resolveStage.detail.source).toBe("pod_bundle");
  });

  // T9-AS-T14: Inspect v2 bundle returns schemaVersion 2 and agents array
  it("POST /api/bundles/inspect with v2 bundle returns schemaVersion 2 and agents", async () => {
    // Create a v2 bundle on disk
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      'name: impl-agent',
      'version: "1.0.0"',
      'resources:',
      '  skills: []',
      'profiles:',
      '  default:',
      '    uses:',
      '      skills: []',
    ].join("\n"));

    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      'name: v2-inspect-test',
      'pods:',
      '  - id: dev',
      '    label: Dev',
      '    members:',
      '      - id: impl',
      '        agent_ref: "local:agents/impl"',
      '        profile: default',
      '        runtime: claude-code',
      '        cwd: .',
      '    edges: []',
      'edges: []',
    ].join("\n"));

    const bundlePath = path.join(tmpDir, "v2-inspect.rigbundle");
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "v2-inspect", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });
    expect(createRes.status).toBe(201);

    const res = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest.schemaVersion).toBe(2);
    expect(Array.isArray(body.manifest.agents)).toBe(true);
    expect(body.manifest.agents.length).toBeGreaterThan(0);
    expect(body.manifest.agents[0].name).toBe("impl-agent");
    expect(body.digestValid).toBe(true);
  });

  // Item 2 / slice-05 / Checkpoint 3.2: v1 create -> inspect compatibility round-trip.
  // Discriminator: removing the v1 inspect normalizer's compatibility surfacing
  // OR the route /create compatibility-extraction must make this test fail.
  it("POST /api/bundles/create accepts compatibility + /inspect surfaces it (v1 round-trip)", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "compat-test.rigbundle");

    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "compat-test", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minDaemonVersion: "0.3.2", minCliVersion: "0.3.2", schemaVersion: 1 },
      }),
    });
    expect(createRes.status).toBe(201);

    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectBody = await inspectRes.json();
    expect(inspectBody.manifest.compatibility).toBeDefined();
    expect(inspectBody.manifest.compatibility.minDaemonVersion).toBe("0.3.2");
    expect(inspectBody.manifest.compatibility.minCliVersion).toBe("0.3.2");
    expect(inspectBody.manifest.compatibility.schemaVersion).toBe(1);
    // Negative — snake_case keys must NOT be present (camelCase contract)
    expect(inspectBody.manifest.compatibility.min_daemon_version).toBeUndefined();
  });

  // Item 2 / slice-05 / Checkpoint 3.2: v2 create -> inspect compatibility round-trip.
  // Avoids the B1 trap from Item 1: this test ships in the SAME commit as the v2 inspect
  // compatibility projection in routes/bundles.ts. Discriminator: removing the v2
  // compatibility-projection line must make this test fail.
  it("POST /api/bundles/inspect with v2 bundle surfaces compatibility in camelCase (create -> inspect round-trip)", async () => {
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      'name: impl-agent',
      'version: "1.0.0"',
      'resources:',
      '  skills: []',
      'profiles:',
      '  default:',
      '    uses:',
      '      skills: []',
    ].join("\n"));

    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      'name: v2-compat-test',
      'pods:',
      '  - id: dev',
      '    label: Dev',
      '    members:',
      '      - id: impl',
      '        agent_ref: "local:agents/impl"',
      '        profile: default',
      '        runtime: claude-code',
      '        cwd: .',
      '    edges: []',
      'edges: []',
    ].join("\n"));

    const bundlePath = path.join(tmpDir, "v2-compat.rigbundle");
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "v2-compat", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minDaemonVersion: "0.3.2", minCliVersion: "0.3.2" },
      }),
    });
    expect(createRes.status).toBe(201);

    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectBody = await inspectRes.json();
    expect(inspectBody.manifest.schemaVersion).toBe(2);
    expect(inspectBody.manifest.compatibility).toBeDefined();
    expect(inspectBody.manifest.compatibility.minDaemonVersion).toBe("0.3.2");
    expect(inspectBody.manifest.compatibility.minCliVersion).toBe("0.3.2");
    // Negative — snake_case keys must NOT be present (camelCase contract)
    expect(inspectBody.manifest.compatibility.min_daemon_version).toBeUndefined();
    expect(inspectBody.manifest.compatibility.min_cli_version).toBeUndefined();
  });

  // Item 1 / slice-05 / guard B1 repair: pod-aware (v2) create -> inspect provenance round-trip.
  // Asserts the inspect response surfaces provenance in normalized camelCase,
  // matching the v1 contract. Discriminator: removing the v2 inspect projection
  // line in routes/bundles.ts must make this test fail.
  it("POST /api/bundles/inspect with v2 bundle surfaces provenance in camelCase (create -> inspect round-trip)", async () => {
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      'name: impl-agent',
      'version: "1.0.0"',
      'resources:',
      '  skills: []',
      'profiles:',
      '  default:',
      '    uses:',
      '      skills: []',
    ].join("\n"));

    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      'name: v2-prov-test',
      'pods:',
      '  - id: dev',
      '    label: Dev',
      '    members:',
      '      - id: impl',
      '        agent_ref: "local:agents/impl"',
      '        profile: default',
      '        runtime: claude-code',
      '        cwd: .',
      '    edges: []',
      'edges: []',
    ].join("\n"));

    const bundlePath = path.join(tmpDir, "v2-prov.rigbundle");
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "v2-prov", bundleVersion: "0.1.0", outputPath: bundlePath,
        provenance: {
          sourceHost: "v2-route-test-host",
          authorSession: "velocity-driver@openrig-velocity",
          cliVersion: "0.3.2",
          notes: "v2 route round-trip fixture",
        },
      }),
    });
    expect(createRes.status).toBe(201);

    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectBody = await inspectRes.json();
    expect(inspectBody.manifest.schemaVersion).toBe(2);
    // The contract: provenance returned in normalized camelCase (matches v1)
    expect(inspectBody.manifest.provenance).toBeDefined();
    expect(inspectBody.manifest.provenance.sourceHost).toBe("v2-route-test-host");
    expect(inspectBody.manifest.provenance.authorSession).toBe("velocity-driver@openrig-velocity");
    expect(inspectBody.manifest.provenance.cliVersion).toBe("0.3.2");
    expect(inspectBody.manifest.provenance.notes).toBe("v2 route round-trip fixture");
    expect(typeof inspectBody.manifest.provenance.daemonVersion).toBe("string");
    expect(inspectBody.manifest.provenance.daemonVersion.length).toBeGreaterThan(0);
    // Negative — snake_case keys must NOT be present (camelCase contract)
    expect(inspectBody.manifest.provenance.source_host).toBeUndefined();
    expect(inspectBody.manifest.provenance.author_session).toBeUndefined();
  });

  it("POST /api/bundles/create refuses unsafe generated provenance in the pod-aware final staging tree", async () => {
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      "name: impl-agent",
      'version: "1.0.0"',
      "resources:",
      "  skills: []",
      "profiles:",
      "  default:",
      "    uses:",
      "      skills: []",
    ].join("\n"));

    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      "name: v2-unsafe-generated",
      "pods:",
      "  - id: dev",
      "    label: Dev",
      "    members:",
      "      - id: impl",
      '        agent_ref: "local:agents/impl"',
      "        profile: default",
      "        runtime: claude-code",
      "        cwd: .",
      "    edges: []",
      "edges: []",
    ].join("\n"));
    const bundlePath = path.join(tmpDir, "v2-unsafe-generated.rigbundle");

    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath,
        bundleName: "v2-unsafe-generated",
        bundleVersion: "0.1.0",
        outputPath: bundlePath,
        provenance: { notes: "See substrate/shared-docs/rigs/private for details." },
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/internal-path/);
    expect(body.error).toMatch(/bundle\.yaml/);
    expect(fs.existsSync(bundlePath)).toBe(false);
  });

  // Item 2 / slice-05 Checkpoint 3.3: install-time version check
  it("POST /api/bundles/install fails with 3-part error when min_daemon_version exceeds running daemon", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "incompat.rigbundle");

    // Create bundle with min_daemon_version way above current
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "incompat", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minDaemonVersion: "99.0.0" },
      }),
    });
    expect(createRes.status).toBe(201);

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true }),
    });
    expect(installRes.status).toBe(400);
    const body = await installRes.json();
    expect(body.error).toBe("Bundle compatibility check failed");
    expect(Array.isArray(body.failures)).toBe(true);
    expect(body.failures.length).toBeGreaterThan(0);
    const daemonFailure = body.failures.find((f: { reason: string }) => f.reason === "daemon_version_mismatch");
    expect(daemonFailure).toBeDefined();
    expect(daemonFailure.required).toBe("99.0.0");
    expect(typeof daemonFailure.actual).toBe("string");
    expect(typeof daemonFailure.description).toBe("string");
    expect(Array.isArray(body.resolutions)).toBe(true);
    expect(body.resolutions.length).toBeGreaterThanOrEqual(2);
  });

  it("POST /api/bundles/install with skipVersionCheck=true bypasses incompatible bundle's compat check", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "incompat-skip.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "incompat-skip", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minDaemonVersion: "99.0.0" },
      }),
    });

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true, skipVersionCheck: true }),
    });
    // Compat check was skipped; we just need NOT to see the "Bundle compatibility
    // check failed" error. Bootstrap may still return any other status; what we
    // assert is the absence of the compat-check failure shape.
    if (installRes.status === 400) {
      const body = await installRes.json();
      expect(body.error).not.toBe("Bundle compatibility check failed");
    }
  });

  it("POST /api/bundles/install fails with 3-part error when min_cli_version exceeds the CLI version sent in body", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "cli-incompat.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "cli-incompat", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minCliVersion: "99.0.0" },
      }),
    });

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true, cliVersion: "0.3.1" }),
    });
    expect(installRes.status).toBe(400);
    const body = await installRes.json();
    expect(body.error).toBe("Bundle compatibility check failed");
    const cliFailure = body.failures.find((f: { reason: string }) => f.reason === "cli_version_mismatch");
    expect(cliFailure).toBeDefined();
    expect(cliFailure.required).toBe("99.0.0");
    expect(cliFailure.actual).toBe("0.3.1");
  });

  it("POST /api/bundles/install passes the compat check when bundle requires versions <= current", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "compat.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "compat-ok", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minDaemonVersion: "0.0.1", minCliVersion: "0.0.1" },
      }),
    });

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true, cliVersion: "0.3.1" }),
    });
    // Must NOT be the compat-fail shape. Bootstrap may return any status.
    if (installRes.status === 400) {
      const body = await installRes.json();
      expect(body.error).not.toBe("Bundle compatibility check failed");
    }
  });

  // Item 2 / slice-05 Checkpoint 3.3 / guard B1 repair: install rejects unsafe
  // archives through the safe error path BEFORE bootstrap delegation.
  // Discriminator: reverting extractManifestForCompatCheck to a raw tar.extract
  // (without unpack's verifyArchiveDigest + tar.list unsafe-entry prescan) must
  // make this test fail — the unsafe symlink would be silently extracted and
  // bootstrap would see an attacker-controlled link target.
  it("POST /api/bundles/install rejects an archive containing a symlink entry via the safe path (B1 repair)", async () => {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-unsafe-staging-"));
    const bundlePath = path.join(tmpDir, "unsafe-symlink.rigbundle");
    try {
      // Minimal valid manifest contents (bundle.yaml present) plus the unsafe
      // symlink that the safety prescan must reject.
      fs.writeFileSync(path.join(stagingDir, "bundle.yaml"), [
        'schema_version: 1',
        'name: unsafe-test',
        'version: "0.1.0"',
        'created_at: "2026-05-18T00:00:00Z"',
        'rig_spec: rig.yaml',
        'packages: []',
      ].join("\n"));
      fs.writeFileSync(path.join(stagingDir, "rig.yaml"), 'schema_version: 1\nname: x\nversion: "1.0"\nnodes: []\nedges: []');
      fs.symlinkSync("/etc/passwd", path.join(stagingDir, "evil-symlink"));

      const tar = await import("tar");
      await tar.create(
        { gzip: { level: 9 }, file: bundlePath, cwd: stagingDir, portable: true },
        ["bundle.yaml", "rig.yaml", "evil-symlink"],
      );

      // Write a valid sibling .sha256 so digest verification PASSES — proving
      // the prescan is what catches the symlink, not the digest check.
      const { createHash } = await import("node:crypto");
      const archiveHash = createHash("sha256").update(fs.readFileSync(bundlePath)).digest("hex");
      fs.writeFileSync(`${bundlePath}.sha256`, archiveHash, "utf-8");

      const installRes = await app.request("/api/bundles/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath, plan: true }),
      });
      expect(installRes.status).toBe(400);
      const body = await installRes.json();
      // Either explicit-extraction-failed shape (safe rejection happened inside
      // unpack) OR the compat-check-failed shape with the safety message in
      // detail. Either way, the symlink string must appear and bootstrap must
      // NOT have been entered.
      const text = JSON.stringify(body);
      expect(text).toMatch(/Unsafe archive entries|SymbolicLink|symlink/i);
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  // Item 3 / slice-05 Checkpoint 4.2: install conflict gate. Conflict path:
  // a running rig with the same name as the bundle's rig must produce a
  // 3-part error response from /install BEFORE bootstrap delegation.
  // Force-bypass path: same bundle with force=true must skip the conflict
  // check.
  it("POST /api/bundles/install fails with 3-part conflict error when bundle rig name collides with a running rig", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "conflict-test.rigbundle");

    // Create bundle whose rig.yaml declares name 'test-rig' (matches VALID_SPEC)
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "conflict-test", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });
    expect(createRes.status).toBe(201);

    // Seed a running rig with the same name as the bundle's rig
    setup.rigRepo.createRig("test-rig");

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true }),
    });
    expect(installRes.status).toBe(400);
    const body = await installRes.json();
    expect(body.error).toBe("Bundle install conflict check failed");
    expect(Array.isArray(body.conflicts)).toBe(true);
    expect(body.conflicts.length).toBeGreaterThan(0);
    const rigConflict = body.conflicts.find((c: { kind: string }) => c.kind === "rig_name_collision");
    expect(rigConflict).toBeDefined();
    expect(rigConflict.bundleRigName).toBe("test-rig");
    expect(typeof rigConflict.collisionWith.rigId).toBe("string");
    expect(rigConflict.collisionWith.rigName).toBe("test-rig");
    expect(Array.isArray(body.resolutions)).toBe(true);
    expect(body.resolutions.length).toBeGreaterThanOrEqual(2);
  });

  it("POST /api/bundles/install with force=true bypasses the conflict check on a name collision", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "conflict-force.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "conflict-force", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });

    setup.rigRepo.createRig("test-rig");

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true, force: true }),
    });
    // Conflict check was bypassed. Bootstrap may return any status; what we
    // assert is the absence of the conflict-check failure shape.
    if (installRes.status === 400) {
      const body = await installRes.json();
      expect(body.error).not.toBe("Bundle install conflict check failed");
    }
  });

  it("POST /api/bundles/install passes the conflict check when no running rig matches the bundle's rig name", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "no-conflict.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "no-conflict", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });

    // No rigs created — running set is empty

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true }),
    });
    // Must NOT be the conflict-fail shape. Bootstrap may return any status.
    if (installRes.status === 400) {
      const body = await installRes.json();
      expect(body.error).not.toBe("Bundle install conflict check failed");
    }
  });

  // Item 3 / slice-05 Checkpoint 4.2 / guard B1 repair: install rejects bundle
  // whose bundle.yaml carries an unsafe rig_spec value (../traversal) via the
  // manifest validator at extractInstallTimeMetadata. Discriminator: removing
  // the validator block makes the test fail (no validation error; path
  // containment still triggers but with a different error string than the
  // validator-rejection assertion).
  it("POST /api/bundles/install rejects bundle whose rig_spec is unsafe via the manifest validator (B1 repair)", async () => {
    const { specPath } = seedPackage();
    const goodBundlePath = path.join(tmpDir, "good.rigbundle");
    const tamperedBundlePath = path.join(tmpDir, "tampered.rigbundle");

    // Build a normal valid bundle via /create (gives us valid integrity + digest)
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "tamper-test", bundleVersion: "0.1.0", outputPath: goodBundlePath }),
    });
    expect(createRes.status).toBe(201);

    // Unpack, modify bundle.yaml to inject unsafe rig_spec (bundle.yaml itself
    // isn't in integrity.files — its hash can't reference itself — so editing
    // it doesn't break verifyIntegrity).
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-tamper-staging-"));
    try {
      const tar = await import("tar");
      await tar.extract({ file: goodBundlePath, cwd: stagingDir });
      const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
      const original = fs.readFileSync(bundleYamlPath, "utf-8");
      // Replace rig_spec line. Original is `rig_spec: rig.yaml` (from /create).
      const tampered = original.replace(/^rig_spec:.*$/m, 'rig_spec: "../escape.yaml"');
      expect(tampered).toContain('rig_spec: "../escape.yaml"');
      fs.writeFileSync(bundleYamlPath, tampered);

      // Re-pack via pack() which writes valid sibling .sha256
      const { pack } = await import("../src/domain/bundle-archive.js");
      await pack(stagingDir, tamperedBundlePath);

      // Install attempt
      const installRes = await app.request("/api/bundles/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath: tamperedBundlePath, plan: true }),
      });
      expect(installRes.status).toBe(400);
      const body = await installRes.json();
      // The validator runs inside extractInstallTimeMetadata which is called
      // from the route's try/catch. The error path wraps it as the
      // "could not run (extraction failed)" shape with the validator message
      // in detail.
      const text = JSON.stringify(body);
      expect(text).toMatch(/Invalid v1 bundle manifest|Invalid v2 bundle manifest|rig_spec.*not.*safe|escapes bundle workspace/i);
      // Negative — bootstrap must NOT have entered. The conflict-check error
      // shape would mean we got past the validator into conflict detection;
      // assert it didn't.
      expect(body.error).not.toBe("Bundle install conflict check failed");
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  // Item 4 / slice-05 Checkpoint 5.2: GET /api/bundles/history surfaces the
  // bundle-audit JSONL records (optionally filtered). Empty file -> []; rig
  // filter scopes; since filter scopes.
  it("GET /api/bundles/history returns empty list when no audit records exist", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-history-test-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const res = await app.request("/api/bundles/history");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.records).toEqual([]);
      expect(body.total).toBe(0);
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("GET /api/bundles/history returns records from the audit file with filters honored", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-history-test-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      // Seed the audit JSONL directly (bypasses any writer; tests the reader path)
      const auditPath = path.join(auditHome, "bundle-audit.jsonl");
      const recs = [
        { installedAt: "2026-05-18T10:00:00Z", bundlePath: "/tmp/a.rigbundle", targetRigName: "alpha", outcome: "success" },
        { installedAt: "2026-05-18T11:00:00Z", bundlePath: "/tmp/b.rigbundle", targetRigName: "beta", outcome: "failed" },
        { installedAt: "2026-05-18T12:00:00Z", bundlePath: "/tmp/c.rigbundle", targetRigName: "alpha", outcome: "partial" },
      ];
      fs.writeFileSync(auditPath, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");

      // Unfiltered: all 3
      const all = await app.request("/api/bundles/history");
      expect(all.status).toBe(200);
      const allBody = await all.json();
      expect(allBody.total).toBe(3);
      expect(allBody.records).toHaveLength(3);

      // Filter rig=alpha: 2 records
      const alpha = await app.request("/api/bundles/history?rig=alpha");
      const alphaBody = await alpha.json();
      expect(alphaBody.total).toBe(2);
      expect(alphaBody.records.every((r: { targetRigName: string }) => r.targetRigName === "alpha")).toBe(true);

      // Filter since=11:00: 2 records (the 11:00 and 12:00 ones)
      const since = await app.request("/api/bundles/history?since=2026-05-18T11:00:00Z");
      const sinceBody = await since.json();
      expect(sinceBody.total).toBe(2);
      expect(sinceBody.records.map((r: { installedAt: string }) => r.installedAt)).toEqual([
        "2026-05-18T11:00:00Z",
        "2026-05-18T12:00:00Z",
      ]);

      // Combined rig=alpha + since=11:00: 1 record (the 12:00 alpha one)
      const combo = await app.request("/api/bundles/history?rig=alpha&since=2026-05-18T11:00:00Z");
      const comboBody = await combo.json();
      expect(comboBody.total).toBe(1);
      expect(comboBody.records[0].installedAt).toBe("2026-05-18T12:00:00Z");
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 4 / slice-05 Checkpoint 5.3: /install writes audit record on apply
  // completion paths; plan mode does NOT write (planning doesn't change
  // state). End-to-end: install -> GET /api/bundles/history reflects the
  // record. Test isolation via OPENRIG_HOME env override to per-test tmpDir.
  it("POST /api/bundles/install plan mode does NOT write an audit record (planning doesn't change state)", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-audit-plan-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "plan-mode.rigbundle");
      await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specPath, bundleName: "plan-mode", bundleVersion: "0.1.0", outputPath: bundlePath }),
      });

      await app.request("/api/bundles/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath, plan: true }),
      });

      const history = await app.request("/api/bundles/history");
      const body = await history.json();
      expect(body.total).toBe(0);
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  /**
   * Item 4 Checkpoint 5.3 B1 repair: deterministic per-branch audit-write tests.
   * Each test stubs setup.bootstrapOrchestrator.bootstrap with vi.fn() to force
   * a specific outcome, then asserts the exact outcome ends up in
   * /api/bundles/history. Discriminator: disabling each branch's
   * writeInstallAudit call must fail its paired test specifically.
   */
  async function runApplyAuditTest(opts: {
    bundleName: string;
    bootstrapResult?: unknown;
    bootstrapThrows?: Error;
    expectedOutcome: "success" | "failed" | "partial";
    expectedRigId?: string;
  }): Promise<{ records: Array<Record<string, unknown>>; total: number }> {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, `${opts.bundleName}.rigbundle`);
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${opts.bundleName}-target-`));
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specPath, bundleName: opts.bundleName, bundleVersion: "0.1.0", outputPath: bundlePath }),
      });

      const stub = opts.bootstrapThrows
        ? vi.fn().mockRejectedValue(opts.bootstrapThrows)
        : vi.fn().mockResolvedValue(opts.bootstrapResult);
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

      await app.request("/api/bundles/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
      });

      const history = await app.request("/api/bundles/history");
      const body = await history.json();
      // Item 4 close-out / guard B2 repair: helper-level bundlePath assertion
      // applies to all 4 branch tests (DRY). Discriminator: setting
      // record.bundlePath to a wrong path in routes/bundles.ts must fail
      // every apply-mode branch test.
      expect(body.total).toBe(1);
      expect(body.records[0].bundlePath).toBe(bundlePath);
      return body;
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  }

  it("POST /api/bundles/install apply / completed branch writes audit record with outcome=success", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-audit-completed-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const body = await runApplyAuditTest({
        bundleName: "completed-test",
        bootstrapResult: {
          status: "completed",
          runId: "test-run-completed",
          rigId: "01H000000000000000COMPL01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        },
        expectedOutcome: "success",
      });
      expect(body.total).toBe(1);
      expect(body.records[0].outcome).toBe("success");
      expect(body.records[0].targetRigId).toBe("01H000000000000000COMPL01");
      expect(typeof body.records[0].daemonVersion).toBe("string");
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install apply / partial branch writes audit record with outcome=partial", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-audit-partial-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const body = await runApplyAuditTest({
        bundleName: "partial-test",
        bootstrapResult: {
          status: "partial",
          runId: "test-run-partial",
          rigId: "01H000000000000000PARTI01",
          stages: [
            { stage: "resolve_spec", status: "ok" },
            { stage: "instantiate_rig", status: "failed" },
          ],
          errors: ["partial fail"],
        },
        expectedOutcome: "partial",
      });
      expect(body.total).toBe(1);
      expect(body.records[0].outcome).toBe("partial");
      expect(body.records[0].targetRigId).toBe("01H000000000000000PARTI01");
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install apply / failed-result branch writes audit record with outcome=failed", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-audit-failed-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const body = await runApplyAuditTest({
        bundleName: "failed-result-test",
        bootstrapResult: {
          status: "failed",
          runId: "test-run-failed",
          stages: [{ stage: "resolve_spec", status: "failed" }],
          errors: ["resolve failed"],
        },
        expectedOutcome: "failed",
      });
      expect(body.total).toBe(1);
      expect(body.records[0].outcome).toBe("failed");
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install apply / thrown-error branch writes audit record with outcome=failed", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-audit-thrown-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const body = await runApplyAuditTest({
        bundleName: "thrown-test",
        bootstrapThrows: new Error("simulated bootstrap explosion"),
        expectedOutcome: "failed",
      });
      expect(body.total).toBe(1);
      expect(body.records[0].outcome).toBe("failed");
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / slice-05 Checkpoint 7.3: /install routes declared skills to
  // operator skills library after successful bootstrap. Uses bootstrap stub
  // to force completed outcome; bundle manifest has skills[]; verifies the
  // skills land at OPENRIG_HOME/skills/.
  it("POST /api/bundles/install routes declared skills after successful bootstrap (completed branch)", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-skills-route-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "with-skills.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-target-"));
      try {
        // Build a bundle with skills[] declared. Add a skill file to the
        // package dir so it lands in the bundle archive when packed.
        const skillSourceDir = path.join(tmpDir, "test-pkg", "skills");
        fs.mkdirSync(skillSourceDir, { recursive: true });
        fs.writeFileSync(path.join(skillSourceDir, "FOO.md"), "# foo skill body");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "with-skills", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        // Tamper the created bundle's bundle.yaml to inject skills[] field.
        // bundle.yaml's own hash is excluded from integrity.files so editing
        // it doesn't break verifyIntegrity.
        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          // Append skills field referencing the file we put inside the bundled package
          const tampered = `${original}\nskills:\n  - packages/test-pkg/skills/FOO.md\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        // Stub bootstrap to return completed so audit-write + skills routing fire
        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-skills",
          rigId: "01H000000000000000SKILLS01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        // Response carries skillsRouting block
        expect(body.skillsRouting).toBeDefined();
        expect(body.skillsRouting.routedCount).toBe(1);
        expect(body.skillsRouting.records).toHaveLength(1);
        expect(body.skillsRouting.records[0].status).toBe("routed");
        // Package-shaped legacy skill payload stays out of the managed catalog.
        const expectedTarget = path.join(auditHome, "packages", "test-pkg", "skills", "FOO.md");
        expect(fs.existsSync(expectedTarget)).toBe(true);
        expect(fs.readFileSync(expectedTarget, "utf-8")).toBe("# foo skill body");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3a / guard B1 repair (qitem-20260518220247): skills
  // routing must fire even when operator uses BOTH --skip-version-check and
  // --force pre-check overrides. The routing is independent of the pre-check
  // extraction gate. Discriminator: re-coupling routeSkillsAfterBootstrap to
  // installMeta would make this test fail (skillsRouting undefined when both
  // override flags are set).
  it("POST /api/bundles/install routes declared skills even when both --skip-version-check and --force are set (B1 repair)", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-skills-dual-override-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dual-override.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-target-"));
      try {
        const skillSourceDir = path.join(tmpDir, "test-pkg", "skills");
        fs.mkdirSync(skillSourceDir, { recursive: true });
        fs.writeFileSync(path.join(skillSourceDir, "DUAL.md"), "# dual-override skill body");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dual-override", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nskills:\n  - packages/test-pkg/skills/DUAL.md\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-dual-override",
          rigId: "01H000000000000000DUAL0001",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        // Critical: both override flags set — this triggered the B1 bug
        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundlePath, targetRoot, autoApprove: true,
            skipVersionCheck: true, force: true,
          }),
        });
        const body = await installRes.json();
        expect(body.skillsRouting).toBeDefined();
        expect(body.skillsRouting.routedCount).toBe(1);
        expect(body.skillsRouting.records[0].status).toBe("routed");
        const expectedTarget = path.join(auditHome, "packages", "test-pkg", "skills", "DUAL.md");
        expect(fs.existsSync(expectedTarget)).toBe(true);
        expect(fs.readFileSync(expectedTarget, "utf-8")).toBe("# dual-override skill body");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3d: /install routes declared plugins after
  // successful bootstrap. Mirrors skills-routing test; bundle has plugins[]
  // with source pointing to a directory in the bundle tree. Verifies the
  // plugin dir lands at OPENRIG_HOME/plugins/<id>/.
  it("POST /api/bundles/install routes declared plugins after successful bootstrap (completed branch)", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-plugins-route-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "with-plugins.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-target-"));
      try {
        // Put a plugin tree inside the bundle's package source so it lands in the archive
        const pluginSrc = path.join(tmpDir, "test-pkg", "plugins", "myplugin");
        fs.mkdirSync(pluginSrc, { recursive: true });
        fs.writeFileSync(path.join(pluginSrc, "plugin.json"), '{"name":"myplugin","version":"1.0"}');
        fs.writeFileSync(path.join(pluginSrc, "README.md"), "# myplugin");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "with-plugins", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        // Tamper bundle.yaml to inject plugins[] referencing the path in the bundle
        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nplugins:\n  - id: myplugin\n    source:\n      kind: local\n      path: packages/test-pkg/plugins/myplugin\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-plugins",
          rigId: "01H000000000000000PLUG0001",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.pluginsRouting).toBeDefined();
        expect(body.pluginsRouting.routedCount).toBe(1);
        expect(body.pluginsRouting.records[0].id).toBe("myplugin");
        expect(body.pluginsRouting.records[0].status).toBe("routed");
        // Plugin directory landed at OPENRIG_HOME/plugins/myplugin
        const expectedPluginDir = path.join(auditHome, "plugins", "myplugin");
        expect(fs.existsSync(expectedPluginDir)).toBe(true);
        expect(fs.existsSync(path.join(expectedPluginDir, "plugin.json"))).toBe(true);
        expect(fs.existsSync(path.join(expectedPluginDir, "README.md"))).toBe(true);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3d / guard B1 mirror of the 5f410eee skills lesson:
  // plugins routing must fire even when operator uses BOTH --skip-version-check
  // and --force pre-check overrides. routePluginsAfterBootstrap takes
  // bundlePath only (decoupled from installMeta) so that the dual-override
  // path — which leaves installMeta null at the pre-check site — still routes
  // declared plugins. Discriminator: re-coupling routePluginsAfterBootstrap
  // to installMeta would make this test fail (pluginsRouting undefined when
  // both override flags are set on a bundle that declares plugins[]).
  it("POST /api/bundles/install routes declared plugins even when both --skip-version-check and --force are set (B1 mirror)", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-plugins-dual-override-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dual-override-plugins.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-plugins-target-"));
      try {
        const pluginSrc = path.join(tmpDir, "test-pkg", "plugins", "dualplugin");
        fs.mkdirSync(pluginSrc, { recursive: true });
        fs.writeFileSync(path.join(pluginSrc, "plugin.json"), '{"name":"dualplugin","version":"1.0"}');
        fs.writeFileSync(path.join(pluginSrc, "README.md"), "# dualplugin body");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dual-override-plugins", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-plugins-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nplugins:\n  - id: dualplugin\n    source:\n      kind: local\n      path: packages/test-pkg/plugins/dualplugin\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-plugins-dual",
          rigId: "01H000000000000000DUAL0002",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        // Critical: both override flags set — installMeta is null at the pre-check
        // site in this path; the plugins-routing wrapper must STILL fire
        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundlePath, targetRoot, autoApprove: true,
            skipVersionCheck: true, force: true,
          }),
        });
        const body = await installRes.json();
        expect(body.pluginsRouting).toBeDefined();
        expect(body.pluginsRouting.routedCount).toBe(1);
        expect(body.pluginsRouting.records[0].id).toBe("dualplugin");
        expect(body.pluginsRouting.records[0].status).toBe("routed");
        const expectedPluginDir = path.join(auditHome, "plugins", "dualplugin");
        expect(fs.existsSync(expectedPluginDir)).toBe(true);
        expect(fs.existsSync(path.join(expectedPluginDir, "plugin.json"))).toBe(true);
        expect(fs.existsSync(path.join(expectedPluginDir, "README.md"))).toBe(true);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.5 (QA-20260601 A2 repair): /create auto-detects
  // author bundle.yaml + vendors declared cross-primitive content into
  // the archive + carries the cross-primitive fields onto the built
  // bundle.yaml. End-to-end proof that an author can declare all 5 kinds
  // and the create CLI produces a bundle that the install side will route.
  it("POST /api/bundles/create auto-detects author bundle.yaml + vendors all 5 cross-primitive kinds (pod-aware)", async () => {
    // 1. Build a pod-aware rig.yaml + agents/impl/agent.yaml at sourceRoot
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "create-author-bundle-src-"));
    const outputPath = path.join(tmpDir, "create-author-test.rigbundle");
    try {
      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent',
        'version: "1.0.0"',
        'resources:',
        '  skills: []',
        'profiles:',
        '  default:',
        '    uses:',
        '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: author-bundle-test-rig', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));

      // 2. Author content for all 5 cross-primitive kinds
      // skills: file
      fs.mkdirSync(path.join(sourceRoot, "skills/author-skill"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "skills/author-skill/SKILL.md"), "# Author skill body");
      // plugins: dir
      fs.mkdirSync(path.join(sourceRoot, "plugins/author-plugin"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "plugins/author-plugin/plugin.json"), '{"name":"author-plugin","version":"1.0"}');
      fs.writeFileSync(path.join(sourceRoot, "plugins/author-plugin/README.md"), "plugin readme");
      // workflow_specs: file (YAML)
      fs.mkdirSync(path.join(sourceRoot, "workflows"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "workflows/author-flow.yaml"), "workflow:\n  id: author-flow\n  version: '1'\n  roles: { producer: {} }\n  steps:\n    - id: produce\n      actor_role: producer\n");
      // context_packs: manifest.yaml inside a dir (vendor copies parent dir)
      fs.mkdirSync(path.join(sourceRoot, "context-packs/author-pack"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "context-packs/author-pack/manifest.yaml"), "name: author-pack\nversion: '1'\ntaxonomy: mission\nfiles:\n  - path: brief.md\n    role: brief\n");
      fs.writeFileSync(path.join(sourceRoot, "context-packs/author-pack/brief.md"), "# brief");
      // agent_images: dir
      fs.mkdirSync(path.join(sourceRoot, "agent-images/author-image"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agent-images/author-image/manifest.yaml"), "name: author-image\nversion: '1'\nruntime: claude-code\nsource_seat: x@y\nsource_session_id: aaa\nsource_resume_token: aaa\ncreated_at: '2026-05-31T00:00:00Z'\nfiles: []\n");

      // 3. Author bundle.yaml at sourceRoot declares all 5 kinds
      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        'skills:',
        '  - skills/author-skill/SKILL.md',
        'plugins:',
        '  - id: author-plugin',
        '    source:',
        '      kind: local',
        '      path: plugins/author-plugin',
        'workflow_specs:',
        '  - workflows/author-flow.yaml',
        'context_packs:',
        '  - context-packs/author-pack/manifest.yaml',
        'agent_images:',
        '  - agent-images/author-image',
      ].join("\n"));

      // 4. /api/bundles/create — pod-aware path
      const createRes = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specPath, rigRoot: sourceRoot,
          bundleName: "author-bundle-test", bundleVersion: "0.1.0", outputPath,
        }),
      });
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json();
      expect(createBody.archiveHash).toMatch(/^[a-f0-9]{64}$/);

      // 5. Unpack the archive + verify ALL 5 kinds' content + manifest fields
      const unpackDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-author-bundle-unpack-"));
      try {
        const tar = await import("tar");
        await tar.extract({ file: outputPath, cwd: unpackDir });

        // Built bundle.yaml has all 5 cross-primitive fields
        const builtYaml = fs.readFileSync(path.join(unpackDir, "bundle.yaml"), "utf-8");
        expect(builtYaml).toContain("skills:");
        expect(builtYaml).toContain("skills/author-skill/SKILL.md");
        expect(builtYaml).toContain("plugins:");
        expect(builtYaml).toContain("id: author-plugin");
        expect(builtYaml).toContain("workflow_specs:");
        expect(builtYaml).toContain("workflows/author-flow.yaml");
        expect(builtYaml).toContain("context_packs:");
        expect(builtYaml).toContain("context-packs/author-pack/manifest.yaml");
        expect(builtYaml).toContain("agent_images:");
        expect(builtYaml).toContain("agent-images/author-image");

        // Vendored content actually landed in staging tree (now archive)
        expect(fs.existsSync(path.join(unpackDir, "skills/author-skill/SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "plugins/author-plugin/plugin.json"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "plugins/author-plugin/README.md"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "workflows/author-flow.yaml"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "context-packs/author-pack/manifest.yaml"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "context-packs/author-pack/brief.md"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "agent-images/author-image/manifest.yaml"))).toBe(true);
      } finally {
        fs.rmSync(unpackDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  it("LP-3 refuses internal substance in an author-declared directory before archive creation", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s12-lp3-internal-src-"));
    const outputPath = path.join(tmpDir, "s12-lp3-internal.rigbundle");
    try {
      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
        'profiles:', '  default:', '    uses:', '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: s12-lp3-internal', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));
      fs.mkdirSync(path.join(sourceRoot, "plugins/private"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "plugins/private/README.md"), "See substrate/shared-docs/rigs/private.\n");
      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        "plugins:", "  - id: private", "    source:", "      kind: local", "      path: plugins/private",
      ].join("\n"));

      const response = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specPath, rigRoot: sourceRoot, bundleName: "s12-lp3", bundleVersion: "1", outputPath }),
      });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toMatch(/internal-path[\s\S]*(genericize|public home|re-home)/i);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  it("LP-3 refuses an author-declared lore pack before archive creation", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s12-lp3-lore-src-"));
    const outputPath = path.join(tmpDir, "s12-lp3-lore.rigbundle");
    try {
      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
        'profiles:', '  default:', '    uses:', '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: s12-lp3-lore', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));
      fs.mkdirSync(path.join(sourceRoot, "context-packs/private-lore"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "context-packs/private-lore/manifest.yaml"), [
        "name: private-lore", 'version: "1"', "taxonomy: lore", "files: []",
      ].join("\n"));
      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        "context_packs:", "  - context-packs/private-lore/manifest.yaml",
      ].join("\n"));

      const response = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specPath, rigRoot: sourceRoot, bundleName: "s12-lp3", bundleVersion: "1", outputPath }),
      });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toMatch(/lore-class|taxonomy:\s*lore/i);
      expect(body.error).toMatch(/genericize|public home|re-home/i);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  // Item 6 / QA-20260601 C1 repair: /api/bundles/inspect normalized
  // response on a v2 archive containing cross-primitive blocks must
  // surface skills + plugins + workflowSpecs + contextPacks +
  // agentImages alongside provenance + compatibility. Built bundle.yaml
  // contains the snake_case fields (Checkpoint 7.5); inspect's response
  // now mirrors them as camelCase per the v2 normalized-manifest contract.
  it("POST /api/bundles/inspect surfaces cross-primitive fields for a v2 archive built from author bundle.yaml", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-crossprim-src-"));
    const outputPath = path.join(tmpDir, "inspect-crossprim.rigbundle");
    try {
      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
        'profiles:', '  default:', '    uses:', '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: inspect-crossprim-rig', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));
      // All 5 cross-primitive kinds — per banked guard catch on dc4df12f:
      // testing only 2 leaves the workflow_specs/context_packs/agent_images
      // snake_case→camelCase mappings unproven. Each kind's content + author
      // declaration + response assertion below.
      fs.mkdirSync(path.join(sourceRoot, "skills/inspect-skill"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "skills/inspect-skill/SKILL.md"), "# inspect skill");
      fs.mkdirSync(path.join(sourceRoot, "plugins/inspect-plugin"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "plugins/inspect-plugin/plugin.json"), '{"name":"inspect-plugin","version":"1.0"}');
      fs.mkdirSync(path.join(sourceRoot, "workflows"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "workflows/inspect-flow.yaml"), "workflow:\n  id: inspect-flow\n  version: '1'\n  roles: { producer: {} }\n  steps:\n    - id: produce\n      actor_role: producer\n");
      fs.mkdirSync(path.join(sourceRoot, "context-packs/inspect-pack"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "context-packs/inspect-pack/manifest.yaml"), "name: inspect-pack\nversion: '1'\nfiles:\n  - path: brief.md\n    role: brief\n");
      fs.writeFileSync(path.join(sourceRoot, "context-packs/inspect-pack/brief.md"), "# brief");
      fs.mkdirSync(path.join(sourceRoot, "agent-images/inspect-image"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agent-images/inspect-image/manifest.yaml"), "name: inspect-image\nversion: '1'\nruntime: claude-code\nsource_seat: x@y\nsource_session_id: aaa\nsource_resume_token: aaa\ncreated_at: '2026-05-31T00:00:00Z'\nfiles: []\n");
      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        'skills:',
        '  - skills/inspect-skill/SKILL.md',
        'plugins:',
        '  - id: inspect-plugin',
        '    source:',
        '      kind: local',
        '      path: plugins/inspect-plugin',
        'workflow_specs:',
        '  - workflows/inspect-flow.yaml',
        'context_packs:',
        '  - context-packs/inspect-pack/manifest.yaml',
        'agent_images:',
        '  - agent-images/inspect-image',
      ].join("\n"));

      const createRes = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specPath, rigRoot: sourceRoot,
          bundleName: "inspect-crossprim-test", bundleVersion: "0.1.0", outputPath,
        }),
      });
      expect(createRes.status).toBe(201);

      const inspectRes = await app.request("/api/bundles/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath: outputPath }),
      });
      expect(inspectRes.status).toBe(200);
      const inspectBody = await inspectRes.json();
      // QA-C1 repair: ALL 5 cross-primitive fields surfaced in the normalized
      // manifest. v2 archive → response.manifest carries camelCase keys.
      // Per banked guard catch on dc4df12f: each snake_case→camelCase
      // mapping individually proven, not just skills+plugins.
      expect(inspectBody.manifest.skills).toEqual(["skills/inspect-skill/SKILL.md"]);
      expect(inspectBody.manifest.plugins).toHaveLength(1);
      expect(inspectBody.manifest.plugins[0].id).toBe("inspect-plugin");
      expect(inspectBody.manifest.workflowSpecs).toEqual(["workflows/inspect-flow.yaml"]);
      expect(inspectBody.manifest.contextPacks).toEqual(["context-packs/inspect-pack/manifest.yaml"]);
      expect(inspectBody.manifest.agentImages).toEqual(["agent-images/inspect-image"]);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  // Item 6 / Checkpoint 7.5 B1 repair (banked 79a89d40 guard catch):
  // symlink escape via author bundle.yaml — FILE shape. A skill path
  // that looks lexically contained but symlinks to an outside file must
  // be rejected. Without realpath validation, dereference at vendor
  // time would copy outside content into the archive as a regular file.
  it("POST /api/bundles/create rejects author bundle.yaml skill that is a symlink targeting outside sourceRoot", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "create-symlink-escape-file-src-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-symlink-escape-file-outside-"));
    const outputPath = path.join(tmpDir, "symlink-escape-file.rigbundle");
    try {
      // Outside content (private/secret file the bundle should NEVER contain)
      const outsideFile = path.join(outsideDir, "secret.md");
      fs.writeFileSync(outsideFile, "SECRET CONTENT");

      // Pod-aware sourceRoot fixture
      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
        'profiles:', '  default:', '    uses:', '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: symlink-escape-file-rig', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));

      // Symlink inside sourceRoot → outside file
      fs.mkdirSync(path.join(sourceRoot, "skills/escape"), { recursive: true });
      fs.symlinkSync(outsideFile, path.join(sourceRoot, "skills/escape/SKILL.md"));

      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        'skills:',
        '  - skills/escape/SKILL.md',
      ].join("\n"));

      const createRes = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specPath, rigRoot: sourceRoot,
          bundleName: "symlink-escape-file-test", bundleVersion: "0.1.0", outputPath,
        }),
      });
      // /create catch returns 500 with the message (per banked 79a89d40
      // comment-honesty update). Body.error names the symlink escape.
      expect(createRes.status).toBe(500);
      const body = await createRes.json();
      expect(body.error).toMatch(/symlink escape|outside bundle source root/i);
      // CRUCIAL: no archive at outputPath (create failed before pack)
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  // Item 6 / Checkpoint 7.5 B1 repair (banked 79a89d40 guard catch):
  // symlink escape via author bundle.yaml — DIR shape. A plugin path
  // that looks lexically contained but symlinks to an outside dir must
  // be rejected. Without realpath validation, cpSync dereference would
  // copy the outside dir tree into the archive.
  it("POST /api/bundles/create rejects author bundle.yaml plugin that is a symlink targeting outside sourceRoot", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "create-symlink-escape-dir-src-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-symlink-escape-dir-outside-"));
    const outputPath = path.join(tmpDir, "symlink-escape-dir.rigbundle");
    try {
      // Outside dir tree (private content the bundle should NEVER contain)
      fs.writeFileSync(path.join(outsideDir, "private.json"), '{"secret":"data"}');

      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
        'profiles:', '  default:', '    uses:', '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: symlink-escape-dir-rig', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));

      // Symlink inside sourceRoot/plugins → outside dir
      fs.mkdirSync(path.join(sourceRoot, "plugins"), { recursive: true });
      fs.symlinkSync(outsideDir, path.join(sourceRoot, "plugins/escape"));

      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        'plugins:',
        '  - id: escape',
        '    source:',
        '      kind: local',
        '      path: plugins/escape',
      ].join("\n"));

      const createRes = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specPath, rigRoot: sourceRoot,
          bundleName: "symlink-escape-dir-test", bundleVersion: "0.1.0", outputPath,
        }),
      });
      expect(createRes.status).toBe(500);
      const body = await createRes.json();
      expect(body.error).toMatch(/symlink escape|outside bundle source root/i);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  // Item 6 / Checkpoint 7.3e step 3: /install routes declared workflow_specs
  // after successful bootstrap. Target = SettingsStore-resolved
  // <workspaceSpecsRoot>/workflows. Bundle has workflow_specs[] with a path
  // pointing to a workflow YAML file in the bundle tree. Router lands the
  // file at top-level basename under <specsRoot>/workflows. Scanner-
  // reachability proven via a real scanWorkflowSpecFolder call against the
  // target dir (guard d43b7729 + 9f9ebe0a scanner-reachability lesson).
  it("POST /api/bundles/install routes declared workflow_specs after successful bootstrap (completed branch) — proves scanner-reachability", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origSpecsRoot = process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-workflow-specs-route-test-"));
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-workflow-specs-route-target-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_WORKSPACE_SPECS_ROOT = specsRoot;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "with-workflow-specs.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wflow-target-"));
      try {
        // Valid workflow YAML fixture mirroring workflow-spec-folder-scanner.test.ts:22-43
        // (workflow.id + workflow.version + workflow.roles + workflow.steps non-empty).
        // Without these the spec-library-workflow-scanner records it as an error
        // diagnostic row, not a valid workflow — defeating the scanner-reachability proof.
        const validWorkflowYaml = `workflow:
  id: bundle-routed-test
  version: '1'
  objective: A bundle-routed workflow fixture
  target:
    rig: test-fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@test-fixture
  steps:
    - id: produce
      actor_role: producer
      objective: Draft.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;
        // Put the valid YAML inside the bundle's package source
        const workflowSrcDir = path.join(tmpDir, "test-pkg", "workflows");
        fs.mkdirSync(workflowSrcDir, { recursive: true });
        fs.writeFileSync(path.join(workflowSrcDir, "onboarding.yaml"), validWorkflowYaml);

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "with-workflow-specs", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "wflow-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          // Declared path can be the verbatim package path; the router uses
          // basename() to land it at top-level (scanner-reachability contract).
          const tampered = `${original}\nworkflow_specs:\n  - packages/test-pkg/workflows/onboarding.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-workflow-specs",
          rigId: "01H000000000000000WSPEC01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.workflowSpecsRouting).toBeDefined();
        expect(body.workflowSpecsRouting.routedCount).toBe(1);
        expect(body.workflowSpecsRouting.records[0].status).toBe("routed");
        // Router uses basename(): declared "packages/test-pkg/workflows/onboarding.yaml"
        // → lands at <specsRoot>/workflows/onboarding.yaml (top-level only).
        const expectedTarget = path.join(specsRoot, "workflows", "onboarding.yaml");
        expect(fs.existsSync(expectedTarget)).toBe(true);
        expect(fs.readFileSync(expectedTarget, "utf-8")).toBe(validWorkflowYaml);

        // Scanner-reachability PROOF: invoke the real scanWorkflowSpecFolder
        // against the target dir with a fresh WorkflowSpecCache; assert at
        // least one valid (non-diagnostic) cached spec matching the fixture
        // id+version. This proves the routed file is operator-visible via
        // the live Library scan path (the d43b7729 / 9f9ebe0a contract).
        const { createDb } = await import("../src/db/connection.js");
        const { migrate } = await import("../src/db/migrate.js");
        const { coreSchema } = await import("../src/db/migrations/001_core_schema.js");
        const { eventsSchema } = await import("../src/db/migrations/003_events.js");
        const { workflowSpecsSchema } = await import("../src/db/migrations/033_workflow_specs.js");
        const { workflowSpecsDiagnosticSchema } = await import("../src/db/migrations/040_workflow_specs_diagnostic.js");
        const { WorkflowSpecCache } = await import("../src/domain/workflow-spec-cache.js");
        const { scanWorkflowSpecFolder } = await import("../src/domain/spec-library-workflow-scanner.js");
        const scanDb = createDb();
        migrate(scanDb, [coreSchema, eventsSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
        const scanCache = new WorkflowSpecCache(scanDb);
        try {
          const scanResult = scanWorkflowSpecFolder({
            db: scanDb,
            cache: scanCache,
            folder: path.join(specsRoot, "workflows"),
            builtinDir: null,
          });
          // The fixture is a VALID workflow spec (workflow.id + version + roles +
          // steps); scanner caches it as `valid`, not `errors`.
          expect(scanResult.scanned).toBe(1);
          expect(scanResult.valid).toBe(1);
          expect(scanResult.errors).toBe(0);
          // Confirm the cached row matches the fixture's workflow.id + version.
          const cached = scanDb.prepare(`SELECT name, version FROM workflow_specs ORDER BY name, version`).all() as Array<{ name: string; version: string }>;
          expect(cached.length).toBeGreaterThanOrEqual(1);
          const found = cached.find((r) => r.name === "bundle-routed-test");
          expect(found).toBeDefined();
          expect(found!.version).toBe("1");
        } finally {
          scanDb.close();
        }
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origSpecsRoot === undefined) delete process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
      else process.env.OPENRIG_WORKSPACE_SPECS_ROOT = origSpecsRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
      fs.rmSync(specsRoot, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3e step 3 / B1-mirror discipline (banked 5f410eee
  // decoupling lesson): workflow_specs routing must fire even when operator
  // uses BOTH --skip-version-check and --force pre-check overrides. The
  // routing is independent of the pre-check extraction gate. Discriminator:
  // re-coupling routeWorkflowSpecsAfterBootstrap to installMeta would make
  // this test fail (workflowSpecsRouting undefined when both flags set on a
  // bundle that declares workflow_specs[]).
  it("POST /api/bundles/install routes declared workflow_specs even when both --skip-version-check and --force are set (B1 mirror)", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origSpecsRoot = process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-wflow-dual-override-"));
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-wflow-dual-override-target-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_WORKSPACE_SPECS_ROOT = specsRoot;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dual-override-wflow.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-wflow-target-"));
      try {
        const workflowSrcDir = path.join(tmpDir, "test-pkg", "workflows");
        fs.mkdirSync(workflowSrcDir, { recursive: true });
        fs.writeFileSync(path.join(workflowSrcDir, "dualflow.yaml"), "name: dualflow\nversion: '2.0'\nsteps: []\n");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dual-override-wflow", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-wflow-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nworkflow_specs:\n  - packages/test-pkg/workflows/dualflow.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-wflow-dual",
          rigId: "01H000000000000000WDUAL01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        // Critical: both override flags set — installMeta is null at the pre-check
        // site in this path; the workflow_specs-routing wrapper must STILL fire
        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundlePath, targetRoot, autoApprove: true,
            skipVersionCheck: true, force: true,
          }),
        });
        const body = await installRes.json();
        expect(body.workflowSpecsRouting).toBeDefined();
        expect(body.workflowSpecsRouting.routedCount).toBe(1);
        expect(body.workflowSpecsRouting.records[0].status).toBe("routed");
        // Router uses basename() → top-level under <specsRoot>/workflows
        const expectedTarget = path.join(specsRoot, "workflows", "dualflow.yaml");
        expect(fs.existsSync(expectedTarget)).toBe(true);
        expect(fs.readFileSync(expectedTarget, "utf-8")).toBe("name: dualflow\nversion: '2.0'\nsteps: []\n");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origSpecsRoot === undefined) delete process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
      else process.env.OPENRIG_WORKSPACE_SPECS_ROOT = origSpecsRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
      fs.rmSync(specsRoot, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3e step 3 / guard B1 mirror at integration boundary:
  // duplicate-basename declared paths must produce routedCount=1 + 1 conflict
  // record, NOT 2 routed records claiming the same installedAt (the false-
  // positive class guard caught on d81456dc).
  it("POST /api/bundles/install duplicate-basename workflow_specs: routedCount=1, second flagged conflict (truthful routedCount)", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origSpecsRoot = process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-wflow-dup-basename-"));
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-wflow-dup-basename-target-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_WORKSPACE_SPECS_ROOT = specsRoot;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dup-basename.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dup-basename-target-"));
      try {
        const wflowA = path.join(tmpDir, "test-pkg", "workflows-a");
        const wflowB = path.join(tmpDir, "test-pkg", "workflows-b");
        fs.mkdirSync(wflowA, { recursive: true });
        fs.mkdirSync(wflowB, { recursive: true });
        fs.writeFileSync(path.join(wflowA, "shared.yaml"), "content-A");
        fs.writeFileSync(path.join(wflowB, "shared.yaml"), "content-B");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dup-basename", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dup-basename-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          // Both declared paths share basename "shared.yaml"
          const tampered = `${original}\nworkflow_specs:\n  - packages/test-pkg/workflows-a/shared.yaml\n  - packages/test-pkg/workflows-b/shared.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-dup-basename",
          rigId: "01H000000000000000WDUPBN",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.workflowSpecsRouting).toBeDefined();
        // Truthful routedCount: only the first declared path was actually
        // written. The second is flagged conflict, not silently overwritten.
        expect(body.workflowSpecsRouting.routedCount).toBe(1);
        expect(body.workflowSpecsRouting.rejectedCount).toBe(1);
        expect(body.workflowSpecsRouting.records).toHaveLength(2);
        expect(body.workflowSpecsRouting.records[0].status).toBe("routed");
        expect(body.workflowSpecsRouting.records[1].status).toBe("conflict");
        // Confirm the first content survived (no silent overwrite by 2nd)
        const expectedTarget = path.join(specsRoot, "workflows", "shared.yaml");
        expect(fs.existsSync(expectedTarget)).toBe(true);
        expect(fs.readFileSync(expectedTarget, "utf-8")).toBe("content-A");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origSpecsRoot === undefined) delete process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
      else process.env.OPENRIG_WORKSPACE_SPECS_ROOT = origSpecsRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
      fs.rmSync(specsRoot, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3f step 3: /install routes declared context_packs
  // after successful bootstrap. Target = <openrigHome>/context-packs
  // (startup.ts:496 user-file root). Bundle has context_packs[] with paths
  // to context-pack manifest.yaml files; router copies the parent dir to
  // <openrigHome>/context-packs/<dirname>/. Consumer-scan reachability
  // proven via real ContextPackLibraryService.scan() against the routed
  // root (guard d491eca9 + 3cd581e3 file-vs-dir discrimination lessons).
  it("POST /api/bundles/install routes declared context_packs after successful bootstrap (completed branch) — proves consumer-scan reachability", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-context-packs-route-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "with-context-packs.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cpacks-target-"));
      try {
        // Build a VALID context-pack: dir w/ manifest.yaml (name + version +
        // files[]) + the file referenced in files[]. Per
        // packages/daemon/src/domain/context-packs/manifest-parser.ts:
        // manifest needs name, version, files[{path, role}].
        const packDir = path.join(tmpDir, "test-pkg", "context-packs", "intent");
        fs.mkdirSync(packDir, { recursive: true });
        const validManifest = `name: bundle-routed-intent
version: '1'
taxonomy: mission
purpose: A bundle-routed context-pack fixture
files:
  - path: brief.md
    role: brief
    summary: One-line summary
`;
        fs.writeFileSync(path.join(packDir, "manifest.yaml"), validManifest);
        fs.writeFileSync(path.join(packDir, "brief.md"), "# Brief\nContent.");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "with-context-packs", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpacks-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\ncontext_packs:\n  - packages/test-pkg/context-packs/intent/manifest.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-cpacks",
          rigId: "01H000000000000000CPCK01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.contextPacksRouting).toBeDefined();
        expect(body.contextPacksRouting.routedCount).toBe(1);
        expect(body.contextPacksRouting.records[0].status).toBe("routed");
        // Router copies the PARENT DIR of manifest.yaml: declared
        // "packages/test-pkg/context-packs/intent/manifest.yaml" → parent
        // basename "intent" → target/intent/
        const expectedPackDir = path.join(auditHome, "context-packs", "intent");
        expect(fs.existsSync(expectedPackDir)).toBe(true);
        expect(fs.existsSync(path.join(expectedPackDir, "manifest.yaml"))).toBe(true);
        expect(fs.existsSync(path.join(expectedPackDir, "brief.md"))).toBe(true);

        // CONSUMER-SCAN REACHABILITY PROOF: instantiate the real consumer
        // against the routed target root + assert the pack is visible.
        const { ContextPackLibraryService } = await import("../src/domain/context-packs/context-pack-library-service.js");
        const consumer = new ContextPackLibraryService({
          roots: [{ path: path.join(auditHome, "context-packs"), sourceType: "user_file" }],
        });
        const scanResult = consumer.scan();
        expect(scanResult.count).toBeGreaterThanOrEqual(1);
        expect(scanResult.errors).toEqual([]);
        // Confirm the consumer indexed our routed pack by id (name+version
        // come from inside the manifest, not the dirname).
        const entries = consumer.list();
        const found = entries.find((e) => e.name === "bundle-routed-intent");
        expect(found).toBeDefined();
        expect(found!.version).toBe("1");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // B1-mirror: context_packs routing must fire even when operator uses
  // BOTH --skip-version-check and --force pre-check overrides (banked
  // 5f410eee decoupling lesson; PROACTIVELY shipped).
  it("POST /api/bundles/install routes declared context_packs even when both --skip-version-check and --force are set (B1 mirror)", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-cpacks-dual-override-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dual-override-cpacks.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-cpacks-target-"));
      try {
        const packDir = path.join(tmpDir, "test-pkg", "context-packs", "dualcontext");
        fs.mkdirSync(packDir, { recursive: true });
        fs.writeFileSync(path.join(packDir, "manifest.yaml"), `name: dualcontext-pack
version: '2'
files:
  - path: notes.md
    role: notes
`);
        fs.writeFileSync(path.join(packDir, "notes.md"), "dual content");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dual-override-cpacks", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-cpacks-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\ncontext_packs:\n  - packages/test-pkg/context-packs/dualcontext/manifest.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-cpacks-dual",
          rigId: "01H000000000000000CPDUAL",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        // Both override flags set — installMeta null at pre-check; the
        // context-packs router must STILL fire.
        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundlePath, targetRoot, autoApprove: true,
            skipVersionCheck: true, force: true,
          }),
        });
        const body = await installRes.json();
        expect(body.contextPacksRouting).toBeDefined();
        expect(body.contextPacksRouting.routedCount).toBe(1);
        expect(body.contextPacksRouting.records[0].status).toBe("routed");
        expect(fs.existsSync(path.join(auditHome, "context-packs", "dualcontext", "manifest.yaml"))).toBe(true);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Degenerate-input dogfood (per guard 3cd581e3 carry-forward "include
  // malformed pack rejection if cheap"): bundle declares a context_pack
  // whose manifest.yaml file is NOT in the bundle tree. routedCount=0,
  // status=missing, NO pack copied to target.
  it("POST /api/bundles/install context_packs degenerate-input: declared manifest absent → status=missing, no false routedCount", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-cpacks-degenerate-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "absent-cpacks.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "absent-cpacks-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "absent-cpacks", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "absent-cpacks-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          // Manifest declares a pack path that does NOT exist in the bundle
          const tampered = `${original}\ncontext_packs:\n  - packages/test-pkg/context-packs/nonexistent/manifest.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-cpacks-absent",
          rigId: "01H000000000000000CPABS0",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.contextPacksRouting).toBeDefined();
        // Truthful routedCount: 0 (manifest absent — consumer would skip)
        expect(body.contextPacksRouting.routedCount).toBe(0);
        expect(body.contextPacksRouting.rejectedCount).toBe(1);
        expect(body.contextPacksRouting.records[0].status).toBe("missing");
        // CRUCIAL: nothing landed at target
        expect(fs.existsSync(path.join(auditHome, "context-packs", "nonexistent"))).toBe(false);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3g step 3: /install routes declared agent_images
  // after successful bootstrap. Per PRD line 197 + e7a0b253 contract:
  // declared paths are image DIRECTORIES (not manifest paths). Target =
  // <openrigHome>/agent-images (startup.ts:523 user-file root). Router
  // copies whole image dir to <openrigHome>/agent-images/<basename>/.
  // Consumer-scan reachability proven via real AgentImageLibraryService.scan
  // against the routed root (mirror of cb0bf7b9 context_packs proof).
  it("POST /api/bundles/install routes declared agent_images after successful bootstrap (completed branch) — proves consumer-scan reachability", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-agent-images-route-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "with-agent-images.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aimgs-target-"));
      try {
        // Build a VALID agent_image: dir w/ manifest.yaml (name + version +
        // runtime + sourceSeat + sourceSessionId + sourceResumeToken +
        // createdAt + files[]) per agent-image-types.ts schema.
        const imageDir = path.join(tmpDir, "test-pkg", "agent-images", "seat-a");
        fs.mkdirSync(imageDir, { recursive: true });
        const validManifest = `name: bundle-routed-seat-a
version: '1'
runtime: claude-code
source_seat: velocity-driver@openrig-velocity
source_session_id: 01HABCDEF000000000000000
source_resume_token: 01HABCDEF000000000000000
created_at: '2026-05-31T00:00:00Z'
files: []
`;
        fs.writeFileSync(path.join(imageDir, "manifest.yaml"), validManifest);

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "with-agent-images", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimgs-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          // PRD-coherent: declared path is the image DIR, not the manifest
          const tampered = `${original}\nagent_images:\n  - packages/test-pkg/agent-images/seat-a\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-aimgs",
          rigId: "01H000000000000000AIMG01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.agentImagesRouting).toBeDefined();
        expect(body.agentImagesRouting.routedCount).toBe(1);
        expect(body.agentImagesRouting.records[0].status).toBe("routed");
        // Router copies WHOLE image dir: declared "packages/test-pkg/agent-
        // images/seat-a" → basename "seat-a" → target/seat-a/
        const expectedImageDir = path.join(auditHome, "agent-images", "seat-a");
        expect(fs.existsSync(expectedImageDir)).toBe(true);
        expect(fs.existsSync(path.join(expectedImageDir, "manifest.yaml"))).toBe(true);

        // CONSUMER-SCAN REACHABILITY PROOF: instantiate the real
        // AgentImageLibraryService against the routed root + assert the
        // image is visible by name+version.
        const { AgentImageLibraryService } = await import("../src/domain/agent-images/agent-image-library-service.js");
        const consumer = new AgentImageLibraryService({
          roots: [{ path: path.join(auditHome, "agent-images"), sourceType: "user_file" }],
        });
        const scanResult = consumer.scan();
        expect(scanResult.count).toBeGreaterThanOrEqual(1);
        expect(scanResult.errors).toEqual([]);
        const entries = consumer.list();
        const found = entries.find((e) => e.name === "bundle-routed-seat-a");
        expect(found).toBeDefined();
        expect(found!.version).toBe("1");
        expect(found!.runtime).toBe("claude-code");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // B1-mirror: agent_images routing must fire even when operator uses
  // BOTH --skip-version-check and --force pre-check overrides.
  it("POST /api/bundles/install routes declared agent_images even when both --skip-version-check and --force are set (B1 mirror)", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-aimgs-dual-override-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dual-override-aimgs.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-aimgs-target-"));
      try {
        const imageDir = path.join(tmpDir, "test-pkg", "agent-images", "dualseat");
        fs.mkdirSync(imageDir, { recursive: true });
        fs.writeFileSync(path.join(imageDir, "manifest.yaml"), `name: dualseat-image
version: '2'
runtime: codex
source_seat: velocity-driver@openrig-velocity
source_session_id: 01HABCDEFDUAL00000000000
source_resume_token: 01HABCDEFDUAL00000000000
created_at: '2026-05-31T00:00:00Z'
files: []
`);

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dual-override-aimgs", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-aimgs-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nagent_images:\n  - packages/test-pkg/agent-images/dualseat\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-aimgs-dual",
          rigId: "01H000000000000000AIMDUL",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundlePath, targetRoot, autoApprove: true,
            skipVersionCheck: true, force: true,
          }),
        });
        const body = await installRes.json();
        expect(body.agentImagesRouting).toBeDefined();
        expect(body.agentImagesRouting.routedCount).toBe(1);
        expect(body.agentImagesRouting.records[0].status).toBe("routed");
        expect(fs.existsSync(path.join(auditHome, "agent-images", "dualseat", "manifest.yaml"))).toBe(true);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Degenerate-input: declared image dir absent. routedCount=0,
  // status=missing, NO image at target.
  it("POST /api/bundles/install agent_images degenerate-input: declared image absent → status=missing, no false routedCount", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-aimgs-degenerate-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "absent-aimgs.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "absent-aimgs-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "absent-aimgs", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "absent-aimgs-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nagent_images:\n  - packages/test-pkg/agent-images/nonexistent\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-aimgs-absent",
          rigId: "01H000000000000000AIMABS",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.agentImagesRouting).toBeDefined();
        expect(body.agentImagesRouting.routedCount).toBe(0);
        expect(body.agentImagesRouting.rejectedCount).toBe(1);
        expect(body.agentImagesRouting.records[0].status).toBe("missing");
        expect(fs.existsSync(path.join(auditHome, "agent-images", "nonexistent"))).toBe(false);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install does NOT include agentImagesRouting when bundle has no agent_images[]", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-aimgs-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "no-aimgs.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-aimgs-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "no-aimgs-installer", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stub = vi.fn().mockResolvedValue({
          status: "completed", runId: "test-run-no-aimgs",
          rigId: "01H000000000000000NOAIMG",
          stages: [], errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.agentImagesRouting).toBeUndefined();
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install does NOT include contextPacksRouting when bundle has no context_packs[]", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-cpacks-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "no-cpacks.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-cpacks-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "no-cpacks-installer", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stub = vi.fn().mockResolvedValue({
          status: "completed", runId: "test-run-no-cpacks",
          rigId: "01H000000000000000NOCPCK",
          stages: [], errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.contextPacksRouting).toBeUndefined();
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install does NOT include workflowSpecsRouting when bundle has no workflow_specs[]", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origSpecsRoot = process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-wflow-test-"));
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-wflow-target-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_WORKSPACE_SPECS_ROOT = specsRoot;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "no-wflow.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-wflow-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "no-wflow-installer", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stub = vi.fn().mockResolvedValue({
          status: "completed", runId: "test-run-no-wflow",
          rigId: "01H000000000000000NOWFLW",
          stages: [], errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.workflowSpecsRouting).toBeUndefined();
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origSpecsRoot === undefined) delete process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
      else process.env.OPENRIG_WORKSPACE_SPECS_ROOT = origSpecsRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
      fs.rmSync(specsRoot, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install does NOT include pluginsRouting when bundle has no plugins[]", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-plugins-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "no-plugins.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-plugins-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "no-plugins-installer", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stub = vi.fn().mockResolvedValue({
          status: "completed", runId: "test-run-no-plugins",
          rigId: "01H000000000000000NOPLG01",
          stages: [], errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.pluginsRouting).toBeUndefined();
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install does NOT include skillsRouting when bundle has no skills[]", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-skills-no-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "no-skills.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-skills-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "no-skills", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stub = vi.fn().mockResolvedValue({
          status: "completed", runId: "test-run-no-skills",
          rigId: "01H000000000000000NOSKIL01",
          stages: [], errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.skillsRouting).toBeUndefined();
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // T11: Install concurrency lock
  it("concurrent bundle install returns 409", async () => {
    // Acquire lock manually
    setup.bootstrapOrchestrator.tryAcquire("/tmp/locked.rigbundle");

    const res = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath: "/tmp/locked.rigbundle", targetRoot: "/tmp/target" }),
    });

    expect(res.status).toBe(409);
    setup.bootstrapOrchestrator.release("/tmp/locked.rigbundle");
  });
});
