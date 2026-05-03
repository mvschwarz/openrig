import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { watchdogRoutes } from "../src/routes/watchdog.js";

function buildApp(opts: {
  eventBus: EventBus;
  jobsRepo: WatchdogJobsRepository;
  historyLog: WatchdogHistoryLog;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("watchdogJobsRepo" as never, opts.jobsRepo);
    c.set("watchdogHistoryLog" as never, opts.historyLog);
    await next();
  });
  app.route("/api/watchdog", watchdogRoutes());
  return app;
}

describe("watchdog routes (PL-004 Phase C)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let jobsRepo: WatchdogJobsRepository;
  let log: WatchdogHistoryLog;
  let app: Hono;

  const validRegisterBody = {
    policy: "periodic-reminder",
    specYaml:
      "policy: periodic-reminder\ntarget: alice@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: alice@rig\n  message: ping\n",
    targetSession: "alice@rig",
    intervalSeconds: 60,
    registeredBySession: "ops@kernel",
  };

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]);
    bus = new EventBus(db);
    jobsRepo = new WatchdogJobsRepository(db);
    log = new WatchdogHistoryLog(db);
    app = buildApp({ eventBus: bus, jobsRepo, historyLog: log });
  });

  afterEach(() => db.close());

  it("POST /register returns 201 + persists job + emits watchdog.job_registered", async () => {
    const captured: Array<{ type: string }> = [];
    bus.subscribe((e) => captured.push(e));
    const res = await app.request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRegisterBody),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { jobId: string; policy: string; state: string };
    expect(body.jobId).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.policy).toBe("periodic-reminder");
    expect(body.state).toBe("active");
    expect(captured.some((e) => e.type === "watchdog.job_registered")).toBe(true);
  });

  it("POST /register rejects workflow-keepalive with 400 + policy_deferred_to_phase_d", async () => {
    const res = await app.request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validRegisterBody, policy: "workflow-keepalive" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("policy_deferred_to_phase_d");
  });

  it("POST /register rejects unknown policy with 400 + policy_unknown", async () => {
    const res = await app.request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validRegisterBody, policy: "totally-bogus" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("policy_unknown");
  });

  it("POST /register rejects missing required field with 400", async () => {
    const res = await app.request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: "periodic-reminder" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /list lists all jobs", async () => {
    jobsRepo.register({ ...validRegisterBody, targetSession: "a@rig" });
    jobsRepo.register({ ...validRegisterBody, targetSession: "b@rig" });
    const res = await app.request("/api/watchdog/list");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ targetSession: string }>;
    expect(list).toHaveLength(2);
  });

  it("GET /:job_id returns job by id", async () => {
    const job = jobsRepo.register(validRegisterBody);
    const res = await app.request(`/api/watchdog/${job.jobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe(job.jobId);
  });

  it("GET /:job_id returns 404 for unknown id", async () => {
    const res = await app.request("/api/watchdog/unknown-id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("job_not_found");
  });

  it("GET /:job_id/status returns job + recent history", async () => {
    const job = jobsRepo.register(validRegisterBody);
    log.record({
      jobId: job.jobId,
      evaluatedAt: "2026-05-03T07:00:00.000Z",
      outcome: "sent",
      deliveryTargetSession: "alice@rig",
      deliveryStatus: "ok",
      deliveryMessage: "ping",
    });
    const res = await app.request(`/api/watchdog/${job.jobId}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { jobId: string }; recentHistory: Array<{ outcome: string }> };
    expect(body.job.jobId).toBe(job.jobId);
    expect(body.recentHistory).toHaveLength(1);
    expect(body.recentHistory[0]?.outcome).toBe("sent");
  });

  it("POST /:job_id/stop stops job + emits watchdog.job_stopped", async () => {
    const captured: Array<{ type: string }> = [];
    bus.subscribe((e) => captured.push(e));
    const job = jobsRepo.register(validRegisterBody);
    const res = await app.request(`/api/watchdog/${job.jobId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "tester stopped" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("stopped");
    expect(captured.some((e) => e.type === "watchdog.job_stopped")).toBe(true);
  });

  it("POST /:job_id/stop on terminal job returns 409 + job_terminal", async () => {
    const job = jobsRepo.register(validRegisterBody);
    jobsRepo.markTerminal(job.jobId, "done");
    const res = await app.request(`/api/watchdog/${job.jobId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("job_terminal");
  });

  it("R1 SSE pattern: GET /api/watchdog/sse returns 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/watchdog/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE pattern: GET /api/watchdog/watch returns 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/watchdog/watch");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE pattern: GET /api/watchdog/sse does NOT return job_not_found (route-order regression guard)", async () => {
    const res = await app.request("/api/watchdog/sse");
    try {
      expect(res.status).not.toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    } finally {
      await res.body?.cancel();
    }
  });
});
