// OPR.0.3.4.11 — launchNodeSubset tests: managed partial restore for held seats.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { createFullTestDb } from "./helpers/test-app.js";

function makeTmux(overrides?: Partial<Record<string, (...args: unknown[]) => unknown>>) {
  return {
    createSession: vi.fn(async () => true),
    hasSession: vi.fn(async () => false),
    sendKeys: vi.fn(async () => {}),
    capturePaneContent: vi.fn(async () => ""),
    getPaneCommand: vi.fn(async () => null),
    getSessionStatus: vi.fn(async () => null),
    waitForReady: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    startPipePane: vi.fn(async () => true),
    killSession: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("RestoreOrchestrator.launchNodeSubset", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let tmux: ReturnType<typeof makeTmux>;
  let orchestrator: RestoreOrchestrator;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    tmux = makeTmux();
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux as any });
    orchestrator = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux as any,
      claudeResume: new ClaudeResumeAdapter(tmux as any),
      codexResume: new CodexResumeAdapter(tmux as any),
    });
  });

  afterEach(() => { db.close(); });

  function seedPodAwareRig(): { rigId: string; nodeIds: string[] } {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-1", rig.id, "dev", "Dev");
    const n1 = rigRepo.addNode(rig.id, "dev.driver", { role: "driver", runtime: "claude-code", podId: "pod-1" });
    const n2 = rigRepo.addNode(rig.id, "dev.guard", { role: "guard", runtime: "codex", podId: "pod-1" });
    return { rigId: rig.id, nodeIds: [n1.id, n2.id] };
  }

  function seedSnapshot(rigId: string, nodeIds: string[]) {
    const sessions = nodeIds.map((nid, i) => ({
      nodeId: nid,
      id: `sess-${i}`,
      sessionName: `seat-${i}@test-rig`,
      status: "running",
      resumeType: "claude-native",
      resumeToken: `token-${i}`,
    }));
    const data = {
      rig: { id: rigId, name: "test-rig" },
      nodes: nodeIds.map((nid, i) => ({
        id: nid,
        logicalId: i === 0 ? "dev.driver" : "dev.guard",
        rigId,
        runtime: i === 0 ? "claude-code" : "codex",
        podId: "pod-1",
      })),
      sessions,
      edges: [],
      checkpoints: {},
      nodeStartupContext: {},
    } as any;
    const snap = snapshotRepo.createSnapshot(rigId, "manual", data);
    return snap.id;
  }

  it("returns rig_not_found for unknown rig", async () => {
    const result = await orchestrator.launchNodeSubset("nonexistent", ["dev.driver"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("rig_not_found");
  });

  it("returns no_usable_snapshot when no snapshot exists", async () => {
    const { rigId } = seedPodAwareRig();
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_usable_snapshot");
  });

  it("returns no_matching_nodes for unknown logical id", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const result = await orchestrator.launchNodeSubset(rigId, ["nonexistent.node"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_matching_nodes");
  });

  it("launches target and holds non-target with default reason", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(1);
    expect(result.launched![0].logicalId).toBe("dev.driver");
    expect(result.held).toHaveLength(1);
    expect(result.held![0].logicalId).toBe("dev.guard");
    expect(result.held![0].reason).toBe("excluded_from_subset");
  });

  it("emits restore.subset_completed for launched targets only", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'restore.subset_completed'").all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.result.nodes).toHaveLength(1);
    expect(payload.result.nodes[0].logicalId).toBe("dev.driver");
  });

  it("emits node.held for non-running held non-targets", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'node.held'").all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.logicalId).toBe("dev.guard");
    expect(payload.reason).toBe("excluded_from_subset");
  });

  it("uses operator hold reason when provided", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"], { holdReason: "codex auth expired" });

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all() as { payload: string }[];
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.reason).toBe("codex auth expired");
  });

  it("reports already_running for live targets (tmux alive)", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[0]!, "dev-driver@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => name === "dev-driver@test-rig");

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    expect(result.ok).toBe(true);
    expect(result.alreadyRunning).toHaveLength(1);
    expect(result.alreadyRunning![0].logicalId).toBe("dev.driver");
    expect(result.launched).toHaveLength(0);
  });

  it("does not emit node.held for running non-targets", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => name === "dev-guard@test-rig");

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all();
    expect(events).toHaveLength(0);
  });

  it("does not emit restore.subset_completed when no targets launched", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[0]!, "dev-driver@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => name === "dev-driver@test-rig");

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT type FROM events WHERE type = 'restore.subset_completed'").all();
    expect(events).toHaveLength(0);
  });

  // OPR.0.4.3.28 correction — INVERT fail-closed-on-unknown for launch liveness. A tmux
  // probe error is NOT positive evidence of a live seat (only a TRUE hasSession is). Was:
  // failedTargets + hard 503. Now: PROCEED to launch + surface a non-blocking
  // liveness_probe_unknown warning so an operator can verify no live seat was squatted.
  it("proceed-on-unknown: tmux probe error LAUNCHES the node with a liveness warning (not failedTargets)", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[0]!, "dev-driver@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockRejectedValue(new Error("tmux unavailable"));

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(1);
    expect(result.launched![0].logicalId).toBe("dev.driver");
    expect(result.failedTargets ?? []).toHaveLength(0);
    expect(result.warnings?.some((w) => w.includes("liveness_probe_unknown") && w.includes("dev.driver"))).toBe(true);
  });

  // B1 regression: non-target with tmux probe error does NOT get node.held
  // Multi-target success: both targets launched, restore.subset_completed contains both
  it("launches multiple targets in one call with restore.subset_completed containing both", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver", "dev.guard"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(2);
    const launchedIds = result.launched!.map((n) => n.logicalId).sort();
    expect(launchedIds).toEqual(["dev.driver", "dev.guard"]);
    expect(result.held).toHaveLength(0);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.subset_completed'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    const eventNodeIds = payload.result.nodes.map((n: { logicalId: string }) => n.logicalId).sort();
    expect(eventNodeIds).toEqual(["dev.driver", "dev.guard"]);
  });

  it("does not emit node.held for non-target with tmux probe error (fail-closed)", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => {
      if (name === "dev-guard@test-rig") throw new Error("tmux unavailable");
      return false;
    });

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all();
    expect(events).toHaveLength(0);
  });

  // B1 regression: mixed valid/invalid seats reports unmatchedIds
  it("reports unmatchedIds for seats that do not match any node", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver", "typo.seat"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(1);
    expect(result.launched![0].logicalId).toBe("dev.driver");
    expect(result.unmatchedIds).toEqual(["typo.seat"]);
  });

  // B4 regression: stale non-target DB-running sessions marked detached so inventory projects heldReason
  it("marks stale non-target DB-running sessions detached before emitting node.held", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // tmux says guard is dead
    tmux.hasSession.mockResolvedValue(false);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    // Session should now be detached, not running
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id) as { status: string };
    expect(row.status).toBe("detached");
    // And node.held should be emitted
    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).logicalId).toBe("dev.guard");
  });
});
