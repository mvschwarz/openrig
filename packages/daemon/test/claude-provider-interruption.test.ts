import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore, AGENT_ACTIVITY_FRESHNESS_MS, latestHookWaitsOnPerson } from "../src/domain/agent-activity-store.js";
import { deriveRelayEvents } from "../src/domain/claude-activity-hooks.js";
import { EventBus } from "../src/domain/event-bus.js";
import { attachAgentActivity, attachTerminalActivityAndWork, hookOrPaneActivity, seatNeedsAttention } from "../src/domain/node-inventory.js";
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
  claudeLimitResetAt: (text: string, now: Date) => string | null;
};
const SESSION = "dev-worker@limit-fixture";
const NODE = "node-limit-fixture";
const GENERATION = "generation-current";
const T0 = "2025-01-01T12:00:00.000Z";
// The seat's own Claude session: its resume token, which a hook from the seat's Claude reports as session_id.
const OWN_CLAUDE_SESSION = "11111111-1111-4111-8111-111111111111";
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
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, resume_type, resume_token) VALUES ('session-limit', ?, ?, 'running', 'ready', 'claude_id', ?)")
      .run(NODE, SESSION, OWN_CLAUDE_SESSION);
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

  function report(payload: Record<string, unknown>, env = identity, occurredAt = new Date().toISOString()) {
    const relayed = relay.buildOpenRigPayload(payload, env, () => new Date(occurredAt));
    const result = store.recordHookEvent(relayed as unknown as Parameters<AgentActivityStore["recordHookEvent"]>[0]);
    expect(result.ok).toBe(true);
    return relayed;
  }

  const reportLimit = () => report({ hook_event_name: "StopFailure", error: "rate_limit" });
  const events = async () => (await service.getReadModel()).signals.filter(signal => signal.sourceClass === "provider_event");

  async function displayLimit(input: { hookAge: number; paneAge: number; permission?: boolean; motion?: boolean }, error = "rate_limit") {
    vi.setSystemTime(Date.parse(T0) - input.hookAge);
    report({ hook_event_name: "StopFailure", error });
    vi.setSystemTime(T0);
    return displayActivity(input);
  }

  async function displayActivity(input: { paneAge?: number; permission?: boolean; motion?: boolean } = {}) {
    let clock = new Date(Date.parse(T0) - (input.paneAge ?? 0));
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

  describe("the reset a Claude limit states (#99)", () => {
    const WEEKLY = "You've hit your weekly limit · resets Jan 2, 4pm (America/Sao_Paulo)";
    const reportStated = (text: string, field = "last_assistant_message", sessionId: string | null = OWN_CLAUDE_SESSION) =>
      report({ hook_event_name: "StopFailure", error: "rate_limit", [field]: text, ...(sessionId ? { session_id: sessionId } : {}) });
    const latestResetsAt = () => (store.getLatestForNode({ sessionName: SESSION }) as { resetsAt?: string | null } | null)?.resetsAt;

    it.each([
      // Real messages from a Claude Code 2.1.296 limit, and the older formats.
      [WEEKLY, "2025-01-02T19:00:00.000Z"],
      ["5-hour limit reached ∙ resets 8am (UTC)", "2025-01-02T08:00:00.000Z"],
      ["5-hour limit reached ∙ resets 1:30pm (UTC)", "2025-01-01T13:30:00.000Z"],
      ["rate limit · resets in 2h 30m", "2025-01-01T14:30:00.000Z"],
      ["Claude AI usage limit reached|1735740000", "2025-01-01T14:00:00.000Z"],
    ])("reads %j", (text, expected) => {
      expect(relay.claudeLimitResetAt(text, new Date(T0))).toBe(expected);
    });

    it.each([
      "API Error: Rate limit reached",
      "resets 3",
      "resets 4pm (Not/AZone)",
      "resets 4pm (Not/AZone", // a truncated zone is not the seat's local time
      "resets 4pm ()",
      "resets in 2 months", // not two minutes
      "resets in 2h 30x",
      "resets in 2h, 30x", // a separator doesn't end the fragment
      "resets in 2h and 30x",
      "resets in soon",
      "resets Feb 30, 4pm (UTC)",
      "resets Mar 1, 4pm (UTC)", // more than a week away: not a usage window
      "Claude AI usage limit reached|1735730000", // already past
    ])("states no reset for %j", text => {
      expect(relay.claudeLimitResetAt(text, new Date(T0))).toBeNull();
    });

    it.each([
      // Close to the impossible date, where only a calendar check (not the distance cap) can reject it.
      ["2026-02-28T12:00:00.000Z", "resets Feb 30, 4pm (UTC)", null],
      ["2026-02-28T12:00:00.000Z", "resets Feb 29, 4pm (UTC)", null], // 2026 is not a leap year
      ["2026-02-28T12:00:00.000Z", "resets Mar 2, 4pm (UTC)", "2026-03-02T16:00:00.000Z"],
      ["2028-02-28T12:00:00.000Z", "resets Feb 29, 4pm (UTC)", "2028-02-29T16:00:00.000Z"],
      ["2026-04-29T12:00:00.000Z", "resets Apr 31, 4pm (UTC)", null],
      // A wall time a DST change repeats or skips names no single instant: no reset rather than one a day late.
      ["2025-11-02T05:00:00.000Z", "resets 1:30am (America/New_York)", null], // 1:30 happens twice that night
      ["2025-11-02T05:00:00.000Z", "resets Nov 2, 1:30am (America/New_York)", null],
      ["2025-03-09T06:00:00.000Z", "resets 2:30am (America/New_York)", null], // 2:30 never happens that night
      ["2025-03-09T06:00:00.000Z", "resets 3:30am (America/New_York)", "2025-03-09T07:30:00.000Z"],
      ["2025-11-02T05:00:00.000Z", "resets 3am (America/New_York)", "2025-11-02T08:00:00.000Z"],
    ])("at %s reads %j as %j", (now, text, expected) => {
      expect(relay.claudeLimitResetAt(text, new Date(now))).toBe(expected);
    });

    it("relays only the instant, never the message", () => {
      const payload = reportStated(WEEKLY);
      expect(payload).toMatchObject({ subtype: "rate_limit", resetsAt: "2025-01-02T19:00:00.000Z" });
      expect(JSON.stringify(payload)).not.toContain("weekly");
      expect(reportStated(WEEKLY, "error_details")).toMatchObject({ resetsAt: "2025-01-02T19:00:00.000Z" });
    });

    it.each([
      { hook_event_name: "StopFailure", error: "overloaded", last_assistant_message: WEEKLY },
      { hook_event_name: "Stop", last_assistant_message: WEEKLY },
      { hook_event_name: "Notification", notification_type: "rate_limit", message: WEEKLY },
    ])("reads no reset off another event: %j", payload => {
      expect(report(payload)).not.toHaveProperty("resetsAt");
    });

    it("keeps a stated reset only from the seat's own Claude session, not a helper's", async () => {
      // A helper Claude started from the seat's shell posts as the seat, but under its own session (maybe another login).
      reportStated(WEEKLY, "last_assistant_message", "22222222-2222-4222-8222-222222222222");
      expect(latestResetsAt()).toBeUndefined();
      const model = await service.getReadModel();
      expect(deriveUsageLimitPools({ signals: model.signals, bindings: model.bindings, now: new Date(), fallbackSeconds: 300 }))
        .toEqual([expect.objectContaining({ poolKey: "claude:local", source: "config-fallback",
          expiresAt: new Date(Date.parse(T0) + 300_000).toISOString() })]);

      reportStated(WEEKLY, "last_assistant_message", null);
      expect(latestResetsAt()).toBeUndefined();
      reportStated(WEEKLY);
      expect(latestResetsAt()).toBe("2025-01-02T19:00:00.000Z");
    });

    it("drops a stated reset past the eight-day cap from any sender", async () => {
      const result = store.recordHookEvent({ runtime: "claude-code", sessionName: SESSION, hookEvent: "StopFailure", subtype: "rate_limit",
        occurredAt: T0, generation: GENERATION, sessionId: OWN_CLAUDE_SESSION, resetsAt: "2025-01-10T12:00:00.000Z" });
      expect(result.ok && result.activity.resetsAt).toBe("2025-01-10T12:00:00.000Z");
      expect(await events()).toEqual([expect.not.objectContaining({ resetsAt: expect.anything() })]);
    });

    it("keeps a stated reset only on the typed limit row", () => {
      const result = store.recordHookEvent({ runtime: "claude-code", sessionName: SESSION, hookEvent: "Stop",
        resetsAt: "2025-01-02T19:00:00.000Z", generation: GENERATION, sessionId: OWN_CLAUDE_SESSION });
      expect(result.ok && result.activity).not.toHaveProperty("resetsAt");
    });

    it("parks pending work until the stated reset instead of the bounded retry", async () => {
      reportStated(WEEKLY);
      const model = await service.getReadModel();
      expect(model.signals.filter(signal => signal.sourceClass === "provider_event"))
        .toEqual([expect.objectContaining({ provider: "claude", seatSession: SESSION, resetsAt: "2025-01-02T19:00:00.000Z" })]);
      expect(deriveUsageLimitPools({ signals: model.signals, bindings: model.bindings, now: new Date(), fallbackSeconds: 300 }))
        .toEqual([{ poolKey: "claude:local", provider: "claude", seatSessions: [SESSION], expiresAt: "2025-01-02T19:00:00.000Z", source: "provider-reset" }]);

      queue.attachWatchdogJobsRepository(new WatchdogJobsRepository(db, () => new Date()));
      queue.attachOutbox(new OutboxHandler(db));
      const source = await queue.create({ sourceSession: "sender@limit-fixture", destinationSession: "relay@limit-fixture", body: "work", nudge: false });
      const { created: baton } = await queue.handoff({ qitemId: source.qitemId, fromSession: "relay@limit-fixture", toSession: SESSION, nudge: false });
      db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = 'failed:provider limit' WHERE qitem_id = ?")
        .run(new Date(Date.parse(T0) - 600_000).toISOString(), baton.qitemId);
      const result = await runWakeLadderTick({ db, queueRepo: queue, attemptWake: vi.fn(async () => "typed"), resolveOrchestrator: () => null,
        retryIntervalSeconds: 300, usageLimitJitterSeconds: 0, getProviderReadModel: () => service.getReadModel(), log: () => {} });
      expect(result.actions).toContainEqual({ qitemId: baton.qitemId, action: "park-usage-limit" });
      const blocker = queue.getById(baton.qitemId)!.blockedOn!;
      expect(queue.getParkWakeStatus(blocker)).toMatchObject({ kind: "timer", live: true, expiresAt: "2025-01-02T19:00:00.000Z" });
      expect(queue.transitionLog.listForQitem(blocker).some(row => row.transitionNote?.includes("cause=provider-reset"))).toBe(true);
    });
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

  it.each(["provider", "display"])("ignores an old limit arriving after a newer turn (%s)", async consumer => {
    report({ hook_event_name: "UserPromptSubmit" }, identity, "2025-01-01T11:59:59.000Z");
    report({ hook_event_name: "StopFailure", error: "rate_limit" }, identity, "2025-01-01T11:59:58.000Z");
    if (consumer === "provider") {
      expect(await events()).toEqual([]);
    } else {
      expect(await displayActivity()).toMatchObject({ state: "running", rawEvent: "UserPromptSubmit", stale: false });
    }
  });

  it.each(["provider", "display"])("keeps a new limit when an older Stop arrives later (%s)", async consumer => {
    report({ hook_event_name: "StopFailure", error: "rate_limit" }, identity, "2025-01-01T11:59:59.000Z");
    report({ hook_event_name: "Stop" }, identity, "2025-01-01T11:59:58.000Z");
    if (consumer === "provider") {
      expect(await events()).toEqual([expect.objectContaining({ provider: "claude", seatSession: SESSION, asOf: "2025-01-01T11:59:59.000Z" })]);
    } else {
      expect(await displayActivity()).toMatchObject({ state: "unknown", reason: "usage_limit", rawEvent: "StopFailure", stale: false });
    }
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

  it.each([false, true])("holds another Claude seat's queue only while its windows support one shared account (conflict: %s)", async conflict => {
    const peer = "dev-peer@limit-fixture";
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, pod_id) VALUES ('node-peer', 'rig-limit', 'dev.peer', 'claude-code', 'pod-limit')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('session-peer', 'node-peer', ?, 'running', 'ready')").run(peer);
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES ('binding-peer', 'node-peer', ?)").run(peer);
    claudeSignals = [SESSION, peer].map((seatSession, index) => ({
      provider: "claude", seatSession, sourceClass: "provider_statusline", authority: "account_cross_device",
      window: "five_hour", usedPercent: 40, resetsAt: `2025-01-01T1${conflict ? index + 3 : 3}:00:00.000Z`, asOf: T0,
      staleAfter: "2025-01-01T12:05:00.000Z", automationUse: "allow_switch_decision",
    }));
    reportLimit();
    const usage = (await service.getReadModel()).hostUsage?.find(row => row.provider === "claude");
    expect(usage).toMatchObject(conflict
      ? { state: "explicit_unknown", anomalies: [expect.objectContaining({ kind: "conflicting_seat_windows" })] }
      : { state: "limited", anomalies: [] });

    queue.attachWatchdogJobsRepository(new WatchdogJobsRepository(db, () => new Date()));
    queue.attachOutbox(new OutboxHandler(db));
    const batons = [];
    for (const destination of [SESSION, peer]) {
      const source = await queue.create({ sourceSession: "sender@limit-fixture", destinationSession: "relay@limit-fixture", body: "work", nudge: false });
      const { created } = await queue.handoff({ qitemId: source.qitemId, fromSession: "relay@limit-fixture", toSession: destination, nudge: false });
      db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = 'failed:delivery' WHERE qitem_id = ?")
        .run("2025-01-01T11:50:00.000Z", created.qitemId);
      batons.push(created);
    }
    const attemptWake = vi.fn(async () => "typed");
    const result = await runWakeLadderTick({ db, queueRepo: queue, attemptWake, resolveOrchestrator: () => null,
      retryIntervalSeconds: 300, usageLimitJitterSeconds: 0, getProviderReadModel: () => service.getReadModel(), log: () => {} });
    expect(result.actions).toContainEqual({ qitemId: batons[0]!.qitemId, action: "park-usage-limit" });
    expect(queue.getById(batons[0]!.qitemId)?.state).toBe("blocked");
    if (conflict) {
      expect(result.actions).toContainEqual({ qitemId: batons[1]!.qitemId, action: "retry", target: peer });
      expect(queue.getById(batons[1]!.qitemId)?.state).toBe("pending");
      expect(attemptWake).toHaveBeenCalledTimes(1);
      expect(attemptWake).toHaveBeenCalledWith(batons[1]!.qitemId, peer);
    } else {
      expect(result.actions).toContainEqual({ qitemId: batons[1]!.qitemId, action: "park-usage-limit" });
      expect(queue.getById(batons[1]!.qitemId)?.blockedOn).toBe(queue.getById(batons[0]!.qitemId)?.blockedOn);
      expect(attemptWake).not.toHaveBeenCalled();
    }
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

  describe("other StopFailure errors keep a typed reason (#3571)", () => {
    const seat = { rigId: "rig-limit", rigName: "limit-fixture", nodeId: NODE, logicalId: "dev.worker", canonicalSessionName: SESSION,
      runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", lifecycleState: "running", latestError: null,
      heldReason: null } as unknown as Parameters<typeof seatNeedsAttention>[0];
    const latest = () => store.getLatestForNode({ sessionName: SESSION, order: "source" });

    it.each([
      ["authentication_failed", "provider_auth_error"],
      ["oauth_org_not_allowed", "provider_auth_error"],
      ["cloud_credential_error", "provider_auth_error"],
      ["billing_error", "provider_billing_error"],
      ["account_on_hold", "provider_billing_error"],
      ["invalid_request", "provider_error"],
      ["model_not_found", "provider_error"],
      ["server_error", "provider_error"],
      ["max_output_tokens", "provider_error"],
      ["unknown", "provider_error"],
      // Not in Claude Code's documented values: generic, never auth or billing.
      ["overloaded", "provider_error"],
      ["verification_required", "provider_error"],
      ["authentication_failed_v2", "provider_error"],
    ])("%s reads %s with its raw value, as an interruption and not exhaustion", async (error, reason) => {
      report({ hook_event_name: "StopFailure", error });
      expect(latest()).toMatchObject({ state: "unknown", reason, rawEvent: "StopFailure", rawSubtype: error, evidence: error, stale: false });
      expect(await events()).toEqual([]);
    });

    it("keeps rate_limit the usage limit, and another runtime's claim on the seat unmapped", () => {
      reportLimit();
      expect(latest()).toMatchObject({ reason: "usage_limit" });
      vi.setSystemTime(Date.parse(T0) + 1000);
      expect(store.recordHookEvent({ sessionName: SESSION, runtime: "codex", hookEvent: "StopFailure", subtype: "authentication_failed",
        generation: GENERATION } as Parameters<AgentActivityStore["recordHookEvent"]>[0]).ok).toBe(true);
      expect(latest()).toMatchObject({ state: "unknown", reason: "unmapped_runtime_hook", runtime: "codex", rawSubtype: "authentication_failed" });
      expect(seatNeedsAttention(seat, latest(), false)).toBe(false);
    });

    it.each([
      ["authentication_failed", "provider_auth_error"],
      ["account_on_hold", "provider_billing_error"],
    ])("serves a fresh %s over the cached idle pane and counts it toward attention, without asking for input", async (error, reason) => {
      for (const motion of [false, true]) {
        const served = await displayLimit({ hookAge: 1000, paneAge: 0, motion }, error);
        expect(served).toMatchObject({ state: "unknown", reason, rawSubtype: error, evidenceSource: "runtime_hook", stale: false });
        // An arbitrated "no question" doesn't cancel it: it is attention, not a request for input.
        expect(seatNeedsAttention(seat, served!, false)).toBe(true);
        expect(latestHookWaitsOnPerson(latest(), "claude-code")).toBe(false);
      }
    });

    it.each(["server_error", "overloaded", "verification_required", "authentication_failed_v2"])(
      "leaves a generic %s to the pane reading and out of attention", async error => {
        const served = await displayLimit({ hookAge: 1000, paneAge: 0 }, error);
        expect(served).toMatchObject({ state: "idle", reason: "idle_prompt", evidenceSource: "pane_heuristic" });
        expect(seatNeedsAttention(seat, latest(), null)).toBe(false);
      });

    it("keeps a fresh failure over a permission prompt the pane saw before it", async () => {
      const served = await displayLimit({ hookAge: 1000, paneAge: 2000, permission: true }, "authentication_failed");
      expect(served).toMatchObject({ state: "unknown", reason: "provider_auth_error", evidenceSource: "runtime_hook" });
    });

    it("keeps the failure over a prompt whose capture began before it, though the capture completed after", async () => {
      vi.setSystemTime(Date.parse(T0) - 1000);
      report({ hook_event_name: "StopFailure", error: "authentication_failed" });
      vi.setSystemTime(T0);
      let clock = new Date(Date.parse(T0) - 2000);
      const capturePaneContent = vi.fn(async () => { clock = new Date(T0); return "Do you want to proceed?"; });
      const structural = new SeatStructuralActivityService({ capturePaneContent }, () => clock);
      const observed = await structural.pollSeat(SESSION, null, "claude-code");
      expect(observed).toMatchObject({ state: "attention", captureStartedAt: new Date(Date.parse(T0) - 2000).toISOString(), observedAt: T0 });
      const [entry] = await attachAgentActivity([{
        canonicalSessionName: SESSION, runtime: "claude-code", attachmentType: "tmux", logicalId: "dev.worker",
      }] as Parameters<typeof attachAgentActivity>[0], { tmuxAdapter: { capturePaneContent } as never, activityStore: store,
        structuralActivity: structural, now: new Date(T0) });
      expect(entry!.agentActivity).toMatchObject({ state: "unknown", reason: "provider_auth_error", evidenceSource: "runtime_hook" });
    });

    it("retains the failure past Claude's idle notification, with its original time", async () => {
      report({ hook_event_name: "StopFailure", error: "billing_error" }, identity, "2025-01-01T11:58:00.000Z");
      report({ hook_event_name: "Notification", notification_type: "idle_prompt" }, identity, "2025-01-01T11:59:00.000Z");
      expect(latest()).toMatchObject({ state: "idle", rawEvent: "Notification" });
      const served = await displayActivity();
      expect(served).toMatchObject({ state: "unknown", reason: "provider_billing_error", rawSubtype: "billing_error",
        eventAt: "2025-01-01T11:58:00.000Z", stale: false, evidenceSource: "runtime_hook" });
      expect(seatNeedsAttention(seat, served!, null)).toBe(true);
      expect(latestHookWaitsOnPerson(latest(), "claude-code")).toBe(false);
    });

    it("retains the failure past the five-minute window, without lifting hook freshness for anything else", async () => {
      const hookAge = AGENT_ACTIVITY_FRESHNESS_MS + 60_000;
      const served = await displayLimit({ hookAge, paneAge: 0 }, "authentication_failed");
      expect(served).toMatchObject({ state: "unknown", reason: "provider_auth_error", stale: false,
        eventAt: new Date(Date.parse(T0) - hookAge).toISOString() });
      expect(seatNeedsAttention(seat, served!, null)).toBe(true);
      expect(latest()).toMatchObject({ state: "unknown", reason: "stale_runtime_hook", stale: true });
    });

    it("is superseded by a newer turn, which doesn't certify a repair", async () => {
      report({ hook_event_name: "StopFailure", error: "authentication_failed" }, identity, "2025-01-01T11:50:00.000Z");
      report({ hook_event_name: "UserPromptSubmit" }, identity, "2025-01-01T11:55:00.000Z");
      report({ hook_event_name: "Stop" }, identity, "2025-01-01T11:56:00.000Z");
      report({ hook_event_name: "Notification", notification_type: "idle_prompt" }, identity, "2025-01-01T11:57:00.000Z");
      const served = await displayActivity();
      expect(served?.reason).not.toMatch(/^provider_/);
      expect(seatNeedsAttention(seat, served!, null)).toBe(false);
    });

    it.each([
      { name: "a Stop", hook: { hook_event_name: "Stop" }, expected: { reason: "idle_prompt" } },
      { name: "a tool batch", hook: { hook_event_name: "PostToolBatch" }, expected: { reason: "idle_prompt" } },
      // Claude sends StopFailure instead of Stop: a newer one ends its own turn, and a newer limit shows as the limit.
      { name: "a newer rate limit", hook: { hook_event_name: "StopFailure", error: "rate_limit" }, expected: { reason: "usage_limit" }, idle: false },
      { name: "a newer generic error", hook: { hook_event_name: "StopFailure", error: "server_error" }, expected: { reason: "idle_prompt" } },
    ])("is superseded by $name from a newer turn whose prompt wasn't recorded", async ({ hook, expected, idle = true }) => {
      report({ hook_event_name: "StopFailure", error: "authentication_failed" }, identity, "2025-01-01T11:59:57.000Z");
      report(hook, identity, "2025-01-01T11:59:58.000Z");
      if (idle) report({ hook_event_name: "Notification", notification_type: "idle_prompt" }, identity, "2025-01-01T11:59:59.000Z");
      expect(store.latestUnsupersededProviderFailure({ sessionName: SESSION })).toBeNull();
      const served = await displayActivity();
      expect(served).toMatchObject(expected);
      if (expected.reason !== "usage_limit") expect(seatNeedsAttention(seat, served!, null)).toBe(false);
    });

    it("is superseded by a newer question to a person", async () => {
      report({ hook_event_name: "StopFailure", error: "billing_error" }, identity, "2025-01-01T11:59:57.000Z");
      report({ hook_event_name: "PermissionRequest", tool_name: "Bash" }, identity, "2025-01-01T11:59:58.000Z");
      report({ hook_event_name: "Notification", notification_type: "idle_prompt" }, identity, "2025-01-01T11:59:59.000Z");
      expect(store.latestUnsupersededProviderFailure({ sessionName: SESSION })).toBeNull();
      expect((await displayActivity())?.reason).not.toMatch(/^provider_/);
    });

    it("counts on a row that serves no pane reading, as the rig count does", () => {
      report({ hook_event_name: "StopFailure", error: "authentication_failed" }, identity, "2025-01-01T11:50:00.000Z");
      report({ hook_event_name: "Notification", notification_type: "idle_prompt" }, identity, "2025-01-01T11:51:00.000Z");
      const [row] = attachTerminalActivityAndWork([{ ...seat, agentActivity: null }] as Parameters<typeof attachTerminalActivityAndWork>[0],
        { db, agentActivity: store, now: new Date(T0) });
      expect(row!.needsAttention).toBe(true);
    });

    it("is superseded by a new occupant", async () => {
      report({ hook_event_name: "StopFailure", error: "billing_error" }, identity, "2025-01-01T11:58:00.000Z");
      liveGeneration = "generation-replacement";
      report({ hook_event_name: "SessionStart" }, { ...identity, OPENRIG_OCCUPANT_GENERATION: "generation-replacement" },
        "2025-01-01T11:59:00.000Z");
      const served = await displayActivity();
      expect(served?.reason).not.toMatch(/^provider_/);
      expect(seatNeedsAttention(seat, served!, null)).toBe(false);
    });

    it("keeps a newer failure when an older turn arrives after it", async () => {
      report({ hook_event_name: "StopFailure", error: "authentication_failed" }, identity, "2025-01-01T11:59:59.000Z");
      report({ hook_event_name: "UserPromptSubmit" }, identity, "2025-01-01T11:59:58.000Z");
      expect(await displayActivity()).toMatchObject({ state: "unknown", reason: "provider_auth_error",
        eventAt: "2025-01-01T11:59:59.000Z" });
    });

    it.each([
      { name: "newer permission", hookAge: 2000, paneAge: 1000, permission: true, expected: "permission_prompt" },
      { name: "replaced occupant", hookAge: 1000, paneAge: 0, expected: "idle_prompt" },
      { name: "unknown occupant", hookAge: 1000, paneAge: 0, expected: "idle_prompt" },
    ])("keeps the display's chronology and identity guards: $name", async input => {
      if (input.name === "replaced occupant") liveGeneration = "generation-replacement";
      if (input.name === "unknown occupant") liveGeneration = null;
      const served = await displayLimit(input, "billing_error");
      expect(served).toMatchObject({ reason: input.expected, evidenceSource: "pane_heuristic" });
      if (input.expected === "idle_prompt") expect(seatNeedsAttention(seat, latest(), null)).toBe(false);
    });

    it("ends with a newer turn that arrives before the older failure", async () => {
      report({ hook_event_name: "UserPromptSubmit" }, identity, "2025-01-01T11:59:59.000Z");
      report({ hook_event_name: "StopFailure", error: "authentication_failed" }, identity, "2025-01-01T11:59:58.000Z");
      expect(await displayActivity()).toMatchObject({ state: "running", rawEvent: "UserPromptSubmit" });
      expect(seatNeedsAttention(seat, latest(), null)).toBe(false);
    });

    it("holds no wake: the readers of hookOrPaneActivity keep the pane's reading", async () => {
      report({ hook_event_name: "StopFailure", error: "authentication_failed" });
      const capturePaneContent = vi.fn(async () => "output\n❯ ");
      const structural = new SeatStructuralActivityService({ capturePaneContent }, () => new Date(T0));
      await structural.pollSeat(SESSION, null, "claude-code");
      expect(hookOrPaneActivity(latest(), structural.getStructuralActivity(SESSION), false, "claude-code"))
        .toMatchObject({ source: "pane", activity: { state: "idle" } });
    });
  });
});
