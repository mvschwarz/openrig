import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { WatchdogHistoryLog } from "../domain/watchdog-history-log.js";
import {
  type WatchdogJobsRepository,
  WatchdogJobsError,
} from "../domain/watchdog-jobs-repository.js";

/**
 * Watchdog HTTP routes (PL-004 Phase C). Backs `rig watchdog` CLI verb.
 *
 * Per Phase A R1 SSE route-order lesson: SSE/static routes mounted
 * BEFORE the bare-param /:job_id catchall so the literal `/sse` and
 * literal action paths win over the param route.
 *
 * Endpoints:
 *   POST /register          register a new watchdog job
 *   GET  /list              list all watchdog jobs (active + stopped + terminal)
 *   GET  /sse               SSE stream of watchdog.* events
 *   GET  /:job_id           show one job
 *   GET  /:job_id/status    job + recent history (compact summary)
 *   POST /:job_id/stop      operator stop
 */
export function watchdogRoutes(): Hono {
  const app = new Hono();

  function getJobsRepo(c: { get: (key: string) => unknown }): WatchdogJobsRepository {
    return c.get("watchdogJobsRepo" as never) as WatchdogJobsRepository;
  }
  function getHistoryLog(c: { get: (key: string) => unknown }): WatchdogHistoryLog {
    return c.get("watchdogHistoryLog" as never) as WatchdogHistoryLog;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  function errorResponse(
    c: { json: (body: unknown, status?: number) => Response },
    err: unknown,
  ): Response {
    if (err instanceof WatchdogJobsError) {
      const status =
        err.code === "job_not_found" ? 404
        : err.code === "policy_unknown" ? 400
        : err.code === "policy_deferred_to_phase_d" ? 400
        : err.code === "interval_invalid" ? 400
        : err.code === "target_session_invalid" ? 400
        : err.code === "job_terminal" ? 409
        : 500;
      return c.json(
        { error: err.code, message: err.message, ...(err.details ?? {}) },
        status as 200,
      );
    }
    const message = err instanceof Error ? err.message : "internal error";
    return c.json({ error: "internal_error", message }, 500);
  }

  app.post("/register", async (c) => {
    const body = await c.req
      .json<{
        policy?: string;
        specYaml?: string;
        targetSession?: string;
        intervalSeconds?: number;
        activeWakeIntervalSeconds?: number;
        scanIntervalSeconds?: number;
        registeredBySession?: string;
      }>()
      .catch(() => ({} as never));
    if (!body.policy) return c.json({ error: "policy is required" }, 400);
    if (!body.specYaml) return c.json({ error: "specYaml is required" }, 400);
    if (!body.targetSession) return c.json({ error: "targetSession is required" }, 400);
    if (typeof body.intervalSeconds !== "number") {
      return c.json({ error: "intervalSeconds is required" }, 400);
    }
    if (!body.registeredBySession) return c.json({ error: "registeredBySession is required" }, 400);
    try {
      const job = getJobsRepo(c).register({
        policy: body.policy,
        specYaml: body.specYaml,
        targetSession: body.targetSession,
        intervalSeconds: body.intervalSeconds,
        activeWakeIntervalSeconds: body.activeWakeIntervalSeconds,
        scanIntervalSeconds: body.scanIntervalSeconds,
        registeredBySession: body.registeredBySession,
      });
      getEventBus(c).emit({
        type: "watchdog.job_registered",
        jobId: job.jobId,
        policy: job.policy,
        targetSession: job.targetSession,
        registeredBy: job.registeredBySession,
      });
      return c.json(job, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /list — list all watchdog jobs.
  // Literal path before /:job_id (per Phase A R1 SSE route-order lesson).
  app.get("/list", (c) => {
    const jobs = getJobsRepo(c).listAll();
    return c.json(jobs);
  });

  // SSE for watchdog.* events. MUST precede /:job_id so the literal
  // path wins. Per Phase A R1 SSE route-order lesson.
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "watchdog.evaluation_fired" &&
          event.type !== "watchdog.evaluation_skipped" &&
          event.type !== "watchdog.evaluation_terminal" &&
          event.type !== "watchdog.job_registered" &&
          event.type !== "watchdog.job_stopped"
        ) return;
        const sse = { id: String(event.seq), data: JSON.stringify(event) };
        stream.writeSSE(sse).catch(() => {});
      });
      try {
        await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      } finally {
        unsubscribe();
      }
    });
  };

  app.get("/sse", sseHandler);
  app.get("/watch", sseHandler);

  app.get("/:job_id/status", (c) => {
    const jobId = c.req.param("job_id");
    const job = getJobsRepo(c).getById(jobId);
    if (!job) return c.json({ error: "job_not_found", jobId }, 404);
    const recentHistory = getHistoryLog(c).listForJob(jobId, 20);
    return c.json({ job, recentHistory });
  });

  app.post("/:job_id/stop", async (c) => {
    const jobId = c.req.param("job_id");
    const body = await c.req
      .json<{ reason?: string }>()
      .catch(() => ({} as { reason?: string }));
    try {
      const job = getJobsRepo(c).stop(jobId, body.reason ?? "operator_stopped");
      getEventBus(c).emit({
        type: "watchdog.job_stopped",
        jobId: job.jobId,
        reason: body.reason ?? "operator_stopped",
      });
      return c.json(job);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/:job_id", (c) => {
    const jobId = c.req.param("job_id");
    const job = getJobsRepo(c).getById(jobId);
    if (!job) return c.json({ error: "job_not_found", jobId }, 404);
    return c.json(job);
  });

  return app;
}
