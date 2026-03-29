import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function seedRigWithNodes(db: Database.Database, rigId: string, rigName: string, nodeIds: { id: string; logicalId: string }[]) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(rigId, rigName);
  for (const n of nodeIds) {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(n.id, rigId, n.logicalId);
  }
}

describe("CheckpointStore", () => {
  let db: Database.Database;
  let store: CheckpointStore;

  beforeEach(() => {
    db = setupDb();
    store = new CheckpointStore(db);
    seedRigWithNodes(db, "rig-1", "r01", [
      { id: "node-1", logicalId: "worker-a" },
      { id: "node-2", logicalId: "worker-b" },
    ]);
  });

  afterEach(() => {
    db.close();
  });

  it("createCheckpoint persists and returns typed Checkpoint with parsed keyArtifacts", () => {
    const cp = store.createCheckpoint("node-1", {
      summary: "Implemented auth module",
      currentTask: "auth tests",
      nextStep: "write integration tests",
      blockedOn: null,
      keyArtifacts: ["src/auth.ts", "test/auth.test.ts"],
      confidence: "high",
    });

    expect(cp.id).toBeDefined();
    expect(cp.nodeId).toBe("node-1");
    expect(cp.summary).toBe("Implemented auth module");
    expect(cp.currentTask).toBe("auth tests");
    expect(cp.keyArtifacts).toEqual(["src/auth.ts", "test/auth.test.ts"]);
    expect(cp.confidence).toBe("high");
    expect(cp.createdAt).toBeDefined();
  });

  it("getLatestCheckpoint: explicit timestamps, newest returned", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-old", "node-1", "first", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-new", "node-1", "third", "[]", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-mid", "node-1", "second", "[]", "2026-03-23 02:00:00");

    const latest = store.getLatestCheckpoint("node-1");
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe("cp-new");
    expect(latest!.summary).toBe("third");
  });

  it("getLatestCheckpoint no checkpoints -> null", () => {
    expect(store.getLatestCheckpoint("node-1")).toBeNull();
  });

  it("getCheckpointsForNode: all returned in created_at ASC order", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-3", "node-1", "third", "[]", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1", "node-1", "first", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-2", "node-1", "second", "[]", "2026-03-23 02:00:00");

    const cps = store.getCheckpointsForNode("node-1");
    expect(cps.map((c) => c.id)).toEqual(["cp-1", "cp-2", "cp-3"]);
  });

  it("getCheckpointsForRig: returns map keyed by node id, latest per node", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1a", "node-1", "node1 old", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1b", "node-1", "node1 new", "[]", "2026-03-23 02:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-2a", "node-2", "node2 only", "[]", "2026-03-23 01:00:00");

    const map = store.getCheckpointsForRig("rig-1");
    expect(Object.keys(map).sort()).toEqual(["node-1", "node-2"]);
    expect(map["node-1"]!.id).toBe("cp-1b"); // latest
    expect(map["node-2"]!.id).toBe("cp-2a");
  });

  it("getCheckpointsForRig: node with no checkpoint -> null in map", () => {
    // node-1 has a checkpoint, node-2 does not
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1", "node-1", "has checkpoint", "[]", "2026-03-23 01:00:00");

    const map = store.getCheckpointsForRig("rig-1");
    expect(map["node-1"]).not.toBeNull();
    expect(map["node-2"]).toBeNull();
  });

  it("getCheckpointsForRig: multiple nodes, each gets latest checkpoint", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1old", "node-1", "n1 old", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1new", "node-1", "n1 new", "[]", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-2old", "node-2", "n2 old", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-2new", "node-2", "n2 new", "[]", "2026-03-23 02:00:00");

    const map = store.getCheckpointsForRig("rig-1");
    expect(map["node-1"]!.summary).toBe("n1 new");
    expect(map["node-2"]!.summary).toBe("n2 new");
  });

  it("getCheckpointsForRig: cross-rig isolation — only rig-1 nodes returned", () => {
    seedRigWithNodes(db, "rig-2", "r02", [
      { id: "node-3", logicalId: "worker-c" },
    ]);
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1", "node-1", "rig1 checkpoint", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-3", "node-3", "rig2 checkpoint", "[]", "2026-03-23 01:00:00");

    const map = store.getCheckpointsForRig("rig-1");

    // Only rig-1 nodes should be in the map
    const nodeIds = Object.keys(map);
    expect(nodeIds).toContain("node-1");
    expect(nodeIds).toContain("node-2"); // null entry
    expect(nodeIds).not.toContain("node-3"); // rig-2 node excluded
  });
});
