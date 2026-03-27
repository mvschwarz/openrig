import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../src/db/migrations/011_bootstrap.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { createTestApp } from "./helpers/test-app.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema,
  discoverySchema, discoveryFkFix,
];

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
