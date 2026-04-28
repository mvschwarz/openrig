import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import type { RigRepository } from "../src/domain/rig-repository.js";
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

describe("Up API route", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;
  let rigRepo: RigRepository;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-"));
    // Create test app with real UpCommandRouter fsOps pointing to tmpDir
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
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
  });
});
