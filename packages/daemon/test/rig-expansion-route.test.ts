import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("POST /api/rigs/:rigId/expand", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function seedRig(name = "test-rig") {
    return setup.rigRepo.createRig(name);
  }

  function terminalPod(id = "infra", memberId = "server") {
    return {
      id,
      label: "Infrastructure",
      members: [
        { id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
  }

  // Seam B (R2 terminal at 4ac243c3): present-INVALID permission_policy must reach the
  // ONE canonical validator — the normalizer may not erase presence into absence/floor.
  it("SEAM-B RED: expansion member permission_policy: null -> structured 400, ZERO persistence, NO launch (rig carries builtin:yolo)", async () => {
    const rig = seedRig("null-policy-rig");
    setup.rigRepo.setRigPermissionPolicy(rig.id, "builtin:yolo");
    setup.rigRepo.setRigPolicyProvenance(rig.id, { origin: "builtin", resolvedTarget: "policies/builtin/yolo.policy.md", declaringDir: null, launchPosture: "full_bypass" });
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev2", label: "Dev2", members: [
        { id: "late", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp", permission_policy: null },
      ], edges: [] } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/permission_policy/);
    // zero persistence: no member node, no session, no edges for the rejected pod
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'dev2.%'").get()).toMatchObject({ c: 0 });
  });

  it("SEAM-B RED: another present-invalid shape (number) is also a structured 400, never coerced/erased", async () => {
    const rig = seedRig("num-policy-rig");
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev3", label: "Dev3", members: [
        { id: "late", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp", permission_policy: 42 },
      ], edges: [] } }),
    });
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'dev3.%'").get()).toMatchObject({ c: 0 });
  });

  it("SEAM-B control: a VALID string permission_policy and TRUE absence both keep working through expansion", async () => {
    const rig = seedRig("valid-policy-rig");
    const ok = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev4", label: "Dev4", members: [
        { id: "server", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ], edges: [] } }),
    });
    expect(ok.status).toBe(201);
  });

  // T1: Valid expansion -> 201
  it("returns 201 with ok result for valid expansion", async () => {
    const rig = seedRig();
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.podNamespace).toBe("infra");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].logicalId).toBe("infra.server");
  });

  // T2: Nonexistent rig -> 404
  it("returns 404 for nonexistent rig", async () => {
    const res = await setup.app.request("/api/rigs/nonexistent/expand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });
    expect(res.status).toBe(404);
  });

  // T3: Duplicate namespace -> 409
  it("returns 409 for duplicate pod namespace", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("infra") }),
    });

    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("infra", "server2") }),
    });
    expect(res.status).toBe(409);
  });

  // T4: Launch failure -> 207
  it("returns 207 for expansion with launch failure", async () => {
    const rig = seedRig();
    const tmux = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    tmux.createSession.mockResolvedValueOnce({ ok: false, code: "unknown", message: "tmux not available" });

    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(["partial", "failed"]).toContain(body.status);
  });

  // T5: Exactly one rig.expanded event
  it("emits exactly one rig.expanded event", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const events = db.prepare("SELECT type FROM events WHERE type = 'rig.expanded'").all() as Array<{ type: string }>;
    expect(events).toHaveLength(1);
  });

  // T6: Missing body -> 400
  it("returns 400 for missing pod in body", async () => {
    const rig = seedRig();
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // T7a: rig.expanded in events table
  it("rig.expanded event contains correct payload", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const events = db.prepare("SELECT payload FROM events WHERE type = 'rig.expanded'").all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
    expect(payload.podNamespace).toBe("infra");
    expect(payload.status).toBe("ok");
  });

  // T7b: Detail events (pod.created, node.added) also emitted
  it("detail events (pod.created, node.added) emitted during expansion", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const podEvents = db.prepare("SELECT type FROM events WHERE type = 'pod.created'").all();
    const nodeEvents = db.prepare("SELECT type FROM events WHERE type = 'node.added'").all();
    expect(podEvents.length).toBeGreaterThanOrEqual(1);
    expect(nodeEvents.length).toBeGreaterThanOrEqual(1);
  });

  // T8: Cross-pod edges -> 201
  it("expansion with cross-pod edges returns 201", async () => {
    const rig = seedRig();
    // First pod
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("orch", "lead") }),
    });

    // Second pod with cross-pod edge
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: terminalPod("dev", "impl"),
        crossPodEdges: [{ kind: "delegates_to", from: "orch.lead", to: "dev.impl" }],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("expansion with edge from new pod to existing node launches only the new node", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("backend", "api") }),
    });

    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: terminalPod("ops", "monitor"),
        crossPodEdges: [{ kind: "delegates_to", from: "ops.monitor", to: "backend.api" }],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].logicalId).toBe("ops.monitor");
  });

  it("accepts spec-style snake_case member fields in pod fragments", async () => {
    const rig = seedRig();
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "qa",
          label: "QA",
          members: [
            {
              id: "reviewer",
              runtime: "terminal",
              agent_ref: "builtin:terminal",
              profile: "none",
              cwd: "/tmp",
              restore_policy: "checkpoint_only",
            },
          ],
          edges: [],
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodes[0].logicalId).toBe("qa.reviewer");
    const stored = db
      .prepare("SELECT agent_ref, restore_policy FROM nodes WHERE rig_id = ? AND logical_id = ?")
      .get(rig.id, "qa.reviewer") as { agent_ref: string; restore_policy: string } | undefined;
    expect(stored?.agent_ref).toBe("builtin:terminal");
    expect(stored?.restore_policy).toBe("checkpoint_only");
  });

  // OPR.0.5.6.3 repair (wave-1 R2 HOLD): the route normalizer recognized only
  // fork/rebuild and silently dropped the entire agent_image session source
  // BEFORE the service mapper could preserve ref.version — the landed S03
  // service test exercised RigExpansionService directly and bypassed this
  // ingress. These pins ride the REAL HTTP route and observe the
  // service/materialized-spec boundary (the materializeStructured argument).
  it("agent_image session_source with a version pin survives the real expand ingress to the materialized spec", async () => {
    const rig = seedRig("image-pin-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "img",
          label: "Imaged",
          members: [
            {
              id: "worker",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              cwd: "/tmp",
              session_source: { mode: "agent_image", ref: { kind: "image_name", value: "builder-base", version: "3" } },
            },
          ],
          edges: [],
        },
      }),
    });

    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = specObject.pods[0]!.members[0]!;
    expect(member["session_source"]).toEqual({
      mode: "agent_image",
      ref: { kind: "image_name", value: "builder-base", version: "3" },
    });
    materializeSpy.mockRestore();
  });

  it("unversioned agent_image session_source survives the ingress with NO version key invented", async () => {
    const rig = seedRig("image-unpinned-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "img2",
          label: "Imaged2",
          members: [
            {
              id: "worker",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              cwd: "/tmp",
              session_source: { mode: "agent_image", ref: { kind: "image_name", value: "builder-base" } },
            },
          ],
          edges: [],
        },
      }),
    });

    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = specObject.pods[0]!.members[0]!;
    expect(member["session_source"]).toEqual({
      mode: "agent_image",
      ref: { kind: "image_name", value: "builder-base" },
    });
    materializeSpy.mockRestore();
  });

  it("invalid agent_image shapes are not widened by the ingress (empty value, wrong kind, non-string version)", async () => {
    const rig = seedRig("image-invalid-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    const post = (sessionSource: unknown, podId: string) =>
      setup.app.request(`/api/rigs/${rig.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pod: {
            id: podId,
            label: "X",
            members: [
              { id: "w", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", session_source: sessionSource },
            ],
            edges: [],
          },
        }),
      });

    await post({ mode: "agent_image", ref: { kind: "image_name", value: "" } }, "inv1");
    await post({ mode: "agent_image", ref: { kind: "image_id", value: "x" } }, "inv2");
    await post({ mode: "agent_image", ref: { kind: "image_name", value: "ok", version: 3 } }, "inv3");

    const captured = materializeSpy.mock.calls.map((call) => {
      const spec = call[0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
      return spec.pods[0]!.members[0]!["session_source"];
    });
    // empty value and wrong kind: no session_source constructed
    expect(captured[0]).toBeUndefined();
    expect(captured[1]).toBeUndefined();
    // non-string version: the source passes with the pin OMITTED, never coerced
    expect(captured[2]).toEqual({ mode: "agent_image", ref: { kind: "image_name", value: "ok" } });
    materializeSpy.mockRestore();
  });
});
