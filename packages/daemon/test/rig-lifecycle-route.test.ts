import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("Rig lifecycle routes", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/sessions/:sessionRef/unclaim releases a claimed session and reactivates discovery", async () => {
    const rig = setup.rigRepo.createRig("claim-rig");
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-claim-session",
      tmuxPane: "%1",
      cwd: "/tmp",
      activeCommand: "codex",
      runtimeHint: "codex",
      confidence: "high",
    });

    setup.rigRepo.addNode(rig.id, "external.helper", { runtime: "codex" });
    const claimed = await setup.claimService.bind({
      discoveredId: discovered.id,
      rigId: rig.id,
      logicalId: "external.helper",
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const res = await setup.app.request(`/api/sessions/${claimed.sessionId}/unclaim`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe(claimed.sessionId);

    const sessions = setup.sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions.find((session) => session.id === claimed.sessionId)?.status).toBe("detached");

    const rigState = setup.rigRepo.getRig(rig.id);
    const node = rigState?.nodes.find((candidate) => candidate.logicalId === "external.helper");
    expect(node?.binding).toBeNull();

    const rediscovered = setup.discoveryRepo.getDiscoveredSession(discovered.id);
    expect(rediscovered?.status).toBe("active");
    expect(rediscovered?.claimedNodeId).toBeNull();
  });

  it("POST /api/rigs/:rigId/release releases claimed sessions without killing tmux and deletes the rig", async () => {
    const rig = setup.rigRepo.createRig("release-rig");
    const discoveredA = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-release-a",
      tmuxPane: "%11",
      cwd: "/tmp",
      activeCommand: "codex",
      runtimeHint: "codex",
      confidence: "high",
    });
    const discoveredB = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-release-b",
      tmuxPane: "%12",
      cwd: "/tmp",
      activeCommand: "codex",
      runtimeHint: "codex",
      confidence: "high",
    });

    setup.rigRepo.addNode(rig.id, "external.a", { runtime: "codex" });
    setup.rigRepo.addNode(rig.id, "external.b", { runtime: "codex" });

    const boundA = await setup.claimService.bind({
      discoveredId: discoveredA.id,
      rigId: rig.id,
      logicalId: "external.a",
    });
    const boundB = await setup.claimService.bind({
      discoveredId: discoveredB.id,
      rigId: rig.id,
      logicalId: "external.b",
    });
    expect(boundA.ok).toBe(true);
    expect(boundB.ok).toBe(true);

    const res = await setup.app.request(`/api/rigs/${rig.id}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.released).toHaveLength(2);
    expect(setup.rigRepo.getRig(rig.id)).toBeNull();
    expect(setup.discoveryRepo.getDiscoveredSession(discoveredA.id)?.status).toBe("active");
    expect(setup.discoveryRepo.getDiscoveredSession(discoveredB.id)?.status).toBe("active");

    const killSession = setup.tmuxAdapter.killSession as ReturnType<typeof import("vitest").vi.fn>;
    expect(killSession).not.toHaveBeenCalled();
  });

  it("POST /api/rigs/:rigId/release refuses rigs containing launched nodes", async () => {
    const rig = setup.rigRepo.createRig("release-mixed-rig");
    const launchedNode = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    setup.sessionRegistry.registerSession(launchedNode.id, "dev.impl@release-mixed-rig");

    const res = await setup.app.request(`/api/rigs/${rig.id}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: true }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("contains_launched_nodes");
    expect(body.launchedLogicalIds).toEqual(["dev.impl"]);
    expect(setup.rigRepo.getRig(rig.id)).not.toBeNull();
  });

  it("DELETE /api/rigs/:rigId/nodes/:nodeRef kills the session and removes the node", async () => {
    const rig = setup.rigRepo.createRig("remove-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "infra",
        label: "Infrastructure",
        members: [{ id: "server", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);

    const res = await setup.app.request(`/api/rigs/${rig.id}/nodes/infra.server`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.logicalId).toBe("infra.server");

    const rigState = setup.rigRepo.getRig(rig.id);
    expect(rigState?.nodes.find((candidate) => candidate.logicalId === "infra.server")).toBeUndefined();

    const events = db.prepare("SELECT type FROM events WHERE type = 'node.removed'").all() as Array<{ type: string }>;
    expect(events).toHaveLength(1);
  });

  it("DELETE /api/rigs/:rigId/nodes/:nodeRef preserves a previously detached claimed session while removing the node", async () => {
    const rig = setup.rigRepo.createRig("remove-detached-rig");
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "phase4-detached-remove",
      tmuxPane: "%44",
      cwd: "/tmp",
      activeCommand: "zsh",
      runtimeHint: "terminal",
      confidence: "high",
    });

    setup.rigRepo.addNode(rig.id, "external.helper", { runtime: "codex" });
    const claimed = await setup.claimService.bind({
      discoveredId: discovered.id,
      rigId: rig.id,
      logicalId: "external.helper",
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const unclaim = await setup.app.request(`/api/sessions/${claimed.sessionId}/unclaim`, {
      method: "POST",
    });
    expect(unclaim.status).toBe(200);

    const res = await setup.app.request(`/api/rigs/${rig.id}/nodes/external.helper`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionsKilled).toBe(0);

    const killSession = setup.tmuxAdapter.killSession as ReturnType<typeof import("vitest").vi.fn>;
    expect(killSession).not.toHaveBeenCalled();
    expect(setup.rigRepo.getRig(rig.id)?.nodes.find((candidate) => candidate.logicalId === "external.helper")).toBeUndefined();
  });

  it("DELETE /api/rigs/:rigId/pods/:podRef removes all nodes in the pod and deletes the pod", async () => {
    const rig = setup.rigRepo.createRig("shrink-rig");
    const seed = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "dev",
        label: "Development",
        members: [
          { id: "impl", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
          { id: "qa", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        ],
        edges: [{ from: "impl", to: "qa", kind: "delegates_to" }],
      },
    });
    expect(seed.ok).toBe(true);

    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/dev`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.namespace).toBe("dev");
    expect(body.removedLogicalIds).toEqual(["dev.impl", "dev.qa"]);

    const podRows = db.prepare("SELECT id FROM pods WHERE rig_id = ?").all(rig.id) as Array<{ id: string }>;
    expect(podRows).toHaveLength(0);
    const rigState = setup.rigRepo.getRig(rig.id);
    expect(rigState?.nodes).toHaveLength(0);

    const podEvents = db.prepare("SELECT type FROM events WHERE type = 'pod.deleted'").all() as Array<{ type: string }>;
    expect(podEvents).toHaveLength(1);
  });

  it("DELETE /api/rigs/:rigId/pods/:podRef returns partial state when a later node removal fails", async () => {
    const rig = setup.rigRepo.createRig("shrink-partial-rig");
    const seed = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "dev",
        label: "Development",
        members: [
          { id: "impl", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
          { id: "qa", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        ],
        edges: [{ from: "impl", to: "qa", kind: "delegates_to" }],
      },
    });
    expect(seed.ok).toBe(true);

    const killSession = setup.tmuxAdapter.killSession as ReturnType<typeof import("vitest").vi.fn>;
    killSession
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, code: "kill_failed", message: "tmux timeout" });

    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/dev`, {
      method: "DELETE",
    });

    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("partial");
    expect(body.removedLogicalIds).toEqual(["dev.impl"]);
    expect(body.sessionsKilled).toBe(1);
    expect(body.nodes).toEqual([
      expect.objectContaining({ logicalId: "dev.impl", status: "removed", sessionsKilled: 1 }),
      expect.objectContaining({ logicalId: "dev.qa", status: "failed", sessionsKilled: 0 }),
    ]);
    expect(body.nodes[1].error).toContain("tmux timeout");

    const rigState = setup.rigRepo.getRig(rig.id);
    expect(rigState?.nodes.map((node) => node.logicalId)).toEqual(["dev.qa"]);

    const podRows = db.prepare("SELECT namespace FROM pods WHERE rig_id = ?").all(rig.id) as Array<{ namespace: string }>;
    expect(podRows.map((pod) => pod.namespace)).toEqual(["dev"]);

    const podEvents = db.prepare("SELECT type FROM events WHERE type = 'pod.deleted'").all() as Array<{ type: string }>;
    expect(podEvents).toHaveLength(0);
  });
});
