import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { CodexInPlaceRestart } from "../src/domain/seat-restart-in-place.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSeatSkillPlugin, seatSkillLocation, seatSkillPaths } from "../src/domain/seat-skill-storage.js";
import { reconcileSkillLoadout, resolvePluginSkills } from "../src/domain/skill-catalog.js";
import { prepareSeatLaunchAdditions, systemPromptPendingNote } from "../src/domain/seat-launch-additions.js";
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
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DefaultOccupantInvalidator, type OccupantInvalidator } from "../src/domain/occupant-invalidator.js";
import { managedBlockText } from "../src/domain/managed-blocks.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";

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
  let claudeProcessStartedAt: ((sessionName: string) => Promise<string | null>) | undefined;
  let invalidateRetiringOccupant: ReturnType<typeof vi.fn>;
  let declareOccupantSwap: ReturnType<typeof vi.fn>;
  let resolvePredecessorRecap: ReturnType<typeof vi.fn>;
  let getDefaultShell: ReturnType<typeof vi.fn>;
  let getPaneCommand: ReturnType<typeof vi.fn>;
  let service: SeatHandoverService;
  let currentCodexPermissions: ReturnType<typeof vi.fn>;

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
    currentCodexPermissions = vi.fn(async () => ({ state: "unverified", reason: "fixture has no native policy" }));
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

  function newService(adapter: TmuxAdapter = tmux(), occupantInvalidator: OccupantInvalidator = { invalidateRetiringOccupant }, runtime = "codex"): SeatHandoverService {
    return new SeatHandoverService({
      codexPermissions: { currentCodexPermissions },
      db,
      rigRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: adapter,
      now: () => new Date("2026-04-24T18:30:00.000Z"),
      newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { [runtime]: { ...codexAdapter(), runtime } },
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

  function seedSeat(opts?: { rigName?: string; runtime?: string; withSession?: boolean; model?: string; codexConfigProfile?: string; effort?: string; advisor?: string }) {
    const rig = rigRepo.createRig(opts?.rigName ?? "seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: opts?.runtime ?? "codex", cwd: "/project", model: opts?.model, codexConfigProfile: opts?.codexConfigProfile, effort: opts?.effort, advisor: opts?.advisor });
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

  it.each(["fresh", "fork:dev-impl@seat-rig", "rebuild"])("records a %s successor as launched without changing its handover tenure or lineage", async source => {
    const { rig, node, sessionId } = seedSeat();
    sessionRegistry.updateResumeToken(sessionId!, "codex_id", "codex-thread-1", "hook");
    const previous = db.prepare("SELECT * FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal").all(node.id);
    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "replace occupant", source });
    expect(result).toMatchObject({ ok: true, result: { sideEffects: { provenanceRecordWritten: true } } });
    const tenures = db.prepare("SELECT * FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal").all(node.id);
    expect(tenures).toHaveLength(previous.length + 1);
    expect(tenures.slice(0, -1)).toEqual(previous);
    expect(tenures.at(-1)).toMatchObject({ kind: "handover", generation_ordinal: 2,
      generation_uuid: respawnPane.mock.calls[0]![2]!.env.OPENRIG_OCCUPANT_GENERATION });
    expect(sessionRegistry.getSessionsForRig(rig.id).find(session => session.id === sessionId)?.status).toBe("superseded");
    const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.handover_completed' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ nodeId: node.id, previousOccupant: "dev-impl@seat-rig", currentOccupant: "dev-impl@seat-rig", source });
    expect(db.prepare("SELECT origin FROM sessions WHERE node_id = ? AND status = 'running'").get(node.id)).toEqual({ origin: "launched" });
  });

  // #875: a Codex seat whose launch carried its guidance as developer instructions left none in the repository AGENTS.md,
  // and a successor's launch carries none. The handover puts the missing blocks back from the saved startup context before
  // the successor starts, as an exact resume does.
  it.each(["fresh", "fork:dev-impl@seat-rig", "rebuild"])("a %s Codex successor starts with the seat's guidance in its repository AGENTS.md (#875)", async source => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "handover-guidance-"));
    try {
      const { node, sessionId } = seedSeat();
      sessionRegistry.updateResumeToken(sessionId!, "codex_id", "codex-thread-1", "hook");
      db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(root, node.id);
      const culture = path.join(root, "spec", "culture.md");
      fs.mkdirSync(path.dirname(culture), { recursive: true });
      fs.writeFileSync(culture, "Team culture.\n");
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, '[]', '[]', 'codex')")
        .run(node.id, JSON.stringify([{ category: "guidance", effectiveId: "culture.md", sourceSpec: "base", sourcePath: path.dirname(culture),
          resourcePath: "culture.md", absolutePath: culture, mergeStrategy: "managed_block", target: "AGENTS.md" }]));
      const agents = path.join(root, "AGENTS.md");
      let atLaunch: string | null = null;
      launchHarness.mockImplementation(async () => {
        atLaunch = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : null;
        return { ok: true, resumeToken: "codex-launch-tok", resumeType: "codex_id", appliedLaunch: observeCodexSandbox(" -s workspace-write") };
      });
      expect(await service.handover({ seatRef: "dev-impl@seat-rig", reason: "replace occupant", source })).toMatchObject({ ok: true });
      expect(atLaunch).toContain("Team culture.");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // #2456: a Claude successor's launch carries no guidance either, so a rebuild into a working directory without the seat's
  // blocks (after `rig seat set-cwd`, say) started without them. The handover puts them back in the rig's Claude file first.
  it.each([
    ["fresh", "CLAUDE.md"],
    ["rebuild", "CLAUDE.md"],
    ["fresh", "CLAUDE.local.md"],
    ["rebuild", "CLAUDE.local.md"],
  ] as const)("a %s Claude successor starts with the seat's guidance in the rig's %s (#2456)", async (source, file) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "handover-guidance-claude-"));
    try {
      const { rig, node } = seedSeat({ runtime: "claude-code" });
      if (file !== "CLAUDE.md") rigRepo.setRigClaudeManagedBlockFile(rig.id, file);
      db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(root, node.id);
      const culture = path.join(root, "spec", "culture.md");
      fs.mkdirSync(path.dirname(culture), { recursive: true });
      fs.writeFileSync(culture, "Team culture.\n");
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, '[]', '[]', 'claude-code')")
        .run(node.id, JSON.stringify([{ category: "guidance", effectiveId: "culture.md", sourceSpec: "base", sourcePath: path.dirname(culture),
          resourcePath: "culture.md", absolutePath: culture, mergeStrategy: "managed_block", target: "CLAUDE.md" }]));
      const guidance = path.join(root, file);
      capturePaneScreen.mockResolvedValue("Claude Code v2.1.303\n❯ \n────────────────────\n  ⏵⏵ accept edits on (shift+tab to cycle)");
      let atLaunch: string | null = null;
      launchHarness.mockImplementation(async () => {
        atLaunch = fs.existsSync(guidance) ? fs.readFileSync(guidance, "utf8") : null;
        return { ok: true, resumeToken: "claude-successor", resumeType: "claude_id" };
      });
      const claude = new SeatHandoverService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: tmux(), runtimeAdapters: { "claude-code": { runtime: "claude-code", launchHarness, checkReady } as unknown as RuntimeAdapter },
        predecessorRecapResolver: resolvePredecessorRecap as never, readinessTimeoutMs: 50, sleep: async () => {} });
      const result = await claude.handover({ seatRef: "dev-impl@seat-rig", reason: "replace occupant", source });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(atLaunch).toContain("Team culture.");
      if (file !== "CLAUDE.md") expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // #2456: a start fails when a required startup file can't be delivered, while a handover's successor starts anyway. So the
  // handover names each required file its successor started without, on its result and on the event the seat list reads.
  it("names the required guidance files a successor started without, on the result and the handover event (#2456)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "handover-required-"));
    try {
      const { node } = seedSeat();
      db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(root, node.id);
      const present = path.join(root, "spec", "present.md");
      fs.mkdirSync(path.dirname(present), { recursive: true });
      fs.writeFileSync(present, "Present and required.\n");
      const projected = path.join(root, "spec", "culture.md");
      const required = path.join(root, "spec", "sop.md");
      const optional = path.join(root, "spec", "notes.md");
      const file = (absolutePath: string, isRequired: boolean) => ({ path: path.basename(absolutePath), absolutePath, ownerRoot: root,
        deliveryHint: "guidance_merge", required: isRequired, appliesOn: ["startup", "restore"] });
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, '[]', 'codex')")
        .run(node.id,
          JSON.stringify([{ category: "guidance", effectiveId: "culture.md", sourceSpec: "base", sourcePath: path.dirname(projected),
            resourcePath: "culture.md", absolutePath: projected, mergeStrategy: "managed_block", target: "AGENTS.md" }]),
          JSON.stringify([file(present, true), file(required, true), file(optional, false)]));
      const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "replace occupant", source: "fresh" });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const handed = (result as unknown as { result: { startedWithoutRequired?: string[]; newSessionId: string } }).result;
      // A projected guidance file fails a start when it can't be written, as a required startup file does; an optional one doesn't.
      expect(handed.startedWithoutRequired).toEqual([projected, required]);
      const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.handover_completed' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
      expect(JSON.parse(event.payload)).toMatchObject({ startedWithoutRequired: [projected, required], successorSessionId: handed.newSessionId });
      expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("Present and required.");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // Round 1: a projected guidance file and an optional startup file can share one block id. The block is still required,
  // since a start fails at projection before the optional file is delivered.
  it("keeps a block required when an optional startup file shares its id with a projected one (#2456)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "handover-required-same-id-"));
    try {
      const { node } = seedSeat();
      db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(root, node.id);
      const projected = path.join(root, "spec", "culture.md");
      const optional = path.join(root, "startup", "culture.md");
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, '[]', 'codex')")
        .run(node.id,
          JSON.stringify([{ category: "guidance", effectiveId: "culture.md", sourceSpec: "base", sourcePath: path.dirname(projected),
            resourcePath: "culture.md", absolutePath: projected, mergeStrategy: "managed_block", target: "AGENTS.md" }]),
          JSON.stringify([{ path: "culture.md", absolutePath: optional, ownerRoot: root, deliveryHint: "guidance_merge", required: false, appliesOn: ["startup", "restore"] }]));
      const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "replace occupant", source: "fresh" });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      // The block's put-back source is the later writer's, as at launch; the block stays required.
      expect((result as unknown as { result: { startedWithoutRequired?: string[] } }).result.startedWithoutRequired).toEqual([optional]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // A fresh or rebuild successor is a new conversation that no start delivered to, so its one first turn points it to each
  // send_text startup file a fresh start delivers, role first. A required one that's missing marks the seat. A fork carries
  // its parent's conversation, which already had them, and gets no list.
  it.each(["fresh", "rebuild", "fork:dev-impl@seat-rig"])("a %s successor's first turn points to the seat's startup files, role first (#2456)", async (source) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "handover-startup-files-"));
    try {
      const { node, sessionId } = seedSeat();
      sessionRegistry.updateResumeToken(sessionId!, "codex_id", "codex-thread-1", "hook");
      db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(root, node.id);
      const role = path.join(root, "guidance", "role.md");
      const context = path.join(root, "startup", "context.md");
      const missing = path.join(root, "startup", "brief.txt");
      for (const [file, text] of [[role, "You are the implementer.\n"], [context, "Project context.\n"]] as const) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
      const text = (absolutePath: string, extra: Record<string, unknown> = {}) => ({ path: path.relative(root, absolutePath), absolutePath, ownerRoot: root,
        deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"], ...extra });
      // Saved in the order a spec might list them; the role comes first in the list all the same.
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', ?, '[]', 'codex')")
        .run(node.id, JSON.stringify([text(context), text(role, { orientation: "role" }), text(missing)]));
      const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "replace occupant", source });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const turns = sendText.mock.calls.map((call) => String(call[1]));
      const listed = turns.find((turn) => turn.includes("Your seat's startup files"));
      const handed = (result as unknown as { result: { startedWithoutRequired?: string[] } }).result;
      if (source.startsWith("fork:")) {
        expect(listed).toBeUndefined();
        expect(handed.startedWithoutRequired).toBeUndefined();
        return;
      }
      expect(listed, JSON.stringify(turns)).toBeDefined();
      const at = (needle: string) => listed!.indexOf(needle);
      expect(at(role)).toBeGreaterThan(at("Your seat's startup files"));
      expect(at(role)).toBeLessThan(at(context));
      expect(listed).toContain(`MISSING: ${missing}`);
      // The list comes before the predecessor's context: its terminal for a fresh successor, its durable chain for a rebuild.
      expect(at("Your seat's startup files")).toBeLessThan(at(source === "fresh" ? "--- Predecessor terminal" : "The durable chain is EMPTY"));
      expect(handed.startedWithoutRequired).toEqual([missing]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // #2456 part 3: a block already in the guidance file. OpenRig keeps a record of what it last wrote there, so a handover
  // refreshes a block it wrote whose source has changed, keeps a block a person edited and names it, and names a block it
  // has no record of as possibly stale instead of replacing it.
  describe("a Claude handover and a block already in its guidance file (#2456)", () => {
    let root: string;
    let culture: string;
    let guidance: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "handover-refresh-"));
      const { node } = seedSeat({ runtime: "claude-code" });
      db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(root, node.id);
      culture = path.join(root, "spec", "culture.md");
      fs.mkdirSync(path.dirname(culture), { recursive: true });
      fs.writeFileSync(culture, "Team culture.\n");
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, '[]', '[]', 'claude-code')")
        .run(node.id, JSON.stringify([{ category: "guidance", effectiveId: "culture.md", sourceSpec: "base", sourcePath: path.dirname(culture),
          resourcePath: "culture.md", absolutePath: culture, mergeStrategy: "managed_block", target: "CLAUDE.md" }]));
      guidance = path.join(root, "CLAUDE.md");
      capturePaneScreen.mockResolvedValue("Claude Code v2.1.303\n❯ \n────────────────────\n  ⏵⏵ accept edits on (shift+tab to cycle)");
    });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    /** One fresh handover; returns its notes and the guidance file as the successor launched with it. */
    async function handOver(): Promise<{ notes: string[]; atLaunch: string | null }> {
      let atLaunch: string | null = null;
      launchHarness.mockImplementation(async () => {
        atLaunch = fs.existsSync(guidance) ? fs.readFileSync(guidance, "utf8") : null;
        return { ok: true, resumeToken: "claude-successor", resumeType: "claude_id" };
      });
      const claude = new SeatHandoverService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: tmux(), runtimeAdapters: { "claude-code": { runtime: "claude-code", launchHarness, checkReady } as unknown as RuntimeAdapter },
        predecessorRecapResolver: resolvePredecessorRecap as never, readinessTimeoutMs: 50, sleep: async () => {} });
      const result = await claude.handover({ seatRef: "dev-impl@seat-rig", reason: "replace occupant", source: "fresh" });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      return { notes: (result as { result: { launchAdditionNotes?: string[] } }).result.launchAdditionNotes ?? [], atLaunch };
    }

    it("refreshes a block OpenRig wrote whose source has changed since", async () => {
      expect((await handOver()).atLaunch).toContain("Team culture.");
      fs.writeFileSync(culture, "Team culture, revised.\n");
      const { atLaunch } = await handOver();
      expect(atLaunch).toContain("Team culture, revised.");
      expect(atLaunch).not.toContain("Team culture.\n");
    });

    it("keeps a block a person edited, and names it", async () => {
      await handOver();
      fs.writeFileSync(guidance, fs.readFileSync(guidance, "utf8").replace("Team culture.", "Team culture. My own note."));
      fs.writeFileSync(culture, "Team culture, revised.\n");
      const { notes, atLaunch } = await handOver();
      expect(atLaunch).toContain("Team culture. My own note.");
      expect(atLaunch).not.toContain("Team culture, revised.");
      expect(notes.some((note) => note.includes("guidance_block_edited") && note.includes("culture.md")), JSON.stringify(notes)).toBe(true);
      // The successor is told too, in one line of its packet.
      const packets = sendText.mock.calls.map((call) => String(call[1])).filter((text) => text.includes("OpenRig guidance note"));
      expect(packets).toHaveLength(1);
      expect(packets[0]).toContain("culture.md");
    });

    it("leaves a block it has no record of writing, and says it may be stale", async () => {
      fs.writeFileSync(guidance, `# Notes\n\n${managedBlockText("culture.md", "Older culture.")}\n`);
      const { notes, atLaunch } = await handOver();
      expect(atLaunch).toContain("Older culture.");
      expect(atLaunch).not.toContain("Team culture.");
      expect(notes.some((note) => note.includes("guidance_block_may_be_stale") && note.includes("culture.md")), JSON.stringify(notes)).toBe(true);
    });
  });

  it.each(["stop", "restart", "clean"] as const)("allows %s for a launched handover but refuses discovered and directly adopted occupants", async operation => {
    for (const provenance of ["adopted", "discovered", "launched"] as const) {
      const { node, sessionId } = seedSeat({ rigName: `${operation}-${provenance}` });
      const seatRef = `dev-impl@${operation}-${provenance}`;
      if (provenance === "adopted") {
        sessionRegistry.markSuperseded(sessionId!);
        sessionRegistry.registerClaimedSession(node.id, seatRef);
      } else {
        const source = provenance === "launched" ? "fresh" : `discovered:${seedDiscovery().id}`;
        expect(await service.handover({ seatRef, reason: "replace occupant", source })).toMatchObject({ ok: true });
      }
      const current = sessionRegistry.getBindingForNode(node.id)!;
      const adapter = Object.assign(tmux(), { probeSession: vi.fn(async () => ({ state: operation === "clean" ? "absent" as const : "present" as const })) });
      const restartAdapter = Object.assign(codexAdapter(), { buildResumeCommand: vi.fn(), verifyResumeInPane: vi.fn(), sendResumeCommand: vi.fn() });
      const lifecycle = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: adapter, runtimeAdapters: { codex: restartAdapter } });
      // The restart engine has its own process/OS fixtures. This cell exercises handover registration
      // through the real lifecycle eligibility checks, stopping at that engine's native-effect boundary.
      const restart = vi.spyOn(CodexInPlaceRestart.prototype, "execute").mockResolvedValue({ ok: true } as never);
      killSession.mockClear();
      try {
        const input = { seatRef, reason: "selected lifecycle operation" };
        const result = operation === "stop" ? await lifecycle.stopSeat(input)
          : operation === "clean" ? await lifecycle.cleanSeat(input) : await lifecycle.restartInPlace(input);
        if (provenance === "launched") {
          expect(result).toMatchObject({ ok: true });
          if (operation === "stop") expect(killSession).toHaveBeenCalledWith(current.tmuxSession);
          if (operation === "clean") expect(sessionRegistry.getBindingForNode(node.id)).toBeNull();
          if (operation === "restart") expect(restart).toHaveBeenCalledWith(expect.objectContaining({ seat: expect.objectContaining({ nodeId: node.id }), sessionName: current.tmuxSession }), expect.anything());
        } else {
          expect(result).toMatchObject({ ok: false, code: "claimed_session" });
          expect(killSession).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled();
          expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe(current.tmuxSession);
        }
      } finally { restart.mockRestore(); }
    }
  });

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
        departingProcess: "not-touched",
        startupContextDelivered: false,
        provenanceRecordWritten: true,
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
          additionalPolicies: [makeIdleGateQitemPolicy({
            db,
            seatActivity: { getSeatStateBySession: () => null },
          })],
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
      additionalPolicies: [makeIdleGateQitemPolicy({
        db,
        seatActivity: { getSeatStateBySession: () => null },
      })],
    });
    for (const job of activeRoleJobs) await engine.evaluate(job);

    expect.soft(activeRoleJobs.filter((job) => job.targetSession === retiredSession)).toEqual([]);
    expect.soft(deliveries.filter((delivery) => delivery.targetSession === retiredSession)).toEqual([]);
  });

  it("kernel handover recomputes operational authority from the persisted rig", async () => {
    seedSeat({ runtime: "codex", rigName: "kernel" });
    const result = await service.handover({ seatRef: "dev-impl@kernel", reason: "context-wall",
      source: "fresh", operator: "operator@kernel" });
    expect(result.ok).toBe(true);
    expect(launchHarness.mock.calls[0]![0]).toMatchObject({ kernelAuthority: true, launchPosture: "full_bypass" });
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
    ["fork source", "fork:dev-impl@seat-rig"],
    ["discovered source", "discovered:some-id"],
  ])("keeps dry-run mutation-free across %s (AC-1)", async (_label, source) => {
    const { sessionId } = seedSeat();
    // A fork source is resolved in the dry run too, so it names a seat with a native conversation id.
    if (source?.startsWith("fork:")) db.prepare("UPDATE sessions SET resume_token = ? WHERE id = ?").run("codex-thread-1", sessionId);
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
      expect(successorBinding.teamPermissionDefault).toBe(true);
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
    expect(sendKeys).toHaveBeenCalledWith("dev-impl@seat-rig", ["Enter"]);
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

  it("S19 (territory ruling 01530): the commit declares the occupant swap to the activity oracle — seat-keyed rungs re-declare, no bleed", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const retiringGen = sessionRegistry.currentOccupantGenerationForSession("dev-impl@seat-rig");

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    expect(declareOccupantSwap).toHaveBeenCalledTimes(1);
    const [seatNodeId, generation] = declareOccupantSwap.mock.calls[0]! as [string, string];
    expect(seatNodeId).toBe(node.id); // seat-keyed: the durable node id, never the session name
    expect(typeof generation).toBe("string");
    expect(generation.length).toBeGreaterThan(0);
    expect(generation).not.toBe(retiringGen); // the SWAP identity is the successor tenure, not the retiree
  });

  it("S19: a handover that fails before commit never declares a swap (no phantom swap events)", async () => {
    seedSeat({ runtime: "codex" });
    respawnPane.mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(false);
    expect(declareOccupantSwap).not.toHaveBeenCalled();
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

  it("B16 rework: packet delivery uses the shared paste-then-submit sequencing — a settle sleep BETWEEN send_text and Enter (r2 live: without it the packet sat staged-unsent 46s)", async () => {
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
      activityOracle: { declareOccupantSwap },
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

  it.each([
    ...[
    ...(["fresh", "rebuild"] as const).flatMap(source =>
      (["clear", "staged", "unreadable", "edited", "unrelated"] as const).map(screen => ({ source, screen, held: false }))),
    ...(["clear", "staged", "edited", "unreadable"] as const).map(screen => ({ source: "rebuild" as const, screen, held: true })),
    ...(["retry-failed", "retry-failed-staged-message", "send-failed", "submit-failed"] as const)
      .map(screen => ({ source: "rebuild" as const, screen, held: false })),
    ].map(row => ({ ...row, continuityPresent: true })),
    { source: "rebuild" as const, screen: "staged" as const, held: false, continuityPresent: false },
  ])("#1544 $source packet submission with $screen composer evidence (held=$held, continuity=$continuityPresent)", async ({ source, screen, held, continuityPresent }) => {
    const { node } = seedSeat({ runtime: "claude-code" });
    db.exec(outboxEntriesSchema.sql);
    db.exec(seatDeliveryGuardSchema.sql);
    const outbox = new OutboxHandler(db);
    if (held) outbox.retain({ outboxId: "held-rebuild", senderSession: "orch-lead@seat-rig",
      destinationSession: "dev-impl@seat-rig", body: "Retain this work without replaying it." },
    { nodeId: node.id, session: "dev-impl@seat-rig", occupant: null, pane: null });
    const heldBefore = outbox.getById("held-rebuild");
    const notice = "1 held message was kept for this seat and not delivered: read it with rig seat held-messages dev-impl@seat-rig.";
    const bindingBefore = sessionRegistry.getBindingForNode(node.id);
    const sleeps: number[] = [];
    const reads: Array<string | null> = [];
    let packet = "";
    let enters = 0;
    if (!continuityPresent) hasSession.mockResolvedValue(false);
    const frame = (text: string) => `Claude Code v2.1.303\n${text.split("\n").map((line, i) => `${i === 0 ? "❯" : " "} ${line}`).join("\n")}\n────────────────────\n  ⏵⏵ accept edits on (shift+tab to cycle)`;
    const visible = () => screen === "unreadable" ? null : frame(screen === "clear" ? ""
      : ["staged", "retry-failed", "retry-failed-staged-message"].includes(screen) ? packet : screen === "edited" ? `${packet}\nEdited by the operator.` : "Unrelated operator draft.");
    capturePaneScreen.mockImplementation(async () => {
      if (!packet) return "predecessor screen tail";
      const pane = visible();
      reads.push(pane);
      if (reads.length > 8) throw new Error("fixture exceeded the finite submission observation budget");
      return pane;
    });
    sendText.mockImplementation(async (_session: string, text: string) => {
      if (!packet) packet = text;
      return screen === "send-failed" ? { ok: false, message: "synthetic initial delivery failure" } : { ok: true };
    });
    sendKeys.mockImplementation(async (_session: string, keys: string[]) => {
      if (packet && keys.includes("Enter")) enters++;
      if (screen === "submit-failed" && enters === 1) return { ok: false, message: "synthetic initial submit failure" };
      if (screen === "retry-failed-staged-message" && enters === 2) return { ok: false, message: "the prompt still looked staged in the input box" };
      return screen === "retry-failed" && enters === 2
        ? { ok: false, message: "synthetic retry delivery failure" } : { ok: true };
    });
    launchHarness.mockResolvedValue({ ok: true, resumeToken: "22222222-2222-4222-8222-222222222222", resumeType: "claude_id" });
    const handover = new SeatHandoverService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: tmux(), runtimeAdapters: { "claude-code": { runtime: "claude-code", launchHarness, checkReady } as unknown as RuntimeAdapter },
      now: () => new Date("2026-04-24T18:30:00.000Z"), newSuccessorId: () => "01SUCCID0",
      contextUsageStore: { readSidecar } as never, predecessorRecapResolver: resolvePredecessorRecap as never,
      rebuildPrimingResolver: () => ({ artifacts: [{ address: "/fixture-seat/RECAP.md", label: "authored recap" }] }),
      rebuildArtifactExists: () => true, readinessTimeoutMs: 50, sleep: async ms => { sleeps.push(ms); },
    });
    const result = await handover.handover({ seatRef: "dev-impl@seat-rig", source, reason: "submission evidence" });
    const bindingAfter = sessionRegistry.getBindingForNode(node.id);
    const candidates = db.prepare("SELECT status,claimed_node_id FROM discovered_sessions").all();
    const completed = db.prepare("SELECT payload FROM events WHERE type = 'seat.handover_completed'").all() as Array<{ payload: string }>;
    console.info("ISSUE1544_SUBMISSION", JSON.stringify({ source, screen, held, continuityPresent, result, enters, sleeps, reads,
      sent: sendText.mock.calls, keys: sendKeys.mock.calls, heldBefore, heldAfter: outbox.getById("held-rebuild"),
      visibleAfter: visible(), bindingBefore, bindingAfter, candidates, completed: completed.map(row => JSON.parse(row.payload)) }));
    expect(packet).toContain(source === "rebuild" ? "# Seat rebuild handover" : "OpenRig seat handover");
    const typedNotice = held && screen === "clear";
    expect(sendText.mock.calls).toEqual(typedNotice
      ? [["dev-impl@seat-rig", packet], ["dev-impl@seat-rig", notice]] : [["dev-impl@seat-rig", packet]]);
    if (held) {
      expect(heldBefore).toMatchObject({ body: "Retain this work without replaying it.", deliveryState: "retained", deliveredAt: null });
      expect(outbox.getById("held-rebuild")).toEqual(heldBefore);
      expect.soft(result).toMatchObject({ ok: true, result: { warnings: [notice] } });
    }
    if (screen === "send-failed") expect(sleeps).toEqual([]);
    else expect(sleeps[0]).toBe(200);
    expect(killSession).not.toHaveBeenCalled();
    expect.soft(result.ok && result.result.sideEffects.startupContextDelivered,
      "delivery requires a clear composer, not only successful paste and Enter").toBe(screen === "clear");
    if ((screen === "staged" && source === "fresh") || ["retry-failed", "retry-failed-staged-message", "send-failed", "submit-failed"].includes(screen)) {
      expect.soft(result, "fresh staged packets and real transport errors still fail delivery").toMatchObject({ ok: false, code: "context_delivery_failed" });
      expect.soft(bindingAfter).toEqual(bindingBefore);
      expect.soft(candidates).toEqual([expect.objectContaining({ status: "vanished", claimed_node_id: null })]);
      expect.soft(completed).toEqual([]);
      expect.soft(enters).toBe(screen === "send-failed" ? 0 : screen === "submit-failed" ? 1 : 2);
      expect(hasSession).not.toHaveBeenCalled();
      if (screen === "retry-failed-staged-message") {
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining("the prompt still looked staged in the input box") });
      }
      if (screen === "retry-failed") {
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining("synthetic retry delivery failure") });
        expect(sendKeys.mock.calls).toEqual(Array.from({ length: 2 }, () => ["dev-impl@seat-rig", ["Enter"]]));
        if (!result.ok) {
          expect.soft(result.guidance).toContain("may still process the priming packet");
          expect.soft(result.guidance).toMatch(/inspect the successor.*resolve.*before.*attempt/i);
          expect.soft(result.guidance).toContain("binding is unchanged");
          expect.soft(result.guidance).toContain("re-wakeable from its provider session file");
        }
      }
      return;
    }
    if (screen === "staged") {
      expect.soft(enters).toBe(2);
      expect.soft(hasSession, "staged screen evidence must still reach ordinary continuity verification").toHaveBeenCalledTimes(1);
      if (!continuityPresent) {
        expect.soft(result).toMatchObject({ ok: false, code: "successor_tmux_absent" });
        expect.soft(bindingAfter).toEqual(bindingBefore);
        expect.soft(candidates).toEqual([expect.objectContaining({ status: "vanished", claimed_node_id: null })]);
        expect.soft(completed).toEqual([]);
        return;
      }
      const restorePacket = { status: "unconfirmed", reason: "the prompt still looked staged in the input box" };
      expect.soft(result, "a running rebuild successor completes unconfirmed after normal continuity checks").toMatchObject({
        ok: true, result: { restorePacket, sideEffects: { startupContextDelivered: false } },
      });
      expect.soft(bindingAfter).toMatchObject({ tmuxSession: "dev-impl@seat-rig", tmuxPane: "%9" });
      expect.soft(candidates).toEqual([expect.objectContaining({ status: "claimed", claimed_node_id: node.id })]);
      expect.soft(completed.map(row => JSON.parse(row.payload))).toEqual([expect.objectContaining({ restorePacket })]);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(bindingAfter).toMatchObject({ tmuxSession: "dev-impl@seat-rig", tmuxPane: "%9" });
    expect(candidates).toEqual([expect.objectContaining({ status: "claimed", claimed_node_id: node.id })]);
    expect(completed).toHaveLength(1);
    expect(enters, "only confirmed submission permits the held notice's Enter").toBe(typedNotice ? 2 : 1);
    expect(sendKeys.mock.calls).toEqual(Array.from({ length: typedNotice ? 2 : 1 }, () => ["dev-impl@seat-rig", ["Enter"]]));
    if (screen === "clear") expect(result.result.restorePacket).toBeUndefined();
    else {
      const reason = screen === "unreadable" ? "the input box could not be observed" : "the input box did not clearly show the prompt as submitted";
      expect.soft(result.result.restorePacket).toEqual({ status: "unconfirmed", reason });
      expect.soft(JSON.parse(completed[0]!.payload).restorePacket).toEqual({ status: "unconfirmed", reason });
    }
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

  // OPR.0.5.5.5 (05-handover-sources-real) INVERTED the former B3 pin: fork and
  it.each(["floor", "inherit", "policy", null] as const)("rebuild respects a deliberate same-mode selection (%s), not an old choice alone", async mode => {
    const { node } = seedSeat();
    const store = new NativePermissionStore(db);
    const setter = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux() });
    if (mode === "policy") {
      await setter.setPolicy({ seatRef: "dev-impl@seat-rig", ref: "builtin:locked", actor: "old operator", reason: "earlier launch" });
      db.prepare("UPDATE events SET created_at = '2026-04-19 00:00:00' WHERE type = 'node.policy_changed' AND node_id = ?").run(node.id);
    } else if (mode !== "inherit") {
      store.write(node.id, { runtime: "codex", mode: "floor" }, "old operator", "earlier launch");
      db.prepare("UPDATE node_permission_selections SET updated_at = '2026-04-19 00:00:00' WHERE node_id = ?").run(node.id);
    }
    const envelope = { approvalPolicy: "never", sandboxPolicy: { type: "danger-full-access" } };
    currentCodexPermissions.mockResolvedValue({ state: "observed", envelope, profile: null,
      processStartedAt: "Mon Apr 20 12:00:00 2026", observedAt: "2026-04-20T12:01:00Z" });
    if (mode !== null) {
      const selected = mode === "policy"
        ? await setter.setPolicy({ seatRef: "dev-impl@seat-rig", ref: "builtin:locked", actor: "person", reason: "choose successor permissions" })
        : await setter.setPermissions({ seatRef: "dev-impl@seat-rig", mode, actor: "person", reason: "choose successor permissions" });
      expect(selected).toMatchObject({ ok: true, changed: false });
      expect(signalPaneProcess).not.toHaveBeenCalled();
      expect(launchHarness).not.toHaveBeenCalled();
    }
    const result = await service.handover({ seatRef: "dev-impl@seat-rig", source: "rebuild", reason: "context wall" });
    expect(result).toMatchObject({ ok: true, result: { sourceOutcome: { permissions: { state: mode === null ? "emitted" : "selection_used" } } } });
    const binding = launchHarness.mock.calls[0]![0];
    expect(binding.launchPosture).toBe("floor");
    expect(binding.codexRebuildPermissions).toEqual(mode === null ? envelope : undefined);
  });

  it("rebuild uses the seat's own envelope over the observed predecessor policy", async () => {
    const { node } = seedSeat();
    const own = { sandbox: "read-only", approval: "on-request" };
    db.prepare("UPDATE nodes SET codex_permissions_json = ? WHERE id = ?").run(JSON.stringify(own), node.id);
    currentCodexPermissions.mockResolvedValue({ state: "observed", envelope: { approvalPolicy: "never", sandboxPolicy: { type: "danger-full-access" } },
      profile: null, processStartedAt: "Mon Apr 20 12:00:00 2026", observedAt: "2026-04-20T12:01:00Z" });
    const result = await service.handover({ seatRef: "dev-impl@seat-rig", source: "rebuild", reason: "context wall" });
    expect(result).toMatchObject({ ok: true, result: { sourceOutcome: { permissions: { state: "selection_used" } } } });
    const binding = launchHarness.mock.calls[0]![0];
    expect(binding.codexRebuildPermissions).toBeUndefined();
    expect(binding.codexPermissions).toEqual(own);
  });

  it.each(["minted", "mint fails"] as const)("a rebuild handover's receipt reads its lineage record back (%s)", async (mint) => {
    const { node } = seedSeat();
    // The tenure mint is best-effort: a failed one is logged and swallowed, and the handover still completes.
    const failing = mint === "mint fails"
      ? [vi.spyOn(sessionRegistry, "mintOccupantTenure").mockImplementation(() => { throw new Error("ledger unavailable"); }),
        vi.spyOn(console, "warn").mockImplementation(() => {})]
      : [];
    try {
      const result = await service.handover({ seatRef: "dev-impl@seat-rig", source: "rebuild", reason: "context wall" });
      expect(result).toMatchObject({ ok: true, result: { sideEffects: { provenanceRecordWritten: mint === "minted" } } });
      if (mint === "minted") expect(sessionRegistry.currentOccupantTenure(node.id)).toMatchObject({ kind: "handover" });
    } finally {
      for (const spy of failing) spy.mockRestore();
    }
  });

  it.each([["graceful", "ended-graceful"], ["forced", "ended-forced"]] as const)(
    "a rebuild handover's receipt says how the departing process ended (%s)", async (exit, reported) => {
      seedSeat();
      // The retiree exits on TERM, or only once KILL follows the TERM window.
      if (exit === "forced") isPaneDead.mockImplementation(async () => signalPaneProcess.mock.calls.some((call) => call[1] === "KILL"));
      const result = await service.handover({ seatRef: "dev-impl@seat-rig", source: "rebuild", reason: "context wall" });
      expect(result).toMatchObject({ ok: true, result: { sideEffects: { departingSessionKilled: false, departingProcess: reported } } });
      expect(signalPaneProcess.mock.calls.some((call) => call[1] === "KILL")).toBe(exit === "forced");
    });

  it.each(["observed", "unverified", "changed selection", "cleared selection", "profile change", "older selection"])(
    "rebuild permission result: %s", async state => {
      const { node } = seedSeat(state === "profile change" ? { codexConfigProfile: "next-profile" } : undefined);
      const envelope = { approvalPolicy: "on-request", sandboxPolicy: { type: "workspace-write",
        network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false } };
      if (state !== "unverified") currentCodexPermissions.mockImplementation(async () => {
        expect(signalPaneProcess).not.toHaveBeenCalled();
        if (state === "changed selection" || state === "older selection") {
          new NativePermissionStore(db).write(node.id, { runtime: "codex", mode: "full_bypass" }, "person", "successor choice");
          if (state === "older selection") db.prepare("UPDATE node_permission_selections SET updated_at = '2026-04-19 00:00:00' WHERE node_id = ?").run(node.id);
        }
        if (state === "cleared selection") eventBus.emit({ type: "node.permissions_changed", nodeId: node.id,
          rigId: node.rig_id, from: { runtime: "codex", mode: "full_bypass" }, to: null, actor: "person", reason: "inherit",
          source: "seat_selection", effect: "future_launches_only" });
        return { state: "observed", envelope, processStartedAt: "Mon Apr 20 12:00:00 2026",
          observedAt: "2026-04-20T12:01:00Z", profile: null };
      });
      const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "rebuild", source: "rebuild" });
      expect(result).toMatchObject({ ok: true, result: { sourceOutcome: { mode: "rebuild",
        permissions: { state: (state === "changed selection" || state === "cleared selection" || state === "profile change") ? "selection_used" : state === "unverified" ? "unverified" : "emitted" } } } });
      const binding = launchHarness.mock.calls[0]![0];
      if (state === "observed" || state === "older selection") expect(binding.codexRebuildPermissions).toEqual(envelope);
      else expect(binding.codexRebuildPermissions).toBeUndefined();
      if (state === "changed selection") expect(binding.launchPosture).toBe("full_bypass");
      expect(respawnPane).toHaveBeenCalledTimes(1);
    });

  // rebuild now EXECUTE (full coverage in seat-handover-sources.test.ts). What
  // survives of B3 is its safety core: a source that cannot proceed refuses
  // HONESTLY and pre-mutation — never a blank successor reported complete.
  it("OPR.0.5.5.5: fork without a discoverable native id refuses honestly pre-mutation — source_not_supported is gone, the seat is untouched", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fork:0b0165d7" });

    expect(result).toMatchObject({ ok: false, code: "fork_source_not_found" });
    expect(createSession).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    // Original seat/binding untouched; no node marked handover complete.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    const nodeRow = db.prepare("SELECT handover_result FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(nodeRow.handover_result).not.toBe("complete");
    expect(durableRows()).toBe(before);
  });

  it("B3: still returns a dry-run PLAN for a fork source the real run can resolve (planning is not blocked)", async () => {
    const { sessionId } = seedSeat({ runtime: "codex" });
    db.prepare("UPDATE sessions SET resume_token = ? WHERE id = ?").run("codex-thread-1", sessionId);
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fork:dev-impl@seat-rig", dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.ok && "plan" in result && result.plan.willMutate).toBe(false);
    expect(durableRows()).toBe(before);
  });

  it("a dry run refuses a fork source the real run refuses, with the same refusal, and writes nothing", async () => {
    seedSeat({ runtime: "codex" });
    const before = durableRows();

    const dryRun = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fork:0b0165d7", dryRun: true });
    const run = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fork:0b0165d7" });

    expect(dryRun).toMatchObject({ ok: false, code: "fork_source_not_found" });
    expect(dryRun).toEqual(run);
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
    // The seat's node goes with it, so a seat with its own CODEX_HOME is searched there.
    expect(captureCodexThreadId).toHaveBeenCalledWith("successor-session", { nodeId: node.id });
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

  // #421: the discovered successor's own sample is taken after its process started; a sidecar
  // sampled before that can only come from an earlier process.
  it.each([
    ["captures the successor's own sample", 60_000, { resume_token: "claude-sid-123", outcome: "captured" }],
    ["skips a sample from an earlier process", -3_600_000, { resume_token: null, outcome: "skipped", reason: "stale_sidecar" }],
  ])("B2 (claude-code): %s", async (_label, offsetMs, expected) => {
    const processStart = "Fri Oct  2 11:00:00 2026";
    readSidecar.mockReturnValue({ ok: true, data: { session_id: "claude-sid-123", sampled_at: new Date(Date.parse(processStart) + offsetMs).toISOString() } });
    const startedAt = vi.fn(async () => processStart);
    claudeProcessStartedAt = startedAt;
    service = newService();
    const { node } = seedSeat({ runtime: "claude-code" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "mvp-proof", source: `discovered:${discovered.id}` });

    expect(result.ok).toBe(true);
    const newSession = db.prepare(
      "SELECT resume_token FROM sessions WHERE node_id = ? AND session_name = ?"
    ).get(node.id, "successor-session") as Record<string, string | null>;
    expect(newSession.resume_token).toBe(expected.resume_token);
    const event = db.prepare("SELECT payload FROM events WHERE type = 'session.resume_token_captured' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    const { resume_token: _token, ...payload } = expected;
    expect(JSON.parse(event.payload)).toMatchObject(payload);
    expect(startedAt).toHaveBeenCalledWith("successor-session");
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

  // #141: a YAML re-import archives the stopped earlier generation, which keeps its binding to the seat's
  // canonical session name. A composer-launched successor reuses that name, so the archived shadow must not
  // reject the live seat's handover after the successor has already replaced the process.
  function seedArchivedGeneration(): void {
    const old = rigRepo.createRig("seat-rig");
    const oldNode = rigRepo.addNode(old.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(oldNode.id, "dev-impl@seat-rig").id, "exited");
    sessionRegistry.updateBinding(oldNode.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%0" });
    rigRepo.archiveRig(old.id);
  }

  it.each(["fresh", "rebuild"] as const)("#141: an archived earlier generation's binding does not block a %s handover of the live seat", async (source) => {
    seedArchivedGeneration();
    const { node } = seedSeat();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source });

    expect(result).toMatchObject({ ok: true });
    expect(respawnPane).toHaveBeenCalledTimes(1);
    expect(killSession).not.toHaveBeenCalled();
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    const nodeRow = db.prepare("SELECT handover_result FROM nodes WHERE id = ?").get(node.id) as { handover_result: string | null };
    expect(nodeRow.handover_result).toBe("complete");
  });

  it("#141 control: another UNARCHIVED rig's binding to the seat's session name still blocks a fresh handover", async () => {
    seedSeat();
    const otherRig = rigRepo.createRig("other-rig");
    const otherNode = rigRepo.addNode(otherRig.id, "dev.other", { runtime: "codex" });
    sessionRegistry.updateBinding(otherNode.id, { tmuxSession: "dev-impl@seat-rig" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_already_managed" });
  });

  it("#141 control: an archived rig's binding still blocks a DISCOVERED successor of that name", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    const archivedRig = rigRepo.createRig("archived-rig");
    const archivedNode = rigRepo.addNode(archivedRig.id, "dev.other", { runtime: "codex" });
    sessionRegistry.updateBinding(archivedNode.id, { tmuxSession: "successor-session" });
    rigRepo.archiveRig(archivedRig.id);
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: `discovered:${discovered.id}` });

    expect(result).toMatchObject({ ok: false, code: "successor_already_managed" });
    expect(durableRows()).toBe(before);
  });

  it("a successful fresh handover keeps the seat's blocked row's park timer live (real invalidator and repositories)", async () => {
    seedSeat();
    const gen = (session: string) => sessionRegistry.currentOccupantGenerationForSession(session);
    const queue = new QueueRepository(db, eventBus, { validateRig: () => true, resolveOccupantGeneration: gen });
    const jobs = new WatchdogJobsRepository(db, undefined, gen);
    queue.attachWatchdogJobsRepository(jobs);
    const row = await queue.create({ sourceSession: "orch-lead@seat-rig", destinationSession: "dev-impl@seat-rig", body: "work" } as never);
    queue.update({ qitemId: row.qitemId, actorSession: "dev-impl@seat-rig", state: "blocked", blockedOn: "external:ci", transitionNote: "continuation: check CI", wakeAfterSeconds: 1800 } as never);
    const timer = (queue.getParkWakeStatus(row.qitemId) as { ref: string }).ref;
    const handover = newService(tmux(), new DefaultOccupantInvalidator({
      enforcer: { invalidateOccupant() {} }, contextUsage: { invalidateOccupantSidecar() {} }, watchdog: jobs, queue,
    }));

    const result = await handover.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    expect(jobs.getById(timer)?.state).toBe("active");
    expect((queue.getParkWakeStatus(row.qitemId) as { live: boolean }).live).toBe(true);
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

  it.each([undefined, "none"] as const)("carries current rules, model, Advisor and MCP selection (%s) to the successor", async claudeMcp => {
    const { node } = seedSeat({ runtime: "claude-code", model: "claude-sonnet-5-5", advisor: "opus" });
    rigRepo.setNodeClaudeMcp(node.id, claudeMcp ?? null);
    capturePaneScreen.mockResolvedValue("Claude Code v2.1.303\n❯ \n────────────────────\n  ⏵⏵ accept edits on (shift+tab to cycle)");
    const rules = { allow: [], deny: ["Read(./private/**)"] };
    const writer = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux() });
    expect(await writer.setPermissions({ seatRef: "dev-impl@seat-rig", rules, actor: "operator@seat-rig", reason: "Set successor rules" })).toMatchObject({ ok: true });
    launchHarness.mockResolvedValue({ ok: true, resumeToken: "claude-successor", resumeType: "claude_id" });
    const claudeService = new SeatHandoverService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: tmux(), runtimeAdapters: { "claude-code": { runtime: "claude-code", launchHarness, checkReady } as unknown as RuntimeAdapter },
      predecessorRecapResolver: resolvePredecessorRecap as never, readinessTimeoutMs: 50, sleep: async () => {} });
    const result = await claudeService.handover({
      seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh", operator: "orch-lead@seat-rig",
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(launchHarness).toHaveBeenCalledTimes(1);
    expect(launchHarness.mock.calls[0]![0]).toMatchObject({ nodeId: node.id, model: "claude-sonnet-5-5", advisor: "opus", claudePermissions: rules, claudeMcp });
  });

  it("#75: an effort-pinned seat's handover launches the successor with that effort — the REAL lookupNode→createSuccessor→launchHarness path", async () => {
    seedSeat({ runtime: "codex", effort: "high" });
    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const successorBinding = launchHarness.mock.calls[0]![0] as { effort?: string };
    expect(successorBinding.effort).toBe("high");
  });

  it("OPR.0.7.0.9 (K2): a Claude seat's launch additions reach its fresh handover successor's launch, and the new conversation's start is recorded", async () => {
    const { rig } = seedSeat({ runtime: "claude-code" });
    capturePaneScreen.mockResolvedValue("Claude Code v2.1.303\n❯ \n────────────────────\n  ⏵⏵ accept edits on (shift+tab to cycle)");
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "handover-additions-"));
    try {
      fs.writeFileSync(path.join(src, "prompt.md"), "Short answers.\n");
      const paths = seatSkillPaths({ rigId: rig.id, logicalId: "dev.impl", runtime: "claude-code" });
      const prepared = prepareSeatLaunchAdditions(paths, { appendSystemPromptFile: path.join(src, "prompt.md") });
      if (!prepared.ok) throw new Error(prepared.message);
      launchHarness.mockImplementation(async () => ({ ok: true, resumeToken: "claude-successor-tok", resumeType: "claude_id" }));
      const claude = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: tmux(),
        now: () => new Date("2026-04-24T18:30:00.000Z"), newSuccessorId: () => "01SUCCID0",
        runtimeAdapters: { "claude-code": { runtime: "claude-code", launchHarness, checkReady } as unknown as RuntimeAdapter },
        contextUsageStore: { readSidecar } as never, resumeTokenCapturer: { captureCodexThreadId } as never,
        claudeProcessStartedAt: async () => "2026-04-24T18:29:59.000Z",
        occupantInvalidator: { invalidateRetiringOccupant }, activityOracle: { declareOccupantSwap },
        predecessorRecapResolver: resolvePredecessorRecap as never, readinessTimeoutMs: 50, sleep: async () => {},
      });
      await claude.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh", operator: "orch-lead@seat-rig" });
      expect(launchHarness).toHaveBeenCalledTimes(1);
      const successorBinding = launchHarness.mock.calls[0]![0] as { launchAdditions?: { appendSystemPromptFile?: string } };
      expect(successorBinding.launchAdditions?.appendSystemPromptFile).toBe(prepared.additions.appendSystemPromptFile);
      // The successor's conversation starts with today's prompt: nothing pending for it.
      expect(systemPromptPendingNote(paths, "claude-successor-tok")).toBeUndefined();
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });

  it("#2426: a Claude seat that loads openrig-core itself drops OpenRig's earlier copies of its skills once its predecessor has exited, before its successor starts, and names them", async () => {
    const saved = process.env["OPENRIG_HOME"];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "handover-core-copies-"));
    process.env["OPENRIG_HOME"] = home;
    try {
      // The vendored core, which the seat's saved selection loads directly, and the copies a launch before #2433 left.
      const core = path.join(home, "plugins", "openrig-core");
      fs.mkdirSync(path.join(core, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(core, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "openrig-core", version: "0.7.9" }));
      for (const id of ["alpha", "edited"]) {
        fs.mkdirSync(path.join(core, "skills", id), { recursive: true });
        fs.writeFileSync(path.join(core, "skills", id, "SKILL.md"), `---\nname: ${id}\ndescription: The ${id} skill.\n---\n\nUse it.\n`);
      }
      const { rig, node } = seedSeat({ runtime: "claude-code" });
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, '[]', '[]', 'claude-code')")
        .run(node.id, JSON.stringify([{ category: "plugin", absolutePath: core }]));
      const paths = seatSkillPaths({ rigId: rig.id, logicalId: "dev.impl", runtime: "claude-code" });
      ensureSeatSkillPlugin(paths);
      const old = reconcileSkillLoadout({
        loadout: { catalogRoot: home, catalogRevision: null, catalogDigest: null, projectSelectionDeclared: false, projectSelection: [],
          entries: resolvePluginSkills({ pluginId: "openrig-core", pluginRoot: core, runtime: "claude-code" }).entries },
        runtime: "claude-code", cwd: paths.root, apply: true, topologyOwner: "dev-impl@seat-rig", location: seatSkillLocation(paths),
      });
      expect(old.errors).toEqual([]);
      fs.writeFileSync(path.join(paths.skillsRoot, "edited", "SKILL.md"), "My own notes.\n");
      const alpha = path.join(paths.skillsRoot, "alpha");
      // Nothing is removed under the running predecessor; the successor's harness starts without the copy.
      const presentWhenSignalled: boolean[] = [];
      signalPaneProcess.mockImplementation(async () => { presentWhenSignalled.push(fs.existsSync(alpha)); return { ok: true }; });
      const presentAtLaunch: boolean[] = [];
      launchHarness.mockImplementation(async () => { presentAtLaunch.push(fs.existsSync(alpha)); return { ok: true, resumeToken: "claude-successor-tok", resumeType: "claude_id" }; });
      capturePaneScreen.mockResolvedValue("Claude Code v2.1.303\n❯ \n────────────────────\n  ⏵⏵ accept edits on (shift+tab to cycle)");
      const claude = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: tmux(),
        now: () => new Date("2026-04-24T18:30:00.000Z"), newSuccessorId: () => "01SUCCID0",
        runtimeAdapters: { "claude-code": { runtime: "claude-code", launchHarness, checkReady } as unknown as RuntimeAdapter },
        contextUsageStore: { readSidecar } as never, resumeTokenCapturer: { captureCodexThreadId } as never,
        claudeProcessStartedAt: async () => "2026-04-24T18:29:59.000Z",
        occupantInvalidator: { invalidateRetiringOccupant }, activityOracle: { declareOccupantSwap },
        predecessorRecapResolver: resolvePredecessorRecap as never, readinessTimeoutMs: 50, sleep: async () => {},
      });
      const result = await claude.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh", operator: "orch-lead@seat-rig" });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(presentWhenSignalled[0]).toBe(true);
      expect(presentAtLaunch).toEqual([false]);
      expect("result" in result ? result.result.warnings : undefined).toEqual(expect.arrayContaining([
        "Seat skills: removed OpenRig's copy of openrig-core's alpha, which this seat now loads from the plugin itself",
        `Seat skills: kept ${path.join(paths.skillsRoot, "edited")}, though openrig-core also supplies edited: it was changed after OpenRig wrote it`,
      ]));
      expect(fs.readFileSync(path.join(paths.skillsRoot, "edited", "SKILL.md"), "utf8")).toBe("My own notes.\n");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("a seat's declared env (its rig's, with the member's over it) reaches the successor's pane — the REAL lookupNode→createSuccessor→respawn path", async () => {
    const { rig, node } = seedSeat({ runtime: "codex" });
    rigRepo.setRigEnv(rig.id, { SHARED: "from-rig", RIG_ONLY: "rig" });
    db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?").run(JSON.stringify({ SHARED: "from-member" }), node.id);
    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh", operator: "orch-lead@seat-rig" });
    expect(result.ok).toBe(true);
    expect(respawnPane).toHaveBeenCalledTimes(1);
    const env = respawnPane.mock.calls[0]![2].env as Record<string, string>;
    expect(env).toMatchObject({ SHARED: "from-member", RIG_ONLY: "rig", OPENRIG_SEAT_ENV_KEYS: "SHARED,RIG_ONLY" });
  });

  it("OPR.0.7.0.7: a seat's saved effort choice wins over its authored effort at handover (the shared resolver)", async () => {
    const { node } = seedSeat({ runtime: "codex", effort: "medium" });
    rigRepo.setNodeEffortChoice(node.id, "high");
    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh", operator: "orch-lead@seat-rig" });
    expect(result.ok).toBe(true);
    expect((launchHarness.mock.calls[0]![0] as { effort?: string }).effort).toBe("high");
  });

  it.each(["codex", "claude-code"])("carries the %s seat's persisted launch_wrapper onto the handover successor binding", async runtime => {
    const { node } = seedSeat({ runtime });
    if (runtime === "claude-code") {
      launchHarness.mockImplementation(async () => ({ ok: true, resumeToken: "claude-successor-tok", resumeType: "claude_id" }));
      capturePaneScreen.mockResolvedValue("Claude Code v2.1.303\n❯ \n────────────────────\n  ⏵⏵ accept edits on (shift+tab to cycle)");
      claudeProcessStartedAt = async () => "2026-04-24T18:29:59.000Z";
    }
    service = newService(undefined, undefined, runtime);
    rigRepo.setNodeLaunchWrapper(node.id, ["rtk", "--handover"]);
    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);
    expect((launchHarness.mock.calls[0]![0] as { launchWrapper?: string[] }).launchWrapper).toEqual(["rtk", "--handover"]);
  });

  it("fails closed before cutover when the seat's stored launch_wrapper is corrupt", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    capturePaneScreen.mockImplementationOnce(async () => {
      db.prepare("UPDATE nodes SET launch_wrapper = ? WHERE id = ?").run("{corrupt", node.id);
      return "predecessor screen tail";
    });
    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "successor_create_failed",
    });
    expect((result as { message: string }).message).toMatch(/Permission selection:.*launch_wrapper/);
    expect(respawnPane).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
  });
});
