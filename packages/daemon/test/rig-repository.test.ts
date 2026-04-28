import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

describe("RigRepository", () => {
  let db: Database.Database;
  let repo: RigRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new RigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("createRig persists and returns typed Rig with id", () => {
    const rig = repo.createRig("test-rig");
    expect(rig.id).toBeDefined();
    expect(typeof rig.id).toBe("string");
    expect(rig.id.length).toBeGreaterThan(0);
    expect(rig.name).toBe("test-rig");
    expect(rig.createdAt).toBeDefined();
  });

  it("addNode persists with rig FK, returns typed Node", () => {
    const rig = repo.createRig("test-rig");
    const node = repo.addNode(rig.id, "orchestrator", {
      role: "orchestrator",
      runtime: "claude-code",
      model: "opus",
    });
    expect(node.id).toBeDefined();
    expect(node.rigId).toBe(rig.id);
    expect(node.logicalId).toBe("orchestrator");
    expect(node.role).toBe("orchestrator");
    expect(node.runtime).toBe("claude-code");
    expect(node.model).toBe("opus");
  });

  it("addNode to nonexistent rig throws", () => {
    expect(() => repo.addNode("nonexistent", "worker")).toThrow();
  });

  it("addNode with duplicate logical_id in same rig throws", () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker");
    expect(() => repo.addNode(rig.id, "worker")).toThrow();
  });

  it("addEdge validates both nodes exist and belong to same rig", () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator");
    const n2 = repo.addNode(rig.id, "worker");
    const edge = repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");
    expect(edge.id).toBeDefined();
    expect(edge.sourceId).toBe(n1.id);
    expect(edge.targetId).toBe(n2.id);
    expect(edge.kind).toBe("delegates_to");
  });

  it("addEdge cross-rig rejected", () => {
    const rig1 = repo.createRig("rig-one");
    const rig2 = repo.createRig("rig-two");
    const n1 = repo.addNode(rig1.id, "worker-a");
    const n2 = repo.addNode(rig2.id, "worker-b");
    expect(() =>
      repo.addEdge(rig1.id, n1.id, n2.id, "delegates_to")
    ).toThrow(/same rig/);
  });

  it("getRig returns full graph with nodes, edges, and bindings", () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator", { role: "orchestrator" });
    const n2 = repo.addNode(rig.id, "worker", { role: "worker" });
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    // Add a binding to n1 only
    db.prepare(
      "INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)"
    ).run("bind-1", n1.id, "r01-orch1-lead");

    const full = repo.getRig(rig.id);
    expect(full).not.toBeNull();
    expect(full!.rig.name).toBe("test-rig");
    expect(full!.nodes).toHaveLength(2);
    expect(full!.edges).toHaveLength(1);
    expect(full!.edges[0]!.kind).toBe("delegates_to");

    // n1 has a binding
    const orchNode = full!.nodes.find((n) => n.logicalId === "orchestrator");
    expect(orchNode!.binding).not.toBeNull();
    expect(orchNode!.binding!.tmuxSession).toBe("r01-orch1-lead");
  });

  it("getRig: unbound nodes have binding: null (not undefined/omitted)", () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker");

    const full = repo.getRig(rig.id);
    const workerNode = full!.nodes.find((n) => n.logicalId === "worker");
    // Must be explicitly null, not undefined
    expect(workerNode).toHaveProperty("binding");
    expect(workerNode!.binding).toBeNull();
  });

  it("listRigs returns all rigs", () => {
    repo.createRig("rig-a");
    repo.createRig("rig-b");
    repo.createRig("rig-c");
    const rigs = repo.listRigs();
    expect(rigs).toHaveLength(3);
    const names = rigs.map((r) => r.name);
    expect(names).toContain("rig-a");
    expect(names).toContain("rig-b");
    expect(names).toContain("rig-c");
  });

  it("deleteRig cascades — nodes and edges gone", () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator");
    const n2 = repo.addNode(rig.id, "worker");
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    repo.deleteRig(rig.id);

    expect(repo.getRig(rig.id)).toBeNull();
    expect(repo.listRigs()).toHaveLength(0);
  });

  // -- P3-T00: Extended node fields --

  it("addNode persists extended fields", () => {
    const rig = repo.createRig("test-rig");
    const node = repo.addNode(rig.id, "worker", {
      role: "worker",
      runtime: "claude-code",
      surfaceHint: "tab:workers",
      workspace: "review",
      restorePolicy: "checkpoint_only",
      packageRefs: ["github:example/pkg@v1", "local:./my-pkg"],
    });

    expect(node.surfaceHint).toBe("tab:workers");
    expect(node.workspace).toBe("review");
    expect(node.restorePolicy).toBe("checkpoint_only");
    expect(node.packageRefs).toEqual(["github:example/pkg@v1", "local:./my-pkg"]);
  });

  it("getRig returns nodes with extended fields (parsed packageRefs)", () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker", {
      surfaceHint: "tab:main",
      packageRefs: ["pkg-a", "pkg-b"],
    });

    const full = repo.getRig(rig.id);
    const node = full!.nodes[0]!;
    expect(node.surfaceHint).toBe("tab:main");
    expect(node.packageRefs).toEqual(["pkg-a", "pkg-b"]);
    expect(Array.isArray(node.packageRefs)).toBe(true);
  });

  it("addNode with no extended fields: surfaceHint=null, workspace=null, restorePolicy=null, packageRefs=[]", () => {
    const rig = repo.createRig("test-rig");
    const node = repo.addNode(rig.id, "worker");

    expect(node.surfaceHint).toBeNull();
    expect(node.workspace).toBeNull();
    expect(node.restorePolicy).toBeNull();
    expect(node.packageRefs).toEqual([]);
  });
});

describe("Wiring regression", () => {
  it("createFullTestDb schema includes 007 columns", async () => {
    const { createFullTestDb } = await import("./helpers/test-app.js");
    const db = createFullTestDb();
    const cols = db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("surface_hint");
    expect(names).toContain("workspace");
    expect(names).toContain("restore_policy");
    expect(names).toContain("package_refs");
    db.close();
  });
});

// L2 findLatestUsableSnapshot
describe("RigRepository.findLatestUsableSnapshot (L2)", () => {
  let db: Database.Database;
  let repo: RigRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new RigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSnapshot(
    rigId: string,
    snapshotId: string,
    sessions: Array<{ nodeId: string; resumeToken: string | null }>,
    createdAt?: string,
  ): void {
    const data = {
      rig: { id: rigId, name: "rig-name", createdAt: "2026-04-28T00:00:00Z", updatedAt: "2026-04-28T00:00:00Z" },
      nodes: [],
      edges: [],
      sessions: sessions.map((s, i) => ({
        id: `sess-snap-${i}`,
        nodeId: s.nodeId,
        sessionName: `tmux-${s.nodeId}`,
        status: "detached",
        resumeType: s.resumeToken ? "claude" : null,
        resumeToken: s.resumeToken,
        restorePolicy: "resume_if_possible",
        lastSeenAt: null,
        createdAt: "2026-04-28T00:00:00Z",
        origin: "launched" as const,
        startupStatus: "ready" as const,
        startupCompletedAt: null,
      })),
      checkpoints: {},
    };
    if (createdAt) {
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(snapshotId, rigId, "manual", "complete", JSON.stringify(data), createdAt);
    } else {
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data) VALUES (?, ?, ?, ?, ?)")
        .run(snapshotId, rigId, "manual", "complete", JSON.stringify(data));
    }
  }

  it("returns null when no snapshot exists for rig", () => {
    const rig = repo.createRig("no-snap");
    expect(repo.findLatestUsableSnapshot(rig.id)).toBeNull();
  });

  it("returns null when only snapshots have null resume tokens for all nodes", () => {
    const rig = repo.createRig("null-tokens");
    seedSnapshot(rig.id, "snap-1", [
      { nodeId: "node-a", resumeToken: null },
      { nodeId: "node-b", resumeToken: null },
    ]);
    expect(repo.findLatestUsableSnapshot(rig.id)).toBeNull();
  });

  it("returns latest snapshot when at least one session has a non-null resume token", () => {
    const rig = repo.createRig("usable");
    seedSnapshot(rig.id, "snap-1", [
      { nodeId: "node-a", resumeToken: "tok-a" },
      { nodeId: "node-b", resumeToken: null },
    ]);

    const result = repo.findLatestUsableSnapshot(rig.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("snap-1");
    expect(result!.data.sessions?.find((s) => s.nodeId === "node-a")?.resumeToken).toBe("tok-a");
  });

  it("returns the snapshot even when only some nodes have valid tokens (per-node lifecycleState handles individual recoverability)", () => {
    const rig = repo.createRig("partial");
    seedSnapshot(rig.id, "snap-1", [
      { nodeId: "node-a", resumeToken: "tok-a" }, // recoverable
      { nodeId: "node-b", resumeToken: null },     // detached
      { nodeId: "node-c", resumeToken: null },     // detached
    ]);

    const result = repo.findLatestUsableSnapshot(rig.id);
    expect(result).not.toBeNull();
    expect(result!.data.sessions).toHaveLength(3);
  });

  it("returns the latest snapshot when multiple usable snapshots exist (ORDER BY created_at DESC, id DESC)", () => {
    const rig = repo.createRig("multi-snap");
    seedSnapshot(rig.id, "snap-old", [{ nodeId: "node-a", resumeToken: "tok-old" }], "2026-04-27 00:00:00");
    seedSnapshot(rig.id, "snap-new", [{ nodeId: "node-a", resumeToken: "tok-new" }], "2026-04-28 00:00:00");

    const result = repo.findLatestUsableSnapshot(rig.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("snap-new");
  });
});
