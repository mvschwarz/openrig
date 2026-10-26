import { statSync } from "node:fs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { WatchdogHistoryLog } from "../domain/watchdog-history-log.js";
import {
  type WatchdogJobsRepository,
  WatchdogJobsError,
} from "../domain/watchdog-jobs-repository.js";
import { parseWatchdogSpec } from "../domain/watchdog-policy-engine.js";
import { updateWatchdogJob } from "../domain/watchdog-job-update.js";

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
 *   POST /:job_id/update    change an active job's interval, spec or message in place
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
        : err.code === "spec_invalid" ? 400
        : err.code === "context_usage_schema_missing" ? 400
        : err.code === "threshold_invalid" ? 400
        : err.code === "watched_file_unresolved" ? 400
        : err.code === "requires_job_not_found" ? 400
        : err.code === "job_terminal" ? 409
        : err.code === "job_stopped" ? 409
        : err.code === "nothing_to_update" ? 400
        : err.code === "field_not_updatable" ? 400
        : err.code === "interval_not_effective" ? 409
        : err.code === "policy_not_updatable" ? 409
        : err.code === "spec_not_updatable" ? 409
        : err.code === "target_not_updatable" ? 409
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
        watchedFilePath?: string;
        thresholdBytes?: number;
        thresholdTokens?: number;
        thresholdPercent?: number;
        requiresJobId?: string;
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
      const jobsRepo = getJobsRepo(c);
      const context = parseWatchdogSpec(body.specYaml).context;
      const isContextUsageThreshold = body.policy === "context-usage-threshold";
      const specWatchedFile = typeof context.watched_file === "string"
        ? context.watched_file
        : null;
      const specThresholdBytes = typeof context.threshold_bytes === "number"
        ? context.threshold_bytes
        : null;
      // Issue #1180 — token / percent-of-window units from the spec context block.
      const specThresholdTokens = typeof context.threshold_tokens === "number"
        ? context.threshold_tokens
        : null;
      const specThresholdPercent = typeof context.threshold_percent === "number"
        ? context.threshold_percent
        : null;
      const thresholdTokens = isContextUsageThreshold
        ? (body.thresholdTokens ?? specThresholdTokens)
        : null;
      const thresholdPercent = isContextUsageThreshold
        ? (body.thresholdPercent ?? specThresholdPercent)
        : null;
      const byteGated = isContextUsageThreshold &&
        (body.thresholdBytes ?? specThresholdBytes) != null && thresholdTokens == null && thresholdPercent == null;
      const specRequiresJobId = typeof context.requires === "string"
        ? context.requires
        : null;
      const watchedFilePath = isContextUsageThreshold
        ? (body.watchedFilePath ?? specWatchedFile ?? jobsRepo.findTranscriptPath(body.targetSession))
        : null;
      if (isContextUsageThreshold && byteGated) {
        try {
          if (!watchedFilePath || !statSync(watchedFilePath).isFile()) throw new Error("not a file");
        } catch {
          throw new WatchdogJobsError(
            "watched_file_unresolved",
            `no readable transcript file could be resolved for ${body.targetSession}`,
            { targetSession: body.targetSession, watchedFilePath },
          );
        }
      }
      const job = jobsRepo.register({
        policy: body.policy,
        specYaml: body.specYaml,
        targetSession: body.targetSession,
        intervalSeconds: body.intervalSeconds,
        activeWakeIntervalSeconds: body.activeWakeIntervalSeconds,
        scanIntervalSeconds: body.scanIntervalSeconds,
        registeredBySession: body.registeredBySession,
        watchedFilePath,
        thresholdBytes: isContextUsageThreshold
          ? (body.thresholdBytes ?? specThresholdBytes)
          : null,
        thresholdTokens,
        thresholdPercent,
        requiresJobId: isContextUsageThreshold
          ? (body.requiresJobId ?? specRequiresJobId)
          : null,
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
          event.type !== "watchdog.job_stopped" &&
          event.type !== "watchdog.job_updated"
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

  // Only these three can change; naming anything else is refused rather than quietly ignored.
  app.post("/:job_id/update", async (c) => {
    const jobId = c.req.param("job_id");
    const body = await c.req.json<unknown>().catch(() => ({}));
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "body must be a JSON object" }, 400);
    }
    try {
      const fixed = Object.keys(body).filter((key) => !["intervalSeconds", "message", "specYaml"].includes(key));
      if (fixed.length > 0) {
        throw new WatchdogJobsError(
          "field_not_updatable",
          `${fixed.join(", ")} cannot be changed on an existing watchdog job; only intervalSeconds, message and specYaml can`,
          { fields: fixed },
        );
      }
      const result = updateWatchdogJob(getJobsRepo(c), jobId, body as Record<string, unknown>);
      if (result.changed.length > 0) {
        getEventBus(c).emit({ type: "watchdog.job_updated", jobId, changed: result.changed });
      }
      return c.json(result);
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
