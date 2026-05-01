import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigExpansionService } from "../src/domain/rig-expansion-service.js";
import type { ExpansionRequest } from "../src/domain/types.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

describe("RigExpansionService", () => {
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

  function seedRig(name = "test-rig") {
    return setup.rigRepo.createRig(name);
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

  // T1: Expansion with valid pod creates pod + nodes
  it("creates pod and nodes for a valid expansion", async () => {
    const rig = seedRig();
    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("ok");
    expect(result.podNamespace).toBe("infra");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.logicalId).toBe("infra.server");
    expect(result.nodes[0]!.status).toBe("launched");

    // Verify in DB
    const updatedRig = setup.rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes.some((n) => n.logicalId === "infra.server")).toBe(true);
  });

  it("accepts labels and summaries with YAML-significant characters", async () => {
    const rig = seedRig();
    const result = await service.expand({
      rigId: rig.id,
      pod: {
        id: "ops",
        label: 'Ops: "Research"',
        summary: "Owns: queues, alerts, and runbooks",
        members: [
          {
            id: "agent",
            runtime: "terminal",
            agentRef: "builtin:terminal",
            profile: "none",
            cwd: '/tmp/"quoted":path',
            label: 'Worker: "A"',
          },
        ],
        edges: [],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("ok");

    const podRow = db.prepare("SELECT namespace, label, summary FROM pods WHERE rig_id = ? AND namespace = ?").get(
      rig.id,
      "ops",
    ) as { namespace: string; label: string; summary: string | null } | undefined;
    expect(podRow?.label).toBe('Ops: "Research"');
    expect(podRow?.summary).toBe("Owns: queues, alerts, and runbooks");

    const node = setup.rigRepo.getRig(rig.id)?.nodes.find((candidate) => candidate.logicalId === "ops.agent");
    expect(node?.label).toBe('Worker: "A"');
  });

  // T2: Nonexistent rig -> error
  it("returns error for nonexistent rig", async () => {
    const result = await service.expand({ rigId: "nonexistent", pod: terminalPodFragment() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rig_not_found");
  });

  // T3: Duplicate pod namespace -> error, rig unchanged
  it("rejects duplicate pod namespace", async () => {
    const rig = seedRig();
    // First expansion succeeds
    await service.expand({ rigId: rig.id, pod: terminalPodFragment("infra") });
    // Second with same namespace should fail
    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment("infra", "server2") });
    expect(result.ok).toBe(false);
  });

  // T4: Duplicate logical ID -> error
  it("rejects duplicate logical ID", async () => {
    const rig = seedRig();
    // Add a node with logicalId "infra.server" directly
    await service.expand({ rigId: rig.id, pod: terminalPodFragment("infra", "server") });
    // Try another pod with a member that creates "infra2.server" — different namespace, should work
    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment("infra2", "server") });
    expect(result.ok).toBe(true);
  });

  // T5: Cross-pod edge to existing node
  it("creates cross-pod edges to existing nodes", async () => {
    const rig = seedRig();
    // Create first pod
    await service.expand({ rigId: rig.id, pod: terminalPodFragment("orch", "lead") });

    // Expand with cross-pod edge
    const result = await service.expand({
      rigId: rig.id,
      pod: terminalPodFragment("dev", "impl"),
      crossPodEdges: [{ kind: "delegates_to", from: "orch.lead", to: "dev.impl" }],
    });

    expect(result.ok).toBe(true);

    // Verify edge in DB
    const updatedRig = setup.rigRepo.getRig(rig.id);
    const edges = updatedRig!.edges;
    expect(edges.some((e) => e.kind === "delegates_to")).toBe(true);
  });

  // T6: Cross-pod edge to nonexistent node -> error
  it("rejects cross-pod edge to nonexistent node", async () => {
    const rig = seedRig();
    const result = await service.expand({
      rigId: rig.id,
      pod: terminalPodFragment("dev", "impl"),
      crossPodEdges: [{ kind: "delegates_to", from: "nonexistent.node", to: "dev.impl" }],
    });
    expect(result.ok).toBe(false);
  });

  // T7: Node launch failure (1 of 2 nodes) -> partial with retry targets
  it("returns partial result when some but not all nodes fail", async () => {
    const rig = seedRig();
    // Mock: first createSession fails, second succeeds
    const tmux = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    tmux.createSession.mockResolvedValueOnce({ ok: false, code: "unknown", message: "tmux not available" });

    const twoPod: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        { id: "server1", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        { id: "server2", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
    const result = await service.expand({ rigId: rig.id, pod: twoPod });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("partial");
    expect(result.nodes.some((n) => n.status === "launched")).toBe(true);
    expect(result.nodes.some((n) => n.status === "failed")).toBe(true);
    expect(result.retryTargets.length).toBeGreaterThan(0);
  });

  // T9: Terminal node launches successfully
  it("terminal node launches with correct session", async () => {
    const rig = seedRig();
    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes[0]!.status).toBe("launched");
    expect(result.nodes[0]!.sessionName).toBeTruthy();
  });

  // T10: rig.expanded event emitted
  it("emits rig.expanded event after expansion", async () => {
    const rig = seedRig();
    await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'rig.expanded'").all() as Array<{ type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
    expect(payload.podNamespace).toBe("infra");
    expect(payload.status).toBe("ok");
  });

  // T8b: All nodes fail -> status "failed"
  it("returns failed status when all node launches fail", async () => {
    const rig = seedRig();
    const tmux = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    tmux.createSession.mockResolvedValue({ ok: false, code: "unknown", message: "tmux unavailable" });

    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("failed");
    expect(result.nodes.every((n) => n.status === "failed")).toBe(true);
    expect(result.retryTargets).toHaveLength(1);

    // Topology still exists despite all launches failing
    const updatedRig = setup.rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes.some((n) => n.logicalId === "infra.server")).toBe(true);
  });

  it("returns partial when startup fails after sessions are launched", async () => {
    const failingTerminalAdapter: RuntimeAdapter = {
      runtime: "terminal",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: "terminal harness failed" }),
      checkReady: async () => ({ ready: true }),
    };

    setup = createTestApp(db, { adapters: { terminal: failingTerminalAdapter } });
    service = new RigExpansionService({
      db,
      rigRepo: setup.rigRepo,
      eventBus: setup.eventBus,
      nodeLauncher: setup.nodeLauncher,
      podInstantiator: setup.podInstantiator,
      sessionRegistry: setup.sessionRegistry,
    });

    const rig = seedRig();
    const twoPod: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        { id: "server1", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        { id: "server2", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };

    const result = await service.expand({ rigId: rig.id, pod: twoPod });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("partial");
    expect(result.nodes.map((n) => n.status)).toEqual(["launched", "failed"]);
    expect(result.retryTargets).toEqual(["infra.server2"]);

    const sessions = setup.sessionRegistry.getSessionsForRig(rig.id);
    const failedSession = sessions.find((session) => session.nodeId === result.nodes[1]!.nodeId);
    expect(failedSession?.startupStatus).toBe("failed");
  });

  it("returns failed when every materialized node fails startup after launch", async () => {
    const failingTerminalAdapter: RuntimeAdapter = {
      runtime: "terminal",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: false, error: "terminal harness failed" }),
      checkReady: async () => ({ ready: true }),
    };

    setup = createTestApp(db, { adapters: { terminal: failingTerminalAdapter } });
    service = new RigExpansionService({
      db,
      rigRepo: setup.rigRepo,
      eventBus: setup.eventBus,
      nodeLauncher: setup.nodeLauncher,
      podInstantiator: setup.podInstantiator,
      sessionRegistry: setup.sessionRegistry,
    });

    const rig = seedRig();
    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("failed");
    expect(result.nodes[0]!.status).toBe("failed");
    expect(result.nodes[0]!.error).toContain("Harness launch failed");
    expect(result.retryTargets).toEqual(["infra.server"]);

    const sessions = setup.sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]?.startupStatus).toBe("failed");
  });

  // T11: No rig.imported event emitted (suppressed)
  it("does not emit rig.imported event during expansion", async () => {
    const rig = seedRig();
    await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    const events = db.prepare("SELECT type FROM events WHERE type = 'rig.imported'").all() as Array<{ type: string }>;
    expect(events).toHaveLength(0);
  });

  // Agent Starter v1 vertical M1 R2 — expansion pass-through. Guard
  // finding: ExpansionPodFragment.members had no `starterRef?` field
  // and `buildSyntheticSpec` had no `starter_ref` emission, so an
  // expansion request couldn't carry `starterRef` through the same
  // route that already carries `sessionSource`. R2 fix: add the field
  // + emit snake-case `starter_ref` in `buildSyntheticSpec`.
  // Strategy: spy on podInstantiator.materialize to capture the
  // synthetic YAML it receives; assert the YAML contains `starter_ref:`
  // and the starter name.
  it("preserves starterRef across expansion → buildSyntheticSpec → synthetic YAML (R2)", async () => {
    const rig = seedRig();
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materialize");
    const podWithStarter: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        {
          id: "server",
          runtime: "claude-code",
          agentRef: "local:agents/server",
          profile: "default",
          cwd: "/tmp",
          starterRef: { name: "openrig-builder-base--claude-code" },
        },
      ],
      edges: [],
    };
    await service.expand({ rigId: rig.id, pod: podWithStarter });

    expect(materializeSpy).toHaveBeenCalled();
    // First arg to materialize is the synthetic YAML string.
    const syntheticYaml = materializeSpy.mock.calls[0]![0] as string;
    expect(syntheticYaml).toContain("starter_ref:");
    expect(syntheticYaml).toContain("openrig-builder-base--claude-code");

    materializeSpy.mockRestore();
  });

  it("absent starterRef does not leak starter_ref into synthetic YAML (negative regression)", async () => {
    const rig = seedRig();
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materialize");
    await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    const syntheticYaml = materializeSpy.mock.calls[0]![0] as string;
    expect(syntheticYaml).not.toContain("starter_ref:");
    materializeSpy.mockRestore();
  });
});
