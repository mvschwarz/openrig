import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { WatchdogAutoRegistration } from "../src/domain/watchdog-auto-registration.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine, type DeliveryFn } from "../src/domain/watchdog-policy-engine.js";
import { makeIdleGateQitemPolicy } from "../src/domain/policies/idle-gate-qitem.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { observeCodexSandbox } from "../src/domain/permission-drift.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";

describe("SeatHandoverService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let discoveryRepo: DiscoveryRepository;
  let eventBus: EventBus;
  let hasSession: ReturnType<typeof vi.fn>;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let respawnPane: ReturnType<typeof vi.fn>;
  let setRemainOnExit: ReturnType<typeof vi.fn>;
  let signalPaneProcess: ReturnType<typeof vi.fn>;
  let isPaneDead: ReturnType<typeof vi.fn>;
  let sendText: ReturnType<typeof vi.fn>;
  let sendKeys: ReturnType<typeof vi.fn>;
  let capturePaneScreen: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let readSidecar: ReturnType<typeof vi.fn>;
  let captureCodexThreadId: ReturnType<typeof vi.fn>;
  let invalidateRetiringOccupant: ReturnType<typeof vi.fn>;
  let resolvePredecessorRecap: ReturnType<typeof vi.fn>;
  let getDefaultShell: ReturnType<typeof vi.fn>;
  let getPaneCommand: ReturnType<typeof vi.fn>;
  let service: SeatHandoverService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    discoveryRepo = new DiscoveryRepository(db);
    eventBus = new EventBus(db);
    hasSession = vi.fn(async () => true);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    respawnPane = vi.fn(async () => ({ ok: true }));
    setRemainOnExit = vi.fn(async () => ({ ok: true }));
    signalPaneProcess = vi.fn(async () => ({ ok: true }));
    isPaneDead = vi.fn(async () => true); // cutover: retiree exits gracefully on SIGTERM
    sendText = vi.fn(async () => ({ ok: true }));
    sendKeys = vi.fn(async () => ({ ok: true }));
    capturePaneScreen = vi.fn(async () => "predecessor screen tail");
    // B1 — a fresh successor is launched into a live agent (launchHarness +
    // readiness) with a scraped resume token (B2 launched-mode).
    launchHarness = vi.fn(async () => ({
      ok: true,
      resumeToken: "codex-launch-tok",
      resumeType: "codex_id",
      appliedLaunch: observeCodexSandbox(" -s workspace-write"),
    }));
    checkReady = vi.fn(async () => ({ ready: true }));
    // B2 — discovered-mode derive-helper deps (Codex thread-id capturer by default).
    readSidecar = vi.fn(() => ({ ok: true, data: { session_id: "claude-sid-123" } }));
    captureCodexThreadId = vi.fn(async () => "codex-discovered-tok");
    invalidateRetiringOccupant = vi.fn();
    resolvePredecessorRecap = vi.fn(() => ({ unavailableReason: "test default: no record" }));
    // KI-14: healthy default — the respawned pane comes up as a blank shell.
    getDefaultShell = vi.fn(async () => "/bin/zsh");
    getPaneCommand = vi.fn(async () => "zsh");
    service = newService();
  });

  afterEach(() => {
    db.close();
  });

  function tmux(): TmuxAdapter {
    return { hasSession, createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, sendText, sendKeys, capturePaneScreen, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
  }

  function codexAdapter(): RuntimeAdapter {
    return { runtime: "codex", launchHarness, checkReady } as unknown as RuntimeAdapter;
  }

  function newService(adapter: TmuxAdapter = tmux()): SeatHandoverService {
    return new SeatHandoverService({
      db,
      rigRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: adapter,
      now: () => new Date("2026-04-24T18:30:00.000Z"),
      newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { codex: codexAdapter() },
      contextUsageStore: { readSidecar } as never,
      resumeTokenCapturer: { captureCodexThreadId } as never,
      occupantInvalidator: { invalidateRetiringOccupant },
      predecessorRecapResolver: resolvePredecessorRecap as never,
      readinessTimeoutMs: 50,
      sleep: async () => {},
    });
  }

  function seedSeat(opts?: { runtime?: string; withSession?: boolean; model?: string; codexConfigProfile?: string }) {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: opts?.runtime ?? "codex", cwd: "/project", model: opts?.model, codexConfigProfile: opts?.codexConfigProfile });
    let sessionId: string | null = null;
    if (opts?.withSession !== false) {
      const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
      sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%0" });
      sessionId = session.id;
    }
    return { rig, node, sessionId };
  }

  function seedDiscovery(opts?: { id?: string; tmuxSession?: string; tmuxPane?: string; runtimeHint?: "codex" | "claude-code" | "terminal" | "unknown" }) {
    const discovered = discoveryRepo.upsertDiscoveredSession({
      tmuxSession: opts?.tmuxSession ?? "successor-session",
      tmuxPane: opts?.tmuxPane ?? "%1",
      tmuxWindow: "0",
      runtimeHint: opts?.runtimeHint ?? "codex",
      confidence: "high",
      cwd: "/project",
    });
    if (opts?.id && opts.id !== discovered.id) {
      db.prepare("UPDATE discovered_sessions SET id = ? WHERE id = ?").run(opts.id, discovered.id);
      return discoveryRepo.getDiscoveredSession(opts.id)!;
    }
    return discovered;
  }

  function durableRows(): string {
    const tables = ["nodes", "sessions", "bindings", "discovered_sessions", "events"] as const;
    return JSON.stringify(Object.fromEntries(tables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ])));
  }

  it("binds an active seat to an already-created discovered successor", async () => {
    const { rig, node, sessionId } = seedSeat();
    const discovered = seedDiscovery();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "mvp-proof",
      source: `discovered:${discovered.id}`,
      operator: "orch-lead@seat-rig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(result.result).toMatchObject({
      ok: true,
      dryRun: false,
      mutated: true,
      continuityTransferred: false,
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: "successor-session",
      source: { mode: "discovered", ref: discovered.id },
      currentStatus: {
        sessionStatus: "running",
        startupStatus: "ready",
        occupantLifecycle: "active",
        continuityOutcome: null,
        handoverResult: "complete",
        previousOccupant: "dev-impl@seat-rig",
        handoverAt: "2026-04-24T18:30:00.000Z",
      },
      sideEffects: {
        departingSessionKilled: false,
        startupContextDelivered: false,
        provenanceRecordWritten: false,
      },
    });
    expect(result.result.previousSessionIdsSuperseded).toContain(sessionId);
    expect(hasSession).toHaveBeenCalledWith("successor-session");

    const sessions = sessionRegistry.getSessionsForRig(rig.id).filter((session) => session.nodeId === node.id);
    expect(sessions.map((session) => ({ name: session.sessionName, status: session.status, origin: session.origin, startup: session.startupStatus }))).toEqual([
      { name: "dev-impl@seat-rig", status: "superseded", origin: "launched", startup: "ready" },
      { name: "successor-session", status: "running", origin: "claimed", startup: "ready" },
    ]);
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("successor-session");
    const claimed = discoveryRepo.getDiscoveredSession(discovered.id);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.claimedNodeId).toBe(node.id);
    const nodeRow = db.prepare("SELECT occupant_lifecycle, continuity_outcome, handover_result, previous_occupant, handover_at FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(nodeRow).toEqual({
      occupant_lifecycle: "active",
      continuity_outcome: null,
      handover_result: "complete",
      previous_occupant: "dev-impl@seat-rig",
      handover_at: "2026-04-24T18:30:00.000Z",
    });
    const event = db.prepare("SELECT type, payload FROM events WHERE type = 'seat.handover_completed' ORDER BY seq DESC LIMIT 1").get() as { type: string; payload: string };
    expect(event.type).toBe("seat.handover_completed");
    expect(JSON.parse(event.payload)).toMatchObject({
      type: "seat.handover_completed",
      rigId: rig.id,
      nodeId: node.id,
      logicalId: "dev.impl",
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: "successor-session",
      source: `discovered:${discovered.id}`,
      reason: "mvp-proof",
      operator: "orch-lead@seat-rig",
    });
  });

  it.each(["active", "stopped"] as const)(
    "keeps the role-bound watchdog baton on a distinct discovered successor when %s",
    async (initialState) => {
      const now = new Date("2026-04-24T18:30:00.000Z");
      const jobsRepo = new WatchdogJobsRepository(db, () => now);
      const autoRegistration = new WatchdogAutoRegistration({
        db,
        jobsRepo,
        settingsStore: {
          resolveOne(key: string) {
            // B6 — these baton tests PREMISE an existing job, so the fake opts the fleet in.
            if (key.endsWith("auto_register")) return { value: "all" };
            if (key.endsWith("opt_in_sessions")) return { value: "" };
            return { value: key.endsWith("active_wake_interval_seconds") ? 900 : 60 };
          },
        } as never,
      });
      sessionRegistry.setWatchdogRegistrationObserver(autoRegistration);

      const { node } = seedSeat();
      const retiredSession = "dev-impl@seat-rig";
      const successorSession = "dev-successor@seat-rig";
      const [original] = jobsRepo.listAll().filter((job) => job.policy === "idle-gate-qitem");
      expect(original).toBeDefined();
      if (!original) return;
      if (initialState === "stopped") {
        db.prepare("UPDATE watchdog_jobs SET state = 'stopped' WHERE job_id = ?").run(original.jobId);
      }

      const discovered = seedDiscovery({ tmuxSession: successorSession });
      const result = await service.handover({
        seatRef: retiredSession,
        reason: "watchdog-baton-proof",
        source: `discovered:${discovered.id}`,
        operator: "orch-lead@seat-rig",
      });
      expect(result.ok).toBe(true);

      const roleRows = jobsRepo.listAll().filter((job) =>
        job.policy === "idle-gate-qitem" && job.targetGeneration === null
      );
      const held = roleRows.filter((job) => job.state === "active" || job.state === "stopped");
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({
        jobId: original.jobId,
        state: initialState,
        targetSession: successorSession,
      });
      expect(held[0]?.specYaml).toContain(`target:\n  session: ${successorSession}\n`);
      expect(roleRows.filter((job) => job.targetSession === retiredSession && job.state === "active")).toEqual([]);

      if (initialState === "active" && held[0]) {
        db.prepare(
          `INSERT INTO queue_items
            (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
           VALUES
            ('q-retired-watchdog', '2026-04-24T18:00:00Z', '2026-04-24T18:00:00Z',
             'orch@seat-rig', ?, 'pending', 'urgent', 'deep', '["gate:guard"]', 'retired target')`,
        ).run(retiredSession);
        const activity = new AgentActivityStore({ db, eventBus, now: () => now });
        expect(activity.recordHookEvent({
          runtime: "codex",
          sessionName: retiredSession,
          hookEvent: "Stop",
          occurredAt: "2026-04-24T18:29:00.000Z",
        }).ok).toBe(true);
        const deliveries: Array<{ targetSession: string; message: string }> = [];
        const deliver: DeliveryFn = async (request) => {
          deliveries.push(request);
          return { status: "ok" };
        };
        const engine = new WatchdogPolicyEngine({
          jobsRepo,
          historyLog: new WatchdogHistoryLog(db),
          eventBus,
          deliver,
          now: () => now,
          additionalPolicies: [makeIdleGateQitemPolicy({ db, agentActivityStore: activity })],
        });

        const evaluation = await engine.evaluate(jobsRepo.getByIdOrThrow(held[0].jobId));
        expect(evaluation.outcome).toEqual({ action: "skip", reason: "no_pending_gate" });
        expect(deliveries, "the retired session no longer holds a deliverable watchdog").toEqual([]);
      } else {
        expect(jobsRepo.listActive()).toEqual([]);
      }
    },
  );

  it("neutralizes the retired watchdog when a real handover admits a noncanonical discovered successor", async () => {
    const now = new Date("2026-04-24T18:30:00.000Z");
    db.exec(watchdogHistorySchema.sql);
    const jobsRepo = new WatchdogJobsRepository(db, () => now);
    sessionRegistry.setWatchdogRegistrationObserver(new WatchdogAutoRegistration({
      db,
      jobsRepo,
      settingsStore: {
        resolveOne(key: string) {
          // B6 — this test premises an existing job; the fake opts the fleet in.
          if (key.endsWith("auto_register")) return { value: "all" };
          if (key.endsWith("opt_in_sessions")) return { value: "" };
          return { value: key.endsWith("active_wake_interval_seconds") ? 900 : 60 };
        },
      } as never,
    }));

    seedSeat();
    const retiredSession = "dev-impl@seat-rig";
    const original = jobsRepo.listActive().find((job) => job.policy === "idle-gate-qitem");
    expect(original).toBeDefined();
    if (!original) return;
    db.prepare(
      `INSERT INTO queue_items
        (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
       VALUES
        ('q-retired-noncanonical', '2026-04-24T18:00:00Z', '2026-04-24T18:00:00Z',
         'orch@seat-rig', ?, 'pending', 'urgent', 'deep', '["gate:guard"]', 'retired target')`,
    ).run(retiredSession);
    const activity = new AgentActivityStore({ db, eventBus, now: () => now });
    expect(activity.recordHookEvent({
      runtime: "codex",
      sessionName: retiredSession,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T18:29:00.000Z",
    }).ok).toBe(true);

    const discovered = seedDiscovery();
    const result = await service.handover({
      seatRef: retiredSession,
      reason: "noncanonical-watchdog-proof",
      source: `discovered:${discovered.id}`,
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);

    const activeRoleJobs = jobsRepo.listActive().filter((job) =>
      job.policy === "idle-gate-qitem" && job.targetGeneration === null
    );
    const deliveries: Array<{ targetSession: string; message: string }> = [];
    const deliver: DeliveryFn = async (request) => {
      deliveries.push(request);
      return { status: "ok" };
    };
    const engine = new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: new WatchdogHistoryLog(db),
      eventBus,
      deliver,
      now: () => now,
      additionalPolicies: [makeIdleGateQitemPolicy({ db, agentActivityStore: activity })],
    });
    for (const job of activeRoleJobs) await engine.evaluate(job);

    expect.soft(activeRoleJobs.filter((job) => job.targetSession === retiredSession)).toEqual([]);
    expect.soft(deliveries.filter((delivery) => delivery.targetSession === retiredSession)).toEqual([]);
  });

  it("keeps dry-run side-effect free", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && "plan" in result && result.plan.willMutate).toBe(false);
    expect(durableRows()).toBe(before);
  });

  it.each([
    ["default source", undefined],
    ["fresh source", "fresh"],
    ["rebuild source", "rebuild"],
    ["fork source", "fork:abc123"],
    ["discovered source", "discovered:some-id"],
  ])("keeps dry-run mutation-free across %s (AC-1)", async (_label, source) => {
    seedSeat();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && "plan" in result && result.plan.willMutate).toBe(false);
    expect(createSession).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("Seam B (R2/Guard): a fresh handover for a NO-policy seat launches the REAL successor at EXPLICIT floor, even under ambient OPENRIG_YOLO", async () => {
    // Production altitude: the pin drives SeatHandoverService.handover() end-to-end and
    // asserts the binding the REAL launchHarness call received — never a re-computed
    // fallback chain (the helper-only false-green Guard rejected at c203812f).
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      seedSeat({ runtime: "codex" }); // no node/rig policy provenance anywhere
      const result = await service.handover({
        seatRef: "dev-impl@seat-rig",
        reason: "context-wall",
        source: "fresh",
        operator: "orch-lead@seat-rig",
      });
      expect(result.ok).toBe(true);
      expect(launchHarness).toHaveBeenCalledTimes(1);
      const successorBinding = launchHarness.mock.calls[0]![0] as { launchPosture?: string };
      // locked absence contract: the continuity edge binds the minimum floor explicitly —
      // ambient YOLO must not widen an attachment-less successor.
      expect(successorBinding.launchPosture).toBe("floor");
    } finally { vi.unstubAllEnvs(); }
  });

  it("persists the successor's applied effect only after the handover generation is minted", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const predecessor = sessionRegistry.currentOccupantTenure(node.id)!;
    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);
    const successor = sessionRegistry.currentOccupantTenure(node.id)!;
    expect(successor.generationUuid).not.toBe(predecessor.generationUuid);
    expect(new AppliedLaunchObservationStore(db).readCurrent(node.id)).toMatchObject({
      generationUuid: successor.generationUuid,
      runtime: "codex",
      axis: "sandbox",
      value: "workspace-write",
    });
  });

  it("MONEY PROOF (0.5.2-07): a SPEC-pinned model seat's handover launches the successor on the SPEC model — the REAL lookupNode→createSuccessor→launchHarness path, not an injected node", async () => {
    // Same shape as Seam B: asserts the binding the REAL launchHarness received, driven end-to-end by
    // service.handover(). The launcher-level money proof injects node.model directly and cannot catch
    // lookupNode dropping the column — this one does. RED on main: lookupNode SELECTs only id/runtime/cwd,
    // so the spec-pinned model is lost before the successor binding is ever built (the handover-reverts gap).
    seedSeat({ runtime: "codex", model: "gpt-5.4-cheap" });
    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const successorBinding = launchHarness.mock.calls[0]![0] as { model?: string };
    expect(successorBinding.model).toBe("gpt-5.4-cheap");
  });

  it("MONEY PROOF (0.5.2-07 A4-profile): a codex_config_profile-pinned seat's handover launches the successor with that profile — the REAL lookupNode→createSuccessor→launchHarness path", async () => {
    // A4-profile mirrors A2-1 for the codex_config_profile column. The codex adapter already emits
    // `-p <profile>` from binding.codexConfigProfile; the gap is the HANDOVER threading — lookupNode
    // must SELECT codex_config_profile and createSuccessor must carry it onto the successor binding.
    // RED on this base: lookupNode SELECTs only id/runtime/cwd/model, so the pinned profile is lost
    // before the successor binding is ever built — the same handover-reverts gap as the model, one
    // field over. The restore path already threads it (restore-orchestrator.ts); handover did not.
    seedSeat({ runtime: "codex", codexConfigProfile: "prod-sandboxed" });
    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const successorBinding = launchHarness.mock.calls[0]![0] as { codexConfigProfile?: string };
    expect(successorBinding.codexConfigProfile).toBe("prod-sandboxed");
  });

  it("composes the full cycle for a fresh source: create -> deliver -> verify -> rebind", async () => {
    const { node } = seedSeat({ runtime: "codex" });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(result.result).toMatchObject({
      ok: true,
      mutated: true,
      previousOccupant: "dev-impl@seat-rig",
      // Cutover: the seat keeps its canonical name; the OCCUPANT changed (new agent), the NAME did not.
      currentOccupant: "dev-impl@seat-rig",
      source: { mode: "fresh" },
      sideEffects: { startupContextDelivered: true },
    });

    // Cutover: no fresh session — the successor respawns into the DEPARTING pane in place, carrying the
    // PRESERVED canonical session name in its identity env (never a -h successor name).
    expect(createSession).not.toHaveBeenCalled();
    expect(listPanes).toHaveBeenCalledWith("dev-impl@seat-rig");
    expect(respawnPane).toHaveBeenCalledTimes(1);
    const [paneTarget, command, opts] = respawnPane.mock.calls[0]!;
    expect(paneTarget).toBe("%9"); // the departing pane resolved from listPanes
    // KI-14: EXPLICIT blank shell (undefined would re-run the pane's baked-in creation command).
    expect(command).toBe("/bin/zsh");
    expect(opts).toMatchObject({ cwd: "/project" });
    expect(opts.env).toMatchObject({
      OPENRIG_NODE_ID: node.id,
      OPENRIG_SESSION_NAME: "dev-impl@seat-rig",
      OPENRIG_RUNTIME: "codex",
      OPENRIG_OCCUPANT_GENERATION: expect.any(String),
    });

    // The departing pane is resolved BEFORE the in-place respawn; the discovery candidate carries it on
    // the PRESERVED name (commit rebinds to it).
    expect(listPanes.mock.invocationCallOrder[0]!).toBeLessThan(respawnPane.mock.invocationCallOrder[0]!);
    expect(result.result.discovery.tmuxPane).toBe("%9");
    const successorRow = db.prepare("SELECT tmux_pane FROM discovered_sessions WHERE tmux_session = ?").get("dev-impl@seat-rig") as { tmux_pane: string };
    expect(successorRow.tmux_pane).toBe("%9");

    // Driver note 3: the restore packet (boot recap) is delivered to the successor in the PRESERVED
    // pane BEFORE the continuity-verify presence probe (never verify an un-restored seat).
    expect(sendText).toHaveBeenCalledTimes(1);
    const [target, packet] = sendText.mock.calls[0]!;
    expect(target).toBe("dev-impl@seat-rig");
    expect(packet).toContain("OpenRig seat handover");
    expect(packet).toContain("predecessor screen tail");
    expect(sendKeys).toHaveBeenCalledWith("dev-impl@seat-rig", ["C-m"]);
    expect(sendText.mock.invocationCallOrder[0]!).toBeLessThan(hasSession.mock.invocationCallOrder[0]!);

    // B1: the successor was launched into a LIVE agent (launchHarness +
    // readiness) BEFORE commit — not a bare shell that only received text.
    expect(launchHarness).toHaveBeenCalledTimes(1);
    expect(checkReady).toHaveBeenCalled();
    // Rebind landed on the PRESERVED seat name.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    const nodeRow = db.prepare("SELECT occupant_lifecycle, handover_result, previous_occupant FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(nodeRow).toMatchObject({ occupant_lifecycle: "active", handover_result: "complete", previous_occupant: "dev-impl@seat-rig" });

    // B2 (launched/fresh): the launch-scraped resume token is persisted on the new claimed session
    // atomically with the commit (provenance scrape). The cutover preserves the seat name, so two rows
    // now share it (the superseded retiree + the active successor); take the NEWEST (the claimed one),
    // exactly as the production latest-session lookup does (ORDER BY id DESC).
    const newSession = db.prepare(
      "SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE node_id = ? AND session_name = ? ORDER BY id DESC LIMIT 1"
    ).get(node.id, "dev-impl@seat-rig") as Record<string, string | null>;
    expect(newSession).toMatchObject({ resume_type: "codex_id", resume_token: "codex-launch-tok", resume_provenance: "scrape" });
    expect(sessionRegistry.currentOccupantTenure(node.id)?.generationUuid)
      .toBe(opts.env.OPENRIG_OCCUPANT_GENERATION);
  });

  it("KI-14 (5.3 wave-1): a fresh handover commit stamps continuity_outcome='fresh' — NEVER NULL, which lets a STALE restore_outcome impersonate the new occupant's continuity", async () => {
    // The live defect's label half (2026-08-22 wave): commit wrote continuity_outcome=NULL and
    // node-inventory then DERIVED the seat's continuity from restore_outcome — a stamp from a
    // restore days earlier — so dev-qa/dev-guard reported fresh/fresh-primed while their panes ran
    // `codex resume <14-day-old-token>`. The recorded label must describe THIS launch.
    const { node } = seedSeat({ runtime: "codex" });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT continuity_outcome, handover_result FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(row.handover_result).toBe("complete");
    expect(row.continuity_outcome).toBe("fresh");
  });

  it("a failed handover commit leaves its carried reservation unregistered and non-mismatch", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    vi.spyOn(eventBus, "persistWithinTransaction").mockImplementationOnce(() => {
      throw new Error("injected commit failure");
    });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "commit-failure-proof",
      source: "fresh",
    });

    expect(result).toMatchObject({ ok: false, code: "handover_commit_failed" });
    const env = respawnPane.mock.calls[0]![2]!.env as Record<string, string>;
    const reserved = env.OPENRIG_OCCUPANT_GENERATION;
    expect(reserved).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sessionRegistry.isOccupantGenerationRegistered(node.id, reserved)).toBe(false);

    const store = new AgentActivityStore({
      db,
      eventBus,
      resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (nodeId, generation) =>
        sessionRegistry.isOccupantGenerationRegistered(nodeId, generation),
    });
    store.recordHookEvent({
      runtime: "codex",
      sessionName: "dev-impl@seat-rig",
      hookEvent: "Stop",
      generation: reserved,
    });

    expect(store.getLatestForNode({ nodeId: node.id, sessionName: "dev-impl@seat-rig" })).toMatchObject({
      state: "unknown",
      reason: "generation_unresolvable",
      generationProvenance: "unresolved",
    });
  });

  it("ghost-stage re-key seam: calls invalidateRetiringOccupant at commit with the retiring + successor names + the RETIRING generation", async () => {
    // The cutover invalidates the RETIRING occupant's seat-name-keyed stores so the successor never
    // inherits a ghost (ghost-stage contract, dev50 slice). This seat OWNS the mechanical call at
    // commit(); dev50 owns the per-store impls behind the OccupantInvalidator interface. In the cutover
    // the successor REUSES the seat name, so retiring === successor by NAME — Class-A is safe by TIMING
    // and Class-B gen-scopes via retiringGeneration (atom-B): the RETIRING occupant's generation,
    // captured BEFORE registerClaimedSession mints the successor's tenure under the reused name.
    seedSeat({ runtime: "codex" });
    const retiringGen = sessionRegistry.currentOccupantGenerationForSession("dev-impl@seat-rig");
    expect(retiringGen, "the retiree has an atom-B tenure to gen-scope by").toBeTruthy();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    expect(invalidateRetiringOccupant).toHaveBeenCalledTimes(1);
    expect(invalidateRetiringOccupant).toHaveBeenCalledWith({
      retiringSessionName: "dev-impl@seat-rig",
      successorSessionName: "dev-impl@seat-rig",
      retiringGeneration: retiringGen, // captured pre-mint = the RETIREE's gen, not the successor's
    });
    // Proof it captured the RETIRING generation: the handover minted a fresh successor tenure under
    // the reused name, so the node's live generation now DIFFERS from what the invalidator received.
    const successorGen = sessionRegistry.currentOccupantGenerationForSession("dev-impl@seat-rig");
    expect(successorGen).not.toBe(retiringGen);
  });

  it("does NOT invalidate the retiring occupant when the handover fails before commit (no re-key on a non-committed handover)", async () => {
    seedSeat({ runtime: "codex" });
    respawnPane.mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(false);
    expect(invalidateRetiringOccupant).not.toHaveBeenCalled();
  });

  it("recap leg: threads the predecessor recap + record path into the delivered restore packet when a record resolves", async () => {
    // The recap leg fires: resolve the predecessor's provider record → a bounded labeled-from-record recap
    // → threaded into the packet delivered to the successor (honest-degraded, never called "scrollback").
    seedSeat({ runtime: "codex" });
    resolvePredecessorRecap.mockReturnValue({
      recap: [
        { role: "user", content: "finish the atom" },
        { role: "assistant", content: "atom finished; handing over" },
      ],
      recordPath: "/home/.claude/projects/x/abc.jsonl",
    });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    expect(resolvePredecessorRecap).toHaveBeenCalledTimes(1);
    const [target, packet] = sendText.mock.calls[0]!;
    expect(target).toBe("dev-impl@seat-rig");
    expect(packet).toContain("Predecessor recap (replayed from record, not the live terminal)");
    expect(packet).toContain("user: finish the atom");
    expect(packet).toContain("/home/.claude/projects/x/abc.jsonl");
    expect(packet.toLowerCase()).toContain("honest-degraded");
  });

  it("recap leg (B16): an unresolved recap rides the packet as a NAMED unavailable line, never a silent omission", async () => {
    seedSeat({ runtime: "codex" });
    resolvePredecessorRecap.mockReturnValue({ unavailableReason: "no resume token recorded for the departing codex session" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    const [, packet] = sendText.mock.calls[0]!;
    expect(packet).not.toContain("Predecessor recap (replayed from record");
    expect(packet).toContain("--- Predecessor recap unavailable: no resume token recorded for the departing codex session ---");
    // the base packet still delivers the captured predecessor terminal.
    expect(packet).toContain("predecessor screen tail");
  });

  it("B16 rework: packet delivery uses the shared paste-then-submit sequencing — a settle sleep BETWEEN send_text and C-m (r2 live: without it the packet sat staged-unsent 46s)", async () => {
    seedSeat({ runtime: "codex" });
    const sleeps: number[] = [];
    const orderedCalls: string[] = [];
    sendText.mockImplementation(async () => { orderedCalls.push("send_text"); return { ok: true }; });
    sendKeys.mockImplementation(async () => { orderedCalls.push("submit"); return { ok: true }; });
    const sleepSpy = async (ms: number) => { sleeps.push(ms); if (orderedCalls[orderedCalls.length - 1] === "send_text") orderedCalls.push(`sleep(${ms})`); };
    service = new SeatHandoverService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: tmux(),
      now: () => new Date("2026-04-24T18:30:00.000Z"),
      newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { codex: codexAdapter() },
      contextUsageStore: { readSidecar } as never,
      resumeTokenCapturer: { captureCodexThreadId } as never,
      occupantInvalidator: { invalidateRetiringOccupant },
      predecessorRecapResolver: resolvePredecessorRecap as never,
      readinessTimeoutMs: 50,
      sleep: sleepSpy,
    });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    // The settle sleep sits BETWEEN the paste and the submit — the transport's proven contract.
    const sendIdx = orderedCalls.indexOf("send_text");
    const settleIdx = orderedCalls.indexOf("sleep(200)");
    const submitIdx = orderedCalls.indexOf("submit");
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(settleIdx).toBeGreaterThan(sendIdx);
    expect(submitIdx).toBeGreaterThan(settleIdx);
    expect(sleeps).toContain(200);
  });

  it("recap leg (B16): the resolver runs BEFORE the successor launches (the successor overwrites the name-keyed sidecar)", async () => {
    seedSeat({ runtime: "codex" });
    resolvePredecessorRecap.mockReturnValue({ recap: [{ role: "user", content: "pre-launch read" }], recordPath: "/p/a.jsonl" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    const resolveOrder = resolvePredecessorRecap.mock.invocationCallOrder[0]!;
    const launchOrder = launchHarness.mock.invocationCallOrder[0]!;
    expect(resolveOrder).toBeLessThan(launchOrder);
  });

  it.each([
    ["rebuild", "rebuild"],
    ["fork", "fork:0b0165d7"],
  ])("B3: loudly REJECTS a live %s handover (never a blank successor reported complete)", async (_label, source) => {
    const { node } = seedSeat({ runtime: "codex" });
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source });

    // Loud rejection BEFORE any successor is created; nothing committed.
    expect(result).toMatchObject({ ok: false, code: "source_not_supported" });
    expect(createSession).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    // Original seat/binding untouched; no node marked handover complete.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    const nodeRow = db.prepare("SELECT handover_result FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(nodeRow.handover_result).not.toBe("complete");
    expect(durableRows()).toBe(before);
  });

  it("B3: still returns a dry-run PLAN for fork/rebuild (planning is not blocked)", async () => {
    seedSeat({ runtime: "codex" });
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fork:abc", dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.ok && "plan" in result && result.plan.willMutate).toBe(false);
    expect(durableRows()).toBe(before);
  });

  it("B2: captures the discovered successor's live resume token at commit (codex)", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const discovered = seedDiscovery();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "mvp-proof",
      source: `discovered:${discovered.id}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    // The FR-3 derive-helper was reused; the token is persisted with provenance
    // "adoption" on the new claimed session, and never appears in the event log.
    expect(captureCodexThreadId).toHaveBeenCalledWith("successor-session");
    const newSession = db.prepare(
      "SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE node_id = ? AND session_name = ?"
    ).get(node.id, "successor-session") as Record<string, string | null>;
    expect(newSession).toMatchObject({ resume_type: "codex_id", resume_token: "codex-discovered-tok", resume_provenance: "adoption" });
    const captureEvent = db.prepare("SELECT payload FROM events WHERE type = 'session.resume_token_captured' ORDER BY seq DESC LIMIT 1").get() as { payload: string } | undefined;
    expect(captureEvent).toBeTruthy();
    const payload = JSON.parse(captureEvent!.payload);
    expect(payload).toMatchObject({ outcome: "captured", provenance: "adoption", redacted: true });
    expect(JSON.stringify(payload)).not.toContain("codex-discovered-tok");
  });

  it("B2: honest redacted skip when the discovered token cannot be derived", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const discovered = seedDiscovery();
    captureCodexThreadId.mockResolvedValue(undefined); // probe found nothing

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "mvp-proof",
      source: `discovered:${discovered.id}`,
    });

    // Handover still succeeds; token stays NULL; a redacted skip event is emitted.
    expect(result.ok).toBe(true);
    const newSession = db.prepare(
      "SELECT resume_token FROM sessions WHERE node_id = ? AND session_name = ?"
    ).get(node.id, "successor-session") as Record<string, string | null>;
    expect(newSession.resume_token).toBeNull();
    const skipEvent = db.prepare("SELECT payload FROM events WHERE type = 'session.resume_token_captured' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(skipEvent.payload)).toMatchObject({ outcome: "skipped", reason: "probe_timeout", redacted: true });
  });

  it("fails loudly and leaves the binding when the in-place respawn fails", async () => {
    const { node } = seedSeat();
    respawnPane.mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    expect((result as { message: string }).message).toContain("create_successor");
    expect(launchHarness).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    // The seat's binding is unchanged — commit never ran.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(durableRows()).toBe(before);
  });

  it("maps a listPanes THROW resolving the departing pane to a loud successor_create_failed (no rejection, seat untouched)", async () => {
    const { node } = seedSeat();
    // The departing-pane probe rethrows BEFORE any respawn — the live retiree is wholly untouched.
    listPanes.mockRejectedValue(new Error("socket permission denied"));
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    expect((result as { message: string }).message).toContain("resolve_pane");
    // CUTOVER INVARIANT: the preserved seat is NEVER killed on unwind; verify + delivery never ran.
    expect(respawnPane).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(durableRows()).toBe(before);
  });

  it("preserves predecessor posture truth when handover fails before physical replacement", async () => {
    const { node } = seedSeat();
    const store = new AppliedLaunchObservationStore(db);
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    store.recordGeneration(generation, observeCodexSandbox(" -s workspace-write"));
    listPanes.mockRejectedValue(new Error("socket unavailable"));

    expect((await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" })).ok).toBe(false);
    expect(store.readCurrent(node.id)).toMatchObject({ generationUuid: generation, value: "workspace-write" });
  });

  it.each(["launch", "readiness", "context-delivery"] as const)(
    "invalidates predecessor posture truth when %s fails after physical replacement",
    async (failure) => {
      const { node } = seedSeat();
      const store = new AppliedLaunchObservationStore(db);
      const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
      store.recordGeneration(generation, observeCodexSandbox(" -s workspace-write"));
      if (failure === "launch") launchHarness.mockResolvedValue({ ok: false, error: "provider refused" });
      if (failure === "readiness") checkReady.mockResolvedValue({ ready: false, reason: "not interactive" });
      if (failure === "context-delivery") sendText.mockResolvedValue({ ok: false, code: "denied", message: "denied" });

      expect((await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" })).ok).toBe(false);
      expect(store.readCurrent(node.id)).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS n FROM applied_launch_observations WHERE generation_uuid = ?").get(generation)).toEqual({ n: 0 });
    },
  );

  it("invalidates predecessor posture at physical cutover before successor readiness", async () => {
    const { node } = seedSeat();
    const store = new AppliedLaunchObservationStore(db);
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    store.recordGeneration(generation, observeCodexSandbox(" -s workspace-write"));
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });
    checkReady.mockImplementation(async () => {
      await readyGate;
      return { ready: true };
    });

    const pending = service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });
    await vi.waitFor(() => expect(checkReady).toHaveBeenCalledTimes(1));
    expect(store.readCurrent(node.id)).toBeNull();
    expect(store.recordGeneration(generation, observeCodexSandbox(" -s danger-full-access"))).toBe(false);
    releaseReady();
    await pending;
  });

  it("invalidates predecessor posture before a failed respawn when sole-pane exit removes the tmux server", async () => {
    const { node } = seedSeat();
    const store = new AppliedLaunchObservationStore(db);
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    store.recordGeneration(generation, observeCodexSandbox(" -s workspace-write"));

    const adapter = new TmuxAdapter(async () => {
      throw new Error("no server running on /private/tmp/tmux-501/w3");
    });
    vi.spyOn(adapter, "capturePaneScreen").mockResolvedValue("predecessor screen tail");
    vi.spyOn(adapter, "listPanes").mockResolvedValue([
      { id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true },
    ]);
    vi.spyOn(adapter, "setRemainOnExit").mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });
    vi.spyOn(adapter, "signalPaneProcess").mockResolvedValue({ ok: true });
    vi.spyOn(adapter, "respawnPane").mockImplementation(async () => {
      expect(store.readCurrent(node.id)).toBeNull();
      return { ok: false, code: "no_server", message: "no server running" };
    });
    service = newService(adapter);

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    expect(adapter.respawnPane).toHaveBeenCalledTimes(1);
    expect(store.readCurrent(node.id)).toBeNull();
  });

  it("unwinds when context delivery fails WITHOUT killing the preserved seat (no false-green)", async () => {
    const { node } = seedSeat();
    sendText.mockResolvedValue({ ok: false, code: "session_not_found", message: "can't find session" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "context_delivery_failed" });
    expect((result as { message: string }).message).toContain("deliver-restore-packet");
    // Continuity verify never ran; the successor candidate is unwound (vanished) — but the preserved
    // seat is NEVER killed (it stays re-wakeable from its session file).
    expect(hasSession).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    const successorRow = db.prepare("SELECT status FROM discovered_sessions WHERE tmux_session = ?").get("dev-impl@seat-rig") as { status: string };
    expect(successorRow.status).toBe("vanished");
    // The seat's binding is unchanged — commit never ran.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
  });

  it("unwinds when continuity verify fails after delivery WITHOUT killing the preserved seat", async () => {
    const { node } = seedSeat();
    hasSession.mockResolvedValue(false);

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_tmux_absent" });
    // Delivery happened, THEN verify failed, THEN unwind — candidate vanished, preserved seat NOT killed.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(killSession).not.toHaveBeenCalled();
    const successorRow = db.prepare("SELECT status FROM discovered_sessions WHERE tmux_session = ?").get("dev-impl@seat-rig") as { status: string };
    expect(successorRow.status).toBe("vanished");
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
  });

  it("fails before mutation when discovered id is missing", async () => {
    seedSeat();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "discovered:missing",
    });

    expect(result).toMatchObject({ ok: false, code: "discovered_not_found" });
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when discovered successor vanished", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    discoveryRepo.markVanished([discovered.id]);
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "discovered_not_active" });
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when discovered successor is already claimed", async () => {
    const { node } = seedSeat();
    const discovered = seedDiscovery();
    discoveryRepo.markClaimed(discovered.id, node.id);
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "discovered_not_active" });
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when successor tmux session is absent", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    hasSession.mockResolvedValue(false);
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "successor_tmux_absent" });
    expect(durableRows()).toBe(before);
  });

  it("fails closed when tmux probe throws", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    hasSession.mockRejectedValue(new Error("socket permission denied"));
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "tmux_probe_failed" });
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation on runtime mismatch", async () => {
    seedSeat({ runtime: "codex" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code" });
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "runtime_mismatch" });
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when successor is already managed elsewhere", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    const otherRig = rigRepo.createRig("other-rig");
    const otherNode = rigRepo.addNode(otherRig.id, "dev.other", { runtime: "codex" });
    sessionRegistry.updateBinding(otherNode.id, { tmuxSession: "successor-session" });
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "successor_already_managed" });
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when the seat has no current occupant", async () => {
    seedSeat({ withSession: false });
    const discovered = seedDiscovery();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev.impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "current_occupant_required" });
    expect(durableRows()).toBe(before);
  });

  it("wires the daemon route for discovered live mutation", async () => {
    const routeTmux = { hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
    const setup = createTestApp(db, { tmux: routeTmux });
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "route-successor",
      tmuxPane: "%2",
      runtimeHint: "codex",
      confidence: "high",
    });

    const res = await setup.app.request("/api/seat/handover/dev-impl%40seat-rig", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "mvp-proof",
        source: `discovered:${discovered.id}`,
        operator: "orch-lead@seat-rig",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      dryRun: false,
      mutated: true,
      continuityTransferred: false,
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: "route-successor",
      currentStatus: { handoverResult: "complete" },
    });
  });
});
