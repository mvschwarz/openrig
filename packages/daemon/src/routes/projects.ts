import type { ShadowCapture } from "../domain/shadow-capture.js";
import type Database from "better-sqlite3";
import type { StreamStore } from "../domain/stream-store.js";
import { classifierOccupant, classificationSources } from "../domain/classification-sources.js";
import { selectedProject } from "../domain/workspace/project-read.js";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { ProjectClassifier } from "../domain/project-classifier.js";
import { ProjectClassifierError } from "../domain/project-classifier.js";
import type { ClassifierLeaseManager } from "../domain/classifier-lease-manager.js";
import { ClassifierLeaseError } from "../domain/classifier-lease-manager.js";
import type { ClassificationAttemptLedger } from "../domain/classification-attempts.js";
import { ClassificationAttemptError } from "../domain/classification-attempts.js";

import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";
import { queryLimit } from "./query-limit.js";

/**
 * Coordination L2 — Project (Classifier) HTTP routes (PL-004 Phase B).
 *
 * Backs `rig project` CLI verb. Lease lifecycle endpoints + project
 * (idempotent classify) + operator-verb reclaim + SSE.
 *
 * Per Phase A R1 SSE route-order lesson (slice IMPL § Audit Row 12):
 * SSE/static routes are mounted BEFORE the bare-param /:id catchall.
 */
export function projectsRoutes(): Hono {
  const app = new Hono();

  function getClassifier(c: { get: (key: string) => unknown }): ProjectClassifier {
    return c.get("projectClassifier" as never) as ProjectClassifier;
  }
  function getLease(c: { get: (key: string) => unknown }): ClassifierLeaseManager {
    return c.get("classifierLeaseManager" as never) as ClassifierLeaseManager;
  }
  function getAttempts(c: { get: (key: string) => unknown }): ClassificationAttemptLedger | undefined {
    return c.get("classificationAttemptLedger" as never) as ClassificationAttemptLedger | undefined;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  // JSON is untrusted in shape, even where the session may use the claimed fallback.
  // Never pass an object to the shared helper's string trim. Wire identity still wins.
  function sender(c: Context, claim: unknown, field = "classifierSession") {
    if (!c.req.header("x-openrig-session")?.trim() && claim !== undefined && typeof claim !== "string") {
      return { ok: false as const, response: c.json({ error: "invalid_field", field, message: `${field} must be a string` }, 400) };
    }
    const actor = requireSenderIdentity(c, { verb: "classification", bodyClaim: typeof claim === "string" ? claim : undefined });
    if (!actor.ok) return actor;
    const expected = c.req.query("expectedOccupant");
    if (expected !== undefined && classifierOccupant(c.get("db" as never) as Database.Database, actor.session)?.generation !== expected) {
      return { ok: false as const, response: c.json({ error: "occupant_changed", message: "Classifier occupant is unavailable or changed; do not reuse its lease." }, 409) };
    }
    return actor;
  }

  function errorResponse(c: { json: (body: unknown, status?: number) => Response }, err: unknown): Response {
    if (err instanceof ProjectClassifierError) {
      const status = err.code === "idempotency_violation" ? 409
        : err.code === "project_not_found" ? 404
        : err.code === "attempt_mismatch" || err.code === "attempt_superseded" ? 409
        : err.code === "unknown_stream_item"
          || err.code === "invalid_field"
          || err.code === "execution_id_required"
          || err.code === "lease_id_required"
          || err.code === "invalid_needs_human"
          || err.code === "invalid_duplicate_of"
          || err.code === "candidate_set_version_required"
          || err.code === "attempt_versions_required" ? 400
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    if (err instanceof ClassifierLeaseError) {
      const status = err.code === "lease_held" ? 409
        : err.code === "lease_session_mismatch" ? 403
        : err.code === "lease_not_active" ? 409
        : err.code === "lease_expired" ? 409
        : err.code === "lease_not_found" ? 404
        : err.code === "no_active_lease" ? 409
        : err.code === "lease_still_active" ? 409
        : err.code === "lease_mismatch" ? 409
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    if (err instanceof ClassificationAttemptError) {
      const status = err.code === "attempt_not_found" ? 404
        : err.code === "unknown_stream_item" || err.code === "invalid_attempt_identity"
          || err.code === "unknown_cursor" || err.code === "invalid_field" ? 400
        : 409;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    const message = err instanceof Error ? err.message : "internal error";
    return c.json({ error: "internal_error", message }, 500);
  }

  // No taxonomy or model judgment lives here: only current, identified source facts.
  app.get("/worker-sources", c => {
    const actor = sender(c, undefined);
    if (!actor.ok) return actor.response;
    const db = c.get("db" as never) as Database.Database;
    const occupant = classifierOccupant(db, actor.session);
    if (!occupant) return c.json({ error: "occupant_unavailable", message: "A real running classifier occupant is required." }, 409);
    try {
      const project = selectedProject(c);
      if (!project) return c.json({ error: "project_required" }, 400);
      return c.json(classificationSources(db, project, occupant, c.get("streamStore" as never) as StreamStore));
    } catch (error) { return c.json({ error: "candidate_sources_unavailable", message: error instanceof Error ? error.message : "source unavailable" }, 409); }
  });

  app.get("/shadow", c => {
    const capture = c.get("shadowCapture" as never) as ShadowCapture | undefined;
    return c.json(capture?.status() ?? {enabled: false, error: c.get("shadowCaptureError" as never) ?? null});
  });
  app.post("/shadow/drain", async c => {
    const body = await c.req.json<{ actor?: unknown }>().catch(() => ({} as never));
    const actor = sender(c, body.actor, "actor"); if (!actor.ok) return actor.response;
    const capture = c.get("shadowCapture" as never) as ShadowCapture | undefined;
    if (!capture) return c.json({enabled: false, error: c.get("shadowCaptureError" as never) ?? null}, 409);
    return c.json(await capture.drain());
  });
  app.post("/shadow/stop", async c => {
    const body = await c.req.json<{ actor?: unknown }>().catch(() => ({} as never));
    const actor = sender(c, body.actor, "actor"); if (!actor.ok) return actor.response;
    const capture = c.get("shadowCapture" as never) as ShadowCapture | undefined;
    return c.json(capture ? await capture.stop() : {enabled: false, error: c.get("shadowCaptureError" as never) ?? null});
  });

  // POST /lease/acquire — acquire active classifier lease for caller.
  // R1 NOTE 3: optional `evaluateDeadnessFirst: true` causes the route to
  // call evaluateDeadness BEFORE acquire, which clears stale TTL-expired or
  // dead-holder leases. Without this opt-in, acquire returns 409 lease_held
  // even when the holder is dead (the operator-verb reclaim path is the
  // only other way to clear a dead lease without waiting for TTL+next
  // evaluateDeadness call). Default OFF — operators / classifiers
  // explicitly request the proactive cleanup.
  app.post("/lease/acquire", async (c) => {
    const body = await c.req.json<{ classifierSession?: string; evaluateDeadnessFirst?: boolean }>().catch(() => ({} as never));
    const actor = sender(c, body.classifierSession);
    if (!actor.ok) return actor.response;
    try {
      if (body.evaluateDeadnessFirst === true) {
        getLease(c).evaluateDeadness();
      }
      const lease = getLease(c).acquire(actor.session);
      return c.json(lease, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /lease/heartbeat — update last_heartbeat + extend expires_at.
  app.post("/lease/heartbeat", async (c) => {
    const body = await c.req.json<{ leaseId?: string; classifierSession?: string }>().catch(() => ({} as never));
    if (typeof body.leaseId !== "string" || !body.leaseId.trim()) return c.json({ error: "invalid_field", field: "leaseId" }, 400);
    const actor = sender(c, body.classifierSession);
    if (!actor.ok) return actor.response;
    try {
      const lease = getLease(c).heartbeat(body.leaseId, actor.session);
      return c.json(lease);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /reclaim-classifier — operator-verb reclaim (per PRD § L2 hard rule).
  app.post("/reclaim-classifier", async (c) => {
    const body = await c.req.json<{
      byClassifierSession?: string;
      ifDead?: boolean;
      reason?: string;
    }>().catch(() => ({} as never));
    const actor = sender(c, body.byClassifierSession, "byClassifierSession");
    if (!actor.ok) return actor.response;
    try {
      const lease = getLease(c).reclaim(actor.session, {
        ifDead: body.ifDead,
        reason: body.reason,
      });
      return c.json(lease);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /project — project a stream item (idempotent on stream_item_id).
  app.post("/project", async (c) => {
    const body = await c.req.json<{
      streamItemId?: string;
      classifierSession?: string;
      leaseId?: string;
      attemptId?: string;
      executionId?: string;
      classificationType?: string;
      classificationUrgency?: string;
      classificationMaturity?: string;
      classificationConfidence?: string;
      classificationDestination?: string;
      action?: string;
      area?: string;
      scopeRef?: string;
      duplicateOfStreamItemId?: string;
      needsHuman?: boolean | null;
      classifierVersion?: string;
      taxonomyVersion?: string;
      candidateSetVersion?: string;
    }>().catch(() => ({} as never));
    if (!body.streamItemId) return c.json({ error: "streamItemId is required" }, 400);
    const actor = sender(c, body.classifierSession);
    if (!actor.ok) return actor.response;
    try {
      const project = getClassifier(c).classify({
        streamItemId: body.streamItemId,
        classifierSession: actor.session,
        identityProvenance: resolveRecordedProvenance(c, actor),
        leaseId: body.leaseId as string,
        attemptId: body.attemptId,
        executionId: body.executionId,
        classificationType: body.classificationType,
        classificationUrgency: body.classificationUrgency,
        classificationMaturity: body.classificationMaturity,
        classificationConfidence: body.classificationConfidence,
        classificationDestination: body.classificationDestination,
        action: body.action,
        area: body.area,
        scopeRef: body.scopeRef,
        duplicateOfStreamItemId: body.duplicateOfStreamItemId,
        needsHuman: body.needsHuman,
        classifierVersion: body.classifierVersion,
        taxonomyVersion: body.taxonomyVersion,
        candidateSetVersion: body.candidateSetVersion,
      });
      return c.json(project, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ---- Attempt ledger (S02 P1) ----
  // Literal paths; all mounted before /:projectId.
  const attemptsUnavailable = (c: { json: (b: unknown, s?: number) => Response }) =>
    c.json({ error: "attempt_ledger_unavailable", message: "classification attempt ledger is not wired in this daemon" }, 503);

  app.post("/attempts/begin", async (c) => {
    const ledger = getAttempts(c);
    if (!ledger) return attemptsUnavailable(c);
    // The ledger validates remaining consumed fields after sender resolution.
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as never));
    const actor = sender(c, body.classifierSession);
    if (!actor.ok) return actor.response;
    try {
      return c.json(ledger.begin({
        streamItemId: body.streamItemId as string,
        classifierVersion: body.classifierVersion as string,
        taxonomyVersion: body.taxonomyVersion as string,
        evidenceEpoch: body.evidenceEpoch as string,
        leaseId: body.leaseId as string,
        classifierSession: actor.session,
      }), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  for (const verb of ["abstain", "fail"] as const) {
    app.post(`/attempts/:attemptId/${verb}`, async (c) => {
      const ledger = getAttempts(c);
      if (!ledger) return attemptsUnavailable(c);
      // The ledger shape-checks the remaining fields (invalid_field).
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as never));
      const actor = sender(c, body.classifierSession);
      if (!actor.ok) return actor.response;
      if (body.reason === undefined) return c.json({ error: "reason is required" }, 400);
      try {
        const input = {
          attemptId: c.req.param("attemptId"),
          executionId: body.executionId as string,
          leaseId: body.leaseId as string,
          classifierSession: actor.session,
          reason: body.reason as string,
        };
        return c.json(verb === "abstain" ? ledger.abstain(input) : ledger.fail(input));
      } catch (err) {
        return errorResponse(c, err);
      }
    });
  }

  // GET /eligible — one bounded page of items to attempt now, in stream order.
  app.get("/eligible", (c) => {
    if (c.req.query("expectedOccupant") !== undefined) { const actor = sender(c, undefined); if (!actor.ok) return actor.response; }
    const ledger = getAttempts(c);
    if (!ledger) return attemptsUnavailable(c);
    try {
      const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
      return c.json(ledger.eligible({
        classifierVersion: c.req.query("classifierVersion") ?? "",
        taxonomyVersion: c.req.query("taxonomyVersion") ?? "",
        evidenceEpoch: c.req.query("evidenceEpoch") ?? "",
        limit: Number.isFinite(limit) ? limit : undefined,
        afterSortKey: c.req.query("afterSortKey") || undefined,
      }));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /lease — show active lease.
  // MUST precede /:projectId so the literal path wins.
  app.get("/lease", (c) => {
    if (c.req.query("expectedOccupant") !== undefined) {
      const actor = sender(c, undefined); if (!actor.ok) return actor.response;
      try { getLease(c).requireActiveHolder(actor.session, c.req.query("expectedLeaseId")); }
      catch (error) { return errorResponse(c, error); }
    }
    const lease = getLease(c).getActiveLease();
    if (!lease) return c.json({ error: "no_active_lease" }, 404);
    return c.json(lease);
  });

  // GET /list — list classifications with filters.
  // MUST precede /:projectId so the literal path wins.
  app.get("/list", (c) => {
    const classifierSession = c.req.query("classifierSession") || undefined;
    const classificationDestination = c.req.query("classificationDestination") || undefined;
    const area = c.req.query("area") || undefined;
    const scopeRef = c.req.query("scopeRef") || undefined;
    const needsHumanRaw = c.req.query("needsHuman") || undefined;
    if (needsHumanRaw && !["true", "false", "unknown"].includes(needsHumanRaw)) {
      return c.json({ error: "needsHuman filter must be true, false or unknown" }, 400);
    }
    const needsHuman = needsHumanRaw as "true" | "false" | "unknown" | undefined;
    const parsed = queryLimit(c);
    if (!parsed.ok) return parsed.response;
    const limit = parsed.limit;
    const items = getClassifier(c).list({ classifierSession, classificationDestination, area, scopeRef, needsHuman, limit });
    return c.json(items);
  });

  // ---- SSE for project + classifier events ----
  // MUST precede /:projectId so the literal `sse` and `watch` paths win
  // over the bare-param route. Per Phase A R1 SSE route-order lesson.
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "project.classified" &&
          event.type !== "classifier.lease_acquired" &&
          event.type !== "classifier.lease_expired" &&
          event.type !== "classifier.dead" &&
          event.type !== "classifier.reclaimed"
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

  // GET /:projectId — show one project (must come AFTER literal routes).
  app.get("/:projectId", (c) => {
    const projectId = c.req.param("projectId");
    const project = getClassifier(c).getById(projectId);
    if (!project) return c.json({ error: "project_not_found" }, 404);
    return c.json(project);
  });

  return app;
}
