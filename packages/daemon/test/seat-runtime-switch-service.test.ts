import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { DefaultOccupantInvalidator } from "../src/domain/occupant-invalidator.js";
import { SeatRuntimeSwitchService } from "../src/domain/seat-runtime-switch-service.js";
import { recoverRuntimeSwitch, type RuntimeSwitchIntent } from "../src/domain/runtime-switch-recovery.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { runtimeRungInventory } from "../src/domain/activity-taxonomy.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";

describe("live seat runtime switching", () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); });
  afterEach(() => { db.close(); });

  function fixture(runtime: "codex" | "claude-code" = "codex") {
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const discoveryRepo = new DiscoveryRepository(db);
    const rig = rigRepo.createRig("switch-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime, cwd: "/workspace", model: "old-model", effort: "old-effort", codexConfigProfile: "old-profile" });
    const sibling = rigRepo.addNode(rig.id, "dev.review", { runtime: "codex", cwd: "/workspace" });
    rigRepo.addEdge(rig.id, node.id, sibling.id, "delegates_to");
    const name = "dev-impl@switch-rig";
    const session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    sessionRegistry.updateResumeToken(session.id, runtime === "codex" ? "codex_id" : "claude_id", "old-native-id", "scrape");
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    const sessions = new Map([[name, { pane: "%1", env: { OPENRIG_NODE_ID: node.id, OPENRIG_OCCUPANT_GENERATION: generation } as Record<string, string>, dead: false }]]);
    const timeline: string[] = [];
    let paneNumber = 1;
    const tmux = {
      deliveryGuard: new SeatDeliveryGuard(db, target => resolveGuardTarget(db, target)),
      createSession: vi.fn(async (sessionName: string, _cwd: string, env: Record<string, string>) => {
        timeline.push("create");
        sessions.set(sessionName, { pane: `%${++paneNumber}`, env, dead: false });
        return { ok: true };
      }),
      listPanes: vi.fn(async (sessionName: string) => {
        const value = sessions.get(sessionName);
        if (!value) throw new Error("session absent");
        return [{ id: value.pane, active: true }];
      }),
      probeSession: vi.fn(async (sessionName: string) => ({ state: sessions.has(sessionName) ? "present" : "absent" })),
      listWindows: vi.fn(async () => [{ index: 0 }]),
      getDefaultShell: vi.fn(async () => "/bin/sh"),
      getPaneCommand: vi.fn(async () => "sh"),
      capturePaneScreen: vi.fn(async () => "incumbent unfinished task"),
      sendText: vi.fn(async (sessionName: string, _text: string) => { timeline.push(sessionName === name ? "activate" : "context"); return { ok: true }; }),
      sendKeys: vi.fn(async () => ({ ok: true })),
      swapRuntimeSwitchPanes: vi.fn(async (input: { canonicalSession: string; session: string }) => {
        timeline.push("swap");
        const a = sessions.get(input.canonicalSession)!;
        const b = sessions.get(input.session)!;
        [a.pane, b.pane] = [b.pane, a.pane];
        [a.dead, b.dead] = [b.dead, a.dead];
        return { ok: true };
      }),
      recoverRuntimeSwitchSession: vi.fn(async (input: { nodeId: string; session: string; pane: string; generation: string }) => {
        const owned = sessions.get(input.session)!;
        return owned.pane === input.pane && owned.env.OPENRIG_NODE_ID === input.nodeId && owned.env.OPENRIG_OCCUPANT_GENERATION === input.generation
          ? { ok: true } : { ok: false, code: "identity_changed", message: "helper ownership changed" };
      }),
      setRemainOnExit: vi.fn(async () => ({ ok: true })),
      signalPaneProcess: vi.fn(async (sessionName: string) => { timeline.push(`retire:${sessions.get(sessionName)!.pane}`); sessions.get(sessionName)!.dead = true; return { ok: true }; }),
      isPaneDead: vi.fn(async (sessionName: string) => sessions.get(sessionName)?.dead ?? true),
      killSession: vi.fn(async (sessionName: string) => { sessions.delete(sessionName); return { ok: true }; }),
      setRuntimeSwitchEnvironment: vi.fn(async () => ({ ok: true })),
      finishLaunchBinding: vi.fn(),
    };
    const launchHarness = vi.fn(async (binding: NodeBinding) => {
      timeline.push("launch");
      expect(sessions.get(name)!.dead).toBe(false);
      expect(sessions.get(name)!.pane).toBe("%1");
      expect(sessionRegistry.currentOccupantTenure(node.id)!.generationUuid).toBe(generation);
      expect(binding.launchGeneration).not.toBe(generation);
      return { ok: true, resumeToken: "new-native-id" };
    });
    const checkReady = vi.fn(async () => { timeline.push("ready"); return { ready: true }; });
    const adapter = { launchHarness, checkReady, project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })) };
    const runtimeAdapters = { codex: { ...adapter, runtime: "codex" }, "claude-code": { ...adapter, runtime: "claude-code" } } as unknown as Record<string, RuntimeAdapter>;
    const invalidateMemory = vi.fn();
    const occupantInvalidator = new DefaultOccupantInvalidator({ enforcer: { invalidateOccupant: invalidateMemory },
      contextUsage: { invalidateOccupantSidecar: invalidateMemory }, queue: new QueueRepository(db, eventBus) });
    const deps = { db, rigRepo, sessionRegistry, discoveryRepo, eventBus, occupantInvalidator, tmuxAdapter: tmux as unknown as TmuxAdapter,
      runtimeAdapters, readinessTimeoutMs: 5, sleep: async () => {} };
    const service = new SeatRuntimeSwitchService(deps);
    const run = (extra: Record<string, unknown> = {}) => service.setRuntime({ seatRef: name, runtime: runtime === "codex" ? "claude-code" : "codex", reason: "operator runtime change", ...extra });
    const rows = () => JSON.stringify(["nodes", "sessions", "bindings", "occupant_tenures", "node_startup_context", "node_permission_selections", "snapshots", "events"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
    return { rigRepo, sessionRegistry, eventBus, discoveryRepo, rig, node, sibling, name, session, generation, sessions, timeline, tmux, adapter, launchHarness, checkReady, deps, service, run, rows, invalidateMemory };
  }

  it.each(["codex", "claude-code"] as const)("starts before retirement and preserves the graph/queue when leaving %s", async runtime => {
    const f = fixture(runtime);
    new NativePermissionStore(db).write(f.node.id, { runtime, mode: "full_bypass" }, f.name, "prior choice");
    const queue = new QueueRepository(db, f.eventBus, { resolveOccupantGeneration: name => f.sessionRegistry.currentOccupantGenerationForSession(name) });
    const item = await queue.create({ sourceSession: f.name, destinationSession: f.name, body: "unfinished obligation", nudge: false });
    await queue.claim({ qitemId: item.qitemId, destinationSession: f.name });
    const beforeQueue = db.prepare("SELECT * FROM queue_items").all() as Array<Record<string, unknown>>;
    const beforeGraph = db.prepare("SELECT * FROM edges").all();
    const beforeSibling = db.prepare("SELECT * FROM nodes WHERE id=?").get(f.sibling.id);
    const observed: boolean[] = [];
    f.eventBus.subscribe(() => { observed.push(db.inTransaction); });
    const result = await f.run();
    expect(result).toMatchObject({ ok: true, changed: true, from: runtime, to: runtime === "codex" ? "claude-code" : "codex", recoveryPending: false, openQueueItems: 1 });
    expect(f.timeline.indexOf("ready")).toBeLessThan(f.timeline.indexOf("retire:%1"));
    expect(f.timeline.indexOf("context")).toBeLessThan(f.timeline.indexOf("retire:%1"));
    expect(f.timeline.indexOf("retire:%1")).toBeLessThan(f.timeline.indexOf("activate"));
    expect(f.sessions.size).toBe(1);
    expect(f.sessions.get(f.name)!.pane).toBe("%2");
    expect(f.sessionRegistry.getBindingForNode(f.node.id)).toMatchObject({ tmuxSession: f.name, tmuxPane: "%2" });
    expect(db.prepare("SELECT * FROM edges").all()).toEqual(beforeGraph);
    expect(db.prepare("SELECT * FROM queue_items").all()).toEqual(beforeQueue.map(row => ({ ...row,
      claimed_by_generation_uuid: f.sessionRegistry.currentOccupantTenure(f.node.id)!.generationUuid })));
    expect(db.prepare("SELECT * FROM nodes WHERE id=?").get(f.sibling.id)).toEqual(beforeSibling);
    expect(new NativePermissionStore(db).read(f.node.id)).toBeNull();
    const launchBinding = f.launchHarness.mock.calls[0]![0];
    expect(launchBinding).toMatchObject({ model: undefined, effort: undefined, codexConfigProfile: undefined });
    const savedSessions = f.sessionRegistry.getSessionsForRig(f.rig.id);
    expect(savedSessions.find(row => row.id === f.session.id)).toMatchObject({ resumeToken: "old-native-id", status: "superseded" });
    expect(savedSessions.find(row => row.status === "running")).toMatchObject({ resumeToken: "new-native-id", resumeType: runtime === "codex" ? "claude_id" : "codex_id" });
    expect(new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry }).exportRig(f.rig.id)).toMatchObject({ nodes: expect.arrayContaining([expect.objectContaining({ id: f.node.logicalId, runtime: runtime === "codex" ? "claude-code" : "codex" })]) });
    expect(db.prepare("SELECT kind FROM snapshots").all()).toEqual([{ kind: "runtime-switch" }]);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed).not.toContain(true);
  });

  it.each(["codex", "claude-code"] as const)("records the committed tenure in the activity oracle when leaving %s", async runtime => {
    const f = fixture(runtime);
    const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3 });
    oracle.declareRungInventory({ seatNodeId: f.node.id, sessionName: f.name }, runtimeRungInventory(runtime));
    const service = new SeatRuntimeSwitchService({ ...f.deps, activityOracle: oracle });
    const result = await service.setRuntime({ seatRef: f.name, runtime: runtime === "codex" ? "claude-code" : "codex", reason: "fixture switch" });
    expect(result).toMatchObject({ ok: true, changed: true });
    const generation = f.sessionRegistry.currentOccupantTenure(f.node.id)!.generationUuid;
    expect(oracle.getSeatState(f.node.id)?.lastSwap).toMatchObject({ generation });
    expect(generation).not.toBe(f.generation);
  });

  it.each(["launch", "readiness", "context", "submit", "swap", "commit"])("keeps the incumbent and rolls back on %s failure", async phase => {
    const f = fixture();
    const before = f.rows();
    if (phase === "launch") f.launchHarness.mockRejectedValueOnce(new Error("launch failed"));
    if (phase === "readiness") f.checkReady.mockResolvedValue({ ready: false });
    if (phase === "context") f.tmux.sendText.mockRejectedValueOnce(new Error("paste failed"));
    if (phase === "submit") f.tmux.sendKeys.mockRejectedValueOnce(new Error("submit failed"));
    if (phase === "swap") f.tmux.swapRuntimeSwitchPanes.mockRejectedValueOnce(new Error("swap failed"));
    const notified = vi.fn();
    f.eventBus.subscribe(notified);
    if (phase === "commit") {
      const persist = f.eventBus.persistWithinTransaction.bind(f.eventBus);
      vi.spyOn(f.eventBus, "persistWithinTransaction").mockImplementation(event => {
        if (event.type === "seat.runtime_changed") throw new Error("commit failed");
        return persist(event);
      });
    }
    expect(await f.run()).toMatchObject({ ok: false, code: "runtime_switch_failed", recoveryPending: false });
    expect(f.rows()).toBe(before);
    expect(f.sessions.size).toBe(1);
    expect(f.sessions.get(f.name)).toMatchObject({ pane: "%1", dead: false });
    expect(f.timeline).not.toContain("retire:%1");
    expect(db.prepare("SELECT * FROM seat_runtime_switches").all()).toEqual([]);
    expect(notified).not.toHaveBeenCalled();
    expect(f.invalidateMemory).not.toHaveBeenCalled();
  });

  it("dry-run performs no launch, generation mint or persisted write", async () => {
    const f = fixture();
    const before = f.rows();
    expect(await f.run({ dryRun: true, model: "target-model", effort: "high" })).toMatchObject({ ok: true, dryRun: true, changed: false, settings: { model: "target-model", effort: "high" } });
    expect(f.timeline).toEqual([]);
    expect(f.rows()).toBe(before);
  });

  it("does not overwrite a setting changed while the successor was starting", async () => {
    const f = fixture();
    f.launchHarness.mockImplementationOnce(async () => {
      f.rigRepo.setNodeModel(f.node.id, "operator-edited-model");
      return { ok: true, resumeToken: "new-native-id" };
    });
    expect(await f.run()).toMatchObject({ ok: false, code: "runtime_switch_failed", recoveryPending: false });
    expect(f.rigRepo.getRig(f.rig.id)!.nodes.find(node => node.id === f.node.id)).toMatchObject({ runtime: "codex", model: "operator-edited-model" });
    expect(f.sessions.get(f.name)).toMatchObject({ pane: "%1", dead: false });
  });

  it("retains an authoritative committed intent when retirement fails, then finishes forward", async () => {
    const f = fixture();
    f.tmux.signalPaneProcess.mockRejectedValueOnce(new Error("retirement unavailable"));
    expect(await f.run()).toMatchObject({ ok: true, changed: true, recoveryPending: true });
    const intent = db.prepare("SELECT * FROM seat_runtime_switches").get() as RuntimeSwitchIntent;
    expect(intent.phase).toBe("committed");
    expect(f.sessionRegistry.currentOccupantTenure(f.node.id)!.generationUuid).toBe(intent.successor_generation);
    expect(f.timeline).not.toContain("activate");
    expect(await recoverRuntimeSwitch(db, f.deps.tmuxAdapter, intent, f.deps.runtimeAdapters, async () => {})).toEqual({ complete: true });
    expect(f.sessions.size).toBe(1);
    expect(db.prepare("SELECT * FROM seat_runtime_switches").all()).toEqual([]);
  });

  it("clears an interrupted intent after both processes are positively absent without reverting the runtime", async () => {
    const f = fixture(); f.tmux.signalPaneProcess.mockRejectedValueOnce(new Error("interrupted"));
    expect(await f.run()).toMatchObject({ ok: true, recoveryPending: true });
    const intent = db.prepare("SELECT * FROM seat_runtime_switches").get() as RuntimeSwitchIntent;
    f.sessions.clear();
    expect(await recoverRuntimeSwitch(db, f.deps.tmuxAdapter, intent, f.deps.runtimeAdapters)).toEqual({ complete: true });
    expect(db.prepare("SELECT runtime FROM nodes WHERE id=?").get(f.node.id)).toEqual({ runtime: "claude-code" });
  });

  it("retains the intent on an unavailable transport or changed helper ownership", async () => {
    const f = fixture(); f.tmux.signalPaneProcess.mockRejectedValueOnce(new Error("interrupted"));
    await f.run(); const intent = db.prepare("SELECT * FROM seat_runtime_switches").get() as RuntimeSwitchIntent;
    f.tmux.probeSession.mockResolvedValueOnce({ state: "transport_unavailable" });
    expect(await recoverRuntimeSwitch(db, f.deps.tmuxAdapter, intent, f.deps.runtimeAdapters)).toMatchObject({ complete: false });
    f.sessions.get(intent.staging_session)!.env.OPENRIG_NODE_ID = "another-node";
    expect(await recoverRuntimeSwitch(db, f.deps.tmuxAdapter, intent, f.deps.runtimeAdapters)).toMatchObject({ complete: false });
    expect(f.tmux.signalPaneProcess).toHaveBeenCalledTimes(1);
    expect(f.sessions.size).toBe(2);
    expect(db.prepare("SELECT id FROM seat_runtime_switches").get()).toEqual({ id: intent.id });
  });

  it("waits for the handover turn to settle before activating the successor", async () => {
    const f = fixture(); f.checkReady.mockResolvedValueOnce({ ready: true }).mockResolvedValueOnce({ ready: false }).mockResolvedValueOnce({ ready: true });
    expect(await f.run()).toMatchObject({ ok: true, recoveryPending: false });
    expect(f.checkReady).toHaveBeenCalledTimes(3);
  });

  it("rejects a non-blank staging pane before launching any runtime", async () => {
    const f = fixture(); f.tmux.getPaneCommand.mockResolvedValue("unrelated-harness");
    expect(await f.run()).toMatchObject({ ok: false, recoveryPending: false });
    expect(f.launchHarness).not.toHaveBeenCalled();
    expect(f.sessions.get(f.name)).toMatchObject({ pane: "%1", dead: false });
  });

  it("uses explicit target settings without inheriting the source permission selection", async () => {
    const f = fixture("claude-code");
    new NativePermissionStore(db).write(f.node.id, { runtime: "claude-code", mode: "auto" }, f.name, "source choice");
    expect(await f.run({ model: "target-model", effort: "high", codexConfigProfile: "target-profile", permissionMode: "floor" }))
      .toMatchObject({ ok: true, settings: { model: "target-model", effort: "high", codexConfigProfile: "target-profile", permissionMode: "floor" } });
    expect(f.launchHarness.mock.calls[0]![0]).toMatchObject({ model: "target-model", effort: "high", codexConfigProfile: "target-profile", launchPosture: "floor", kernelAuthority: false, teamPermissionDefault: false });
    expect(new NativePermissionStore(db).read(f.node.id)).toMatchObject({ runtime: "codex", mode: "floor" });
  });

  it("commits a native identity received while staged even when launch returned no token", async () => {
    const f = fixture();
    f.launchHarness.mockImplementationOnce(async () => {
      db.prepare("UPDATE seat_runtime_switches SET successor_resume_type='claude_id', successor_resume_token='hook-native-id' WHERE node_id=?").run(f.node.id);
      return { ok: true, resumeToken: undefined } as never;
    });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(db.prepare("SELECT resume_type,resume_token,resume_provenance FROM sessions WHERE status='running' AND node_id=?").get(f.node.id))
      .toEqual({ resume_type: "claude_id", resume_token: "hook-native-id", resume_provenance: "hook" });
    const snapshot = db.prepare("SELECT data FROM snapshots WHERE kind='runtime-switch'").get() as { data: string };
    const data = JSON.parse(snapshot.data) as import("../src/domain/types.js").SnapshotData;
    const current = data.sessions.find(session => session.id === data.activeSessionIdByNode?.[f.node.id]);
    expect(current).toMatchObject({ resumeToken: "hook-native-id", resumeType: "claude_id" });
    expect(data.sessions.find(session => session.id === f.session.id)).toMatchObject({ status: "superseded", resumeToken: "old-native-id" });
  });

  it("refuses a queued request for the old occupant; an explicit retry observes the committed runtime", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.run(), f.run()]);
    expect(results).toMatchObject([{ status: "fulfilled", value: { ok: true, changed: true } },
      { status: "rejected", reason: { code: "guard_target_changed" } }]);
    expect(await f.run()).toMatchObject({ ok: true, changed: false });
    expect(f.launchHarness).toHaveBeenCalledTimes(1);
    expect(f.tmux.createSession).toHaveBeenCalledTimes(1);
  });
});
