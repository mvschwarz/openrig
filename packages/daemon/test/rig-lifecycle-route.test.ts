import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

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
    setup.sessionRegistry.registerSession(launchedNode.id, "dev-impl@release-mixed-rig");

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
    const materializedNode = setup.rigRepo.getRig(rig.id)?.nodes.find((candidate) => candidate.logicalId === "infra.server");
    expect(materializedNode).toBeDefined();
    const materializedRoster = db.prepare(
      "SELECT payload FROM events WHERE rig_id = ? AND type = 'topology.roster_recorded' ORDER BY seq DESC LIMIT 1",
    ).get(rig.id) as { payload: string };
    expect(JSON.parse(materializedRoster.payload)).toMatchObject({
      intendedNodeIds: [materializedNode!.id],
      source: "materialized_topology",
    });

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
    const roster = db.prepare(
      "SELECT payload FROM events WHERE rig_id = ? AND type = 'topology.roster_recorded' ORDER BY seq DESC LIMIT 1",
    ).get(rig.id) as { payload: string };
    expect(JSON.parse(roster.payload)).toMatchObject({
      intendedNodeIds: [],
      source: "materialized_topology",
    });
  });

  it("DELETE /api/rigs/:rigId/nodes/:nodeRef refuses removal while active qitems target the session", async () => {
    const rig = setup.rigRepo.createRig("remove-active-qitem-rig");
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
    if (!expanded.ok) return;

    const sessionName = expanded.nodes[0]?.sessionName;
    expect(sessionName).toBeTruthy();
    if (!sessionName) return;

    const queueRepo = new QueueRepository(db, setup.eventBus);
    const qitem = await queueRepo.create({
      sourceSession: "source@remove-active-qitem-rig",
      destinationSession: sessionName,
      body: "must survive seat removal",
      nudge: false,
    });
    const killSession = setup.tmuxAdapter.killSession as ReturnType<typeof import("vitest").vi.fn>;
    killSession.mockClear();

    const res = await setup.app.request(`/api/rigs/${rig.id}/nodes/infra.server`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("active_qitems");
    expect(body.activeQitemIds).toEqual([qitem.qitemId]);
    expect(body.error).toContain(`rig queue fallback ${qitem.qitemId} --destination <live-seat>`);
    expect(killSession).not.toHaveBeenCalled();
    expect(setup.rigRepo.getRig(rig.id)?.nodes.find((candidate) => candidate.logicalId === "infra.server")).toBeDefined();
    expect(db.prepare("SELECT destination_session, state FROM queue_items WHERE qitem_id = ?").get(qitem.qitemId)).toEqual({
      destination_session: sessionName,
      state: "pending",
    });
  });

  it("DELETE /api/rigs/:rigId/nodes/:nodeRef reroutes active qitems to an explicit running fallback before removal", async () => {
    const rig = setup.rigRepo.createRig("remove-fallback-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "infra",
        label: "Infrastructure",
        members: [
          { id: "server", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
          { id: "fallback", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        ],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;

    const targetSession = expanded.nodes.find((node) => node.logicalId === "infra.server")?.sessionName;
    const fallbackSession = expanded.nodes.find((node) => node.logicalId === "infra.fallback")?.sessionName;
    expect(targetSession).toBeTruthy();
    expect(fallbackSession).toBeTruthy();
    if (!targetSession || !fallbackSession) return;

    const queueRepo = new QueueRepository(db, setup.eventBus);
    const qitem = await queueRepo.create({
      sourceSession: "source@remove-fallback-rig",
      destinationSession: targetSession,
      body: "must move with the removal",
      nudge: false,
    });
    const hasSession = setup.tmuxAdapter.hasSession as ReturnType<typeof import("vitest").vi.fn>;
    hasSession.mockResolvedValue(true);

    const res = await setup.app.request(
      `/api/rigs/${rig.id}/nodes/infra.server?fallback=${encodeURIComponent(fallbackSession)}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fallbackDestination).toBe(fallbackSession);
    expect(body.reroutedQitemIds).toEqual([qitem.qitemId]);
    expect(setup.rigRepo.getRig(rig.id)?.nodes.map((node) => node.logicalId)).toEqual(["infra.fallback"]);
    expect(db.prepare("SELECT qitem_id, destination_session, state FROM queue_items WHERE qitem_id = ?").get(qitem.qitemId)).toEqual({
      qitem_id: qitem.qitemId,
      destination_session: fallbackSession,
      state: "pending",
    });
  });

  it("DELETE /api/rigs/:rigId/nodes/:nodeRef refuses a non-running fallback before changing queue or topology", async () => {
    const rig = setup.rigRepo.createRig("remove-stopped-fallback-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "infra",
        label: "Infrastructure",
        members: [
          { id: "server", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
          { id: "fallback", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        ],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const targetSession = expanded.nodes.find((node) => node.logicalId === "infra.server")?.sessionName;
    const fallbackNode = expanded.nodes.find((node) => node.logicalId === "infra.fallback");
    expect(targetSession).toBeTruthy();
    expect(fallbackNode?.sessionName).toBeTruthy();
    if (!targetSession || !fallbackNode?.sessionName) return;
    db.prepare("UPDATE sessions SET status = 'exited' WHERE session_name = ?").run(fallbackNode.sessionName);

    const queueRepo = new QueueRepository(db, setup.eventBus);
    const qitem = await queueRepo.create({
      sourceSession: "source@remove-stopped-fallback-rig",
      destinationSession: targetSession,
      body: "must not move to a stopped seat",
      nudge: false,
    });
    const killSession = setup.tmuxAdapter.killSession as ReturnType<typeof import("vitest").vi.fn>;
    killSession.mockClear();

    const res = await setup.app.request(
      `/api/rigs/${rig.id}/nodes/infra.server?fallback=${encodeURIComponent(fallbackNode.sessionName)}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: false, code: "fallback_not_running" }));
    expect(killSession).not.toHaveBeenCalled();
    expect(setup.rigRepo.getRig(rig.id)?.nodes.map((node) => node.logicalId).sort()).toEqual(["infra.fallback", "infra.server"]);
    expect(db.prepare("SELECT destination_session, state FROM queue_items WHERE qitem_id = ?").get(qitem.qitemId)).toEqual({
      destination_session: targetSession,
      state: "pending",
    });
  });

  it("DELETE /api/rigs/:rigId/nodes/:nodeRef refuses a stale running fallback absent from tmux", async () => {
    const rig = setup.rigRepo.createRig("remove-stale-fallback-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "infra",
        label: "Infrastructure",
        members: [
          { id: "server", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
          { id: "fallback", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        ],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const targetSession = expanded.nodes.find((node) => node.logicalId === "infra.server")?.sessionName;
    const fallbackSession = expanded.nodes.find((node) => node.logicalId === "infra.fallback")?.sessionName;
    expect(targetSession).toBeTruthy();
    expect(fallbackSession).toBeTruthy();
    if (!targetSession || !fallbackSession) return;

    const queueRepo = new QueueRepository(db, setup.eventBus);
    const qitem = await queueRepo.create({
      sourceSession: "source@remove-stale-fallback-rig",
      destinationSession: targetSession,
      body: "must stay with the target when fallback is absent",
      nudge: false,
    });
    const hasSession = setup.tmuxAdapter.hasSession as ReturnType<typeof import("vitest").vi.fn>;
    hasSession.mockClear();
    hasSession.mockResolvedValue(false);

    const res = await setup.app.request(
      `/api/rigs/${rig.id}/nodes/infra.server?fallback=${encodeURIComponent(fallbackSession)}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: false, code: "fallback_not_running" }));
    expect(hasSession).toHaveBeenCalledTimes(1);
    expect(hasSession).toHaveBeenCalledWith(fallbackSession);
    expect(setup.rigRepo.getRig(rig.id)?.nodes.map((node) => node.logicalId).sort()).toEqual(["infra.fallback", "infra.server"]);
    expect(db.prepare("SELECT destination_session, state FROM queue_items WHERE qitem_id = ?").get(qitem.qitemId)).toEqual({
      destination_session: targetSession,
      state: "pending",
    });
  });

  it("DELETE /api/rigs/:rigId/nodes/:nodeRef refuses the removed seat as its own fallback", async () => {
    const rig = setup.rigRepo.createRig("remove-self-fallback-rig");
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
    if (!expanded.ok) return;
    const sessionName = expanded.nodes[0]?.sessionName;
    expect(sessionName).toBeTruthy();
    if (!sessionName) return;

    const res = await setup.app.request(
      `/api/rigs/${rig.id}/nodes/infra.server?fallback=${encodeURIComponent(sessionName)}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: false, code: "fallback_in_target" }));
    expect(setup.rigRepo.getRig(rig.id)?.nodes.map((node) => node.logicalId)).toEqual(["infra.server"]);
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

  it("DELETE /api/rigs/:rigId/pods/:podRef reroutes member work to an explicit fallback outside the pod", async () => {
    const rig = setup.rigRepo.createRig("shrink-fallback-rig");
    const dev = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "dev",
        label: "Development",
        members: [
          { id: "impl", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
          { id: "qa", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        ],
        edges: [],
      },
    });
    const ops = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "ops",
        label: "Operations",
        members: [{ id: "fallback", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }],
        edges: [],
      },
    });
    expect(dev.ok).toBe(true);
    expect(ops.ok).toBe(true);
    if (!dev.ok || !ops.ok) return;
    const fallbackSession = ops.nodes[0]?.sessionName;
    expect(fallbackSession).toBeTruthy();
    if (!fallbackSession) return;

    const queueRepo = new QueueRepository(db, setup.eventBus);
    const qitems = await Promise.all(dev.nodes.map((node) => queueRepo.create({
      sourceSession: "source@shrink-fallback-rig",
      destinationSession: node.sessionName!,
      body: `must move before ${node.logicalId} is removed`,
      nudge: false,
    })));
    qitems.push(await queueRepo.create({
      sourceSession: "source@shrink-fallback-rig",
      destinationSession: dev.nodes[0]!.sessionName!,
      body: "pending work must move too",
      nudge: false,
    }));
    const hasSession = setup.tmuxAdapter.hasSession as ReturnType<typeof import("vitest").vi.fn>;
    hasSession.mockResolvedValue(true);
    db.prepare("UPDATE queue_items SET state = 'in-progress' WHERE qitem_id = ?").run(qitems[0]!.qitemId);
    db.prepare("UPDATE queue_items SET state = 'blocked' WHERE qitem_id = ?").run(qitems[1]!.qitemId);

    const res = await setup.app.request(
      `/api/rigs/${rig.id}/pods/dev?fallback=${encodeURIComponent(fallbackSession)}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fallbackDestination).toBe(fallbackSession);
    expect(body.reroutedQitemIds).toEqual(qitems.map((qitem) => qitem.qitemId).sort());
    expect(setup.rigRepo.getRig(rig.id)?.nodes.map((node) => node.logicalId)).toEqual(["ops.fallback"]);
    const expectedStates = ["in-progress", "blocked", "pending"];
    qitems.forEach((qitem, index) => {
      expect(db.prepare("SELECT destination_session, state FROM queue_items WHERE qitem_id = ?").get(qitem.qitemId)).toEqual({
        destination_session: fallbackSession,
        state: expectedStates[index],
      });
    });
  });

  it("DELETE /api/rigs/:rigId/pods/:podRef refuses active work before removing an earlier pod member", async () => {
    const rig = setup.rigRepo.createRig("shrink-active-qitem-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "dev",
        label: "Development",
        members: [
          { id: "impl", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
          { id: "qa", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        ],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const qaSession = expanded.nodes.find((node) => node.logicalId === "dev.qa")?.sessionName;
    expect(qaSession).toBeTruthy();
    if (!qaSession) return;
    const queueRepo = new QueueRepository(db, setup.eventBus);
    const qitem = await queueRepo.create({
      sourceSession: "source@shrink-active-qitem-rig",
      destinationSession: qaSession,
      body: "later member work blocks the whole shrink",
      nudge: false,
    });

    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/dev`, { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({
      ok: false,
      code: "active_qitems",
      activeQitemIds: [qitem.qitemId],
    }));
    expect(setup.rigRepo.getRig(rig.id)?.nodes.map((node) => node.logicalId).sort()).toEqual(["dev.impl", "dev.qa"]);
  });

  it("DELETE /api/rigs/:rigId/pods/:podRef refuses a fallback inside the removed pod before mutation", async () => {
    const rig = setup.rigRepo.createRig("shrink-in-pod-fallback-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "dev",
        label: "Development",
        members: [
          { id: "impl", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
          { id: "qa", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        ],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const fallbackSession = expanded.nodes.find((node) => node.logicalId === "dev.qa")?.sessionName;
    expect(fallbackSession).toBeTruthy();
    if (!fallbackSession) return;

    const res = await setup.app.request(
      `/api/rigs/${rig.id}/pods/dev?fallback=${encodeURIComponent(fallbackSession)}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: false, code: "fallback_in_target" }));
    expect(setup.rigRepo.getRig(rig.id)?.nodes.map((node) => node.logicalId).sort()).toEqual(["dev.impl", "dev.qa"]);
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
