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
import { contextUsageWatchdogUnitsSchema } from "../src/db/migrations/102_context_usage_watchdog_units.js";
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
    });
  }

  function register(input: { thresholdTokens?: number; thresholdPercent?: number } = {}) {
    return repo.register({
      policy: "context-usage-threshold",
      specYaml:
        `policy: context-usage-threshold\ntarget:\n  session: target@rig\n` +
        `message: Hand over at the planned context level.\n`,
      targetSession: "target@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
      thresholdTokens: input.thresholdTokens ?? null,
      thresholdPercent: input.thresholdPercent ?? null,
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

  it("skips loudly on a stale sample instead of firing on a frozen reading", async () => {
    sample = { ...FRESH_SAMPLE, fresh: false };
    const job = register({ thresholdTokens: 1 });
    const outcome = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(outcome.outcome.action).toBe("skip");
    if (outcome.outcome.action === "skip") {
      expect(outcome.outcome.reason).toBe("context_sample_stale");
    }
    expect(deliveries).toHaveLength(0);
  });

  it("skips loudly when no sample is available for the seat", async () => {
    sample = null;
    const job = register({ thresholdPercent: 1 });
    const outcome = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(outcome.outcome.action).toBe("skip");
    if (outcome.outcome.action === "skip") {
      expect(outcome.outcome.reason).toBe("context_sample_unavailable");
    }
  });

  it("skips loudly on a token threshold when the seat's window size is unknown", async () => {
    sample = { ...FRESH_SAMPLE, contextWindowSize: null, usedTokens: null };
    const job = register({ thresholdTokens: 1 });
    const outcome = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(outcome.outcome.action).toBe("skip");
    if (outcome.outcome.action === "skip") {
      expect(outcome.outcome.reason).toBe("context_window_unknown");
    }
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
