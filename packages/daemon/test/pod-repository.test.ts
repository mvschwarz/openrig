import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";

describe("PodRepository + RigRepository evolution (AS-T08a)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // T1: pod record persists and loads correctly
  it("pod record persists and loads correctly", () => {
    const rig = rigRepo.createRig("test-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Development", {
      summary: "Dev pod",
      continuityPolicyJson: JSON.stringify({ enabled: true, sync_triggers: ["manual"] }),
    });

    expect(pod.id).toBeDefined();
    expect(pod.rigId).toBe(rig.id);
    expect(pod.namespace).toBe("dev");
    expect(pod.label).toBe("Development");
    expect(pod.summary).toBe("Dev pod");
    expect(pod.continuityPolicyJson).toContain("enabled");
    expect(pod.createdAt).toBeDefined();

    // Round-trip via getPod
    const loaded = podRepo.getPod(pod.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.namespace).toBe("dev");
    expect(loaded!.label).toBe("Development");
    expect(loaded!.summary).toBe("Dev pod");

    // getPodsForRig
    const pods = podRepo.getPodsForRig(rig.id);
    expect(pods).toHaveLength(1);
    expect(pods[0]!.id).toBe(pod.id);
  });

  // T2: node creation persists agent_ref, profile, and pod_id
  it("node creation persists agent_ref, profile, and pod_id", () => {
    const rig = rigRepo.createRig("test-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Dev");

    const node = rigRepo.addNode(rig.id, "impl", {
      runtime: "claude-code",
      podId: pod.id,
      agentRef: "local:agents/implementer",
      profile: "tdd",
      label: "Implementer",
    });

    expect(node.podId).toBe(pod.id);
    expect(node.agentRef).toBe("local:agents/implementer");
    expect(node.profile).toBe("tdd");
    expect(node.label).toBe("Implementer");

    // Round-trip via getRig
    const full = rigRepo.getRig(rig.id);
    const loadedNode = full!.nodes.find((n) => n.logicalId === "impl");
    expect(loadedNode!.podId).toBe(pod.id);
    expect(loadedNode!.agentRef).toBe("local:agents/implementer");
    expect(loadedNode!.profile).toBe("tdd");
  });

  // T3: resolved spec identity persists on node creation
  it("resolved spec identity persists on node creation", () => {
    const rig = rigRepo.createRig("test-rig");

    const node = rigRepo.addNode(rig.id, "impl", {
      runtime: "claude-code",
      resolvedSpecName: "implementer",
      resolvedSpecVersion: "0.2",
      resolvedSpecHash: "sha256:abc123def456",
    });

    expect(node.resolvedSpecName).toBe("implementer");
    expect(node.resolvedSpecVersion).toBe("0.2");
    expect(node.resolvedSpecHash).toBe("sha256:abc123def456");

    // Round-trip
    const full = rigRepo.getRig(rig.id);
    const loaded = full!.nodes[0]!;
    expect(loaded.resolvedSpecName).toBe("implementer");
    expect(loaded.resolvedSpecVersion).toBe("0.2");
    expect(loaded.resolvedSpecHash).toBe("sha256:abc123def456");
  });

  // T4: FK behavior between rig/pod/node matches design
  it("FK behavior: pod with nonexistent rig throws, cross-rig pod_id throws, same-rig succeeds", () => {
    // Pod FK on rig: nonexistent rig_id throws
    expect(() => podRepo.createPod("nonexistent-rig", "bad", "Bad")).toThrow();

    // Create two rigs and a pod on rig A
    const rigA = rigRepo.createRig("rig-a");
    const rigB = rigRepo.createRig("rig-b");
    const podA = podRepo.createPod(rigA.id, "pod-a", "Pod A");

    // Cross-rig pod_id: node on rig B with pod from rig A -> throws
    expect(() => {
      rigRepo.addNode(rigB.id, "impl", { podId: podA.id });
    }).toThrow(/different rig/);

    // Same-rig pod_id succeeds
    const node = rigRepo.addNode(rigA.id, "impl", { podId: podA.id });
    expect(node.podId).toBe(podA.id);
  });

  // T5: deleting a pod or rig behaves correctly for member nodes
  it("delete pod -> node.pod_id NULL; delete rig -> cascades pods + nodes", () => {
    const rig = rigRepo.createRig("test-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Dev");
    const node = rigRepo.addNode(rig.id, "impl", { podId: pod.id, runtime: "claude-code" });

    // Delete pod -> node.pod_id becomes NULL
    podRepo.deletePod(pod.id);
    expect(podRepo.getPod(pod.id)).toBeNull();

    const full = rigRepo.getRig(rig.id);
    const loadedNode = full!.nodes.find((n) => n.logicalId === "impl");
    expect(loadedNode!.podId).toBeNull();

    // Delete rig -> cascades pods and nodes
    const pod2 = podRepo.createPod(rig.id, "arch", "Arch");
    rigRepo.deleteRig(rig.id);
    expect(podRepo.getPodsForRig(rig.id)).toHaveLength(0);
    expect(rigRepo.getRig(rig.id)).toBeNull();
  });

  // T6: repository methods use the shared DB handle correctly
  it("repository methods use the shared DB handle", () => {
    expect(rigRepo.db).toBe(db);
    expect(podRepo.db).toBe(db);
    expect(rigRepo.db).toBe(podRepo.db);
  });
});
