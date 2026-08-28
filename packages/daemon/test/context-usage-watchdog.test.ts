import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { contextUsageSchema } from "../src/db/migrations/018_context_usage.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { contextUsageWatchdogSchema } from "../src/db/migrations/074_context_usage_watchdog.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";
import { watchdogRoutes } from "../src/routes/watchdog.js";

describe("context-usage-threshold watchdog", () => {
  let db: Database.Database;
  let repo: WatchdogJobsRepository;
  let history: WatchdogHistoryLog;
  let bus: EventBus;
  let tmp: string;
  let transcript: string;
  let generation: string;
  let deliveries: Array<{ targetSession: string; message: string }>;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      watchdogJobsSchema,
      watchdogHistorySchema,
      contextUsageWatchdogSchema,
    ]);
    repo = new WatchdogJobsRepository(db);
    history = new WatchdogHistoryLog(db);
    bus = new EventBus(db);
    tmp = join(tmpdir(), `context-watchdog-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
    transcript = join(tmp, "session.jsonl");
    writeFileSync(transcript, "1234");
    generation = "gen-1";
    deliveries = [];
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
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
    });
  }

  function register(input: {
    targetSession?: string;
    watchedFilePath?: string;
    thresholdBytes?: number;
    requiresJobId?: string | null;
    specTarget?: string;
  } = {}) {
    const targetSession = input.targetSession ?? "target@rig";
    const specTarget = input.specTarget ?? targetSession;
    return repo.register({
      policy: "context-usage-threshold",
      specYaml:
        `policy: context-usage-threshold\n` +
        `target:\n  session: ${specTarget}\n` +
        `message: Context threshold crossed; prepare continuity now.\n`,
      targetSession,
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
      watchedFilePath: input.watchedFilePath ?? transcript,
      thresholdBytes: input.thresholdBytes ?? 8,
      requiresJobId: input.requiresJobId ?? null,
    });
  }

  it("keeps the wrong seat silent, fires once with reason, and survives an engine restart", async () => {
    const job = register({ specTarget: "wrong-seat@rig" });

    const below = await engine().evaluate(job);
    expect(below.outcome).toMatchObject({ action: "skip", reason: "context_usage_below_threshold" });
    expect(deliveries).toEqual([]);

    writeFileSync(transcript, "1234567890");
    const fired = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(fired.outcome.action).toBe("send");
    expect(deliveries).toEqual([{
      targetSession: "target@rig",
      message: "Context threshold crossed; prepare continuity now.",
    }]);
    expect(history.listForJob(job.jobId)[0]?.evaluationNotes).toMatchObject({
      reason: expect.stringContaining("10 transcript bytes crossed the 8-byte threshold"),
      observedBytes: 10,
      thresholdBytes: 8,
      occupantGeneration: "gen-1",
    });

    const repeat = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(repeat.outcome).toMatchObject({ action: "skip", reason: "threshold_already_fired" });
    expect(deliveries).toHaveLength(1);
    expect(repo.getByIdOrThrow(job.jobId).lastFiredGeneration).toBe("gen-1");
  });

  it("a new occupant generation resets eligibility exactly once", async () => {
    writeFileSync(transcript, "1234567890");
    const job = register();
    await engine().evaluate(job);
    generation = "gen-2";
    await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(deliveries).toHaveLength(2);
    expect(repo.getByIdOrThrow(job.jobId).lastFiredGeneration).toBe("gen-2");
  });

  it("requires an earlier job receipt for the same occupant generation", async () => {
    writeFileSync(transcript, "1234567890");
    const prepare = register();
    const cutover = register({ requiresJobId: prepare.jobId });

    const blocked = await engine().evaluate(cutover);
    expect(blocked.outcome).toMatchObject({
      action: "skip",
      reason: "required_watchdog_receipt_missing",
    });
    expect(history.listForJob(cutover.jobId)[0]).toMatchObject({
      outcome: "skipped",
      skipReason: "required_watchdog_receipt_missing",
      evaluationNotes: expect.objectContaining({ requiresJobId: prepare.jobId }),
    });

    await engine().evaluate(prepare);
    await engine().evaluate(repo.getByIdOrThrow(cutover.jobId));
    expect(deliveries.map((delivery) => delivery.targetSession)).toEqual(["target@rig", "target@rig"]);
  });

  it("advances only one requires rung per scheduler evaluation pass", async () => {
    writeFileSync(transcript, "1234567890");
    let clockMs = Date.parse("2026-08-28T09:50:00.000Z");
    const now = () => new Date(clockMs++);
    repo = new WatchdogJobsRepository(db, now);
    const prepare = register();
    const cutover = register({ requiresJobId: prepare.jobId });
    const passEngine = new WatchdogPolicyEngine({
      jobsRepo: repo,
      historyLog: history,
      eventBus: bus,
      deliver: async (request) => {
        deliveries.push(request);
        return { status: "ok" as const };
      },
      resolveTargetGeneration: () => generation,
      now,
    });
    const scheduler = new WatchdogScheduler({
      jobsRepo: repo,
      policyEngine: passEngine,
      now,
    });

    await scheduler.runTickNow();
    expect(deliveries).toHaveLength(1);
    expect(history.listForJob(cutover.jobId)[0]).toMatchObject({
      outcome: "skipped",
      skipReason: "required_watchdog_receipt_not_yet_eligible",
    });

    clockMs += 60_000;
    await scheduler.runTickNow();
    expect(deliveries).toHaveLength(2);
    expect(repo.getByIdOrThrow(cutover.jobId).lastFiredGeneration).toBe("gen-1");
  });

  it("a missing watched file is terminal and loud in status history", async () => {
    const missing = join(tmp, "missing.jsonl");
    const job = register({ watchedFilePath: missing });
    const result = await engine().evaluate(job);
    expect(result.outcome).toMatchObject({ action: "terminal", reason: "watched_file_unresolved" });
    expect(repo.getByIdOrThrow(job.jobId)).toMatchObject({
      state: "terminal",
      terminalReason: "watched_file_unresolved",
    });
    expect(history.listForJob(job.jobId)[0]).toMatchObject({
      outcome: "terminal",
      skipReason: "watched_file_unresolved",
      evaluationNotes: expect.objectContaining({ watchedFilePath: missing }),
    });
  });

  it("shrinking a transcript never clears the generation receipt", async () => {
    writeFileSync(transcript, "1234567890");
    const job = register();
    await engine().evaluate(job);
    writeFileSync(transcript, "1");
    const shrunk = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(shrunk.outcome).toMatchObject({ action: "skip", reason: "threshold_already_fired" });
    expect(deliveries).toHaveLength(1);
    expect(history.listForJob(job.jobId).some((entry) => entry.skipReason === "threshold_already_fired")).toBe(true);
  });
});

describe("context-usage-threshold registration", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      contextUsageSchema,
      watchdogJobsSchema,
      watchdogHistorySchema,
      contextUsageWatchdogSchema,
    ]);
    tmp = join(tmpdir(), `context-watchdog-route-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function app() {
    const jobsRepo = new WatchdogJobsRepository(db);
    const eventBus = new EventBus(db);
    const historyLog = new WatchdogHistoryLog(db);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, eventBus);
      c.set("watchdogJobsRepo" as never, jobsRepo);
      c.set("watchdogHistoryLog" as never, historyLog);
      await next();
    });
    app.route("/api/watchdog", watchdogRoutes());
    return app;
  }

  function body(overrides: Record<string, unknown> = {}) {
    return {
      policy: "context-usage-threshold",
      specYaml: "policy: context-usage-threshold\n",
      targetSession: "target@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
      thresholdBytes: 8,
      ...overrides,
    };
  }

  it("derives a transcript path from recorded context usage", async () => {
    const derived = join(tmp, "derived.jsonl");
    writeFileSync(derived, "1234");
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-1', 'rig-1', 'target')").run();
    db.prepare(
      "INSERT INTO context_usage (node_id, session_name, availability, transcript_path) VALUES ('node-1', 'target@rig', 'known', ?)",
    ).run(derived);

    const response = await app().request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ watchedFilePath: derived, thresholdBytes: 8 });
  });

  it("an explicit watched file wins over the derived path", async () => {
    const derived = join(tmp, "derived.jsonl");
    const explicit = join(tmp, "explicit.jsonl");
    writeFileSync(derived, "1234");
    writeFileSync(explicit, "1234");
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-1', 'rig-1', 'target')").run();
    db.prepare(
      "INSERT INTO context_usage (node_id, session_name, availability, transcript_path) VALUES ('node-1', 'target@rig', 'known', ?)",
    ).run(derived);

    const response = await app().request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body({ watchedFilePath: explicit })),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ watchedFilePath: explicit });
  });

  it("fails registration loudly when neither resolution path exists", async () => {
    const response = await app().request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "watched_file_unresolved" });
  });
});
