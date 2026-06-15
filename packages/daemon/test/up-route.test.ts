import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { buildAttentionResponse } from "../src/routes/up.js";

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
  let restoreOrchestrator: RestoreOrchestrator;

  beforeEach(() => {
    db = createFullTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-"));
    // Create test app with real UpCommandRouter fsOps pointing to tmpDir
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotCapture = setup.snapshotCapture;
    restoreOrchestrator = setup.restoreOrchestrator;
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
    expect(body.nodes[0].status).toBe("fresh-primed");
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

  // OPR.0.3.4.9 — Option Y: auto-periodic co-equal with auto-pre-down in restore selection.
  describe("OPR.0.3.4.9 Option Y restore selection via /api/up", () => {
    it("stale auto-pre-down + newer auto-periodic -> restores from auto-periodic", async () => {
      const rig = rigRepo.createRig("option-y-rig");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      // Wait a tick so created_at differs
      await new Promise((r) => setTimeout(r, 10));
      snapshotCapture.captureSnapshot(rig.id, "auto-periodic");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "option-y-rig" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(body.snapshotKind).toBe("auto-periodic");
    });

    it("fresher auto-pre-down + older auto-periodic -> restores from auto-pre-down", async () => {
      const rig = rigRepo.createRig("option-y-rig2");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(rig.id, "auto-periodic");
      await new Promise((r) => setTimeout(r, 10));
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "option-y-rig2" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshotKind).toBe("auto-pre-down");
    });
  });

  // OPR.0.3.4.4 — `--plan` must be READ-ONLY on the rig_name restore path.
  // The rig_name branch early-returned BEFORE the bootstrap plan gate, so
  // `rig up --existing <rig> --plan` mutated (recreated sessions, flipped
  // detached->running). These tests pin the daemon-level gate.
  describe("OPR.0.3.4.4 --plan read-only restore gate (rig_name path)", () => {
    function snapshotOf(db_: Database.Database, table: string): unknown[] {
      return db_.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    }

    it("plan:true returns a read-only preview: restore() NOT called, zero session/snapshot mutation", async () => {
      const rig = rigRepo.createRig("plan-ro-rig");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const sess = sessionRegistry.registerSession(node.id, "worker@plan-ro-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
        .run("claude_name", "tok-1", "detached", sess.id);
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");
      const sessionsBefore = snapshotOf(db, "sessions");
      const snapshotsBefore = snapshotOf(db, "snapshots");
      const bindingsBefore = snapshotOf(db, "bindings");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-ro-rig", plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("plan");
      expect(body.mode).toBe("restore");
      expect(body.mutated).toBe(false);
      // Useful preview: per-seat intended action, derived from resume state.
      expect(body.nodes).toHaveLength(1);
      expect(body.nodes[0].logicalId).toBe("worker");
      expect(body.nodes[0].intendedAction).toBe("resume-original");
      expect(body.snapshot).not.toBeNull();
      expect(body.wouldCaptureCurrentState).toBe(false);
      // THE gate: no restore mutation of any kind.
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(snapshotOf(db, "sessions")).toEqual(sessionsBefore);
      expect(snapshotOf(db, "snapshots")).toEqual(snapshotsBefore);
      expect(snapshotOf(db, "bindings")).toEqual(bindingsBefore);
    });

    it("plan:true previews awaiting-decision for a recorded-source/no-token seat (forecasts the slice-02 stop)", async () => {
      const rig = rigRepo.createRig("plan-ad-rig");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const sess = sessionRegistry.registerSession(node.id, "worker@plan-ad-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = NULL, status = ? WHERE id = ?")
        .run("claude_name", "detached", sess.id);
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-ad-rig", plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nodes[0].intendedAction).toBe("awaiting-decision");
      expect(body.nodes[0].reason).toContain("no token");
    });

    it("plan:true + freshLogicalIds previews fresh-primed for the listed RESUMABLE seat (operation-B honesty), zero mutation", async () => {
      // Guard BLOCKING a23009d8: a token-resumable seat listed in --fresh
      // must preview what apply would DO (deliberate fresh-prime), not what
      // the token alone suggests (resume-original).
      const rig = rigRepo.createRig("plan-fresh-rig");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const sess = sessionRegistry.registerSession(node.id, "worker@plan-fresh-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
        .run("claude_name", "tok-1", "detached", sess.id);
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");
      const sessionsBefore = snapshotOf(db, "sessions");
      const snapshotsBefore = snapshotOf(db, "snapshots");
      const bindingsBefore = snapshotOf(db, "bindings");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-fresh-rig", plan: true, freshLogicalIds: ["worker"] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("plan");
      expect(body.nodes[0].logicalId).toBe("worker");
      expect(body.nodes[0].intendedAction).toBe("fresh-primed");
      expect(body.nodes[0].reason).toContain("--fresh");
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(snapshotOf(db, "sessions")).toEqual(sessionsBefore);
      expect(snapshotOf(db, "snapshots")).toEqual(snapshotsBefore);
      expect(snapshotOf(db, "bindings")).toEqual(bindingsBefore);
    });

    it("plan:true + freshLogicalIds leaves UNLISTED seats forecast from their resume state", async () => {
      const rig = rigRepo.createRig("plan-fresh-mixed");
      const nodeA = rigRepo.addNode(rig.id, "worker-a", { role: "worker", runtime: "claude-code" });
      const nodeB = rigRepo.addNode(rig.id, "worker-b", { role: "worker", runtime: "claude-code" });
      for (const [node, name] of [[nodeA, "worker-a"], [nodeB, "worker-b"]] as const) {
        const sess = sessionRegistry.registerSession(node.id, `${name}@plan-fresh-mixed`);
        db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
          .run("claude_name", "tok-1", "detached", sess.id);
      }
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-fresh-mixed", plan: true, freshLogicalIds: ["worker-b"] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const byId = Object.fromEntries((body.nodes as Array<{ logicalId: string; intendedAction: string }>).map((n) => [n.logicalId, n.intendedAction]));
      expect(byId["worker-a"]).toBe("resume-original");
      expect(byId["worker-b"]).toBe("fresh-primed");
    });

    it("plan:true with no usable snapshot reports wouldCaptureCurrentState WITHOUT capturing", async () => {
      const rig = rigRepo.createRig("plan-rehydrate-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@plan-rehydrate-rig");
      sessionRegistry.updateStatus(session.id, "stopped");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      insertStartupContextRow(db, node.id);
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-rehydrate-rig", plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("plan");
      expect(body.snapshot).toBeNull();
      expect(body.wouldCaptureCurrentState).toBe(true);
      // The auto-rehydrate capture is a mutation; plan must NOT perform it.
      const rows = db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE rig_id = ?").get(rig.id) as { c: number };
      expect(rows.c).toBe(0);
      expect(restoreSpy).not.toHaveBeenCalled();
    });

    it("plan:true with no usable snapshot and ineligible state still 404s (same as apply)", async () => {
      rigRepo.createRig("plan-no-snap");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-no-snap", plan: true }),
      });

      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("no_snapshot");
    });

    it("APPLY regression: plan absent still restores (restore() called once)", async () => {
      const rig = rigRepo.createRig("plan-apply-rig");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-apply-rig" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(restoreSpy).toHaveBeenCalledTimes(1);
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

  // --- Conveyor-Trust Minimal Fix (OPR.0.3.2.CT) — guard verdict
  //     qitem-20260518082933 BLOCKER 2: HG-4 route response shape must
  //     be pinned by tests. buildAttentionResponse is the pure
  //     helper that constructs the 3-part error from a bootstrap
  //     result with a blocked/attention_required import_rig stage; the
  //     route returns 409 with that body. These tests pin the shape
  //     without needing the full daemon harness.

  describe("OPR.0.3.2.CT BLOCKER-2: HG-4 3-part error shape", () => {
    it("returns null when no import_rig stage is blocked/attention_required (normal partial path)", () => {
      const result = {
        rigId: "rig-1",
        stages: [
          { stage: "resolve_spec", status: "ok" },
          { stage: "import_rig", status: "ok", detail: { rigId: "rig-1", nodes: [] } },
        ],
      };
      expect(buildAttentionResponse(result)).toBeNull();
    });

    it("returns null on a 'failed' import_rig stage (no attention_required code)", () => {
      const result = {
        rigId: "rig-1",
        stages: [
          { stage: "import_rig", status: "failed", detail: { code: "instantiate_error" } },
        ],
      };
      expect(buildAttentionResponse(result)).toBeNull();
    });

    it("HG-4: blocked + attention_required stage → fact/consequence/action with attentionNodes", () => {
      const result = {
        rigId: "rig-conveyor-1",
        stages: [
          {
            stage: "import_rig",
            status: "blocked",
            detail: {
              code: "attention_required",
              message: "1 node requires attention before becoming interactive (rig parked, NOT failed; approve and resume to proceed).",
              attentionNodes: [
                { logicalId: "dev.impl", sessionName: "dev-impl@conveyor", evidence: "trust prompt", reason: "trust_gate" },
              ],
            },
          },
        ],
      };
      const r = buildAttentionResponse(result);
      expect(r).not.toBeNull();
      expect(r!.error.fact).toMatch(/requires attention/i);
      expect(r!.error.consequence).toMatch(/rig-conveyor-1/);
      expect(r!.error.consequence).toMatch(/rig ps/);
      expect(r!.error.consequence).toMatch(/attention_required/);
      expect(r!.error.action).toMatch(/tmux attach -t dev-impl@conveyor/);
      expect(r!.error.action).not.toMatch(/rig setup --cwd/);
      // Singular phrasing for a 1-node case
      expect(r!.error.action).toMatch(/^Attach to the session/);
      expect(r!.attentionNodes).toHaveLength(1);
      expect(r!.attentionNodes[0]!.logicalId).toBe("dev.impl");
    });

    it("HG-4: multi-node action message uses plural phrasing + lists multiple tmux attach hints", () => {
      const result = {
        rigId: "rig-conveyor-2",
        stages: [
          {
            stage: "import_rig",
            status: "blocked",
            detail: {
              code: "attention_required",
              message: "3 nodes require attention before becoming interactive.",
              attentionNodes: [
                { logicalId: "dev.impl", sessionName: "dev-impl@conveyor", reason: "trust_gate" },
                { logicalId: "dev.qa", sessionName: "dev-qa@conveyor", reason: "trust_gate" },
                { logicalId: "dev.review", sessionName: "dev-review@conveyor", reason: "trust_gate" },
              ],
            },
          },
        ],
      };
      const r = buildAttentionResponse(result);
      expect(r).not.toBeNull();
      // Plural phrasing
      expect(r!.error.action).toMatch(/^Attach to each parked session/);
      // First 3 hints listed
      expect(r!.error.action).toContain("tmux attach -t dev-impl@conveyor");
      expect(r!.error.action).toContain("tmux attach -t dev-qa@conveyor");
      expect(r!.error.action).toContain("tmux attach -t dev-review@conveyor");
      expect(r!.attentionNodes).toHaveLength(3);
    });

    it("HG-4: multi-node action message points to attentionNodes when attach hints are abbreviated", () => {
      const result = {
        rigId: "rig-conveyor-4",
        stages: [
          {
            stage: "import_rig",
            status: "blocked",
            detail: {
              code: "attention_required",
              message: "4 nodes require attention before becoming interactive.",
              attentionNodes: [
                { logicalId: "intake.lead", sessionName: "intake-lead@conveyor", reason: "trust_gate" },
                { logicalId: "plan.planner", sessionName: "plan-planner@conveyor", reason: "trust_gate" },
                { logicalId: "build.builder", sessionName: "build-builder@conveyor", reason: "trust_gate" },
                { logicalId: "review.reviewer", sessionName: "review-reviewer@conveyor", reason: "trust_gate" },
              ],
            },
          },
        ],
      };
      const r = buildAttentionResponse(result);
      expect(r).not.toBeNull();
      expect(r!.error.action).toMatch(/^Attach to each parked session listed in attentionNodes/);
      expect(r!.error.action).toContain("tmux attach -t intake-lead@conveyor");
      expect(r!.error.action).toContain("tmux attach -t plan-planner@conveyor");
      expect(r!.error.action).toContain("tmux attach -t build-builder@conveyor");
      expect(r!.error.action).toContain("plus 1 more listed in attentionNodes");
      expect(r!.error.action).not.toContain("review-reviewer@conveyor");
      expect(r!.attentionNodes).toHaveLength(4);
    });

    it("HG-4: when no sessionName is present on any node, action falls back to 'see rig ps' (defense)", () => {
      const result = {
        rigId: "rig-conveyor-3",
        stages: [
          {
            stage: "import_rig",
            status: "blocked",
            detail: {
              code: "attention_required",
              message: "1 node requires attention.",
              attentionNodes: [
                { logicalId: "dev.impl", sessionName: "", reason: "trust_gate" },
              ],
            },
          },
        ],
      };
      const r = buildAttentionResponse(result);
      expect(r!.error.action).toContain("see `rig ps`");
    });

    it("HG-4: result without rigId still produces a valid response (defense)", () => {
      const result = {
        stages: [
          {
            stage: "import_rig",
            status: "blocked",
            detail: {
              code: "attention_required",
              message: "1 node requires attention.",
              attentionNodes: [
                { logicalId: "dev.impl", sessionName: "dev-impl@x", reason: "trust_gate" },
              ],
            },
          },
        ],
      };
      const r = buildAttentionResponse(result);
      expect(r).not.toBeNull();
      expect(r!.error.consequence).toContain("(rigId unavailable)");
    });
  });

  // OPR.0.3.2.CT — route-level POST /api/up discriminator
  //
  // Guard re-verify (qitem-20260518083805) BLOCKER: the prior
  // forward-fix added pure helper tests on buildAttentionResponse,
  // but those would still pass even if the route stopped calling
  // the helper or dropped 409. This test exercises the real route
  // by stubbing bootstrapOrchestrator.bootstrap with a
  // partial+blocked+attention result; it fails red if up.ts returns
  // 200 (normal partial path) or 201 (completed path) instead of
  // 409 with a 3-part body.
  describe("OPR.0.3.2.CT BLOCKER-2 (route-level): POST /api/up surfaces 409 with 3-part body on attention_required partial", () => {
    it("attention_required partial → 409 with error.fact / error.consequence / error.action / attentionNodes", async () => {
      // Build a fresh app instance so we can monkey-patch the
      // orchestrator without leaking state into other tests.
      db.close();
      const freshDb = createFullTestDb();
      // Use real-fs upRouter so the spec file we write is resolvable.
      const setup = createTestApp(freshDb, {
        upRouterFsOps: {
          exists: (p: string) => fs.existsSync(p),
          readFile: (p: string) => fs.readFileSync(p, "utf-8"),
          readHead: (p: string, n: number) => {
            const fd = fs.openSync(p, "r");
            try {
              const buf = Buffer.alloc(n);
              const bytes = fs.readSync(fd, buf, 0, n, 0);
              return buf.subarray(0, bytes);
            } finally {
              fs.closeSync(fd);
            }
          },
        },
      });
      const freshApp = setup.app;
      const bootstrapOrch = setup.bootstrapOrchestrator;

      // Write a valid pod spec file so the route's pre-bootstrap
      // resolution path succeeds and reaches the bootstrap() call.
      const podSpecYaml = `
version: "0.2"
name: conveyor-attention-route-test
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
      const specPath = path.join(tmpDir, "attention-route-spec.yaml");
      fs.writeFileSync(specPath, podSpecYaml);

      // Stub the orchestrator's bootstrap to emit the
      // partial+blocked+attention shape we expect from a real
      // trust-gated launch. The route MUST translate this to 409.
      const stubResult = {
        runId: "run-stub-1",
        status: "partial" as const,
        rigId: "rig-stub-1",
        stages: [
          { stage: "resolve_spec" as const, status: "ok" as const, detail: {} },
          {
            stage: "import_rig" as const,
            status: "blocked" as const,
            detail: {
              code: "attention_required",
              message: "1 node requires attention before becoming interactive (rig parked, NOT failed; approve and resume to proceed).",
              rigId: "rig-stub-1",
              specName: "conveyor-attention-route-test",
              nodes: [{ logicalId: "dev.impl", status: "attention_required" as const, sessionName: "dev-impl@conveyor-attention-route-test", evidence: "trust prompt" }],
              attentionNodes: [
                { logicalId: "dev.impl", sessionName: "dev-impl@conveyor-attention-route-test", evidence: "trust prompt", reason: "trust_gate" },
              ],
            },
          },
        ],
        errors: ["1 node requires attention before becoming interactive (rig parked, NOT failed; approve and resume to proceed)."],
        warnings: [],
      };
      const origBootstrap = bootstrapOrch.bootstrap.bind(bootstrapOrch);
      bootstrapOrch.bootstrap = (async () => stubResult) as typeof bootstrapOrch.bootstrap;
      // Also stub release() so we don't try to release an unknown
      // sourceRef key in the orchestrator's internal map.
      const origRelease = bootstrapOrch.release.bind(bootstrapOrch);
      bootstrapOrch.release = (() => undefined) as typeof bootstrapOrch.release;

      try {
        const res = await freshApp.request("/api/up", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceRef: specPath }),
        });

        // BLOCKER-2 from re-verify: route MUST return 409 (not 200
        // partial-success, not 201 completed).
        expect(res.status).toBe(409);
        const body = await res.json();
        // HG-4 3-part error shape.
        expect(body.error).toBeDefined();
        expect(body.error.fact).toMatch(/require[s]? attention/i);
        expect(body.error.consequence).toMatch(/rig-stub-1/);
        expect(body.error.consequence).toMatch(/rig ps/);
        expect(body.error.action).toMatch(/tmux attach -t dev-impl@conveyor-attention-route-test/);
        expect(body.error.action).not.toMatch(/rig setup --cwd/);
        // attentionNodes array carried through to operator
        expect(body.attentionNodes).toBeInstanceOf(Array);
        expect(body.attentionNodes).toHaveLength(1);
        expect(body.attentionNodes[0].logicalId).toBe("dev.impl");
        // The bootstrap's partial result still carries the rigId
        // for `rig ps` lookups
        expect(body.rigId).toBe("rig-stub-1");
        // status remains "partial" so downstream tooling can branch
        expect(body.status).toBe("partial");
      } finally {
        bootstrapOrch.bootstrap = origBootstrap;
        bootstrapOrch.release = origRelease;
        freshDb.close();
      }
      // Restore db so afterEach's close() doesn't double-close —
      // but afterEach closes the original `db` which we already
      // closed above. Replace it with a no-op stub for the rest of
      // teardown.
      db = { close: () => undefined } as unknown as Database.Database;
    });
  });

  // --- OPR.0.3.2.22 Bug 1 BONUS — import_rig stage failures with known codes
  //     (cycle_error, preflight_failed, validation_failed, service_boot_failed)
  //     surface as HTTP 4xx with the code at the TOP LEVEL of the response
  //     body. CLI up.ts:208-227 already branches on res.data["code"] for
  //     these codes — the daemon just has to put the code where the CLI
  //     looks, instead of leaving operators staring at a bare 500 with the
  //     real cause buried in stages[N].detail.code.
  //
  //     The conveyor delegates_to cycle (f3449baf already on main) is the
  //     direct manifestation reported by the openrig-comms hero-flow
  //     dogfood. This regression also pins the more general contract.
  describe("OPR.0.3.2.22 Bug 1 BONUS: import_rig stage failures map to HTTP 4xx with top-level code", () => {
    let specDir: string;
    let app3: ReturnType<typeof createTestApp>["app"];
    let db3: Database.Database;

    beforeEach(() => {
      specDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-import-rig-fail-"));

      for (const name of ["builder", "reviewer"]) {
        const agentDir = path.join(specDir, "agents", name);
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentDir, "agent.yaml"),
          `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`,
        );
      }

      db3 = createFullTestDb();
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
      const setup3 = createTestApp(db3, {
        upRouterFsOps: realRouterFsOps,
        podInstantiatorFsOps: realInstantiatorFsOps,
      });
      app3 = setup3.app;
    });

    afterEach(() => {
      db3.close();
      fs.rmSync(specDir, { recursive: true, force: true });
    });

    it("apply-mode delegates_to cycle returns HTTP 400 with code=cycle_error at top level", async () => {
      const yaml = `version: "0.2"
name: cycle-bug-rig
pods:
  - id: build
    label: Build
    members:
      - id: builder
        agent_ref: local:agents/builder
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
  - id: review
    label: Review
    members:
      - id: reviewer
        agent_ref: local:agents/reviewer
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges:
  - from: build.builder
    to: review.reviewer
    kind: delegates_to
  - from: review.reviewer
    to: build.builder
    kind: delegates_to
`;
      const specPath = path.join(specDir, "cycle.yaml");
      fs.writeFileSync(specPath, yaml, "utf-8");

      const res = await app3.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath }),
      });

      const bodyForDebug = await res.clone().json();
      expect(res.status, `expected 400 for import_rig cycle_error, got ${res.status} with body ${JSON.stringify(bodyForDebug)}`).toBe(400);
      const body = await res.json() as { code?: string; stages?: Array<{ stage: string; status: string; detail?: { code?: string } }> };

      // The load-bearing fix: code surfaces at TOP LEVEL where CLI looks.
      expect(body.code, `expected top-level code=cycle_error, got body=${JSON.stringify(body)}`).toBe("cycle_error");

      // Provenance discriminator — proves the code came from import_rig stage
      // (not a resolve_spec misclassification that the existing 400-mapping
      // path was already handling).
      const importRigStage = (body.stages ?? []).find((s) => s.stage === "import_rig");
      expect(importRigStage, `expected import_rig stage in body.stages, got ${JSON.stringify(body.stages)}`).toBeDefined();
      expect(importRigStage!.status).toBe("failed");
      expect(importRigStage!.detail?.code).toBe("cycle_error");
    });
  });
});
