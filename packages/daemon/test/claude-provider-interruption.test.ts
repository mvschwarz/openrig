import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore, AGENT_ACTIVITY_FRESHNESS_MS } from "../src/domain/agent-activity-store.js";
import { deriveRelayEvents } from "../src/domain/claude-activity-hooks.js";
import { EventBus } from "../src/domain/event-bus.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { deriveUsageLimitPools } from "../src/domain/provider/provider-signals.js";
import type { ProviderSignal } from "../src/domain/provider/provider-types.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildOpenRigPayload: (payload: Record<string, unknown>, env: Record<string, string>, now: () => Date) => Record<string, unknown>;
};
const SESSION = "dev-worker@limit-fixture";
const NODE = "node-limit-fixture";
const GENERATION = "generation-current";
const T0 = "2025-01-01T12:00:00.000Z";
const identity = { OPENRIG_SESSION_NAME: SESSION, OPENRIG_NODE_ID: NODE, OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: GENERATION };

describe("Claude provider interruptions (#99)", () => {
  let db: Database.Database;
  let store: AgentActivityStore;
  let queue: QueueRepository;
  let service: ProviderServiceImpl;
  let fixtureHome: string;
  let liveGeneration: string | null;
  let claudeSignals: ProviderSignal[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-limit-"));
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-limit', 'limit-fixture')").run();
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES ('pod-limit', 'rig-limit', 'dev', 'Dev')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, pod_id) VALUES (?, 'rig-limit', 'dev.worker', 'claude-code', 'pod-limit')").run(NODE);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('session-limit', ?, ?, 'running', 'ready')").run(NODE, SESSION);
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES ('binding-limit', ?, ?)").run(NODE, SESSION);
    const eventBus = new EventBus(db);
    liveGeneration = GENERATION;
    store = new AgentActivityStore({ db, eventBus,
      resolveOccupantGeneration: () => liveGeneration,
      isRegisteredOccupantGeneration: (_nodeId, generation) => [GENERATION, "generation-replacement"].includes(generation),
    });
    queue = new QueueRepository(db, eventBus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    claudeSignals = [];
    service = new ProviderServiceImpl({ db, listRigs: () => [{ id: "rig-limit" }],
      env: { CODEX_HOME: fixtureHome }, agentActivityStore: store, collectClaudeSignals: () => claudeSignals,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(fixtureHome, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function report(payload: Record<string, unknown>, env = identity) {
    const relayed = relay.buildOpenRigPayload(payload, env, () => new Date());
    const result = store.recordHookEvent(relayed as unknown as Parameters<AgentActivityStore["recordHookEvent"]>[0]);
    expect(result.ok).toBe(true);
    return relayed;
  }

  const reportLimit = () => report({ hook_event_name: "StopFailure", error: "rate_limit" });
  const events = async () => (await service.getReadModel()).signals.filter(signal => signal.sourceClass === "provider_event");

  async function displayLimit(input: { hookAge: number; paneAge: number; permission?: boolean; motion?: boolean }) {
    vi.setSystemTime(Date.parse(T0) - input.hookAge);
    reportLimit();
    vi.setSystemTime(T0);
    let clock = new Date(Date.parse(T0) - input.paneAge);
    const capturePaneContent = vi.fn(async () => input.permission ? "Do you want to proceed?" : "output\n❯ ");
    const structuralActivity = new SeatStructuralActivityService({ capturePaneContent }, () => clock);
    expect((await structuralActivity.pollSeat(SESSION, null, "claude-code"))?.state)
      .toBe(input.permission ? "attention" : "agent_idle");
    clock = new Date(T0);
    capturePaneContent.mockClear();
    const seatActivity = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => clock.getTime() / 1000 - 1 },
      defaultWindowSeconds: 3, now: () => clock,
    });
    if (input.motion) await seatActivity.pollSeat(SESSION);
    const entries = [{
      canonicalSessionName: SESSION, runtime: "claude-code", attachmentType: "tmux", logicalId: "dev.worker",
    }] as Parameters<typeof attachAgentActivity>[0];
    const [entry] = await attachAgentActivity(entries, {
      tmuxAdapter: { capturePaneContent } as never,
      activityStore: store, structuralActivity, seatActivity, now: clock,
    });
    expect(capturePaneContent).not.toHaveBeenCalled();
    return entry!.agentActivity;
  }

  it("delivers StopFailure through the committed Claude hook manifest", () => {
    const manifest = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/claude.json");
    const events = deriveRelayEvents({ exists: fs.existsSync, readFile: file => fs.readFileSync(file, "utf8") }, manifest);
    expect(events).toContainEqual({ event: "StopFailure", timeout: 5 });
  });

  it("carries the typed native error without copying provider error text or a tool-name substitute", () => {
    const payload = report({ hook_event_name: "StopFailure", error: "rate_limit", subtype: "overloaded",
      tool_name: "overloaded", error_details: "private details", last_assistant_message: "private text" });
    expect(payload).toMatchObject({ hookEvent: "StopFailure", subtype: "rate_limit", runtime: "claude-code", generation: GENERATION });
    expect(payload).not.toHaveProperty("error_details");
    expect(payload).not.toHaveProperty("last_assistant_message");
    expect(store.getLatestForNode({ sessionName: SESSION })).toMatchObject({ state: "unknown", reason: "usage_limit" });
  });

  it("reports a fresh same-occupant limit without inventing a Claude account, usage meter or reset", async () => {
    reportLimit();
    const model = await service.getReadModel();
    expect(model.signals.filter(signal => signal.sourceClass === "provider_event")).toEqual([{
      provider: "claude", seatSession: SESSION, sourceClass: "provider_event", authority: "reactive_error",
      asOf: T0, staleAfter: new Date(Date.parse(T0) + AGENT_ACTIVITY_FRESHNESS_MS).toISOString(), automationUse: "allow_switch_decision",
    }]);
    expect(model.accounts).toEqual([]);
    expect(model.hostUsage).toContainEqual(expect.objectContaining({ provider: "claude", state: "limited", windows: [] }));
    expect(model.hostUsage?.find(row => row.provider === "claude")).not.toHaveProperty("resetsAt");
  });

  it.each([
    { hook_event_name: "StopFailure", error: "overloaded" },
    { hook_event_name: "StopFailure", error: "authentication_failed" },
    { hook_event_name: "StopFailure", error: "billing_error" },
    { hook_event_name: "StopFailure", error: "rate_limit_warning" },
    { hook_event_name: "StopFailure", subtype: "rate_limit", tool_name: "rate_limit" },
    { hook_event_name: "StopFailure", error: { type: "rate_limit" } },
    { hook_event_name: "Notification", notification_type: "rate_limit" },
    { hook_event_name: "PermissionRequest", tool_name: "rate_limit", error: "rate_limit" },
    { hook_event_name: "PostToolUse", tool_name: "rate_limit", error: "rate_limit" },
  ])("does not turn another producer or error into exhaustion: %j", async payload => {
    report(payload);
    expect(await events()).toEqual([]);
  });

  it.each(["generation-replacement", null])("discards a limit when the current occupant is %s", async generation => {
    reportLimit();
    liveGeneration = generation;
    expect(await events()).toEqual([]);
  });

  it("does not accept a same-name seat's event from another runtime", async () => {
    report({ hook_event_name: "StopFailure", error: "rate_limit" }, { ...identity, OPENRIG_RUNTIME: "codex" });
    expect(await events()).toEqual([]);
  });

  it("expires a limit at the freshness bound, and a new turn supersedes it", async () => {
    reportLimit();
    expect(await events()).toHaveLength(1);
    vi.setSystemTime(Date.parse(T0) + AGENT_ACTIVITY_FRESHNESS_MS);
    expect(await events()).toEqual([]);
    reportLimit();
    expect(await events()).toHaveLength(1);
    report({ hook_event_name: "UserPromptSubmit" });
    expect(await events()).toEqual([]);
  });

  it("does not act on a provider failure timestamp in the future", async () => {
    vi.setSystemTime(Date.parse(T0) + 1000);
    reportLimit();
    vi.setSystemTime(T0);
    expect(await events()).toEqual([]);
  });

  it.each([false, true])("keeps a fresh limit over cached idle without asking for human input (motion: %s)", async motion => {
    expect(await displayLimit({ hookAge: 1000, paneAge: 0, motion })).toMatchObject({
      state: "unknown", reason: "usage_limit", evidenceSource: "runtime_hook",
      rawEvent: "StopFailure", rawSubtype: "rate_limit", stale: false,
      generation: GENERATION, generationProvenance: "resolved",
    });
  });

  it.each([
    { name: "newer permission", hookAge: 2000, paneAge: 1000, permission: true, expected: "permission_prompt" },
    { name: "equal permission", hookAge: 1000, paneAge: 1000, permission: true, expected: "usage_limit" },
    { name: "stale permission", hookAge: 6000, paneAge: 5000, permission: true, expected: "usage_limit" },
    { name: "expired limit", hookAge: 600000, paneAge: 0, expected: "idle_prompt" },
    { name: "replaced occupant", hookAge: 1000, paneAge: 0, expected: "idle_prompt" },
    { name: "unknown occupant", hookAge: 1000, paneAge: 0, expected: "idle_prompt" },
  ])("preserves the display's chronology and identity guards: $name", async input => {
    if (input.name === "replaced occupant") liveGeneration = "generation-replacement";
    if (input.name === "unknown occupant") liveGeneration = null;
    expect(await displayLimit(input)).toMatchObject({
      state: input.expected === "usage_limit" ? "unknown" : input.expected === "permission_prompt" ? "needs_input" : "idle",
      reason: input.expected,
      evidenceSource: input.expected === "usage_limit" ? "runtime_hook" : "pane_heuristic",
    });
  });

  it("keeps the structured reset when a statusline window is also exhausted", async () => {
    const reset = new Date(Date.parse(T0) + 3_600_000).toISOString();
    claudeSignals = [{ provider: "claude", seatSession: SESSION, sourceClass: "provider_statusline", authority: "account_cross_device",
      window: "five_hour", usedPercent: 100, resetsAt: reset, asOf: T0,
      staleAfter: new Date(Date.parse(T0) + AGENT_ACTIVITY_FRESHNESS_MS).toISOString(), automationUse: "allow_switch_decision" }];
    reportLimit();
    const model = await service.getReadModel();
    expect(deriveUsageLimitPools({ signals: model.signals, bindings: model.bindings, now: new Date(), fallbackSeconds: 300 }))
      .toEqual([{ poolKey: "claude:local", provider: "claude", seatSessions: [SESSION], expiresAt: reset, source: "provider-reset" }]);
  });

  it("keeps a below-limit meter intact while the typed failure supplies a bounded retry", async () => {
    claudeSignals = [{ provider: "claude", seatSession: SESSION, sourceClass: "provider_statusline", authority: "account_cross_device",
      window: "five_hour", usedPercent: 40, resetsAt: "2025-01-01T13:00:00.000Z", asOf: T0,
      staleAfter: "2025-01-01T12:05:00.000Z", automationUse: "allow_switch_decision" }];
    reportLimit();
    const model = await service.getReadModel();
    const usage = model.hostUsage?.find(row => row.provider === "claude");
    expect(usage).toMatchObject({ state: "limited", windows: [expect.objectContaining({ usedPercent: 40 })] });
    expect(usage).not.toHaveProperty("resetsAt");
    expect(deriveUsageLimitPools({ signals: model.signals, bindings: model.bindings, now: new Date(), fallbackSeconds: 300 }))
      .toEqual([{ poolKey: "claude:local", provider: "claude", seatSessions: [SESSION], expiresAt: "2025-01-01T12:05:00.000Z", source: "config-fallback" }]);
  });

  it("does not hide conflicting statusline windows behind a typed failure", async () => {
    const peer = "dev-peer@limit-fixture";
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, pod_id) VALUES ('node-peer', 'rig-limit', 'dev.peer', 'claude-code', 'pod-limit')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('session-peer', 'node-peer', ?, 'running', 'ready')").run(peer);
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES ('binding-peer', 'node-peer', ?)").run(peer);
    claudeSignals = [SESSION, peer].map((seatSession, index) => ({
      provider: "claude", seatSession, sourceClass: "provider_statusline", authority: "account_cross_device",
      window: "five_hour", usedPercent: 40, resetsAt: `2025-01-01T1${index + 3}:00:00.000Z`, asOf: T0,
      staleAfter: "2025-01-01T12:05:00.000Z", automationUse: "allow_switch_decision",
    }));
    reportLimit();
    expect((await service.getReadModel()).hostUsage?.find(row => row.provider === "claude"))
      .toMatchObject({ state: "explicit_unknown", anomalies: [expect.objectContaining({ kind: "conflicting_seat_windows" })] });
  });

  it("parks pending work on the existing bounded timer when the hook has no reset, then releases it once", async () => {
    const jobs = new WatchdogJobsRepository(db, () => new Date());
    queue.attachWatchdogJobsRepository(jobs);
    queue.attachOutbox(new OutboxHandler(db));
    const delivered = vi.fn(async () => ({ ok: true, verified: true }));
    queue.attachTransport({ send: delivered });
    const source = await queue.create({ sourceSession: "sender@limit-fixture", destinationSession: "relay@limit-fixture", body: "work", nudge: false });
    const { created: baton } = await queue.handoff({ qitemId: source.qitemId, fromSession: "relay@limit-fixture", toSession: SESSION, nudge: false });
    const old = new Date(Date.parse(T0) - 600_000).toISOString();
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = 'failed:provider limit' WHERE qitem_id = ?").run(old, baton.qitemId);
    const attemptWake = vi.fn(async () => "typed");
    const tick = () => runWakeLadderTick({ db, queueRepo: queue, attemptWake, resolveOrchestrator: () => null,
      retryIntervalSeconds: 300, usageLimitJitterSeconds: 0, getProviderReadModel: () => service.getReadModel(), log: () => {} });

    reportLimit();
    expect((await tick()).actions).toContainEqual({ qitemId: baton.qitemId, action: "park-usage-limit" });
    expect(queue.getById(baton.qitemId)?.state).toBe("blocked");
    const blocker = queue.getById(baton.qitemId)!.blockedOn!;
    const timer = queue.getParkWakeStatus(blocker)!;
    expect(timer).toMatchObject({ kind: "timer", live: true, expiresAt: "2025-01-01T12:05:00.000Z" });
    expect(queue.transitionLog.listForQitem(blocker).some(row => row.transitionNote?.includes("cause=config-fallback"))).toBe(true);
    await tick();
    expect(attemptWake).not.toHaveBeenCalled();
    expect((db.prepare("SELECT COUNT(*) AS n FROM watchdog_jobs WHERE state = 'active'").get() as { n: number }).n).toBe(1);

    vi.setSystemTime("2025-01-01T12:05:01.000Z");
    report({ hook_event_name: "UserPromptSubmit" });
    queue.recordWatchdogWakeAttempt(timer.ref!, "typed");
    await queue.drainPendingWakeIntents();
    expect(queue.getById(baton.qitemId)?.state).toBe("pending");
    expect(queue.getById(blocker)?.state).toBe("done");
    expect(jobs.getById(timer.ref!)?.state).toBe("terminal");
    expect(delivered).toHaveBeenCalledTimes(1);
    queue.recordWatchdogWakeAttempt(timer.ref!, "typed");
    await queue.drainPendingWakeIntents();
    expect(delivered).toHaveBeenCalledTimes(1);
  });
});
