import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";

function startupEntry(category: "skill" | "guidance", id: string) {
  return {
    category,
    effectiveId: id,
    sourceSpec: "agent.yaml",
    sourcePath: `resources/${id}`,
    resourcePath: id,
    absolutePath: `/spec/${id}`,
  };
}

describe("SeatLifecycleService.launchFresh", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let alive: Set<string>;
  let killed: string[];
  let tmux: TmuxAdapter;
  let projectedPlan: ProjectionPlan | null;
  let launchBinding: Record<string, unknown> | null;
  let launchOpts: Record<string, unknown> | null;
  let harnessResult: Awaited<ReturnType<RuntimeAdapter["launchHarness"]>>;
  let paneCommand: string;
  let adapter: RuntimeAdapter;
  let invalidations: Array<Record<string, unknown>>;
  let activitySwaps: Array<{ nodeId: string; generation: string }>;
  let service: SeatLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    alive = new Set();
    killed = [];
    projectedPlan = null;
    launchBinding = null;
    launchOpts = null;
    harnessResult = { ok: true, resumeToken: "fresh-native-uuid", resumeType: "claude_session_id" };
    paneCommand = "claude";
    tmux = {
      createSession: vi.fn(async (name: string) => {
        if (alive.has(name)) return { ok: false as const, code: "duplicate_session", message: "duplicate" };
        alive.add(name);
        return { ok: true as const };
      }),
      killSession: vi.fn(async (name: string): Promise<TmuxResult> => {
        killed.push(name);
        alive.delete(name);
        return { ok: true };
      }),
      probeSession: vi.fn(async (name: string) => alive.has(name) ? { state: "present" as const } : { state: "absent" as const }),
      hasSession: vi.fn(async (name: string) => alive.has(name)),
      listSessions: vi.fn(async () => [...alive].map((name) => ({ name, windows: 1, created: "", attached: false }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async (name: string) => alive.has(name)
        ? [{ id: "%fresh", index: 0, cwd: "/project", width: 80, height: 24, active: true }]
        : []),
      getPanePid: vi.fn(async () => 4242),
      getPaneCommand: vi.fn(async () => paneCommand),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
    } as unknown as TmuxAdapter;
    adapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async (plan) => {
        projectedPlan = plan;
        return { projected: [], skipped: [], failed: [] };
      },
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding, opts) => {
        launchBinding = binding as unknown as Record<string, unknown>;
        launchOpts = opts as unknown as Record<string, unknown>;
        return harnessResult;
      },
      checkReady: async () => ({ ready: true }),
    };
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrchestrator = new StartupOrchestrator({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: tmux,
      sleep: async () => undefined,
    });
    invalidations = [];
    activitySwaps = [];
    service = new SeatLifecycleService({
      db,
      rigRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter: tmux,
      nodeLauncher,
      startupOrchestrator,
      runtimeAdapters: { "claude-code": adapter, codex: { ...adapter, runtime: "codex" } },
      occupantInvalidator: { invalidateRetiringOccupant: (input) => invalidations.push(input) },
      activityOracle: { declareOccupantSwap: (nodeId, generation) => activitySwaps.push({ nodeId, generation }) },
    });
  });

  afterEach(() => db.close());

  function seedSeat(opts?: { clean?: boolean; adopted?: boolean; model?: string; withContext?: boolean; runtime?: "claude-code" | "codex" }) {
    const runtime = opts?.runtime ?? "claude-code";
    const rig = rigRepo.createRig("fresh-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime,
      cwd: "/project",
      model: opts?.model ?? "claude-current",
    });
    const sessionName = "dev-impl@fresh-rig";
    let session: ReturnType<SessionRegistry["registerSession"]> | null = null;
    if (!opts?.clean) {
      session = opts?.adopted
        ? sessionRegistry.registerClaimedSession(node.id, sessionName)
        : sessionRegistry.registerSession(node.id, sessionName);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName, tmuxPane: "%old" });
      alive.add(sessionName);
    }
    if (opts?.withContext !== false) {
      db.prepare(
        "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)",
      ).run(
        node.id,
        JSON.stringify([startupEntry("skill", "stale-skill"), startupEntry("guidance", "live-guidance")]),
        "[]",
        "[]",
        runtime,
      );
    }
    return { rig, node, session, sessionName };
  }

  it("requires explicit fresh and a valid persisted startup context before mutation", async () => {
    const seat = seedSeat({ clean: true, withContext: false });
    const notExplicit = await service.launchFresh({ seatRef: "dev.impl", fresh: false, reason: "x" });
    expect(notExplicit).toMatchObject({ ok: false, code: "fresh_required" });
    const missing = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "x" });
    expect(missing).toMatchObject({ ok: false, code: "startup_context_missing" });
    expect(alive).not.toContain(seat.sessionName);

    db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)",
    ).run(seat.node.id, "{", "[]", "[]", "claude-code");
    const malformed = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "x" });
    expect(malformed).toMatchObject({ ok: false, code: "startup_context_malformed" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE node_id = ?").get(seat.node.id)).toEqual({ c: 0 });
  });

  it("refuses a live managed seat without stop and refuses an adopted seat even with stop", async () => {
    const live = seedSeat();
    expect(await service.launchFresh({ seatRef: live.sessionName, fresh: true, reason: "x" }))
      .toMatchObject({ ok: false, code: "session_live" });
    expect(killed).toEqual([]);

    const adoptedRig = rigRepo.createRig("adopted-rig");
    const adoptedNode = rigRepo.addNode(adoptedRig.id, "dev.adopted", { runtime: "claude-code", cwd: "/project" });
    const adoptedName = "dev-adopted@adopted-rig";
    const adopted = sessionRegistry.registerClaimedSession(adoptedNode.id, adoptedName);
    sessionRegistry.updateStatus(adopted.id, "running");
    sessionRegistry.updateBinding(adoptedNode.id, { tmuxSession: adoptedName, tmuxPane: "%adopted" });
    alive.add(adoptedName);
    db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')",
    ).run(adoptedNode.id);
    expect(await service.launchFresh({ seatRef: adoptedName, fresh: true, stop: true, reason: "x" }))
      .toMatchObject({ ok: false, code: "claimed_session" });
    expect(alive.has(adoptedName)).toBe(true);
  });

  it("refuses an unmanaged canonical collision even when the database seat is clean", async () => {
    const seat = seedSeat({ clean: true });
    alive.add(seat.sessionName);
    const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, stop: true, reason: "x" });
    expect(result).toMatchObject({ ok: false, code: "unmanaged_session_collision" });
    expect(killed).toEqual([]);
    expect(alive.has(seat.sessionName)).toBe(true);
  });

  it("does not mistake a historical canonical row for ownership of a current unmanaged collision", async () => {
    const seat = seedSeat();
    alive.delete(seat.sessionName);
    const newer = sessionRegistry.registerSession(seat.node.id, "r00-current-other");
    sessionRegistry.updateStatus(newer.id, "running");
    sessionRegistry.updateBinding(seat.node.id, { tmuxSession: "r00-current-other", tmuxPane: "%other" });
    alive.add(seat.sessionName);

    const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, stop: true, reason: "collision discriminator" });

    expect(result).toMatchObject({ ok: false, code: "unmanaged_session_collision" });
    expect(killed).toEqual([]);
    expect(alive.has(seat.sessionName)).toBe(true);
  });

  it("refuses when canonical-session existence is indeterminate because tmux transport is unavailable", async () => {
    const seat = seedSeat({ clean: true });
    vi.mocked(tmux.probeSession).mockResolvedValue({ state: "transport_unavailable", cause: "tmux socket unavailable" });

    const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "transport discriminator" });

    expect(result).toMatchObject({ ok: false, code: "tmux_probe_failed" });
    expect(alive.has(seat.sessionName)).toBe(false);
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("stops exactly the managed pod-aware occupant, launches fresh, and preserves sibling/work state", async () => {
    const seat = seedSeat();
    const retiringGeneration = sessionRegistry.currentOccupantTenure(seat.node.id)!.generationUuid;
    const sibling = rigRepo.addNode(seat.rig.id, "dev.qa", { runtime: "claude-code", cwd: "/project" });
    const siblingName = "dev-qa@fresh-rig";
    const siblingSession = sessionRegistry.registerSession(sibling.id, siblingName);
    sessionRegistry.updateStatus(siblingSession.id, "running");
    sessionRegistry.updateBinding(sibling.id, { tmuxSession: siblingName, tmuxPane: "%sibling" });
    alive.add(siblingName);
    db.prepare(
      "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q-fresh', '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z', 'op@rig', ?, 'pending', 'work')",
    ).run(seat.sessionName);

    const result = await service.launchFresh({
      seatRef: seat.sessionName,
      fresh: true,
      stop: true,
      reason: "deliberate blank restart",
      operator: "op@rig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.sessionName).toBe(seat.sessionName);
    expect(result.model).toBe("claude-current");
    expect(result.generation).not.toBe(retiringGeneration);
    expect(killed).toEqual([seat.sessionName]);
    expect(alive.has(seat.sessionName)).toBe(true);
    expect(alive.has(siblingName)).toBe(true);
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(siblingSession.id) as { status: string }).status).toBe("running");
    expect((db.prepare("SELECT state FROM queue_items WHERE qitem_id = 'q-fresh'").get() as { state: string }).state).toBe("pending");
    expect(sessionRegistry.getBindingForNode(seat.node.id)?.tmuxPane).toBe("%fresh");
    expect(launchBinding).toMatchObject({ model: "claude-current", tmuxSession: seat.sessionName, tmuxPane: "%fresh" });
    expect(launchOpts).toEqual({ name: seat.sessionName, resumeToken: undefined });
    expect(projectedPlan?.entries.map((entry) => entry.effectiveId)).toEqual(["live-guidance"]);
    expect(invalidations).toEqual([{ retiringSessionName: seat.sessionName, successorSessionName: seat.sessionName, retiringGeneration }]);
    expect(activitySwaps).toEqual([{ nodeId: seat.node.id, generation: result.generation }]);
    expect(db.prepare("SELECT kind FROM occupant_tenures WHERE generation_uuid = ?").get(result.generation)).toEqual({ kind: "fresh" });
    const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.fresh_launched' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      sessionName: seat.sessionName,
      retiringGeneration,
      newGeneration: result.generation,
      nativeSessionId: "fresh-native-uuid",
      model: "claude-current",
      status: "ready",
    });
    expect(new SeatIdentityStore(db).getForNode(seat.node.id)).toMatchObject({
      verdict: "verified",
      evidence: { registeredPane: "%fresh" },
    });
    expect(getNodeInventory(db, seat.rig.id)[0]).toMatchObject({
      lifecycleState: "running",
      occupantLifecycle: "active",
      startupStatus: "ready",
    });
  });

  it("launches a Codex seat through the same fresh-only path without a resume carrier", async () => {
    const seat = seedSeat({ clean: true, runtime: "codex", model: "gpt-5.6-codex" });
    harnessResult = { ok: true, resumeToken: "codex-fresh-uuid", resumeType: "codex_thread_id" };
    paneCommand = "codex";

    const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "codex blank restart" });

    expect(result).toMatchObject({ ok: true, model: "gpt-5.6-codex", status: "ready" });
    expect(launchOpts).toEqual({ name: seat.sessionName, resumeToken: undefined });
    const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.fresh_launched' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ nativeSessionId: "codex-fresh-uuid" });
  });

  it("supersedes historically ambiguous dead rows without selecting a continuity source", async () => {
    const seat = seedSeat();
    alive.delete(seat.sessionName);
    const second = sessionRegistry.registerSession(seat.node.id, "r00-stale-other");
    sessionRegistry.updateStatus(second.id, "running");
    sessionRegistry.updateBinding(seat.node.id, { tmuxSession: "r00-stale-other", tmuxPane: "%stale" });
    const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "discard all history" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.supersededSessionIds.sort()).toEqual([seat.session!.id, second.id].sort());
    expect(launchOpts).toEqual({ name: seat.sessionName, resumeToken: undefined });
  });

  it("keeps an auth-attention occupant and projects attention instead of false healthy", async () => {
    const seat = seedSeat({ clean: true });
    harnessResult = { ok: false, error: "login required", recovery: "attention_required", evidence: "login" };
    const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "auth discriminator" });
    expect(result).toMatchObject({ ok: false, code: "attention_required", status: "attention_required", sessionName: seat.sessionName });
    expect(alive.has(seat.sessionName)).toBe(true);
    expect(sessionRegistry.getBindingForNode(seat.node.id)?.tmuxPane).toBe("%fresh");
    expect(getNodeInventory(db, seat.rig.id)[0]).toMatchObject({
      lifecycleState: "attention_required",
      sessionStatus: "running",
      startupStatus: "attention_required",
    });
  });

  it("compensates a hard startup failure to zero live session and binding while retaining audit tenure", async () => {
    const seat = seedSeat({ clean: true });
    harnessResult = { ok: false, error: "binary missing" };
    const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "hard failure proof" });
    expect(result).toMatchObject({ ok: false, code: "startup_failed", status: "failed" });
    expect(alive.has(seat.sessionName)).toBe(false);
    expect(sessionRegistry.getBindingForNode(seat.node.id)).toBeNull();
    const sessions = sessionRegistry.getSessionsForRig(seat.rig.id).filter((row) => row.nodeId === seat.node.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: "exited", startupStatus: "failed" });
    expect(sessionRegistry.currentOccupantTenure(seat.node.id)?.kind).toBe("fresh");
    expect(db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'seat.fresh_launch_failed'").get()).toEqual({ c: 1 });
  });
});
