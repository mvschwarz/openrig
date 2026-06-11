import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { ExpansionRequest } from "../src/domain/types.js";

// OPR.0.3.3.24 Chunk 3 — POST /api/rigs/:rigId/pods/:podNamespace/members.
// The HTTP surface of the add_member converge op: status-code mapping mirrors
// the expand route (404 not-found, 409 conflict, 400 validation, 201 created).
describe("POST /api/rigs/:rigId/pods/:podNamespace/members", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function terminalPodFragment(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
    return {
      id,
      label: "Infrastructure",
      members: [{ id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }],
      edges: [],
    };
  }

  async function seedRigWithPod() {
    const rig = setup.rigRepo.createRig("test-rig");
    const expanded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: terminalPodFragment() });
    expect(expanded.ok).toBe(true);
    return rig;
  }

  function addMember(rigId: string, podNamespace: string, member: Record<string, unknown>, rigRoot = ".") {
    return setup.app.request(`/api/rigs/${rigId}/pods/${podNamespace}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member, rigRoot }),
    });
  }

  const terminalMember = (id: string) => ({ id, runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" });

  it("returns 201 with the added node for a valid add", async () => {
    const rig = await seedRigWithPod();
    const res = await addMember(rig.id, "infra", terminalMember("server2"));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.podNamespace).toBe("infra");
    expect(body.result.node.logicalId).toBe("infra.server2");
    expect(body.result.node.status).toBe("launched");

    // The new node is in the live rig under the existing pod.
    const updatedRig = setup.rigRepo.getRig(rig.id)!;
    expect(updatedRig.nodes.some((n) => n.logicalId === "infra.server2")).toBe(true);
  });

  it("returns 404 for a nonexistent rig", async () => {
    const res = await addMember("nonexistent", "infra", terminalMember("x"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("rig_not_found");
  });

  it("returns 404 for a nonexistent pod namespace", async () => {
    const rig = await seedRigWithPod();
    const res = await addMember(rig.id, "nope", terminalMember("x"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("pod_not_found");
    expect(body.message).toContain("infra");
  });

  it("returns 409 for a duplicate member id (dup guard kept)", async () => {
    const rig = await seedRigWithPod();
    const res = await addMember(rig.id, "infra", terminalMember("server"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("member_conflict");
  });

  it("returns 400 for a missing member in the body", async () => {
    const rig = await seedRigWithPod();
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed member fragment (validation_failed)", async () => {
    const rig = await seedRigWithPod();
    // Missing agent_ref.
    const res = await addMember(rig.id, "infra", { id: "broken", runtime: "claude-code", profile: "default", cwd: "/tmp" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_failed");
  });

  it("emits a node.added event for the added member", async () => {
    const rig = await seedRigWithPod();
    await addMember(rig.id, "infra", terminalMember("server2"));

    const added = db.prepare("SELECT payload FROM events WHERE type = 'node.added'").all() as Array<{ payload: string }>;
    const logicalIds = added.map((e) => JSON.parse(e.payload).logicalId);
    expect(logicalIds).toContain("infra.server2");
  });

  it("accepts spec-style snake_case member fields", async () => {
    const rig = await seedRigWithPod();
    const res = await addMember(rig.id, "infra", {
      id: "reviewer",
      runtime: "terminal",
      agent_ref: "builtin:terminal",
      profile: "none",
      cwd: "/tmp",
      restore_policy: "checkpoint_only",
    });
    expect(res.status).toBe(201);
    const stored = db
      .prepare("SELECT agent_ref, restore_policy FROM nodes WHERE rig_id = ? AND logical_id = ?")
      .get(rig.id, "infra.reviewer") as { agent_ref: string; restore_policy: string } | undefined;
    expect(stored?.agent_ref).toBe("builtin:terminal");
    expect(stored?.restore_policy).toBe("checkpoint_only");
  });

  // Governance FM2: pod-local edges in the request body are preserved end-to-end.
  it("persists pod-local edges declared in the body (not silently dropped)", async () => {
    const rig = await seedRigWithPod();
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member: terminalMember("server2"),
        edges: [{ from: "server2", to: "server", kind: "delegates_to" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.result.edges).toEqual([{ from: "infra.server2", to: "infra.server", kind: "delegates_to" }]);

    const rows = db.prepare("SELECT kind FROM edges WHERE rig_id = ?").all(rig.id) as Array<{ kind: string }>;
    expect(rows.some((r) => r.kind === "delegates_to")).toBe(true);
  });

  it("returns 400 for an unresolvable pod-local edge (edge_unresolved)", async () => {
    const rig = await seedRigWithPod();
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member: terminalMember("server2"),
        edges: [{ from: "server2", to: "ghost", kind: "delegates_to" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("edge_unresolved");
  });

  it("returns 400 for a present-but-non-array edges field (no silent drop)", async () => {
    const rig = await seedRigWithPod();
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: terminalMember("server2"), edges: { from: "server2", to: "server", kind: "delegates_to" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_failed");
    // Not silently created.
    expect(setup.rigRepo.getRig(rig.id)!.nodes.some((n) => n.logicalId === "infra.server2")).toBe(false);
  });

  it("returns 400 for an invalid edge kind (validation_failed)", async () => {
    const rig = await seedRigWithPod();
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: terminalMember("server2"), edges: [{ from: "server2", to: "server", kind: "nonsense_kind" }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_failed");
  });
});
