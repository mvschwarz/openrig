import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
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
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { createContinuityCutoverBaton } from "../src/domain/continuity-policy-materializer.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";
import { watchdogRoutes } from "../src/routes/watchdog.js";
import { resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

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
      bindingsSessionsSchema,
      eventsSchema,
      contextUsageSchema,
      watchdogJobsSchema,
      watchdogHistorySchema,
      occupantTenuresSchema,
      contextUsageWatchdogSchema,
      contextUsageWatchdogGenerationSchema,
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

  it("registers a generated birth-race as pending, then binds visibly with a durable receipt", async () => {
    const job = repo.register({
      policy: "context-usage-threshold",
      specYaml:
        "policy: context-usage-threshold\n" +
        "generated_by: continuity-policy-materializer\n" +
        "continuity_mode: managed-compaction\n" +
        "target:\n  session: target@rig\n" +
        "message: Deposit continuity context before managed compaction.\n",
      targetSession: "target@rig",
      intervalSeconds: 60,
      registeredBySession: "daemon@kernel",
      watchedFilePath: null,
      thresholdBytes: 8,
    });

    expect(job).toMatchObject({
      state: "active",
      watchedFilePath: null,
      watchedFileGeneration: null,
      bindingState: "pending-binding",
    });

    const pending = await engine().evaluate(job);
    expect(pending.outcome).toMatchObject({
      action: "skip",
      reason: "current_generation_transcript_pending",
    });

    db.prepare(
      `INSERT INTO context_usage
        (node_id, session_id, session_name, availability, transcript_path, sampled_at)
       VALUES ('node-1', 'native-session-1', 'target@rig', 'known', ?, '2026-08-28T09:00:01.000Z')`,
    ).run(transcript);

    repo = new WatchdogJobsRepository(db, undefined, () => generation);
    const bound = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(bound.outcome).toMatchObject({
      action: "skip",
      reason: "context_usage_below_threshold",
    });
    expect(repo.getByIdOrThrow(job.jobId)).toMatchObject({
      watchedFilePath: transcript,
      watchedFileGeneration: "gen-1",
      bindingState: "bound",
    });
    expect(history.listForJob(job.jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outcome: "skipped",
        skipReason: "watched_file_bound",
        evaluationNotes: expect.objectContaining({
          boundAt: expect.any(String),
          occupantGeneration: "gen-1",
          watchedFilePath: transcript,
        }),
      }),
    ]));
  });

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

  it("threads a cutover action through the real threshold fire with the target occupant generation", async () => {
    writeFileSync(transcript, "1234567890");
    const job = repo.register({
      policy: "context-usage-threshold",
      specYaml:
        "policy: context-usage-threshold\n" +
        "generated_by: continuity-policy-materializer\n" +
        "continuity_mode: apprentice-handover\n" +
        "target:\n  session: target@rig\n" +
        "message: Cut over now.\n" +
        "context:\n" +
        "  continuity_action:\n" +
        "    type: create-cutover-baton\n" +
        "    destination: mechanic@kernel\n" +
        "    body: Owned cutover baton with one-active-walker and authority-effective-at-effect-receipt.\n",
      targetSession: "target@rig",
      intervalSeconds: 60,
      registeredBySession: "daemon@kernel",
      watchedFilePath: transcript,
      thresholdBytes: 8,
    });

    await engine().evaluate(job);

    expect(deliveries).toEqual([expect.objectContaining({
      targetSession: "target@rig",
      message: "Cut over now.",
      continuityAction: {
        type: "create-cutover-baton",
        jobId: job.jobId,
        occupantGeneration: "gen-1",
        sourceSession: "target@rig",
        destination: "mechanic@kernel",
        body: expect.stringContaining("one-active-walker"),
      },
    })]);
  });

  it("retries a refused structured cutover until one durable baton exists, then stamps the generation", async () => {
    migrate(db, ALL_MIGRATIONS);
    writeFileSync(transcript, "1234567890");
    let destinationExists = false;
    const queue = new QueueRepository(db, bus, {
      validateRig: (sessionRef) => sessionRef === "mechanic@missing-rig" && destinationExists,
    });
    const job = repo.register({
      policy: "context-usage-threshold",
      specYaml:
        "policy: context-usage-threshold\n" +
        "generated_by: continuity-policy-materializer\n" +
        "continuity_mode: apprentice-handover\n" +
        "target:\n  session: target@rig\n" +
        "message: Cut over now.\n" +
        "context:\n" +
        "  continuity_action:\n" +
        "    type: create-cutover-baton\n" +
        "    destination: mechanic@missing-rig\n" +
        "    body: Owned cutover baton with one-active-walker and authority-effective-at-effect-receipt.\n",
      targetSession: "target@rig",
      intervalSeconds: 60,
      registeredBySession: "daemon@kernel",
      watchedFilePath: transcript,
      thresholdBytes: 8,
    });
    const retryEngine = new WatchdogPolicyEngine({
      jobsRepo: repo,
      historyLog: history,
      eventBus: bus,
      deliver: async (request) => {
        let continuityActionCompleted = false;
        try {
          if (request.continuityAction) {
            await createContinuityCutoverBaton(request.continuityAction, queue);
            continuityActionCompleted = true;
          }
          return {
            status: "failed" as const,
            error: "terminal send failed after durable baton creation",
            continuityActionCompleted,
          };
        } catch (error) {
          return {
            status: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
            continuityActionCompleted,
          };
        }
      },
      resolveTargetGeneration: () => generation,
    });

    const first = await retryEngine.evaluate(job);
    expect(first.delivery).toMatchObject({
      status: "failed",
      continuityActionCompleted: false,
    });
    expect(repo.getByIdOrThrow(job.jobId).lastFiredGeneration).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n).toBe(0);

    destinationExists = true;
    const second = await retryEngine.evaluate(repo.getByIdOrThrow(job.jobId));
    expect(second.delivery).toMatchObject({
      status: "failed",
      error: "terminal send failed after durable baton creation",
      continuityActionCompleted: true,
    });
    expect(repo.getByIdOrThrow(job.jobId).lastFiredGeneration).toBe("gen-1");
    expect((db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n).toBe(1);

    const third = await retryEngine.evaluate(repo.getByIdOrThrow(job.jobId));
    expect(third.outcome).toMatchObject({ action: "skip", reason: "threshold_already_fired" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n).toBe(1);
  });

  it("rebinds a new occupant to its own transcript and preserves that receipt through restart", async () => {
    writeFileSync(transcript, "1234567890");
    const successorTranscript = join(tmp, "successor.jsonl");
    writeFileSync(successorTranscript, "1");
    const job = register();
    await engine().evaluate(job);

    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('session-2', 'node-1', 'target@rig')").run();
    db.prepare(
      `INSERT INTO occupant_tenures
        (id, node_id, generation_ordinal, generation_uuid, kind, boot_at)
       VALUES ('tenure-2', 'node-1', 2, 'gen-2', 'handover', '2026-08-28T10:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO context_usage
        (node_id, session_id, session_name, availability, transcript_path, sampled_at)
       VALUES ('node-1', 'successor-native-session', 'target@rig', 'known', ?, '2026-08-28T10:00:01.000Z')`,
    ).run(successorTranscript);
    generation = "gen-2";

    // Daemon restart: the durable job must resolve the CURRENT generation's
    // small transcript B, never reuse predecessor transcript A (still large).
    repo = new WatchdogJobsRepository(db, undefined, () => generation);
    const below = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(below.outcome).toMatchObject({
      action: "skip",
      reason: "context_usage_below_threshold",
    });
    expect(deliveries).toHaveLength(1);
    expect(repo.getByIdOrThrow(job.jobId)).toMatchObject({
      watchedFilePath: successorTranscript,
      watchedFileGeneration: "gen-2",
    });

    writeFileSync(successorTranscript, "1234567890");
    repo = new WatchdogJobsRepository(db, undefined, () => generation);
    await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(deliveries).toHaveLength(2);
    expect(repo.getByIdOrThrow(job.jobId).lastFiredGeneration).toBe("gen-2");

    repo = new WatchdogJobsRepository(db, undefined, () => generation);
    const repeat = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(repeat.outcome).toMatchObject({ action: "skip", reason: "threshold_already_fired" });
    expect(deliveries).toHaveLength(2);
  });

  it("waits visibly for a successor transcript sample before rebinding and firing", async () => {
    writeFileSync(transcript, "1234567890");
    const successorTranscript = join(tmp, "successor.jsonl");
    writeFileSync(successorTranscript, "1234567890");
    const job = register();
    await engine().evaluate(job);

    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('session-2', 'node-1', 'target@rig')").run();
    db.prepare(
      `INSERT INTO occupant_tenures
        (id, node_id, generation_ordinal, generation_uuid, kind, boot_at)
       VALUES ('tenure-2', 'node-1', 2, 'gen-2', 'handover', '2026-08-28T10:00:00.000Z')`,
    ).run();
    generation = "gen-2";

    // A restart before the successor's first sample must wait, not measure
    // the predecessor transcript or permanently terminalize the active job.
    repo = new WatchdogJobsRepository(db, undefined, () => generation);
    const pending = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(pending.outcome).toMatchObject({
      action: "skip",
      reason: "current_generation_transcript_pending",
    });
    expect(deliveries).toHaveLength(1);
    expect(repo.getByIdOrThrow(job.jobId)).toMatchObject({
      state: "active",
      watchedFilePath: transcript,
      watchedFileGeneration: "gen-1",
      lastFiredGeneration: "gen-1",
    });
    const pendingReceipts = history.listForJob(job.jobId).filter(
      (entry) => entry.skipReason === "current_generation_transcript_pending",
    );
    expect(pendingReceipts).toHaveLength(1);
    expect(pendingReceipts[0]).toMatchObject({
      outcome: "skipped",
      skipReason: "current_generation_transcript_pending",
      evaluationNotes: expect.objectContaining({
        targetSession: "target@rig",
        occupantGeneration: "gen-2",
      }),
    });

    db.prepare(
      `INSERT INTO context_usage
        (node_id, session_id, session_name, availability, transcript_path, sampled_at)
       VALUES ('node-1', 'successor-native-session', 'target@rig', 'known', ?, '2026-08-28T10:00:01.000Z')`,
    ).run(successorTranscript);

    repo = new WatchdogJobsRepository(db, undefined, () => generation);
    const fired = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(fired.outcome.action).toBe("send");
    expect(deliveries).toHaveLength(2);
    expect(repo.getByIdOrThrow(job.jobId)).toMatchObject({
      watchedFilePath: successorTranscript,
      watchedFileGeneration: "gen-2",
      lastFiredGeneration: "gen-2",
    });

    repo = new WatchdogJobsRepository(db, undefined, () => generation);
    const repeat = await engine().evaluate(repo.getByIdOrThrow(job.jobId));
    expect(repeat.outcome).toMatchObject({ action: "skip", reason: "threshold_already_fired" });
    expect(deliveries).toHaveLength(2);
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
    repo = new WatchdogJobsRepository(db, now, () => generation);
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
      bindingsSessionsSchema,
      eventsSchema,
      contextUsageSchema,
      watchdogJobsSchema,
      watchdogHistorySchema,
      occupantTenuresSchema,
      contextUsageWatchdogSchema,
      contextUsageWatchdogGenerationSchema,
    ]);
    tmp = join(tmpdir(), `context-watchdog-route-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function app() {
    const jobsRepo = new WatchdogJobsRepository(db, undefined, () => "gen-1");
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
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('session-1', 'node-1', 'target@rig')").run();
    db.prepare(
      `INSERT INTO occupant_tenures
        (id, node_id, generation_ordinal, generation_uuid, kind, boot_at)
       VALUES ('tenure-1', 'node-1', 1, 'gen-1', 'initial', '2026-08-28T09:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO context_usage
        (node_id, session_name, availability, transcript_path, sampled_at)
       VALUES ('node-1', 'target@rig', 'known', ?, '2026-08-28T09:00:01.000Z')`,
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
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('session-1', 'node-1', 'target@rig')").run();
    db.prepare(
      `INSERT INTO occupant_tenures
        (id, node_id, generation_ordinal, generation_uuid, kind, boot_at)
       VALUES ('tenure-1', 'node-1', 1, 'gen-1', 'initial', '2026-08-28T09:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO context_usage
        (node_id, session_name, availability, transcript_path, sampled_at)
       VALUES ('node-1', 'target@rig', 'known', ?, '2026-08-28T09:00:01.000Z')`,
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

describe("context-usage-threshold watchdog on a name two seat generations share", () => {
  let db: Database.Database;
  let tmp: string;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tmp = join(tmpdir(), `context-watchdog-ambiguous-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const seat = (rig: string, node: string, generation: string, transcript: string) => {
        db.prepare("INSERT INTO rigs (id, name) VALUES (?, 'seat-rig')").run(rig);
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, 'dev.impl')").run(node, rig);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, 'dev-impl@seat-rig', 'detached')").run(`session-${node}`, node);
        db.prepare(`INSERT INTO occupant_tenures (id, node_id, generation_ordinal, generation_uuid, kind, boot_at)
          VALUES (?, ?, 1, ?, 'initial', '2026-08-28T09:00:00.000Z')`).run(`tenure-${node}`, node, generation);
        writeFileSync(transcript, "1234567890");
        db.prepare(`INSERT INTO context_usage (node_id, session_id, session_name, availability, transcript_path, sampled_at)
          VALUES (?, ?, 'dev-impl@seat-rig', 'known', ?, '2026-08-28T09:00:01.000Z')`).run(node, `native-${node}`, transcript);
  };
  // As startup wires it.
  const watch = () => {
    const repo = new WatchdogJobsRepository(db);
    const history = new WatchdogHistoryLog(db);
    const deliveries: Array<{ targetSession: string; message: string }> = [];
    const sessions = new SessionRegistry(db);
    const engine = new WatchdogPolicyEngine({ jobsRepo: repo, historyLog: history, eventBus: new EventBus(db),
      deliver: async (request) => { deliveries.push(request); return { status: "ok" as const }; },
      resolveTargetGeneration: (s) => resolveGuardTarget(db, s)?.occupant ?? null,
      targetNameCarried: (s) => sessions.carriesSessionName(s) });
    const job = repo.register({ policy: "context-usage-threshold",
      specYaml: "policy: context-usage-threshold\ngenerated_by: continuity-policy-materializer\ncontinuity_mode: managed-compaction\n"
        + "target:\n  session: dev-impl@seat-rig\nmessage: Context threshold crossed.\n",
      targetSession: "dev-impl@seat-rig", intervalSeconds: 60, registeredBySession: "daemon@kernel", watchedFilePath: null, thresholdBytes: 8 });
    return { repo, history, deliveries, engine, job };
  };

  it("skips while the name names no single seat, stays active, then fires on its own seat's numbers", async () => {
    // Two unarchived generations of seat dev-impl@seat-rig (the old rig unarchived for its restore), both stopped.
    const oldTranscript = join(tmp, "old.jsonl"), currentTranscript = join(tmp, "current.jsonl");
    seat("rig-old", "node-old", "gen-old", oldTranscript);
    seat("rig-current", "node-current", "gen-current", currentTranscript);
    const { repo, history, deliveries, engine, job } = watch();

    expect(resolveGuardTarget(db, "dev-impl@seat-rig")).toBeNull();
    const ambiguous = await engine.evaluate(repo.getByIdOrThrow(job.jobId));
    expect(ambiguous.outcome).toMatchObject({ action: "skip", reason: "occupant_generation_unresolved" });
    expect(repo.getByIdOrThrow(job.jobId)).toMatchObject({ state: "active", watchedFilePath: null });
    expect(history.listForJob(job.jobId)[0]).toMatchObject({ outcome: "skipped", skipReason: "occupant_generation_unresolved" });
    expect(deliveries).toEqual([]);

    db.prepare("UPDATE rigs SET archived_at = datetime('now') WHERE id = 'rig-old'").run();
    const resolved = await engine.evaluate(repo.getByIdOrThrow(job.jobId));
    expect(resolved.outcome.action).toBe("send");
    expect(deliveries).toEqual([{ targetSession: "dev-impl@seat-rig", message: "Context threshold crossed." }]);
    expect(repo.getByIdOrThrow(job.jobId)).toMatchObject({ watchedFilePath: currentTranscript, watchedFileGeneration: "gen-current",
      lastFiredGeneration: "gen-current" });
  });

  it.each(["session", "tmux binding", "external binding"])("keeps a watch with missing tenure while a %s carries its name", async (carrier) => {
    seat("rig-current", "node-current", "gen-current", join(tmp, "current.jsonl"));
    db.prepare("DELETE FROM occupant_tenures WHERE node_id = 'node-current'").run();
    if (carrier !== "session") {
      new SessionRegistry(db).updateBinding("node-current", carrier === "tmux binding"
        ? { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%1" }
        : { attachmentType: "external_cli", externalSessionName: "dev-impl@seat-rig" });
      db.prepare("DELETE FROM sessions WHERE node_id = 'node-current'").run();
    }
    const { repo, history, deliveries, engine, job } = watch();
    expect(new SessionRegistry(db).currentOccupantGenerationForSession("dev-impl@seat-rig")).toBeNull();

    const unresolved = await engine.evaluate(repo.getByIdOrThrow(job.jobId));
    expect(unresolved.outcome).toMatchObject({ action: "skip", reason: "occupant_generation_unresolved" });
    expect(repo.getByIdOrThrow(job.jobId)).toMatchObject({ state: "active", watchedFilePath: null });
    expect(history.listForJob(job.jobId)[0]).toMatchObject({ outcome: "skipped", skipReason: "occupant_generation_unresolved" });
    expect(deliveries).toEqual([]);
  });

  it("ends the watch of a seat that's gone: its rig removed, nothing carries the name", async () => {
    seat("rig-current", "node-current", "gen-current", join(tmp, "current.jsonl"));
    const { repo, deliveries, engine, job } = watch();

    db.prepare("DELETE FROM rigs WHERE id = 'rig-current'").run();
    expect(new SessionRegistry(db).currentOccupantGenerationForSession("dev-impl@seat-rig")).toBeNull();
    const gone = await engine.evaluate(repo.getByIdOrThrow(job.jobId));
    expect(gone.outcome).toMatchObject({ action: "terminal", reason: "occupant_generation_unresolved" });
    expect(repo.getByIdOrThrow(job.jobId).state).toBe("terminal");
    expect(deliveries).toEqual([]);
  });
});
