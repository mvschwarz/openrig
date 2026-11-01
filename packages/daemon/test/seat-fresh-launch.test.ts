import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { seatSkillPaths } from "../src/domain/seat-skill-storage.js";
import { prepareSeatLaunchAdditions } from "../src/domain/seat-launch-additions.js";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { normalizeStartupBlock } from "../src/domain/startup-validation.js";
import { deriveOriented } from "../src/domain/startup-proof.js";
import { deriveRehydrateSessionIdByNode } from "../src/domain/active-occupant.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";
import type { NativeProcessLister, NativeProcessRow } from "../src/domain/native-process-lineage.js";

import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CLAUDE_BYPASS_CONSENT } from "./fixtures/claude-bypass-consent.js";

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
  let livePanes: Map<string, string>;
  let killed: string[];
  let tmux: TmuxAdapter;
  let projectedPlan: ProjectionPlan | null;
  let launchBinding: Record<string, unknown> | null;
  let launchOpts: Record<string, unknown> | null;
  let harnessResult: Awaited<ReturnType<RuntimeAdapter["launchHarness"]>>;
  let paneCommand: string;
  let adapter: RuntimeAdapter;
  let runtimeAdapters: Record<string, RuntimeAdapter>;
  let invalidations: Array<Record<string, unknown>>;
  let activitySwaps: Array<{ nodeId: string; generation: string }>;
  let service: SeatLifecycleService;
  let listProcesses: NativeProcessLister;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    alive = new Set();
    livePanes = new Map();
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
        livePanes.set(name, "%fresh");
        return { ok: true as const };
      }),
      killSession: vi.fn(async (name: string): Promise<TmuxResult> => {
        killed.push(name);
        alive.delete(name);
        livePanes.delete(name);
        return { ok: true };
      }),
      probeSession: vi.fn(async (name: string) => alive.has(name) ? { state: "present" as const } : { state: "absent" as const }),
      hasSession: vi.fn(async (name: string) => alive.has(name)),
      startServer: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
      listSessions: vi.fn(async () => [...alive].map((name) => ({ name, windows: 1, created: "", attached: false }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async (name: string) => {
        const pane = alive.has(name) ? livePanes.get(name) : undefined;
        return pane
          ? [{ id: pane, index: 0, cwd: "/project", width: 80, height: 24, active: true }]
          : [];
      }),
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
    listProcesses = async () => [{ pid: 4242, ppid: 1, pgid: 4242, tpgid: 4242,
      executableName: "codex", command: "/opt/native/codex -m model", argv: ["/opt/native/codex", "-m", "model"],
      startedAt: "Sat Jan  1 12:00:00 2000" }];
    runtimeAdapters = { "claude-code": adapter, codex: { ...adapter, runtime: "codex" } };
    service = new SeatLifecycleService({
      db,
      rigRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter: tmux,
      listProcesses: () => listProcesses(),
      nodeLauncher,
      startupOrchestrator,
      runtimeAdapters,
      occupantInvalidator: { invalidateRetiringOccupant: (input) => invalidations.push(input) },
      activityOracle: { declareOccupantSwap: (nodeId, generation) => activitySwaps.push({ nodeId, generation }) },
    });
  });

  afterEach(() => db.close());

  it.each([
    { runtime: "terminal" as const, fail: false },
    { runtime: "claude-code" as const, fail: false },
    { runtime: "claude-code" as const, fail: true },
  ])("#1939: reports view recovery after replacement: $runtime, startup failure=$fail", async ({ runtime, fail }) => {
    if (runtime === "terminal") runtimeAdapters.terminal = { ...adapter, runtime };
    const seat = seedSeat({ runtime });
    if (fail) adapter.launchHarness = async () => ({ ok: false, error: "fixture startup failure" });
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "replace occupant" });
    expect(result.ok).toBe(!fail);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(`Replacing the tmux session for "${seat.sessionName}" detaches its open terminal clients.`),
    ]));
    expect(result.warnings?.join("\n")).toContain("rig terminal open 'rig:fresh-rig' --window");
    expect(result.warnings?.join("\n")).toContain("--provider cmux");
  });

  it("#1939: a clean seat launch does not claim that it replaced an open tile", async () => {
    const seat = seedSeat({ clean: true });
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, reason: "first occupant" });
    expect(result.warnings?.some(warning => warning.includes("open terminal clients"))).not.toBe(true);
  });

  it.each([true, false])("#729: retains warnings independently of fresh identity (verified=%s)", async verified => {
    const seat = seedSeat();
    if (!verified) paneCommand = "codex"; // Positive wrong-runtime observation, not absent telemetry.
    adapter.project = async () => ({ projected: [], skipped: [], failed: [], warnings: ["Existing projection warning"] });
    db.prepare("UPDATE node_startup_context SET startup_actions_json = ? WHERE node_id = ?").run(JSON.stringify([
      { type: "send_text", value: "Startup context", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true },
    ]), seat.node.id);
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "explicit fresh" });
    expect(result.ok).toBe(verified);
    expect(result.warnings).toEqual(["Existing projection warning", expect.stringContaining("Startup submission unverified"), expect.stringContaining("open terminal clients")]);
    if (verified) expect(new SeatIdentityStore(db).getForNode(seat.node.id)?.verdict).toBe("verified");
    else expect(result).toMatchObject({ code: "runtime_identity_unverified", status: "attention_required" });
  });

  it.each(["valid", "missing path", "wrong token", "no token"])("numeric Claude pane fresh launch: %s", async mode => {
    const seat = seedSeat();
    paneCommand = "2.1.289";
    if (mode === "no token") harnessResult = { ok: true };
    const startedAt = "Sun Oct  4 12:00:00 2026";
    const rows: NativeProcessRow[] = [
      { pid: 4242, ppid: 1, pgid: 4242, tpgid: 4243, executableName: "zsh", command: "-zsh", startedAt },
      { pid: 4243, ppid: 4242, pgid: 4243, tpgid: 4243, executableName: "2.1.289",
        command: `claude --session-id ${mode === "wrong token" ? "other" : "fresh-native-uuid"}`, startedAt,
        executablePath: mode === "missing path" ? undefined : "/fixture/.local/share/claude/versions/2.1.289" },
    ];
    const observe = vi.fn(async () => rows);
    listProcesses = observe;
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "fresh occupant" });
    expect(result.ok).toBe(mode === "valid");
    const current = sessionRegistry.getSessionsForRig(seat.rig.id).find(s => s.status === "running")!;
    expect(current.id).not.toBe(seat.session!.id);
    expect(current.startupStatus).toBe(mode === "valid" ? "ready" : "attention_required");
    expect(new SeatIdentityStore(db).getForNode(seat.node.id)?.verdict).toBe(mode === "valid" ? "verified" : "mismatch");
    expect(alive.has(seat.sessionName)).toBe(true);
    if (mode === "valid") expect(observe).toHaveBeenCalledTimes(2);
  });

  it("default-path consent retains context and continues the same occupant once after late acceptance", async () => {
    const seat = seedSeat();
    const actions = normalizeStartupBlock({ actions: [{ type: "send_text", value: "Configured startup instructions", idempotent: true }] }).actions;
    db.prepare("UPDATE node_startup_context SET startup_actions_json=? WHERE node_id=?").run(JSON.stringify(actions), seat.node.id);
    let screen = CLAUDE_BYPASS_CONSENT;
    tmux.capturePaneContent = vi.fn(async () => screen);
    const native = new ClaudeCodeAdapter({ tmux, fsOps: {
      readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {},
    } });
    adapter.checkReady = binding => native.checkReady(binding);
    const first = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "fixture" });
    expect(first).toMatchObject({ ok: false, status: "attention_required" });
    const message = "message" in first ? first.message : "";
    expect(message).toContain("rig seat continue");
    expect(message).toContain(seat.sessionName);
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    const sessions = sessionRegistry.getSessionsForRig(seat.rig.id);
    const binding = sessionRegistry.getBindingForNode(seat.node.id);
    const nativeIds = db.prepare("SELECT id, resume_type, resume_token FROM sessions WHERE node_id=? ORDER BY id").all(seat.node.id);
    const launch = vi.spyOn(adapter, "launchHarness");
    expect(await service.continueStartup(seat.sessionName)).toMatchObject({ ok: false, code: "attention_required" });
    expect(tmux.sendText).not.toHaveBeenCalled();
    // The person has accepted in the same pane; no new process or session.
    screen = "Claude Code v2.1.282\n❯ ";
    const send = vi.mocked(tmux.sendText);
    send.mockImplementation(async () => {
      const last = db.prepare("SELECT type FROM events WHERE node_id=? AND type IN ('node.startup_pending','node.startup_ready','node.startup_failed') ORDER BY seq DESC LIMIT 1").get(seat.node.id);
      expect(last).toEqual({ type: "node.startup_pending" });
      return { ok: true };
    });
    expect(await service.continueStartup(seat.sessionName)).toMatchObject({ ok: true });
    expect(launch).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT id, resume_type, resume_token FROM sessions WHERE node_id=? ORDER BY id").all(seat.node.id)).toEqual(nativeIds);
    expect(send.mock.calls[0]?.[1]).toContain("Configured startup instructions");
    expect(sessionRegistry.getSessionsForRig(seat.rig.id).map(s => s.id)).toEqual(sessions.map(s => s.id));
    expect(sessionRegistry.getBindingForNode(seat.node.id)?.tmuxPane).toBe(binding?.tmuxPane);
    expect(await service.continueStartup(seat.sessionName)).toMatchObject({ ok: false, code: "continuation_unavailable" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["launch", "readiness"])("continues a fresh occupant gated at %s exactly once without another launch", async (gate) => {
    const seat = seedSeat();
    if (gate === "launch") harnessResult = { ok: false, recovery: "attention_required", error: "native gate" };
    else adapter.checkReady = async () => ({ ready: false, code: "hook_trust_gate", reason: "native gate" });
    const first = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "explicit fresh" });
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected pending startup context");
    expect(first.message).toContain(`After resolving it in ${seat.sessionName}, run: rig seat continue`);
    adapter.checkReady = async () => ({ ready: true });
    const rows = sessionRegistry.getSessionsForRig(seat.rig.id).map((s) => s.id);
    const launch = vi.spyOn(adapter, "launchHarness");
    const delivery = vi.spyOn(adapter, "deliverStartup");
    const continued = await service.continueStartup(seat.sessionName);
    expect(continued.ok).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect(delivery).toHaveBeenCalled();
    expect(sessionRegistry.getSessionsForRig(seat.rig.id).map((s) => s.id)).toEqual(rows);
    delivery.mockClear();
    expect((await service.continueStartup(seat.sessionName)).ok).toBe(false);
    expect(delivery).not.toHaveBeenCalled();
  });

  it("continues a fresh occupant once when another pending event for it arrives during the readiness check", async () => {
    const seat = seedSeat();
    adapter.checkReady = async () => ({ ready: false, code: "hook_trust_gate", reason: "native gate" });
    const first = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "explicit fresh" });
    expect(first.ok).toBe(false);
    const occupant = db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(seat.node.id) as { id: string };
    let reported = false;
    adapter.checkReady = async () => {
      // The same occupant's fresh context is reported pending again while `continue` observes the pane.
      if (!reported) {
        reported = true;
        eventBus.emit({ type: "node.startup_failed", rigId: seat.rig.id, nodeId: seat.node.id, sessionId: occupant.id,
          error: "native gate reported again", freshContextPending: true });
      }
      return { ready: true };
    };
    const delivery = vi.spyOn(adapter, "deliverStartup");
    expect(await service.continueStartup(seat.sessionName)).toMatchObject({ ok: true });
    expect(delivery).toHaveBeenCalledTimes(1);
    expect((await service.continueStartup(seat.sessionName)).ok).toBe(false);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it("supersedes detached history so a later reboot identifies the deliberate successor", async () => {
    const seat = seedSeat();
    alive.delete(seat.sessionName);
    livePanes.delete(seat.sessionName);
    sessionRegistry.markDetached(seat.session!.id);
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, reason: "explicit fresh after process loss" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supersededSessionIds).toContain(seat.session!.id);
    sessionRegistry.markDetached(result.sessionId);
    const history = sessionRegistry.getSessionsForRig(seat.rig.id);
    expect(history.find((row) => row.id === seat.session!.id)?.status).toBe("superseded");
    expect(deriveRehydrateSessionIdByNode(history, [seat.node.id])[seat.node.id]).toBe(result.sessionId);
  });

  it("recovers an older fresh effect from its current generation without rewriting history", async () => {
    const seat = seedSeat();
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "explicit successor" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Reproduce the old build's unsuperseded detached predecessor after reboot.
    sessionRegistry.markDetached(seat.session!.id);
    sessionRegistry.markDetached(result.sessionId);
    const history = sessionRegistry.getSessionsForRig(seat.rig.id);
    const recorded = readFreshOccupantRelations(db, seat.rig.id);
    expect(deriveRehydrateSessionIdByNode(history, [seat.node.id], recorded)[seat.node.id]).toBe(result.sessionId);
    expect(sessionRegistry.getSessionsForRig(seat.rig.id)).toEqual(history);
    // A later occupant generation invalidates the old effect; no newest-row fallback.
    sessionRegistry.mintOccupantTenure(seat.node.id, "handover");
    expect(readFreshOccupantRelations(db, seat.rig.id)).toEqual({});
    expect(deriveRehydrateSessionIdByNode(history, [seat.node.id], readFreshOccupantRelations(db, seat.rig.id))[seat.node.id]).toBeNull();
  });

  function seedSeat(opts?: { clean?: boolean; adopted?: boolean; model?: string; withContext?: boolean; runtime?: "claude-code" | "codex" | "terminal" }) {
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
      livePanes.set(sessionName, "%old");
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

  // OPR.0.7.0.9: the fresh-launch plan lists the seat's own launch additions (what its launch will pass), and null for
  // a seat without any. It writes nothing.
  it("lists the seat's launch additions, and none for a seat without them", async () => {
    const seat = seedSeat({ clean: true });
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-plan-additions-"));
    try {
      fs.writeFileSync(path.join(src, "prompt.md"), "Short answers.\n");
      const paths = seatSkillPaths({ rigId: seat.rig.id, logicalId: "dev.impl", runtime: "claude-code" });
      const peer = rigRepo.addNode(seat.rig.id, "dev.peer", { runtime: "claude-code", cwd: "/project" });
      sessionRegistry.registerSession(peer.id, "dev-peer@fresh-rig");
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(peer.id);
      const prepared = prepareSeatLaunchAdditions(paths, { appendSystemPromptFile: path.join(src, "prompt.md") });
      if (!prepared.ok) throw new Error(prepared.message);
      const result = await service.planFresh({ seatRef: seat.sessionName, fresh: true });
      expect(result).toMatchObject({ ok: true, launchAdditions: { appendSystemPromptFile: prepared.additions.appendSystemPromptFile, pluginDirs: [], missing: [], refused: [] } });
      const none = await service.planFresh({ seatRef: "dev-peer@fresh-rig", fresh: true });
      expect(none).toMatchObject({ ok: true, launchAdditions: null });
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });

  it.each([false, true])("previews fresh launch without changing target, siblings or startup state (live=%s)", async live => {
    const seat = seedSeat({ clean: !live });
    const sibling = rigRepo.addNode(seat.rig.id, "dev.qa", { runtime: "claude-code", cwd: "/sibling" });
    const siblingSession = sessionRegistry.registerSession(sibling.id, "dev-qa@fresh-rig");
    sessionRegistry.updateBinding(sibling.id, { tmuxSession: siblingSession.sessionName, tmuxPane: "%qa" });
    alive.add(siblingSession.sessionName);
    for (const name of ["project", "deliverStartup", "launchHarness", "checkReady"] as const) vi.spyOn(adapter, name);
    const before = db.serialize();
    const result = await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: true });
    expect(result).toMatchObject({ ok: true, planOnly: true, complete: true, launchable: true,
      currentOccupant: live ? "present" : "absent", wouldStop: live, stopRequired: live,
      siblings: [{ logicalId: "dev.qa", sessionName: siblingSession.sessionName, effect: "unchanged" }] });
    expect(result).not.toHaveProperty("command");
    expect(result).not.toHaveProperty("permission");
    expect(db.serialize()).toEqual(before);
    for (const name of ["createSession", "killSession", "startServer", "sendText", "sendKeys", "setSessionOption"] as const) expect(tmux[name]).not.toHaveBeenCalled();
    for (const name of ["project", "deliverStartup", "launchHarness", "checkReady"] as const) expect(adapter[name]).not.toHaveBeenCalled();
    expect(alive.has(siblingSession.sessionName)).toBe(true);
    expect(invalidations).toEqual([]);
    expect(activitySwaps).toEqual([]);
  });

  it("returns an incomplete redacted plan when tmux cannot be read, without repairing it", async () => {
    const seat = seedSeat();
    await service.stopSeat({ seatRef: seat.sessionName, reason: "fixture stop" });
    vi.clearAllMocks();
    vi.mocked(tmux.probeSession).mockRejectedValue(new Error("secret-provider-token"));
    const before = db.serialize();
    const result = await service.planFresh({ seatRef: seat.sessionName, fresh: true });
    expect(result).toMatchObject({ ok: true, planOnly: true, complete: false, launchable: null,
      currentOccupant: "unknown", stopRequired: null, wouldStop: null });
    expect(JSON.stringify(result)).not.toContain("secret-provider-token");
    expect(db.serialize()).toEqual(before);
    expect(tmux.startServer).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it.each(["live", "adopted", "collision", "pane", "history"])("previews a known %s blocker without mutation", async mode => {
    const seat = seedSeat({ adopted: mode === "adopted", clean: mode === "collision" });
    if (mode === "collision") alive.add(seat.sessionName);
    if (mode === "pane") livePanes.set(seat.sessionName, "%other");
    if (mode === "history") {
      const old = sessionRegistry.registerSession(seat.node.id, "old@fresh-rig");
      sessionRegistry.updateStatus(old.id, "running");
      alive.add(old.sessionName);
    }
    const before = db.serialize();
    const result = await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: mode !== "live" });
    expect(result).toMatchObject({ ok: true, planOnly: true, launchable: false, wouldStop: false });
    if (!result.ok) throw new Error("Expected resolved plan");
    expect(result.blockers.map(b => b.code)).toContain(mode === "adopted" ? "claimed_session" : ["collision", "pane"].includes(mode) ? "unmanaged_session_collision" : "session_live");
    if (mode === "history") expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: 'Historical session "old@fresh-rig" is still live; fresh launch refuses to change this seat.',
        guidance: "rig seat stop targets the seat's latest session, not a selected historical session; it may stop the current occupant instead.",
      }),
    ]));
    expect(db.serialize()).toEqual(before);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.startServer).not.toHaveBeenCalled();
  });

  it("preserves the adopted seat name and manual cleanup guidance in plans and execution", async () => {
    const seat = seedSeat({ adopted: true });
    const expected = {
      code: "claimed_session",
      message: `Seat "${seat.sessionName}" has an adopted/operator-owned occupant; fresh launch refuses even with --stop.`,
      guidance: "Stop the adopted process yourself, then run rig seat clean before launching fresh.",
    };
    const before = db.serialize();
    expect(await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: true }))
      .toMatchObject({ launchable: false, wouldStop: false, blockers: expect.arrayContaining([expected]) });
    expect(db.serialize()).toEqual(before);
    expect(await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "fixture" }))
      .toMatchObject({ ok: false, ...expected });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("keeps stop effects unknown when pane identity cannot be observed", async () => {
    const seat = seedSeat();
    vi.mocked(tmux.listPanes).mockRejectedValue(new Error("secret-pane-error"));
    const result = await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: true });
    expect(result).toMatchObject({ complete: false, launchable: null, currentOccupant: "present", stopRequired: null, wouldStop: null });
    expect(JSON.stringify(result)).not.toContain("secret-pane-error");
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it("does not expose startup content or malformed JSON in a plan", async () => {
    const seat = seedSeat({ clean: true });
    const secret = "SECRET_STARTUP_CONTENT";
    db.prepare("UPDATE node_startup_context SET startup_actions_json = ? WHERE node_id = ?").run(JSON.stringify([
      { type: "send_text", value: secret, phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true },
    ]), seat.node.id);
    const valid = await service.planFresh({ seatRef: seat.sessionName, fresh: true });
    expect(valid).toMatchObject({ startup: { actionCount: 1 } });
    expect(JSON.stringify(valid)).not.toContain(secret);
    db.prepare("UPDATE node_startup_context SET startup_actions_json = ? WHERE node_id = ?").run(secret, seat.node.id);
    const invalid = await service.planFresh({ seatRef: seat.sessionName, fresh: true });
    expect(invalid).toMatchObject({ ok: false, planOnly: true, code: "startup_context_malformed" });
    expect(JSON.stringify(invalid)).not.toContain(secret);
  });

  it("execution resolves again when state changes after preview", async () => {
    const seat = seedSeat({ clean: true });
    expect(await service.planFresh({ seatRef: seat.sessionName, fresh: true })).toMatchObject({ launchable: true });
    alive.add(seat.sessionName);
    expect(await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "execute after preview" }))
      .toMatchObject({ ok: false, code: "unmanaged_session_collision" });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it.each(["missing", "runtime", "adapter", "ambiguous"])("refuses invalid %s preview inputs before native observation", async mode => {
    const seat = seedSeat({ clean: true, withContext: mode !== "missing" });
    if (mode === "runtime") db.prepare("UPDATE node_startup_context SET runtime = 'codex' WHERE node_id = ?").run(seat.node.id);
    if (mode === "adapter") {
      db.prepare("UPDATE nodes SET runtime = 'terminal' WHERE id = ?").run(seat.node.id);
      db.prepare("UPDATE node_startup_context SET runtime = 'terminal' WHERE node_id = ?").run(seat.node.id);
    }
    if (mode === "ambiguous") rigRepo.addNode(rigRepo.createRig("other-rig").id, "dev.impl", { runtime: "claude-code" });
    const result = await service.planFresh({ seatRef: "dev.impl", fresh: true });
    const code = { missing: "startup_context_missing", runtime: "startup_context_runtime_mismatch", adapter: "runtime_adapter_missing", ambiguous: "seat_ambiguous" }[mode];
    expect(result).toMatchObject({ ok: false, planOnly: true, launchable: false, code });
    expect(tmux.probeSession).not.toHaveBeenCalled();
    expect(tmux.startServer).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("reports typing protection without acquiring or modifying a lifecycle lock", async () => {
    const seat = seedSeat({ clean: true });
    const lifecycle = vi.fn();
    Object.defineProperty(tmux, "deliveryGuard", { value: { preference: () => ({ desired: true, effective: true }), lifecycle } });
    const result = await service.planFresh({ seatRef: seat.sessionName, fresh: true });
    expect(result).toMatchObject({ launchable: false, wouldStop: false, blockers: [{ code: "typing_guard_enabled" }] });
    expect(lifecycle).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("uses a captured sibling snapshot if the rig disappears during asynchronous observation", async () => {
    const seat = seedSeat({ clean: true });
    vi.mocked(tmux.probeSession).mockImplementation(async () => {
      vi.spyOn(rigRepo, "getRig").mockReturnValue(null);
      return { state: "absent" };
    });
    expect(await service.planFresh({ seatRef: seat.sessionName, fresh: true })).toMatchObject({ ok: true, planOnly: true, siblings: [] });
  });

  it("does not promise a stop when a historical tmux probe is unknown", async () => {
    const seat = seedSeat();
    const historical = sessionRegistry.registerSession(seat.node.id, "old@fresh-rig");
    sessionRegistry.updateStatus(historical.id, "running");
    vi.mocked(tmux.probeSession).mockImplementation(async name => name === historical.sessionName
      ? { state: "transport_unavailable", cause: "fixture" } : { state: "present" });
    // Keep the canonical binding/row ownership proof independent of the history probe.
    const current = sessionRegistry.registerSession(seat.node.id, seat.sessionName);
    sessionRegistry.updateStatus(current.id, "running");
    const result = await service.planFresh({ seatRef: seat.sessionName, fresh: true, stop: true });
    expect(result).toMatchObject({ complete: false, launchable: null, wouldStop: null });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });


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

  it.each(["authenticated", "none", "unknown"])("fresh launch consumes persisted proof selection %s", async (value) => {
    const seat = seedSeat({ clean: true });
    const actions = normalizeStartupBlock({ actions: [{ type: "startup_proof", value, idempotent: true }] }).actions;
    db.prepare("UPDATE node_startup_context SET startup_actions_json=? WHERE node_id=?").run(JSON.stringify(actions), seat.node.id);
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, reason: "fixture" });
    if (value === "unknown") {
      expect(result).toMatchObject({ ok: false, code: "startup_context_malformed" });
      expect(tmux.createSession).not.toHaveBeenCalled();
    } else {
      expect(result.ok).toBe(true);
      expect(projectedPlan?.startup.actions).toEqual(actions);
      expect(deriveOriented(db, seat.node.id)).toBe(value === "authenticated" ? "missing" : "n-a");
    }
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

  it("checks historical occupants before stopping the current managed seat", async () => {
    const seat = seedSeat({ clean: true });
    const historical = sessionRegistry.registerSession(seat.node.id, "old-impl@fresh-rig");
    sessionRegistry.updateStatus(historical.id, "running");
    const current = sessionRegistry.registerSession(seat.node.id, seat.sessionName);
    sessionRegistry.updateStatus(current.id, "running");
    sessionRegistry.updateBinding(seat.node.id, { tmuxSession: seat.sessionName, tmuxPane: "%old" });
    alive.add(seat.sessionName);
    livePanes.set(seat.sessionName, "%old");
    alive.add(historical.sessionName);
    const before = db.serialize();
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "history gate" });
    expect(result).toMatchObject({
      ok: false, code: "session_live",
      message: `Historical session "${historical.sessionName}" is still live; fresh launch refuses to change this seat.`,
      guidance: "rig seat stop targets the seat's latest session, not a selected historical session; it may stop the current occupant instead.",
    });
    expect(killed).toEqual([]);
    expect(db.serialize()).toEqual(before);
    expect(tmux.startServer).not.toHaveBeenCalled();
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

  it("refuses to stop a canonical session whose live pane does not match the managed binding", async () => {
    const seat = seedSeat();
    livePanes.set(seat.sessionName, "%unmanaged");

    const result = await service.launchFresh({
      seatRef: "dev.impl",
      fresh: true,
      stop: true,
      reason: "live occupant ownership discriminator",
    });

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
    expect(tmux.startServer).not.toHaveBeenCalled();
  });

  it.each(["probe failure", "collision"])("keeps a refused replacement degraded after stopping its occupant: %s", async (mode) => {
    const seat = seedSeat();
    sessionRegistry.updateStartupStatus(seat.session!.id, "ready");
    const sibling = rigRepo.addNode(seat.rig.id, "dev.qa", { runtime: "claude-code", cwd: "/sibling" });
    const siblingSession = sessionRegistry.registerSession(sibling.id, "dev-qa@fresh-rig");
    sessionRegistry.updateStatus(siblingSession.id, "running");
    sessionRegistry.updateStartupStatus(siblingSession.id, "ready");
    sessionRegistry.updateBinding(sibling.id, { attachmentType: "tmux", tmuxSession: siblingSession.sessionName, tmuxPane: "%qa" });
    alive.add(siblingSession.sessionName);
    livePanes.set(siblingSession.sessionName, "%qa");
    // This hook runs after the managed occupant was killed, before the final probe.
    vi.mocked(tmux.startServer).mockImplementationOnce(async () => {
      if (mode === "collision") {
        alive.add(seat.sessionName);
        livePanes.set(seat.sessionName, "%unmanaged");
      } else {
        vi.mocked(tmux.probeSession).mockResolvedValueOnce({ state: "transport_unavailable", cause: "final probe failed" });
      }
      return { ok: true };
    });

    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "replace occupant" });
    expect(result).toMatchObject({ ok: false, code: mode === "collision" ? "unmanaged_session_collision" : "tmux_probe_failed" });
    expect(killed).toEqual([seat.sessionName]);
    expect(alive.has(siblingSession.sessionName)).toBe(true);
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(sessionRegistry.getBindingForNode(seat.node.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE node_id = ?").get(seat.node.id)).toEqual({ count: 1 });
    expect(getNodeInventory(db, seat.rig.id).find((entry) => entry.nodeId === seat.node.id)).toMatchObject({
      sessionStatus: "exited", intentionallyStopped: false,
    });
    expect(new PsProjectionService({ db }).getEntries().find((entry) => entry.rigId === seat.rig.id)).toMatchObject({
      lifecycleState: "degraded", status: "partial", nodeCount: 2, runningCount: 1,
    });
  });

  // Real tmux ends its server when the last session goes (exit-empty), and a
  // probe then fails "no server running": transport_unavailable, never absence.
  // new-session and startServer() each bring a server back.
  function modelServerLifetime() {
    const server = { up: true, starts: 0 };
    const createSession = vi.mocked(tmux.createSession).getMockImplementation()!;
    vi.mocked(tmux.createSession).mockImplementation(async (...args) => {
      server.up = true;
      return createSession(...args);
    });
    vi.mocked(tmux.killSession).mockImplementation(async (name: string) => {
      killed.push(name);
      alive.delete(name);
      livePanes.delete(name);
      if (alive.size === 0) server.up = false;
      return { ok: true };
    });
    vi.mocked(tmux.probeSession).mockImplementation(async (name: string) => {
      if (!server.up) return { state: "transport_unavailable", cause: "no server running on /tmp/tmux-1000/default" };
      return alive.has(name) ? { state: "present" } : { state: "absent" };
    });
    vi.mocked(tmux.hasSession).mockImplementation(async (name: string) => server.up && alive.has(name));
    vi.mocked(tmux.startServer).mockImplementation(async () => {
      if (!server.up) {
        server.up = true;
        server.starts += 1;
      }
      return { ok: true };
    });
    return server;
  }

  describe("when stopping the managed occupant ends the tmux server", () => {
    it.each(["sole", "pair"] as const)("continues the requested fresh launch for a %s seat", async (shape) => {
      const seat = seedSeat();
      const retiringGeneration = sessionRegistry.currentOccupantTenure(seat.node.id)!.generationUuid;
      if (shape === "pair") alive.add("dev-qa@fresh-rig");
      const server = modelServerLifetime();

      const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "sole-seat fresh" });

      expect(result).toMatchObject({ ok: true, status: "ready", sessionName: seat.sessionName });
      if (!result.ok) return;
      expect(killed).toEqual([seat.sessionName]);
      expect(server.starts).toBe(shape === "sole" ? 1 : 0);
      expect(tmux.createSession).toHaveBeenCalledTimes(1);
      expect(alive.has(seat.sessionName)).toBe(true);
      expect(result.generation).not.toBe(retiringGeneration);
      expect(result.supersededSessionIds).toContain(seat.session!.id);
      expect(sessionRegistry.getBindingForNode(seat.node.id)?.tmuxPane).toBe("%fresh");
    });

    it("reopens an empty tmux server after an explicit stop before a fresh launch", async () => {
      const seat = seedSeat();
      const server = modelServerLifetime();

      const stopped = await service.stopSeat({ seatRef: seat.sessionName, reason: "operator requested stop" });
      expect(stopped).toMatchObject({ ok: true });
      expect(server).toEqual({ up: false, starts: 0 });

      const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, reason: "start a new occupant" });

      expect(result).toMatchObject({ ok: true, status: "ready", sessionName: seat.sessionName });
      expect(server).toEqual({ up: true, starts: 1 });
      expect(tmux.createSession).toHaveBeenCalledTimes(1);
      expect(alive.has(seat.sessionName)).toBe(true);
    });

    it("proves older non-terminal rows absent on the restored server before superseding them", async () => {
      const seat = seedSeat({ clean: true });
      const older = sessionRegistry.registerSession(seat.node.id, "r00-dev-impl@fresh-rig");
      sessionRegistry.updateStatus(older.id, "running");
      const current = sessionRegistry.registerSession(seat.node.id, seat.sessionName);
      sessionRegistry.updateStatus(current.id, "running");
      sessionRegistry.updateBinding(seat.node.id, { tmuxSession: seat.sessionName, tmuxPane: "%old" });
      alive.add(seat.sessionName);
      livePanes.set(seat.sessionName, "%old");
      const server = modelServerLifetime();

      const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "old-row history" });

      expect(result).toMatchObject({ ok: true, status: "ready" });
      if (!result.ok) return;
      expect(server.starts).toBe(1);
      expect(vi.mocked(tmux.probeSession).mock.calls.map(([name]) => name)).toContain("r00-dev-impl@fresh-rig");
      expect(result.supersededSessionIds).toEqual(expect.arrayContaining([older.id, current.id]));
      expect(killed).toEqual([seat.sessionName]);
    });

    it("still refuses a same-name session that appears on the restored server", async () => {
      const seat = seedSeat();
      const server = modelServerLifetime();
      vi.mocked(tmux.startServer).mockImplementation(async () => {
        server.up = true;
        server.starts += 1;
        alive.add(seat.sessionName);
        livePanes.set(seat.sessionName, "%recreated");
        return { ok: true };
      });

      const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "recreated occupant" });

      expect(result).toMatchObject({ ok: false, code: "unmanaged_session_collision" });
      expect(killed).toEqual([seat.sessionName]);
      expect(tmux.createSession).not.toHaveBeenCalled();
      expect(livePanes.get(seat.sessionName)).toBe("%recreated");
    });

    it.each([
      ["the server cannot be restored", () => undefined],
      ["the probe fails with a permission error", () => { throw new Error("permission denied"); }],
    ])("keeps the transport refusal when %s", async (_label, afterStop) => {
      const seat = seedSeat();
      const server = modelServerLifetime();
      const probe = vi.mocked(tmux.probeSession).getMockImplementation()!;
      vi.mocked(tmux.probeSession).mockImplementation(async (name: string) => {
        if (!server.up) afterStop();
        return probe(name);
      });
      vi.mocked(tmux.startServer).mockResolvedValue({ ok: false, code: "tmux_unavailable", message: "The terminal server did not become available." });

      const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "transport stays down" });

      expect(result).toMatchObject({ ok: false, code: "tmux_probe_failed" });
      expect(killed).toEqual([seat.sessionName]);
      expect(tmux.createSession).not.toHaveBeenCalled();
    });

    it("neither stops nor starts a server when stop was not requested", async () => {
      const seat = seedSeat();
      const server = modelServerLifetime();

      const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, reason: "no stop" });

      expect(result).toMatchObject({ ok: false, code: "session_live" });
      expect(killed).toEqual([]);
      expect(tmux.startServer).not.toHaveBeenCalled();
      expect(server).toEqual({ up: true, starts: 0 });
    });

    it("does not start a server it did not stop: a seat with no server stays a transport refusal", async () => {
      seedSeat({ clean: true });
      const server = modelServerLifetime();
      server.up = false;

      const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "server already down" });

      expect(result).toMatchObject({ ok: false, code: "tmux_probe_failed" });
      expect(tmux.startServer).not.toHaveBeenCalled();
      expect(tmux.createSession).not.toHaveBeenCalled();
    });
  });

  it("stops exactly the managed pod-aware occupant, launches fresh, and preserves sibling/work state", async () => {
    const seat = seedSeat();
    rigRepo.setNodeAdvisor(seat.node.id, "opus");
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
    expect(result.advisor).toBe("opus");
    expect(result.generation).not.toBe(retiringGeneration);
    expect(killed).toEqual([seat.sessionName]);
    expect(alive.has(seat.sessionName)).toBe(true);
    expect(alive.has(siblingName)).toBe(true);
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(siblingSession.id) as { status: string }).status).toBe("running");
    expect((db.prepare("SELECT state FROM queue_items WHERE qitem_id = 'q-fresh'").get() as { state: string }).state).toBe("pending");
    expect(sessionRegistry.getBindingForNode(seat.node.id)?.tmuxPane).toBe("%fresh");
    expect(launchBinding).toMatchObject({ model: "claude-current", advisor: "opus", tmuxSession: seat.sessionName, tmuxPane: "%fresh" });
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
      advisor: "opus",
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

  it("#116: a ready fresh launch supersedes the seat's failed full restore without rewriting it", async () => {
    const seat = seedSeat();
    eventBus.emit({ type: "restore.started", rigId: seat.rig.id, snapshotId: "snap-1" });
    eventBus.emit({
      type: "restore.completed",
      rigId: seat.rig.id,
      snapshotId: "snap-1",
      result: { snapshotId: "snap-1", preRestoreSnapshotId: "snap-0", rigResult: "failed", nodes: [{ nodeId: seat.node.id, logicalId: "dev.impl", status: "failed" }], warnings: [] },
    } as any);
    expect(getNodeInventory(db, seat.rig.id)[0]).toMatchObject({ restoreOutcome: "failed", lifecycleState: "attention_required" });

    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, stop: true, reason: "replace the failed occupant" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.fresh_launched' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ newGeneration: result.generation, status: "ready" });
    expect(sessionRegistry.currentOccupantTenure(seat.node.id)?.generationUuid).toBe(result.generation);
    expect(getNodeInventory(db, seat.rig.id)[0]).toMatchObject({
      restoreOutcome: "n-a",
      lifecycleState: "running",
      continuityOutcome: "fresh",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'restore.completed'").get()).toEqual({ n: 1 });
  });

  it("OPR.0.7.0.7: a fresh launch sends the seat's saved effort choice over its authored effort, and records it", async () => {
    const seat = seedSeat({ clean: true, runtime: "codex", model: "gpt-5.6-codex" });
    rigRepo.setNodeEffort(seat.node.id, "medium");
    rigRepo.setNodeEffortChoice(seat.node.id, "high");
    harnessResult = { ok: true, resumeToken: "codex-fresh-uuid", resumeType: "codex_thread_id" };
    paneCommand = "codex";

    const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "apply effort" });

    expect(result).toMatchObject({ ok: true, effort: "high" });
    expect(launchBinding).toMatchObject({ effort: "high" });
    const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.fresh_launched' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ effort: "high" });
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

  it("keeps a fresh occupant alive when its startup prompt remains staged", async () => {
    const seat = seedSeat({ clean: true });
    db.prepare("UPDATE node_startup_context SET startup_actions_json = ? WHERE node_id = ?").run(
      JSON.stringify([{ type: "send_text", builtin: "session_identity", value: "OpenRig session identity: dev-impl@fresh-rig", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }]),
      seat.node.id,
    );
    let composer = "";
    vi.mocked(tmux.sendText).mockImplementation(async (_target, text) => {
      composer += text;
      return { ok: true };
    });
    tmux.capturePaneContent = vi.fn(async () => `❯ ${composer}\n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n`);
    const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "staged prompt preservation" });
    expect(result).toMatchObject({ ok: true, status: "ready" });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
    expect(composer).toContain("OpenRig session identity:");
    expect(alive.has(seat.sessionName)).toBe(true);
    expect(sessionRegistry.getBindingForNode(seat.node.id)?.tmuxPane).toBe("%fresh");
    expect(sessionRegistry.getSessionsForRig(seat.rig.id).at(-1)).toMatchObject({ status: "running", startupStatus: "ready" });
    const event = db.prepare("SELECT payload FROM events WHERE type = 'node.startup_ready' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ submission: { status: "staged", warning: expect.stringContaining("press Enter in that pane") } });
    expect(db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'seat.fresh_launch_failed'").get()).toEqual({ c: 0 });
  });

  it("compensates a hard startup failure to zero live session and binding while retaining audit tenure", async () => {
    const seat = seedSeat({ clean: true });
    harnessResult = { ok: false, error: "binary missing" };
    adapter.project = async () => ({ projected: [], skipped: [], failed: [], warnings: ["Earlier projection warning"] });
    const result = await service.launchFresh({ seatRef: "dev.impl", fresh: true, reason: "hard failure proof" });
    expect(result).toMatchObject({ ok: false, code: "startup_failed", status: "failed", warnings: ["Earlier projection warning"] });
    expect(alive.has(seat.sessionName)).toBe(false);
    expect(sessionRegistry.getBindingForNode(seat.node.id)).toBeNull();
    const sessions = sessionRegistry.getSessionsForRig(seat.rig.id).filter((row) => row.nodeId === seat.node.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: "exited", startupStatus: "failed" });
    expect(sessionRegistry.currentOccupantTenure(seat.node.id)?.kind).toBe("fresh");
    expect(db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'seat.fresh_launch_failed'").get()).toEqual({ c: 1 });
  });

  // #261: a fresh launch delivers stored built-in startup files from the RUNNING install;
  // a custom rig file with the same basename is delivered exactly as stored.
  it("#261 delivers stored built-ins from the running install and leaves custom files untouched", async () => {
    const seat = seedSeat({ clean: true });
    const oldAssets = "/mise/installs/npm-openrig-cli/0.6.2/node_modules/@openrig/cli/daemon/assets";
    const running = path.resolve(import.meta.dirname, "../assets");
    const meta = { deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] };
    const stored = [
      { path: "CULTURE-default.md", absolutePath: `${oldAssets}/guidance/CULTURE-default.md`, ownerRoot: oldAssets, ...meta },
      { path: "openrig-onboarding-01.md", absolutePath: `${oldAssets}/onboarding/01-world-and-purpose.md`, ownerRoot: oldAssets, ...meta },
      { path: "CULTURE-default.md", absolutePath: "/project/CULTURE-default.md", ownerRoot: "/project", ...meta },
    ];
    db.prepare("UPDATE node_startup_context SET resolved_files_json=? WHERE node_id=?").run(JSON.stringify(stored), seat.node.id);
    const delivered: Array<{ path: string; absolutePath: string; ownerRoot: string; required: boolean }> = [];
    adapter.deliverStartup = async (files) => { delivered.push(...(files as typeof delivered)); return { delivered: files.length, failed: [] }; };
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, reason: "issue 261" });
    expect(result.ok).toBe(true);
    expect(delivered.map((f) => f.absolutePath).sort()).toEqual([
      "/project/CULTURE-default.md",
      `${running}/guidance/CULTURE-default.md`,
      `${running}/onboarding/01-world-and-purpose.md`,
    ].sort());
    expect(delivered.every((f) => f.required)).toBe(true);
    const persisted = JSON.parse((db.prepare("SELECT resolved_files_json AS j FROM node_startup_context WHERE node_id=?").get(seat.node.id) as { j: string }).j) as Array<{ absolutePath: string }>;
    expect(persisted.some((f) => f.absolutePath.startsWith(oldAssets))).toBe(false);
  });

  // #261 extension: shipped-spec projection resources follow the running install; a plugin stored
  // outside daemon/specs and user resources are projected exactly as stored.
  it("#261 projects shipped-spec resources from the running install and leaves plugin/user entries untouched", async () => {
    const seat = seedSeat({ clean: true });
    const oldSpecs = "/mise/installs/npm-openrig-cli/0.6.2/node_modules/@openrig/cli/daemon/specs";
    const runningSpecs = path.resolve(import.meta.dirname, "../specs");
    const entry = (over: Record<string, string>) => ({ category: "runtime_resource", effectiveId: "x", sourceSpec: "shared", resourcePath: "r", ...over });
    const stored = [
      entry({ effectiveId: "shared:claude-default-settings", sourcePath: `${oldSpecs}/agents/shared`, absolutePath: `${oldSpecs}/agents/shared/runtime/claude-settings.fragment.json`, resourceType: "claude_settings_fragment" }),
      entry({ category: "plugin", effectiveId: "shared:openrig-core", sourcePath: `${oldSpecs}/agents/shared`, absolutePath: "/home/u/.openrig/plugins/openrig-core" }),
      entry({ category: "guidance", effectiveId: "role", sourceSpec: "dev.impl", sourcePath: "/project/agents/impl", absolutePath: "/project/agents/impl/guidance/role.md" }),
    ];
    db.prepare("UPDATE node_startup_context SET projection_entries_json=? WHERE node_id=?").run(JSON.stringify(stored), seat.node.id);
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, reason: "issue 261 projection" });
    expect(result.ok).toBe(true);
    const byId = Object.fromEntries((projectedPlan?.entries ?? []).map((e) => [e.effectiveId, e]));
    expect(byId["shared:claude-default-settings"]).toMatchObject({
      sourcePath: `${runningSpecs}/agents/shared`, absolutePath: `${runningSpecs}/agents/shared/runtime/claude-settings.fragment.json`,
      resourceType: "claude_settings_fragment", category: "runtime_resource",
    });
    expect(byId["shared:openrig-core"]).toMatchObject({ sourcePath: `${oldSpecs}/agents/shared`, absolutePath: "/home/u/.openrig/plugins/openrig-core" });
    expect(byId["role"]).toMatchObject({ absolutePath: "/project/agents/impl/guidance/role.md" });
  });

  // #261 startup extension: shipped-spec startup files (kernel culture, agent role/startup context) follow the running install.
  it("#261 delivers shipped-spec startup files (pre- and post-launch) from the running install", async () => {
    const seat = seedSeat({ clean: true });
    const oldSpecs = "/mise/installs/npm-openrig-cli/0.6.2/node_modules/@openrig/cli/daemon/specs";
    const runningSpecs = path.resolve(import.meta.dirname, "../specs");
    const kernel = "rigs/launch/kernel";
    const agent = `${kernel}/agents/advisor/lead`;
    const stored = [
      { path: "culture/CULTURE.md", absolutePath: `${oldSpecs}/${kernel}/culture/CULTURE.md`, ownerRoot: `${oldSpecs}/${kernel}`, deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] },
      { path: "guidance/role.md", absolutePath: `${oldSpecs}/${agent}/guidance/role.md`, ownerRoot: `${oldSpecs}/${agent}`, deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"] },
      { path: "culture/CULTURE.md", absolutePath: "/project/culture/CULTURE.md", ownerRoot: "/project", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] },
    ];
    db.prepare("UPDATE node_startup_context SET resolved_files_json=? WHERE node_id=?").run(JSON.stringify(stored), seat.node.id);
    const delivered: string[] = [];
    adapter.deliverStartup = async (files) => { delivered.push(...files.map((f) => f.absolutePath)); return { delivered: files.length, failed: [] }; };
    const result = await service.launchFresh({ seatRef: seat.sessionName, fresh: true, reason: "issue 261 shipped specs" });
    expect(result.ok).toBe(true);
    // Pre-launch culture and the post-launch send_text role both arrive at the running install; custom is as stored.
    expect(delivered.sort()).toEqual([
      `${runningSpecs}/${agent}/guidance/role.md`,
      `${runningSpecs}/${kernel}/culture/CULTURE.md`,
      "/project/culture/CULTURE.md",
    ].sort());
    const persisted = JSON.parse((db.prepare("SELECT resolved_files_json AS j FROM node_startup_context WHERE node_id=?").get(seat.node.id) as { j: string }).j) as Array<{ path: string; absolutePath: string; deliveryHint: string }>;
    expect(persisted.find((f) => f.path === "guidance/role.md")).toMatchObject({ absolutePath: `${runningSpecs}/${agent}/guidance/role.md`, deliveryHint: "send_text" });
    expect(persisted.some((f) => f.absolutePath.startsWith(oldSpecs))).toBe(false);
  });
});
