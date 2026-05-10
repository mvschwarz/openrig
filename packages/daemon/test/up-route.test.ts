import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const VALID_SPEC = `
schema_version: 1
name: r99
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

function insertStartupContextRow(db: Database.Database, nodeId: string) {
  db.prepare(
    "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run(nodeId, "[]", "[]", "[]", "claude-code");
}

describe("Up API route", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-"));
    // Create test app with real UpCommandRouter fsOps pointing to tmpDir
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotCapture = setup.snapshotCapture;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // T5: Missing sourceRef -> 400
  it("POST /api/up with missing sourceRef returns 400", async () => {
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // T2: Unknown source -> 400
  it("POST /api/up with nonexistent source returns 400", async () => {
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "/nonexistent/file.yaml" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // T6: Startup wiring
  it("createDaemon wires /api/up route", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { app: daemonApp, db: daemonDb } = await createDaemon({ dbPath: ":memory:" });
    try {
      const res = await daemonApp.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400); // Proves route is mounted
    } finally {
      daemonDb.close();
    }
  });

  it("POST /api/up restoring an existing rig name includes rigResult", async () => {
    const rig = rigRepo.createRig("restore-me");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");

    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "restore-me" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("restored");
    expect(body.rigResult).toBe("partially_restored");
    expect(body.nodes[0].status).toBe("fresh");
  });

  it("POST /api/up restoring an existing rig name returns validation blockers", async () => {
    const rig = rigRepo.createRig("restore-blocked");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    const data = JSON.parse(JSON.stringify(snap.data));
    const node = data.nodes[0];
    const missingPath = `/tmp/openrig-slice7-up-missing-${Date.now()}.md`;
    data.nodeStartupContext[node.id] = {
      projectionEntries: [],
      resolvedStartupFiles: [{
        path: "startup.md",
        absolutePath: missingPath,
        ownerRoot: "/tmp",
        deliveryHint: "guidance_merge",
        required: true,
        appliesOn: ["restore"],
      }],
      startupActions: [],
      runtime: "claude-code",
    };
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);

    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "restore-blocked" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("not_attempted");
    expect(body.code).toBe("pre_restore_validation_failed");
    expect(body.rigResult).toBe("not_attempted");
    expect(body.blockers[0].path).toBe(missingPath);
  });

  // L3b: rig-name path falls back to manual snapshot when no auto-pre-down exists.
  // Both routes preserve auto-pre-down preference and echo `snapshotKind`.
  describe("L3b snapshot-selection fallback", () => {
    it("auto-pre-down preferred when present; response echoes snapshotKind=auto-pre-down", async () => {
      const rig = rigRepo.createRig("auto-pref");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      // Capture manual first, then auto-pre-down. Auto-pre-down must win.
      snapshotCapture.captureSnapshot(rig.id, "manual");
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "auto-pref" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(body.snapshotKind).toBe("auto-pre-down");
    });

    it("falls back to manual snapshot when no auto-pre-down exists; response echoes snapshotKind=manual", async () => {
      const rig = rigRepo.createRig("manual-only");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(rig.id, "manual");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "manual-only" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(body.snapshotKind).toBe("manual");
    });

    it("returns 404 with updated 'no restore-usable snapshot' message when no usable snapshot exists", async () => {
      rigRepo.createRig("no-snap");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "no-snap" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("no_snapshot");
      expect(body.error).toContain("restore-usable");
      // Old message specifically said "auto-pre-down" — must NOT anymore.
      expect(body.error).not.toContain("auto-pre-down snapshot");
    });

    it("captures auto-rehydrate snapshot from durable current state when no usable snapshot exists", async () => {
      const rig = rigRepo.createRig("current-state-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@current-state-rig");
      sessionRegistry.updateStatus(session.id, "stopped");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      insertStartupContextRow(db, node.id);

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "current-state-rig" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(body.snapshotKind).toBe("auto-rehydrate");
      expect(body.warnings).toContain("No restore-usable snapshot existed; captured current DB state as auto-rehydrate snapshot for reboot recovery.");
    });
  });

  // Agent Starter v1 vertical M2 R2 — POST /api/up end-to-end proof for starter_ref.
  //
  // These tests exercise the full apply path through the route. The positive
  // case proves STARTER artifacts reach the startup-orchestrator (verified
  // via `node_startup_context.resolved_files_json` SQLite roundtrip — the
  // same persistence boundary asserted in agent-starter-instantiator.test.ts,
  // but here driven through the HTTP layer). The failed-scan negative
  // proves credential-bearing registry entries refuse the launch with a
  // clear failure and no completed startup_context (load-bearing
  // credential-safety contract). Schema-composition negatives
  // (fork+starter_ref, terminal+starter_ref) remain plan-mode tests since
  // they reject upfront.
  describe("M2 R2: POST /api/up with starter_ref (end-to-end)", () => {
    let specDir: string;
    let registryDir: string;
    let app2: ReturnType<typeof createTestApp>["app"];
    let setup2: ReturnType<typeof createTestApp>;
    let db2: Database.Database;

    beforeEach(() => {
      specDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-starter-"));
      registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-registry-"));

      // Real agent.yaml fixture so apply-mode agent_ref resolution succeeds.
      const agentDir = path.join(specDir, "agents", "impl");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "agent.yaml"),
        `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`,
      );

      db2 = createFullTestDb();
      const realRouterFsOps = {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        readHead: (p: string, n: number) => {
          const buf = Buffer.alloc(n);
          const fd = fs.openSync(p, "r");
          try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
          return buf;
        },
      };
      const realInstantiatorFsOps = {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      };
      setup2 = createTestApp(db2, {
        upRouterFsOps: realRouterFsOps,
        podInstantiatorFsOps: realInstantiatorFsOps,
      });
      app2 = setup2.app;
      process.env.OPENRIG_AGENT_STARTER_ROOT = registryDir;
    });

    afterEach(() => {
      delete process.env.OPENRIG_AGENT_STARTER_ROOT;
      db2.close();
      fs.rmSync(specDir, { recursive: true, force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    });

    function writeSpec(name: string, body: string): string {
      const p = path.join(specDir, name);
      fs.writeFileSync(p, body, "utf-8");
      return p;
    }

    function writeRegistryEntry(name: string, body: string): void {
      fs.writeFileSync(path.join(registryDir, `${name}.yaml`), body, "utf-8");
    }

    const CLEAN_REGISTRY_BODY = `draft: false
starter_id: route-fixture
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fx"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`;

    const CRED_REGISTRY_BODY = `draft: false
starter_id: route-fixture-mal
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fx"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
api_key: example-not-real
`;

    it("end-to-end positive: apply-mode POST /api/up resolves starter and STARTER reaches orchestrator (DB roundtrip)", async () => {
      writeRegistryEntry("route-fixture", CLEAN_REGISTRY_BODY);
      const yaml = `version: "0.2"
name: starter-route-positive
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        starter_ref:
          name: route-fixture
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-route-positive.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath }),
      });
      const body = await res.json();
      // Apply mode: 201 completed (or 200 partial if another stage flakes,
      // but the import_rig stage MUST be ok and a rigId MUST be returned).
      expect(body.rigId, JSON.stringify(body)).toBeDefined();

      // Look up the impl node and read its node_startup_context row to
      // verify the STARTER layer survived the persistence boundary
      // (startup-orchestrator.ts:293-301 SQLite write).
      const rig = setup2.rigRepo.getRig(body.rigId);
      expect(rig).not.toBeNull();
      const dbNode = rig!.nodes.find((n) => n.logicalId === "dev.impl");
      expect(dbNode).toBeDefined();

      const row = db2
        .prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?")
        .get(dbNode!.id) as { resolved_files_json: string } | undefined;
      expect(row, "expected node_startup_context row to exist after route apply").toBeDefined();
      const persisted = JSON.parse(row!.resolved_files_json) as Array<{
        path: string;
        ownerRoot: string;
        appliesOn: string[];
        deliveryHint: string;
      }>;
      expect(persisted.length).toBeGreaterThan(0);
      // STARTER layer at index 0 — registry-rooted, fresh_start, guidance_merge.
      expect(persisted[0]!.ownerRoot).toBe(registryDir);
      expect(persisted[0]!.path).toBe("route-fixture.yaml");
      expect(persisted[0]!.appliesOn).toEqual(["fresh_start"]);
      expect(persisted[0]!.deliveryHint).toBe("guidance_merge");
    });

    it("end-to-end negative: credential-bearing registry entry → launch fails with clear error and NO startup_context row", async () => {
      writeRegistryEntry("route-fixture-mal", CRED_REGISTRY_BODY);
      const yaml = `version: "0.2"
name: starter-route-failed-scan
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        starter_ref:
          name: route-fixture-mal
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-route-failed-scan.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath }),
      });
      const body = await res.json();
      // Credential-scan failure surfaces as a node-level launch failure.
      // The instantiator returns a NodeOutcome with status="failed" and
      // error mentioning "Agent Starter resolver failed" — this propagates
      // up as a partial/failed bootstrap. The route returns non-2xx.
      expect(res.status).not.toBe(201);
      const errStr = JSON.stringify(body);
      expect(errStr).toMatch(/Agent Starter resolver failed|credential/i);

      // The rigId may or may not have been created depending on
      // partial-failure policy; the load-bearing assertion is that NO
      // node_startup_context row was persisted (the launch aborted
      // before startup-orchestrator.startNode wrote the SQLite row).
      const startupRows = db2
        .prepare("SELECT COUNT(*) as cnt FROM node_startup_context")
        .get() as { cnt: number };
      expect(startupRows.cnt).toBe(0);
    });

    it("rejects fork + starter_ref composition with 400 (terminal-equivalent route surface)", async () => {
      const yaml = `version: "0.2"
name: starter-fork-reject
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        starter_ref:
          name: openrig-builder-base--claude-code
        session_source:
          mode: fork
          ref:
            kind: native_id
            value: some-id
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-fork-reject.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath, plan: true }),
      });
      // Pod-aware composition rule (validateStarterRef in rigspec-schema)
      // rejects fork+starter_ref, so the upRouter does NOT classify the
      // YAML as a valid pod-aware rig_spec. The route returns 400.
      // (Pre-existing UX caveat: the error message bubbles from the
      // legacy fallthrough, not from the pod-aware validator — but the
      // contract behavior of REJECTING the spec is what M2 requires.)
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("not a valid rig spec");
    });

    it("rejects terminal + starter_ref composition with 400", async () => {
      const yaml = `version: "0.2"
name: starter-terminal-reject
pods:
  - id: dev
    label: Development
    members:
      - id: t1
        agent_ref: local:agents/t1
        profile: default
        runtime: terminal
        cwd: .
        starter_ref:
          name: openrig-builder-base--claude-code
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-terminal-reject.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath, plan: true }),
      });
      // Pod-aware composition rule rejects terminal+starter_ref. Route
      // returns 400 (same caveat as the fork case above re: error
      // message provenance — the contract behavior of rejection is what
      // M2 requires).
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("not a valid rig spec");
    });
  });
});
