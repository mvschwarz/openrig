import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { contextUsageSchema } from "../src/db/migrations/018_context_usage.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { occupantTenuresSchema } from "../src/db/migrations/060_occupant_tenures.js";
import { contextUsageWatchdogSchema } from "../src/db/migrations/074_context_usage_watchdog.js";
import { contextUsageWatchdogGenerationSchema } from "../src/db/migrations/075_context_usage_watchdog_generation.js";
import { idleGateFiredConditionSchema } from "../src/db/migrations/078_idle_gate_fired_condition.js";
import { contextUsageWatchdogUnitsSchema } from "../src/db/migrations/124_context_usage_watchdog_units.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

/** Issue #1180 — per-watchdog token / percent-of-window thresholds. */

const FRESH_SAMPLE = {
  usedPercentage: 50,
  contextWindowSize: 1_000_000,
  usedTokens: 500_000,
  sampledAt: "2026-08-28T09:30:00.000Z",
  fresh: true,
};

describe("context-usage-threshold token/percent units", () => {
  let db: Database.Database;
  let repo: WatchdogJobsRepository;
  let history: WatchdogHistoryLog;
  let bus: EventBus;
  let generation: string;
  let sample: typeof FRESH_SAMPLE | null;
  let deliveries: Array<{ targetSession: string; message: string }>;
  let clock: Date;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      contextUsageSchema,
      watchdogJobsSchema,
      watchdogHistorySchema,
      occupantTenuresSchema,
      contextUsageWatchdogSchema,
      contextUsageWatchdogGenerationSchema,
      idleGateFiredConditionSchema,
      contextUsageWatchdogUnitsSchema,
    ]);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-1', 'rig-1', 'target')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('session-1', 'node-1', 'target@rig')").run();
    db.prepare(
      `INSERT INTO occupant_tenures
        (id, node_id, generation_ordinal, generation_uuid, kind, boot_at)
       VALUES ('tenure-1', 'node-1', 1, 'gen-1', 'initial', '2026-08-28T09:00:00.000Z')`,
    ).run();
    repo = new WatchdogJobsRepository(db, undefined, () => generation);
    history = new WatchdogHistoryLog(db);
    bus = new EventBus(db);
    generation = "gen-1";
    sample = { ...FRESH_SAMPLE };
    deliveries = [];
    clock = new Date("2026-08-28T09:31:00.000Z");
  });

  afterEach(() => {
    db.close();
  });

  function engine() {
    return new WatchdogPolicyEngine({
      jobsRepo: repo,
      historyLog: history,
      eventBus: bus,
      deliver: async (request) => {
        deliveries.push(request);
        return { status: "ok" as const };
      },
      resolveTargetGeneration: () => generation,
      resolveContextUsage: () => sample,
      now: () => clock,
    });
  }

  function register(input: { thresholdTokens?: number; thresholdPercent?: number; activeWakeIntervalSeconds?: number } = {}, extraSpec = "") {
    return repo.register({
      policy: "context-usage-threshold",
      specYaml:
        `policy: context-usage-threshold\ntarget:\n  session: target@rig\n` +
        `message: Hand over at the planned context level.\n` + extraSpec,
      targetSession: "target@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
      thresholdTokens: input.thresholdTokens ?? null,
      thresholdPercent: input.thresholdPercent ?? null,
      activeWakeIntervalSeconds: input.activeWakeIntervalSeconds ?? null,
    });
  }

  it("fires once when the sampled token estimate crosses the token threshold", async () => {
    const job = register({ thresholdTokens: 400_000 });
    const outcome = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(outcome.outcome.action).toBe("send");
    expect(deliveries).toHaveLength(1);
    // Receipt carries the observed sample time alongside value + generation.
    expect(outcome.outcome).toMatchObject({
      notes: { sampledAt: FRESH_SAMPLE.sampledAt, observedTokens: 500_000 },
    });
    const second = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(second.outcome.action).toBe("skip");
    expect(deliveries).toHaveLength(1);
  });

  it("stays below the token threshold while usage is lower", async () => {
    const job = register({ thresholdTokens: 600_000 });
    const outcome = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(outcome.outcome.action).toBe("skip");
    expect(deliveries).toHaveLength(0);
  });

  it("fires on a percent-of-window threshold from the seat's reported percentage", async () => {
    const job = register({ thresholdPercent: 45 });
    const outcome = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(outcome.outcome.action).toBe("send");
    expect(deliveries).toHaveLength(1);
  });

  it.each([
    { name: "no sample", reading: () => null, units: { thresholdPercent: 1 }, reason: "context_sample_unavailable" },
    { name: "a stale sample", reading: () => ({ ...FRESH_SAMPLE, fresh: false }), units: { thresholdTokens: 1 }, reason: "context_sample_stale" },
    { name: "no token count", reading: () => ({ ...FRESH_SAMPLE, contextWindowSize: null, usedTokens: null }), units: { thresholdTokens: 1 }, reason: "context_window_unknown" },
  ])("tells the target once that it can't read its sample ($name), and fires nothing", async ({ reading, units, reason }) => {
    sample = reading();
    const job = register(units);
    const first = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(first.outcome).toMatchObject({ action: "send", notes: { unreadable: reason } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.targetSession).toBe("target@rig");
    expect(deliveries[0]!.message).toContain("can't read");
    expect(repo.getByIdOrThrow(job.jobId).lastFiredGeneration).toBeNull();
    const again = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(again).toMatchObject({ history: null, meaningful: false });
    expect(deliveries).toHaveLength(1);
  });

  it("after that notice, a fresh sample still fires the threshold, and only the threshold runs the continuity action", async () => {
    sample = { ...FRESH_SAMPLE, fresh: false };
    const job = register({ thresholdTokens: 400_000 },
      "context:\n  continuity_action:\n    type: create-cutover-baton\n    destination: next@rig\n    body: Take over.\n");
    await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).not.toHaveProperty("continuityAction");
    sample = { ...FRESH_SAMPLE };
    const fired = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(fired.outcome).toMatchObject({ action: "send", message: "Hand over at the planned context level." });
    expect(deliveries[1]).toMatchObject({ continuityAction: { type: "create-cutover-baton", destination: "next@rig" } });
  });

  it("a notice doesn't hold back the threshold's own fire during the active-wake interval", async () => {
    sample = { ...FRESH_SAMPLE, fresh: false };
    const job = register({ thresholdTokens: 400_000, activeWakeIntervalSeconds: 3600 });
    await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(deliveries).toHaveLength(1);
    clock = new Date(clock.getTime() + 60_000);
    sample = { ...FRESH_SAMPLE };
    const fired = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(fired.outcome).toMatchObject({ action: "send", message: "Hand over at the planned context level." });
    expect(deliveries).toHaveLength(2);
  });

  it("tells the target about each reason once per occupant, even when the reasons alternate", async () => {
    const noTokens = { ...FRESH_SAMPLE, contextWindowSize: null, usedTokens: null };
    const stale = { ...FRESH_SAMPLE, fresh: false };
    const job = register({ thresholdTokens: 1 });
    for (const reading of [noTokens, stale, noTokens, stale]) {
      sample = reading;
      await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    }
    expect(deliveries).toHaveLength(2);
  });

  it("registers token/percent jobs without a transcript and persists the units", () => {
    const tokenJob = register({ thresholdTokens: 250_000 });
    expect(tokenJob.thresholdTokens).toBe(250_000);
    expect(tokenJob.thresholdBytes).toBeNull();
    const percentJob = register({ thresholdPercent: 70 });
    expect(percentJob.thresholdPercent).toBe(70);
    expect(percentJob.watchedFilePath).toBeNull();
  });

  it("rejects a job with no threshold units", () => {
    expect(() => register({})).toThrow();
  });
});
