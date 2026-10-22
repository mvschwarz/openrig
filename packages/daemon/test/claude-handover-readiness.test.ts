// Reuses the released handover fixture. Process startup and pane bytes are modeled; no native Claude.
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const observations: unknown[] = [];
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { observeCodexSandbox } from "../src/domain/permission-drift.js";
import { type OccupantInvalidator } from "../src/domain/occupant-invalidator.js";

describe("Claude fresh in-place handover readiness", () => {
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
  let claudeProcessStartedAt: ((sessionName: string) => Promise<string | null>) | undefined;
  let invalidateRetiringOccupant: ReturnType<typeof vi.fn>;
  let declareOccupantSwap: ReturnType<typeof vi.fn>;
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
    claudeProcessStartedAt = undefined;
    invalidateRetiringOccupant = vi.fn();
    declareOccupantSwap = vi.fn();
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

  function newService(adapter: TmuxAdapter = tmux(), occupantInvalidator: OccupantInvalidator = { invalidateRetiringOccupant }): SeatHandoverService {
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
      ...(claudeProcessStartedAt ? { claudeProcessStartedAt } : {}),
      occupantInvalidator,
      activityOracle: { declareOccupantSwap },
      predecessorRecapResolver: resolvePredecessorRecap as never,
      readinessTimeoutMs: 50,
      sleep: async () => {},
    });
  }

  function seedSeat(opts?: { rigName?: string; runtime?: string; withSession?: boolean; model?: string; codexConfigProfile?: string; effort?: string }) {
    const rig = rigRepo.createRig(opts?.rigName ?? "seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: opts?.runtime ?? "codex", cwd: "/project", model: opts?.model, codexConfigProfile: opts?.codexConfigProfile, effort: opts?.effort });
    let sessionId: string | null = null;
    if (opts?.withSession !== false) {
      const session = sessionRegistry.registerSession(node.id, `dev-impl@${rig.name}`);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
      sessionRegistry.updateBinding(node.id, { tmuxSession: `dev-impl@${rig.name}`, tmuxPane: "%0" });
      sessionId = session.id;
    }
    return { rig, node, sessionId };
  }


  it.each(["classic-predecessor-history", "screen-without-predecessor-history", "new-runtime-already-ready", "stale-wrapper-screen-unavailable", "working-wrapper-screen-unavailable", "working-headerless-auto-proof", "working-headerless-auto-unavailable", "working-headerless-accept-edits-unavailable", "working-headerless-bypass-unavailable",
    ...["shell", "script"].flatMap(process => ["prompt", "command"].flatMap(frame =>
      ["readable", "unreadable"].map(listing => `classic-chevron-${process}-${frame}-${listing}`))),
  ])("1544 %s", async mode => {
    const { node } = seedSeat({ runtime: "claude-code" });
    let elapsed = 0, requested = false, packetPasted = false;
    const chevron = mode.startsWith("classic-chevron-");
    const script = chevron && mode.includes("-script-");
    const unreadable = chevron && mode.endsWith("-unreadable");
    const shellPrompt = chevron ? mode.includes("-command-") ? "❯ /bin/sh fixture-launch.txt" : "❯ " : "operator@host$ ";
    const headerless = mode.startsWith("working-headerless-");
    const auto = mode.startsWith("working-headerless-auto");
    const bypass = mode === "working-headerless-bypass-unavailable";
    if (auto || bypass) new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode: auto ? "auto" : "bypassPermissions" }, "fixture", "headerless qualification");
    const nativeAt = mode === "new-runtime-already-ready" || mode === "working-wrapper-screen-unavailable" || headerless ? 0 : 500;
    const unavailable = mode.endsWith("screen-unavailable");
    const identicalFrame = "Claude Code v2.1.303\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)";
    const autoFrame = "Restored conversation\n─────────\n❯ \n─────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
    const headerlessFrame = auto ? autoFrame : autoFrame.replace("auto mode on", bypass ? "bypass permissions on" : "accept edits on");
    const oldFrame = "Claude Code v2.1.303\n❯ predecessor finished turn\n  ⏵⏵ accept edits on (shift+tab to cycle)";
    const freshFrame = "Claude Code v2.1.303\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)";
    const trace: unknown[] = [];
    const pane = () => headerless ? identicalFrame + "\n" + headerlessFrame : unavailable ? identicalFrame : requested && elapsed >= nativeAt ? freshFrame
      : mode === "classic-predecessor-history" || chevron ? oldFrame + "\n" + shellPrompt : shellPrompt;
    getPaneCommand.mockImplementation(async () => (unavailable || headerless) && requested ? "sh" : requested && elapsed >= nativeAt ? "claude" : requested && script ? "sh" : "zsh");
    capturePaneScreen.mockImplementation(async (target: string) => {
      const returnedPane = unavailable ? null : headerless ? headerlessFrame : requested && elapsed < nativeAt ? shellPrompt : pane();
      trace.push({ kind: "current-frame", target, elapsed, returnedPane });
      return returnedPane;
    });
    const capturePaneContent = vi.fn(async (_session: string, lines: number) => {
      trace.push({ kind: "history", elapsed, lines, returnedPane: pane() });
      return pane();
    });
    const target = { ...tmux(), capturePaneContent, getPanePid: vi.fn(async () => 100),
      sendShellCommand: async (session: string, text: string) => sendText(session, text) } as unknown as TmuxAdapter;
    const fsError = () => { throw new Error("unexpected filesystem access"); };
    const listProcesses = vi.fn(() => {
      if (unavailable || unreadable || mode.endsWith("-unavailable")) {
        trace.push({ kind: "process-read", elapsed, available: false });
        throw new Error("fixture ps unavailable");
      }
      const startedAt = "Mon Oct 19 21:30:00 2026";
      if (chevron) {
        const running = requested && elapsed >= nativeAt;
        const foreground = script ? 101 : running ? 102 : 100;
        const rows = [{ pid: 100, ppid: 1, pgid: 100, tpgid: foreground,
          command: "-zsh", executableName: "zsh", startedAt },
          ...(script ? [{ pid: 101, ppid: 100, pgid: 101, tpgid: 101,
            command: "/bin/sh fixture-launch.txt", executableName: "sh", startedAt }] : []),
          ...(running ? [{ pid: 102, ppid: script ? 101 : 100, pgid: foreground, tpgid: foreground,
            command: `claude --session-id ${successorToken}`, executableName: "claude", startedAt }] : [])];
        trace.push({ kind: "process-read", elapsed, available: true, rows });
        return rows;
      }
      if (mode !== "working-headerless-auto-proof") return [];
      return [
        { pid: 100, ppid: 1, pgid: 100, tpgid: 101, command: "-bash", executableName: "bash", startedAt },
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101, command: "/bin/sh fixture-launch.txt", executableName: "sh", startedAt },
        { pid: 102, ppid: 101, pgid: 101, tpgid: 101, command: `/opt/claude.exe --permission-mode auto --session-id ${successorToken} --name dev-impl@seat-rig`, executableName: "claude", startedAt },
      ];
    });
    const claude = new ClaudeCodeAdapter({ tmux: target, fsOps: { exists: () => false, readFile: fsError,
      writeFile: fsError, mkdirp: fsError, copyFile: fsError }, listProcesses, sleep: async () => {}, sessionIdFactory: () => successorToken,
      ...(headerless ? { claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[]) => `claude ${args.join(" ")}`,
        assertCurrent: () => {}, configDir: "/fixture" }) } as never } : {}) });
    const reads: unknown[] = [];
    const readiness = vi.fn(async (binding) => {
      const result = await claude.checkReady(binding);
      reads.push({ elapsed, successorRuntimeStarted: requested && elapsed >= nativeAt, result });
      return result;
    });
    const successorToken = "22222222-2222-4222-8222-222222222222";
    sendText.mockImplementation(async (session: string, text: string) => {
      if (text.includes("claude ") && text.includes("--session-id")) {
        requested = true; trace.push({ kind: "launch-text", elapsed, session, text, nativeAt });
        return { ok: true };
      }
      packetPasted = true;
      trace.push({ kind: "packet-paste", session, elapsed, successorRuntimeStarted: requested && elapsed >= nativeAt, text });
      return { ok: true };
    });
    sendKeys.mockImplementation(async (session: string, keys: string[]) => {
      trace.push({ kind: packetPasted ? "input" : "launch-input", session, elapsed, successorRuntimeStarted: requested && elapsed >= nativeAt, keys });
      return { ok: true };
    });
    const handover = new SeatHandoverService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: target, now: () => new Date("2026-10-19T21:30:00Z"), newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { "claude-code": { runtime: "claude-code", launchHarness: (binding, opts) => { trace.push({ kind: "launch-intent", opts }); return claude.launchHarness(binding, opts); }, checkReady: readiness } as unknown as RuntimeAdapter },
      contextUsageStore: { readSidecar } as never, resumeTokenCapturer: { captureCodexThreadId } as never,
      occupantInvalidator: { invalidateRetiringOccupant }, activityOracle: { declareOccupantSwap },
      predecessorRecapResolver: resolvePredecessorRecap as never, readinessTimeoutMs: 5000,
      sleep: async ms => { elapsed += ms; trace.push({ kind: "sleep", ms, elapsed }); },
    });
    const result = await handover.handover({ seatRef: "dev-impl@seat-rig", source: "fresh", reason: "bounded scrollback reproduction" });
    const sessions = db.prepare("SELECT session_name,status,resume_token,startup_status FROM sessions ORDER BY id").all();
    observations.push({ mode, result, trace, reads, listProcessesCalls: listProcesses.mock.calls.length,
      sessions, respawn: respawnPane.mock.calls });
    expect(result.ok).toBe(true);
    expect(reads.length).toBeGreaterThan(0);
    const first = reads[0] as any;
    if (chevron) {
      expect(first.result.ready).toBe(unreadable);
      expect(first.successorRuntimeStarted).toBe(false);
      const packet = trace.find((x: any) => x.kind === "packet-paste") as any;
      expect(packet.elapsed).toBe(unreadable ? 0 : 1000);
      expect(packet.successorRuntimeStarted).toBe(!unreadable);
      expect(trace).toContainEqual({ kind: "current-frame", target: "%9", elapsed: 0, returnedPane: shellPrompt });
      expect(trace.some((x: any) => x.kind === "process-read" && x.available === !unreadable)).toBe(true);
    } else if (mode === "classic-predecessor-history") {
      expect(first.result.ready).toBe(false);
      expect(first.successorRuntimeStarted).toBe(false);
      expect((trace.find((x: any) => x.kind === "packet-paste") as any).elapsed).toBeGreaterThanOrEqual(nativeAt);
      expect((reads.at(-1) as any).result.ready).toBe(true);
      expect(trace).toContainEqual({ kind: "current-frame", target: "%9", elapsed: 0, returnedPane: "operator@host$ " });
    } else if (headerless) {
      const launched = trace.find((x: any) => x.kind === "launch-text") as any;
      if (auto) expect(launched.text).toMatch(/--permission-mode auto(?: |$)/);
      if (bypass) expect(launched.text).toMatch(/--permission-mode bypassPermissions(?: |$)/);
      if (!auto && !bypass) expect(launched.text).toMatch(/--permission-mode acceptEdits(?: |$)/);
      expect(first.result.ready).toBe(true);
      expect(first.successorRuntimeStarted).toBe(true);
      expect(capturePaneScreen).toHaveBeenCalledWith("%9");
    } else if (unavailable) {
      // O1 deliberately preserves admission for this indistinguishable stale/working pair.
      expect(first.result.ready).toBe(true);
      expect(first.successorRuntimeStarted).toBe(mode === "working-wrapper-screen-unavailable");
      expect(capturePaneScreen).toHaveBeenCalledWith("%9");
    } else if (mode === "new-runtime-already-ready") expect(first.result.ready).toBe(true);
    else {
      expect(first.result.ready).toBe(false);
      expect((reads.at(-1) as any).result.ready).toBe(true);
    }
    expect(trace.find((x: any) => x.kind === "launch-intent")).toMatchObject({ opts: { freshInPlace: true } });
    expect(respawnPane).toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();

  });
});

afterAll(() => {
  const dir = process.env.CHECKPOINT_OUTPUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
});
