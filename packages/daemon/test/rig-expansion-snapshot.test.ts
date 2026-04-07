import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigExpansionService } from "../src/domain/rig-expansion-service.js";
import type { ExpansionRequest } from "../src/domain/types.js";

describe("Expansion → Snapshot/Restore/Export compatibility", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let service: RigExpansionService;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    service = new RigExpansionService({
      db,
      rigRepo: setup.rigRepo,
      eventBus: setup.eventBus,
      nodeLauncher: setup.nodeLauncher,
      podInstantiator: setup.podInstantiator,
      sessionRegistry: setup.sessionRegistry,
    });
  });

  afterEach(() => { db.close(); });

  function terminalPod(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
    return {
      id,
      label: "Infrastructure",
      members: [
        { id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
  }

  // T1: expand -> snapshot captures expanded pod + nodes
  it("snapshot captures expanded pod and nodes", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const result = await service.expand({ rigId: rig.id, pod: terminalPod() });
    expect(result.ok).toBe(true);

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "test");
    expect(snapshot).toBeDefined();

    // Snapshot should include the expanded pod
    const snapshotData = snapshot!.data;
    expect(snapshotData.pods.some((p) => p.namespace === "infra")).toBe(true);
    expect(snapshotData.nodes.some((n) => n.logicalId === "infra.server")).toBe(true);
  });

  // T2: expand -> snapshot -> teardown -> restore brings back expanded nodes
  it("expand -> snapshot -> teardown -> restore brings back expanded nodes", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const expandResult = await service.expand({ rigId: rig.id, pod: terminalPod() });
    expect(expandResult.ok).toBe(true);

    // Snapshot
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "pre-restore");
    expect(snapshot).toBeDefined();

    // Teardown (kill sessions, mark stopped)
    const teardown = await setup.teardownOrchestrator.teardown(rig.id);
    expect(teardown.errors).toHaveLength(0);

    // Restore
    const restoreResult = await setup.restoreOrchestrator.restore(snapshot!.id);
    expect(restoreResult.ok).toBe(true);

    // Verify expanded nodes are back
    const restoredRig = setup.rigRepo.getRig(rig.id);
    expect(restoredRig!.nodes.some((n) => n.logicalId === "infra.server")).toBe(true);
  });

  // T3: expand -> export spec includes expanded pod with authored namespace
  it("export spec includes expanded pod with authored namespace", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    await service.expand({ rigId: rig.id, pod: terminalPod("monitoring", "collector") });

    const spec = setup.rigSpecExporter.exportRig(rig.id) as Record<string, unknown>;
    const pods = spec["pods"] as Array<{ id: string; members: Array<{ id: string }> }>;
    expect(pods.some((p) => p.id === "monitoring")).toBe(true);
    const monPod = pods.find((p) => p.id === "monitoring")!;
    expect(monPod.members.some((m) => m.id === "collector")).toBe(true);
  });

  // T4: expanded pod namespace preserved after restore
  it("expanded pod namespace preserved after restore cycle", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    await service.expand({ rigId: rig.id, pod: terminalPod("custom-ns", "worker") });

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "ns-test");
    await setup.teardownOrchestrator.teardown(rig.id);
    await setup.restoreOrchestrator.restore(snapshot!.id);

    // Pod namespace should still be "custom-ns"
    const pods = db.prepare("SELECT namespace FROM pods WHERE rig_id = ?").all(rig.id) as Array<{ namespace: string }>;
    expect(pods.some((p) => p.namespace === "custom-ns")).toBe(true);

    // Node logical ID should still use authored namespace
    const restoredRig = setup.rigRepo.getRig(rig.id);
    expect(restoredRig!.nodes.some((n) => n.logicalId === "custom-ns.worker")).toBe(true);
  });

  // T5: cross-pod edges survive snapshot/restore
  it("cross-pod edges survive snapshot/restore cycle", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    await service.expand({ rigId: rig.id, pod: terminalPod("orch", "lead") });
    await service.expand({
      rigId: rig.id,
      pod: terminalPod("dev", "impl"),
      crossPodEdges: [{ kind: "delegates_to", from: "orch.lead", to: "dev.impl" }],
    });

    // Verify edge exists before snapshot
    const rigBefore = setup.rigRepo.getRig(rig.id);
    expect(rigBefore!.edges.some((e) => e.kind === "delegates_to")).toBe(true);

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "edge-test");
    await setup.teardownOrchestrator.teardown(rig.id);
    await setup.restoreOrchestrator.restore(snapshot!.id);

    // Edges should survive
    const rigAfter = setup.rigRepo.getRig(rig.id);
    expect(rigAfter!.edges.some((e) => e.kind === "delegates_to")).toBe(true);
  });

  // T6: snapshot data has same shape for expanded vs original pods
  it("snapshot data has same pod structure for expanded pods", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    await service.expand({ rigId: rig.id, pod: terminalPod() });

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "shape-test");
    const pod = snapshot!.data.pods.find((p) => p.namespace === "infra");

    // Should have standard Pod fields — no special "expanded" flag
    expect(pod).toBeDefined();
    expect(pod!.id).toBeTruthy();
    expect(pod!.rigId).toBe(rig.id);
    expect(pod!.namespace).toBe("infra");
    expect(pod!.label).toBe("Infrastructure");
    // No "expanded" or "source" field
    expect((pod as Record<string, unknown>)["expanded"]).toBeUndefined();
    expect((pod as Record<string, unknown>)["source"]).toBeUndefined();
  });
});
