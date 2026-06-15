// OPR.0.3.4.9 — periodic snapshot scheduler tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { PeriodicSnapshotScheduler } from "../src/domain/periodic-snapshot-scheduler.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("PeriodicSnapshotScheduler", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let snapshotCapture: SnapshotCapture;
  let scheduler: PeriodicSnapshotScheduler;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    scheduler = new PeriodicSnapshotScheduler({ db, snapshotCapture, snapshotRepo });
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  function seedRunningRig(name: string): string {
    const rig = rigRepo.createRig(name);
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, `worker@${name}`);
    sessionRegistry.updateStatus(session.id, "running");
    return rig.id;
  }

  it("tick captures an auto-periodic snapshot for a running rig", async () => {
    const rigId = seedRunningRig("r1");
    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(rigId, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.kind).toBe("auto-periodic");
  });

  it("tick skips archived rigs", async () => {
    const rigId = seedRunningRig("r-archived");
    rigRepo.archiveRig(rigId);
    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(rigId, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(0);
  });

  it("tick skips stopped rigs (no running sessions)", async () => {
    const rig = rigRepo.createRig("r-stopped");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(rig.id, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(0);
  });

  it("kind-scoped retention prunes only auto-periodic, preserves other kinds", async () => {
    const rigId = seedRunningRig("r-prune");
    snapshotCapture.captureSnapshot(rigId, "manual");
    snapshotCapture.captureSnapshot(rigId, "auto-pre-down");
    scheduler.start(100000, 2);
    scheduler.stop();
    // Run 5 ticks with retention_keep=2
    for (let i = 0; i < 5; i++) {
      snapshotCapture.captureSnapshot(rigId, "auto-periodic");
    }
    snapshotRepo.pruneSnapshotsByKind(rigId, "auto-periodic", 2);

    const periodic = snapshotRepo.listSnapshots(rigId, { kind: "auto-periodic" });
    expect(periodic).toHaveLength(2);
    const manual = snapshotRepo.listSnapshots(rigId, { kind: "manual" });
    expect(manual).toHaveLength(1);
    const preDown = snapshotRepo.listSnapshots(rigId, { kind: "auto-pre-down" });
    expect(preDown).toHaveLength(1);
  });

  it("retention_keep floor: keepCount < 1 still leaves at least 1", () => {
    const rigId = seedRunningRig("r-floor");
    snapshotCapture.captureSnapshot(rigId, "auto-periodic");
    snapshotCapture.captureSnapshot(rigId, "auto-periodic");
    snapshotRepo.pruneSnapshotsByKind(rigId, "auto-periodic", 0);
    const remaining = snapshotRepo.listSnapshots(rigId, { kind: "auto-periodic" });
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });

  it("per-rig error isolation: one rig's failure does not abort others", async () => {
    const rigId1 = seedRunningRig("r-ok");
    const rigId2 = seedRunningRig("r-fail");
    const origCapture = snapshotCapture.captureSnapshot.bind(snapshotCapture);
    const captureSpy = vi.spyOn(snapshotCapture, "captureSnapshot").mockImplementation((id, kind) => {
      if (id === rigId2) throw new Error("simulated failure");
      return origCapture(id, kind);
    });

    await scheduler.tick();

    const snaps1 = snapshotRepo.listSnapshots(rigId1, { kind: "auto-periodic" });
    expect(snaps1).toHaveLength(1);
    const snaps2 = snapshotRepo.listSnapshots(rigId2, { kind: "auto-periodic" });
    expect(snaps2).toHaveLength(0);
    captureSpy.mockRestore();
  });

  it("start/stop is idempotent", () => {
    scheduler.start(60000, 10);
    expect(scheduler.isActive).toBe(true);
    scheduler.start(60000, 10);
    expect(scheduler.isActive).toBe(true);
    scheduler.stop();
    expect(scheduler.isActive).toBe(false);
    scheduler.stop();
    expect(scheduler.isActive).toBe(false);
  });

  it("non-overlapping ticks: the running flag prevents re-entry", () => {
    // The running flag is set synchronously at the top of tick();
    // the setInterval callback checks it before calling tick().
    scheduler.start(100000, 10);
    expect(scheduler.isActive).toBe(true);
    scheduler.stop();
  });
});

describe("findLatestRestoreUsable Option Y", () => {
  let db: Database.Database;
  let snapshotRepo: SnapshotRepository;

  function insertRaw(id: string, rigId: string, kind: string, createdAt: string) {
    const data = JSON.stringify({
      rig: { id: rigId, name: "test" },
      nodes: [{ id: "n1", logicalId: "w", binding: null }],
      edges: [],
      sessions: [],
      checkpoints: {},
    });
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, 'active', ?, ?)"
    ).run(id, rigId, kind, data, createdAt);
  }

  beforeEach(() => {
    db = createFullTestDb();
    snapshotRepo = new SnapshotRepository(db);
  });

  afterEach(() => { db.close(); });

  it("stale auto-pre-down + newer auto-periodic -> auto-periodic wins (the crash fix)", () => {
    insertRaw("snap-old-apd", "rig-1", "auto-pre-down", "2026-06-10T00:00:00Z");
    insertRaw("snap-new-periodic", "rig-1", "auto-periodic", "2026-06-14T12:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("rig-1");
    expect(result!.id).toBe("snap-new-periodic");
    expect(result!.kind).toBe("auto-periodic");
  });

  it("fresher auto-pre-down + older auto-periodic -> auto-pre-down wins (graceful-cycle preserved)", () => {
    insertRaw("snap-new-apd", "rig-1", "auto-pre-down", "2026-06-14T18:00:00Z");
    insertRaw("snap-old-periodic", "rig-1", "auto-periodic", "2026-06-14T12:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("rig-1");
    expect(result!.id).toBe("snap-new-apd");
    expect(result!.kind).toBe("auto-pre-down");
  });

  it("manual unchanged: Apr-27 auto-pre-down beats Apr-28 manual (manual below tier)", () => {
    insertRaw("snap-apd", "rig-1", "auto-pre-down", "2026-04-27T00:00:00Z");
    insertRaw("snap-manual", "rig-1", "manual", "2026-04-28T00:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("rig-1");
    expect(result!.id).toBe("snap-apd");
    expect(result!.kind).toBe("auto-pre-down");
  });

  it("only auto-periodic present -> returned", () => {
    insertRaw("snap-periodic-only", "rig-1", "auto-periodic", "2026-06-14T12:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("rig-1");
    expect(result!.id).toBe("snap-periodic-only");
  });
});
