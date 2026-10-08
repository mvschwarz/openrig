// A post-compact stage that drains without a usage sample must not trust the hook that came before
// /compact. Managed /compact relays no hook of its own, so until compaction ends the newest hook
// is the preparation turn's Stop (idle). These tests compose the real monitor, usage store,
// enforcer, activity store and SessionTransport over an inert tmux adapter.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { SessionTransport, classifyPaneActivity } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";

const COMPACTING_PANE = "⠋ Compacting conversation\nesc to interrupt";
const IDLE_PANE = "Conversation compacted\n❯ ";

describe("post-compact drain readiness without a usage sample", () => {
  let db: Database.Database;
  let home: string;
  let monitor: ContextMonitor;
  let enforcer: ClaudeCompactionEnforcer;
  let activity: AgentActivityStore;
  let realTransport: SessionTransport;
  let tmux: {
    capturePaneContent: ReturnType<typeof vi.fn>;
    sendText: ReturnType<typeof vi.fn>;
    sendKeys: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  let sessionName: string;
  let clock: number;
  let pane: string;
  let deliver: boolean;
  let preparation: string[];

  const sidecar = () => join(home, "state", "context-usage", `${sessionName}.json`);
  const usage = (value: number | null, ageMs = 0) => writeFileSync(sidecar(), JSON.stringify({
    session_id: "fixture-session",
    session_name: sessionName,
    transcript_path: null,
    sampled_at: new Date(Date.now() - ageMs).toISOString(),
    context_window: { context_window_size: 200000, used_percentage: value, remaining_percentage: value == null ? null : 100 - value },
  }));
  const hook = (event: string, ageMs = 0) => {
    const result = activity.recordHookEvent({
      runtime: "claude-code", sessionName, hookEvent: event, generation: "gen-1",
      occurredAt: new Date(clock - ageMs).toISOString(),
    });
    expect(result.ok).toBe(true);
  };
  const boundaryWrites = () => tmux.sendText.mock.calls
    .map((call) => String(call[1]))
    .filter((text) => text.includes("OpenRig post-compaction turn boundary."));

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    home = mkdtempSync(join(tmpdir(), "compaction-drain-readiness-"));
    mkdirSync(join(home, "state", "context-usage"), { recursive: true });
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("drain");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    sessionName = "worker@drain";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName });
    clock = Date.now();
    pane = COMPACTING_PANE;
    deliver = false;
    preparation = [];
    activity = new AgentActivityStore({
      db, eventBus: new EventBus(db), now: () => new Date(clock),
      resolveOccupantGeneration: () => "gen-1", isRegisteredOccupantGeneration: () => true,
    });
    tmux = {
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" }),
      getPanePid: async () => null,
      getPaneCommand: async () => null,
      capturePaneContent: vi.fn(async () => pane),
      sendText: vi.fn(async () => ({ ok: true })),
      sendKeys: vi.fn(async () => ({ ok: true })),
      listSessions: async () => [],
      listWindows: async () => [],
      listPanes: async () => [],
    };
    realTransport = new SessionTransport({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux, agentActivityStore: activity,
      now: () => new Date(clock), sleep: async (ms: number) => { clock += ms; }, waitForIdlePollMs: 10,
    } as never);
    // Preparation and /compact go to a recording fake; after /compact the real transport delivers.
    const transport = {
      send: async (name: string, text: string, opts: unknown) => {
        if (deliver) return realTransport.send(name, text, opts as never);
        preparation.push(text);
        const marker = text.match(/<!-- openrig-compaction-complete .*? -->/)?.[0];
        const target = text.match(/Write this attempt's complete restore map to ("(?:[^"\\]|\\.)*")/);
        if (marker && target) {
          const file = JSON.parse(target[1]!) as string;
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, `# Completed fixture map\n${marker}\n`);
        }
        return { ok: true };
      },
    } as unknown as SessionTransport;
    const settings = new SettingsStore(join(home, "settings.json"));
    settings.set("policies.claude_compaction.enabled", "true");
    settings.set("policies.claude_compaction.threshold_percent", "80");
    enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      openrigHome: home, resolveOccupantGeneration: () => "gen-1", postCompactSendWaitMs: 40,
    });
    monitor = new ContextMonitor(db, new ContextUsageStore(db, { stateDir: home, codexHomeDir: home }), undefined, enforcer);
  });

  afterEach(() => {
    monitor.stop();
    db.close();
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function compact() {
    usage(80);
    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(preparation).toHaveLength(2);
    expect(preparation[1]).toMatch(/^\/compact/);
    expect(enforcer.hasPendingPostCompactStage(sessionName)).toBe(true);
    deliver = true;
  }

  it.each([
    ["a missing sidecar", "missing", 1_000],
    ["a malformed sidecar", "parse", 30_000],
    ["a null percentage", "null", 30_000],
  ])("with %s and the pre-compact idle hook, sends nothing while the pane is compacting, then drains once it is idle", async (_name, kind, hookAgeMs) => {
    await compact();
    hook("Stop", Number(hookAgeMs));
    if (kind === "missing") rmSync(sidecar(), { force: true });
    else if (kind === "parse") writeFileSync(sidecar(), "{");
    else usage(null);
    expect(classifyPaneActivity(pane).state).toBe("agent_active");

    await monitor.pollOnce();
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(enforcer.hasPendingPostCompactStage(sessionName)).toBe(true);

    // Compaction finishes: the pane shows an empty composer. No new hook is needed.
    pane = IDLE_PANE;
    await monitor.pollOnce();
    expect(boundaryWrites()).toHaveLength(1);
    await monitor.pollOnce();
    expect(boundaryWrites()).toHaveLength(1);
  });

  it("an unreadable pane with only the old idle hook keeps waiting", async () => {
    await compact();
    hook("Stop", 30_000);
    rmSync(sidecar(), { force: true });
    pane = "";
    await monitor.pollOnce();
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(enforcer.hasPendingPostCompactStage(sessionName)).toBe(true);
  });

  it("ordinary wait-for-idle sends keep trusting a fresh idle hook", async () => {
    hook("Stop", 1_000);
    const result = await realTransport.send(sessionName, "ordinary message", { waitForIdleMs: 40 });
    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
  });
});
