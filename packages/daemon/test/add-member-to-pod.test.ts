import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { ExpansionRequest } from "../src/domain/types.js";

// OPR.0.3.3.24 Chunk 2 — add_member converge op.
// Focused daemon coverage for PodRigInstantiator.addMemberToPod: the happy path
// (member created into an EXISTING pod + launched), the kept per-member dup
// guard (AC-3), pod/rig not-found honesty, validation, and the load-bearing
// identity-migration-free property (AC-2: a pod-mate is untouched before/after).
describe("PodRigInstantiator.addMemberToPod", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function terminalMember(id: string) {
    return { id, runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" };
  }

  function terminalPodFragment(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
    return {
      id,
      label: "Infrastructure",
      members: [
        { id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
  }

  // Seed a live rig with one existing pod (infra) holding one member (infra.server).
  async function seedRigWithPod() {
    const rig = setup.rigRepo.createRig("test-rig");
    const expanded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: terminalPodFragment() });
    expect(expanded.ok).toBe(true);
    return rig;
  }

  it("adds a member into an existing pod and launches it", async () => {
    const rig = await seedRigWithPod();

    const result = await setup.podInstantiator.addMemberToPod(
      rig.id,
      "infra",
      terminalMember("server2"),
      ".",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.podNamespace).toBe("infra");
    expect(result.result.node.logicalId).toBe("infra.server2");
    expect(result.result.node.status).toBe("launched");
    expect(result.result.node.sessionName).toBeTruthy();

    // The new node is in the live rig, under the SAME existing pod.
    const updatedRig = setup.rigRepo.getRig(rig.id)!;
    const newNode = updatedRig.nodes.find((n) => n.logicalId === "infra.server2");
    expect(newNode).toBeDefined();
    expect(newNode!.podId).toBe(result.result.podId);
  });

  function podRowsForRig(rigId: string) {
    return db.prepare("SELECT id, namespace FROM pods WHERE rig_id = ?").all(rigId) as Array<{ id: string; namespace: string }>;
  }

  it("creates the member under the EXISTING pod — no new pod is created", async () => {
    const rig = await seedRigWithPod();
    const podsBefore = podRowsForRig(rig.id);
    expect(podsBefore).toHaveLength(1);
    const existingPodId = podsBefore[0]!.id;

    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Pod count unchanged; the new node's pod_id is the pre-existing pod.
    const podsAfter = podRowsForRig(rig.id);
    expect(podsAfter).toHaveLength(1);
    expect(result.result.podId).toBe(existingPodId);
    const newNode = setup.rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === "infra.server2");
    expect(newNode!.podId).toBe(existingPodId);

    // Exactly one new node.added event for the added member.
    const added = db.prepare("SELECT payload FROM events WHERE type = 'node.added'").all() as Array<{ payload: string }>;
    const addedLogicalIds = added.map((e) => JSON.parse(e.payload).logicalId);
    expect(addedLogicalIds).toContain("infra.server2");
  });

  it("identity-migration-free: a pod-mate is untouched before/after (AC-2)", async () => {
    const rig = await seedRigWithPod();
    const mateBefore = setup.rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === "infra.server")!;
    const mateNodeIdBefore = mateBefore.id;
    const matePodIdBefore = mateBefore.podId;
    const mateSessionBefore = setup.sessionRegistry.getSessionsForRig(rig.id).find((s) => s.nodeId === mateNodeIdBefore);

    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mateAfter = setup.rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === "infra.server")!;
    // The existing seat's identity is unchanged: same node id, same logical id,
    // same pod. The new node is a DISTINCT fresh node id.
    expect(mateAfter.id).toBe(mateNodeIdBefore);
    expect(mateAfter.logicalId).toBe("infra.server");
    expect(mateAfter.podId).toBe(matePodIdBefore);
    expect(result.result.node.nodeId).not.toBe(mateNodeIdBefore);

    // The pod-mate's session is not re-keyed: same session id + name.
    const mateSessionAfter = setup.sessionRegistry.getSessionsForRig(rig.id).find((s) => s.nodeId === mateNodeIdBefore);
    expect(mateSessionAfter?.id).toBe(mateSessionBefore?.id);
    expect(mateSessionAfter?.sessionName).toBe(mateSessionBefore?.sessionName);
    // (LIVE-RIG QA additionally proves continuity_state + queue routing untouched.)
  });

  it("rejects a duplicate member id in the target pod (AC-3, dup guard KEPT)", async () => {
    const rig = await seedRigWithPod();

    // "server" already exists in pod "infra".
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server"), ".");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("member_conflict");
    expect(result.message).toContain("infra.server");
  });

  it("returns pod_not_found for an unknown pod namespace", async () => {
    const rig = await seedRigWithPod();

    const result = await setup.podInstantiator.addMemberToPod(rig.id, "nope", terminalMember("x"), ".");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pod_not_found");
    // Honest: names the missing namespace and lists the available ones.
    expect(result.message).toContain("nope");
    expect(result.message).toContain("infra");
  });

  it("returns rig_not_found for an unknown rig", async () => {
    const result = await setup.podInstantiator.addMemberToPod("nonexistent", "infra", terminalMember("x"), ".");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rig_not_found");
  });

  it("returns validation_failed for a malformed member fragment", async () => {
    const rig = await seedRigWithPod();

    // Missing agent_ref (required by the schema).
    const result = await setup.podInstantiator.addMemberToPod(
      rig.id,
      "infra",
      { id: "broken", runtime: "claude-code", profile: "default", cwd: "/tmp" },
      ".",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("the new seat is queue-addressable as ${pod}-${member}@${rig} (AC-1 derived session)", async () => {
    const rig = await seedRigWithPod();

    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.node.sessionName).toBe("infra-server2@test-rig");
  });

  // Governance FM2: optional pod-local edges are PRESERVED, never silently dropped.
  function edgeRows(rigId: string) {
    return db.prepare("SELECT source_id, target_id, kind FROM edges WHERE rig_id = ?").all(rigId) as Array<{ source_id: string; target_id: string; kind: string }>;
  }

  it("defaults to no edges when none are declared", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.edges).toEqual([]);
  });

  it("persists a declared pod-local edge from the new member to an existing pod-mate", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".", {
      edges: [{ from: "server2", to: "server", kind: "delegates_to" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Reported with qualified endpoints.
    expect(result.result.edges).toEqual([{ from: "infra.server2", to: "infra.server", kind: "delegates_to" }]);

    // Persisted as a real graph edge between the two node ids.
    const nodes = setup.rigRepo.getRig(rig.id)!.nodes;
    const newId = nodes.find((n) => n.logicalId === "infra.server2")!.id;
    const mateId = nodes.find((n) => n.logicalId === "infra.server")!.id;
    const rows = edgeRows(rig.id);
    expect(rows).toContainEqual({ source_id: newId, target_id: mateId, kind: "delegates_to" });
  });

  it("rejects a pod-local edge to an unresolvable endpoint (edge_unresolved) and creates no node", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".", {
      edges: [{ from: "server2", to: "ghost", kind: "delegates_to" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("edge_unresolved");
    expect(result.message).toContain("infra.ghost");

    // Fail-fast: no orphan node, no edge.
    expect(setup.rigRepo.getRig(rig.id)!.nodes.some((n) => n.logicalId === "infra.server2")).toBe(false);
    expect(edgeRows(rig.id)).toHaveLength(0);
  });

  it("rejects a malformed edge (empty kind) with validation_failed", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".", {
      edges: [{ from: "server2", to: "server", kind: "" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
    // No orphan node from a rejected declaration.
    expect(setup.rigRepo.getRig(rig.id)!.nodes.some((n) => n.logicalId === "infra.server2")).toBe(false);
  });

  it("rejects an edge kind outside the canonical set (validation_failed, shared VALID_EDGE_KINDS)", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".", {
      edges: [{ from: "server2", to: "server", kind: "nonsense_kind" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
    expect(result.errors.join(" ")).toContain("delegates_to");
    expect(edgeRows(rig.id)).toHaveLength(0);
  });

  it("rejects a present-but-non-array edges field with validation_failed (no silent drop)", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".", {
      edges: { from: "server2", to: "server", kind: "delegates_to" } as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
    expect(setup.rigRepo.getRig(rig.id)!.nodes.some((n) => n.logicalId === "infra.server2")).toBe(false);
  });
});
