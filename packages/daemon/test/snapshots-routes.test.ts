import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { createDaemon } from "../src/startup.js";
import type { ExecFn } from "../src/adapters/tmux.js";

describe("Snapshot routes", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let snapshotCapture: SnapshotCapture;
  let snapshotRepo: SnapshotRepository;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    snapshotCapture = setup.snapshotCapture;
    snapshotRepo = setup.snapshotRepo;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/rigs/:rigId/snapshots -> 201 + snapshot with id and kind", async () => {
    const rig = rigRepo.createRig("r99");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.kind).toBe("manual");
    expect(body.rigId).toBe(rig.id);
  });

  it("GET /api/rigs/:rigId/snapshots -> list of snapshots", async () => {
    const rig = rigRepo.createRig("r99");
    snapshotCapture.captureSnapshot(rig.id, "manual");
    snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it("GET /api/rigs/:rigId/snapshots/:id -> snapshot with parsed data", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots/${snap.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(snap.id);
    expect(body.data.rig.name).toBe("r99");
    expect(body.data.nodes).toHaveLength(1);
  });

  it("POST /api/rigs/nonexistent/snapshots -> 404", async () => {
    const res = await app.request("/api/rigs/nonexistent-rig/snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST with non-rig error containing 'not found' -> 500 (not false-positive 404)", async () => {
    const rig = rigRepo.createRig("r99");

    // Sabotage with error message containing 'not found' — must NOT match as 404
    db.exec("CREATE TRIGGER block_snap_notfound BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'index not found in cache'); END;");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual" }),
    });
    expect(res.status).toBe(500);

    db.exec("DROP TRIGGER block_snap_notfound");
  });

  it("POST snapshot with sabotaged DB -> 500 (not 404)", async () => {
    const rig = rigRepo.createRig("r99");

    // Sabotage snapshots table so creation fails with non-not-found error
    db.exec("CREATE TRIGGER block_snap_create BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'db error'); END;");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual" }),
    });
    expect(res.status).toBe(500);

    db.exec("DROP TRIGGER block_snap_create");
  });

  it("GET nonexistent snapshot -> 404", async () => {
    const rig = rigRepo.createRig("r99");
    const res = await app.request(`/api/rigs/${rig.id}/snapshots/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("GET cross-rig snapshot -> 404", async () => {
    const rigA = rigRepo.createRig("r99");
    const rigB = rigRepo.createRig("r98");
    const snap = snapshotCapture.captureSnapshot(rigA.id, "manual");

    // Snapshot belongs to rigA, request under rigB
    const res = await app.request(`/api/rigs/${rigB.id}/snapshots/${snap.id}`);
    expect(res.status).toBe(404);
  });
});

describe("Restore routes", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotCapture = setup.snapshotCapture;
  });

  afterEach(() => {
    db.close();
  });

  // L3: route returns 202 + attemptId immediately after restore.started emit.
  // Per-node restore work runs in the background; clients query event log /
  // node inventory for follow-up state.
  it("POST /api/rigs/:rigId/restore/:snapshotId -> 202 + attemptId (L3)", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("started");
    expect(body.rigId).toBe(rig.id);
    expect(typeof body.attemptId).toBe("number");
    expect(body.attemptId).toBeGreaterThan(0);

    // attemptId must match a queryable restore.started event seq.
    const startedEvent = db
      .prepare("SELECT seq FROM events WHERE rig_id = ? AND type = 'restore.started' ORDER BY seq DESC LIMIT 1")
      .get(rig.id) as { seq: number } | undefined;
    expect(startedEvent?.seq).toBe(body.attemptId);
  });

  it("POST restore returns 409 not_attempted when pre-restore validation blocks", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    const data = JSON.parse(JSON.stringify(snap.data));
    const node = data.nodes[0];
    const missingPath = `/tmp/openrig-slice7-snapshot-missing-${Date.now()}.md`;
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

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("pre_restore_validation_failed");
    expect(body.rigResult).toBe("not_attempted");
    expect(body.preRestoreSnapshotId).toBeNull();
    expect(body.nodes).toEqual([]);
    expect(body.blockers[0]).toMatchObject({
      code: "required_startup_file_missing",
      severity: "critical",
      logicalId: "worker",
      path: missingPath,
    });
    expect(body.remediation[0]).toContain("Restore the missing startup file");
  });

  it("POST nonexistent snapshot -> 404", async () => {
    const rig = rigRepo.createRig("r99");
    const res = await app.request(`/api/rigs/${rig.id}/restore/nonexistent`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST cross-rig restore -> 404, no restore performed", async () => {
    const rigA = rigRepo.createRig("r99");
    const rigB = rigRepo.createRig("r98");
    rigRepo.addNode(rigA.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rigA.id, "manual");

    const res = await app.request(`/api/rigs/${rigB.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST rig not found in snapshot -> 404", async () => {
    const rig = rigRepo.createRig("r99");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    // Delete the rig so restore finds snapshot but rig is gone
    rigRepo.deleteRig(rig.id);

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST restore_error -> 500", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    // Sabotage snapshots table with a trigger that blocks new inserts
    // (pre-restore snapshot capture will fail, triggering restore_error)
    // Existing rows survive so the original snapshot can still be found.
    db.exec(`
      CREATE TRIGGER block_snapshot_insert BEFORE INSERT ON snapshots
      BEGIN
        SELECT RAISE(ABORT, 'sabotaged: no new snapshots');
      END;
    `);

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(500);
  });

  it("POST running rig restore with live tmux sessions -> 409", async () => {
    // Use a custom app with hasSession=true to simulate genuinely live tmux
    const db2 = createFullTestDb();
    const tmux = mockTmuxAdapter();
    (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const setup = createTestApp(db2, { tmux });

    const rig = setup.rigRepo.createRig("r99");
    const node = setup.rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = setup.sessionRegistry.registerSession(node.id, "r99-worker");
    setup.sessionRegistry.updateStatus(session.id, "running");
    const snap = setup.snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await setup.app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("rig_not_stopped");
    db2.close();
  });

  // L3: per-node detail is no longer in the immediate route response. Verify
  // the route returns the new shape; per-node statuses are exercised by
  // restore-orchestrator tests directly.
  it("restore response is asynchronous: 202 + attemptId, no per-node body", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker-a", { role: "worker" });
    rigRepo.addNode(rig.id, "worker-b", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("started");
    expect(typeof body.attemptId).toBe("number");
    // The immediate response intentionally does NOT include nodes/rigResult;
    // per-node work runs in the background.
    expect(body.nodes).toBeUndefined();
    expect(body.rigResult).toBeUndefined();
  });
});

describe("Restore concurrency", () => {
  it("restore while in progress -> 409 Conflict", async () => {
    const db2 = createFullTestDb();
    // Use a custom tmux mock that delays createSession
    const { vi: vitest } = await import("vitest");
    const setup = createTestApp(db2);
    const rig = setup.rigRepo.createRig("r99");
    setup.rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = setup.snapshotCapture.captureSnapshot(rig.id, "manual");

    // Both requests hit concurrently — one should get 409
    const [res1, res2] = await Promise.all([
      setup.app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" }),
      setup.app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toContain(409);

    db2.close();
  });
});

describe("Restore response contract", () => {
  // L3: per-node statuses are no longer in the immediate route response (route
  // returns 202 + attemptId). Per-node behavior is verified in restore-orchestrator
  // tests directly. This test now confirms the async contract holds even when a
  // checkpoint exists for the node (which previously yielded `rebuilt`).
  it("restore returns 202 + attemptId even when nodes have checkpoints (L3 async contract)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const db2 = createFullTestDb();
    const setup = createTestApp(db2);

    const rig = setup.rigRepo.createRig("r99");
    setup.rigRepo.addNode(rig.id, "worker", { role: "worker", cwd: tmpDir });
    setup.checkpointStore.createCheckpoint(
      setup.rigRepo.getRig(rig.id)!.nodes[0]!.id,
      { summary: "test checkpoint", keyArtifacts: [] }
    );
    const snap = setup.snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await setup.app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.attemptId).toBe("number");

    db2.close();
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("Startup mount regression", () => {
  it("createDaemon app: POST snapshot returns 201", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { app, db, deps } = await createDaemon({ tmuxExec, cmuxExec });
    const rig = deps.rigRepo.createRig("r99");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual" }),
    });
    expect(res.status).toBe(201);
    db.close();
  });

  it("createDaemon app: GET snapshots returns 200", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { app, db, deps } = await createDaemon({ tmuxExec, cmuxExec });
    const rig = deps.rigRepo.createRig("r99");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`);
    expect(res.status).toBe(200);
    db.close();
  });

  it("createDaemon app: POST restore route returns valid response", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { app, db, deps } = await createDaemon({ tmuxExec, cmuxExec });
    const rig = deps.rigRepo.createRig("r99");

    // Nonexistent snapshot -> 404 proves the route is mounted and handling requests
    const res = await app.request(`/api/rigs/${rig.id}/restore/nonexistent`, { method: "POST" });
    expect(res.status).toBe(404);
    db.close();
  });
});
