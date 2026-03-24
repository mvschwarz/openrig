import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createDaemon } from "../src/startup.js";
import { RigSpecExporter as RigSpecExporterClass } from "../src/domain/rigspec-exporter.js";
import { RigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import { RigRepository as RigRepoClass } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createApp } from "../src/server.js";
import type { ExecFn } from "../src/adapters/tmux.js";

const VALID_YAML = `
schema_version: 1
name: r99
version: 1.0.0
nodes:
  - id: worker
    runtime: claude-code
    role: worker
    cwd: /
edges: []
`;

const INVALID_YAML = `
name: ""
version: ""
nodes: bad
`;

describe("Rigspec export routes", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/rigs/:rigId/spec -> 200 + YAML content-type", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const res = await app.request(`/api/rigs/${rig.id}/spec`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/yaml");
    const text = await res.text();
    expect(text).toContain("r99");
  });

  it("GET /api/rigs/:rigId/spec.json -> 200 + JSON", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const res = await app.request(`/api/rigs/${rig.id}/spec.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("r99");
    expect(body.nodes).toHaveLength(1);
  });

  it("GET nonexistent rig -> 404", async () => {
    const res = await app.request("/api/rigs/nonexistent/spec");
    expect(res.status).toBe(404);
  });

  it("export internal error for corrupted rig -> 500", async () => {
    const rig = rigRepo.createRig("r99");
    // Insert node with no runtime via raw SQL
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)")
      .run("bad-node", rig.id, "broken");

    const res = await app.request(`/api/rigs/${rig.id}/spec`);
    expect(res.status).toBe(500);
  });
});

describe("Rigspec import routes", () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/rigs/import valid YAML -> 201 + InstantiateResult", async () => {
    const res = await app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rigId).toBeDefined();
    expect(body.specName).toBe("r99");
    expect(body.nodes).toHaveLength(1);
  });

  it("POST /api/rigs/import invalid YAML -> 400", async () => {
    const res = await app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: INVALID_YAML,
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/rigs/import preflight failure -> 409", async () => {
    // Create name collision
    const setup = createTestApp(db);
    setup.rigRepo.createRig("r99");

    const res = await setup.app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/rigs/import/validate -> 200 + ValidationResult", async () => {
    const res = await app.request("/api/rigs/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it("POST /api/rigs/import/validate invalid YAML -> 400", async () => {
    const res = await app.request("/api/rigs/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not: [valid: yaml: {{{",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/rigs/import/preflight -> 200 + PreflightResult", async () => {
    const res = await app.request("/api/rigs/import/preflight", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ready");
    expect(body).toHaveProperty("errors");
    expect(body).toHaveProperty("warnings");
  });

  it("POST /api/rigs/import/preflight invalid YAML -> 400", async () => {
    const res = await app.request("/api/rigs/import/preflight", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not: [valid: yaml: {{{",
    });
    expect(res.status).toBe(400);
  });
});

describe("Rigspec wiring", () => {
  it("startup mounts rigspec routes (createDaemon regression)", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };
    const { app, db, deps } = await createDaemon({ tmuxExec, cmuxExec });
    const rig = deps.rigRepo.createRig("r99");
    deps.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const res = await app.request(`/api/rigs/${rig.id}/spec.json`);
    expect(res.status).toBe(200);
    db.close();
  });

  it("createApp throws on mismatched exporter db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();
    const goodDeps = createTestApp(db1);
    const otherRepo = new RigRepoClass(db2);
    const otherRegistry = new SessionRegistry(db2);
    const badExporter = new RigSpecExporterClass({ rigRepo: otherRepo, sessionRegistry: otherRegistry });

    expect(() => createApp({
      ...extractDeps(goodDeps),
      rigSpecExporter: badExporter,
    })).toThrow(/rigSpecExporter.*same db handle/);
    db1.close();
    db2.close();
  });

  it("createApp throws on mismatched instantiator db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();
    const goodDeps = createTestApp(db1);
    expect(() => createApp({
      ...extractDeps(goodDeps),
      rigInstantiator: { db: db2 } as any,
    })).toThrow(/rigInstantiator.*same db handle/);
    db1.close();
    db2.close();
  });

  it("createApp throws on mismatched preflight db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();
    const goodDeps = createTestApp(db1);
    expect(() => createApp({
      ...extractDeps(goodDeps),
      rigSpecPreflight: { db: db2 } as any,
    })).toThrow(/rigSpecPreflight.*same db handle/);
    db1.close();
    db2.close();
  });

  it("startup constructs all Phase 3 deps", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };
    const { app, db } = await createDaemon({ tmuxExec, cmuxExec });

    // Import route is mounted (proves instantiator + preflight wired)
    const res = await app.request("/api/rigs/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    db.close();
  });

  it("round-trip: export then import produces equivalent rig", async () => {
    const db1 = createFullTestDb();
    const setup = createTestApp(db1);
    const rig = setup.rigRepo.createRig("r99");
    setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", role: "worker" });

    // Export
    const exportRes = await setup.app.request(`/api/rigs/${rig.id}/spec`);
    const yaml = await exportRes.text();

    // Import into fresh app
    const db2 = createFullTestDb();
    const setup2 = createTestApp(db2);
    const importRes = await setup2.app.request("/api/rigs/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    });
    expect(importRes.status).toBe(201);
    const body = await importRes.json();
    expect(body.specName).toBe("r99");
    expect(body.nodes).toHaveLength(1);

    db1.close();
    db2.close();
  });
});

function extractDeps(setup: ReturnType<typeof createTestApp>) {
  return {
    rigRepo: setup.rigRepo,
    sessionRegistry: setup.sessionRegistry,
    eventBus: setup.eventBus,
    nodeLauncher: setup.nodeLauncher,
    tmuxAdapter: (setup as any).tmuxAdapter ?? setup.app,
    cmuxAdapter: (setup as any).cmuxAdapter ?? setup.app,
    snapshotCapture: setup.snapshotCapture,
    snapshotRepo: setup.snapshotRepo,
    restoreOrchestrator: setup.restoreOrchestrator,
    rigSpecExporter: setup.rigSpecExporter,
    rigSpecPreflight: setup.rigSpecPreflight,
    rigInstantiator: setup.rigInstantiator,
  };
}
