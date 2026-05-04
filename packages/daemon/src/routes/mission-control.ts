import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import {
  MissionControlActionLogError,
  MISSION_CONTROL_VERBS,
  type MissionControlVerb,
} from "../domain/mission-control/mission-control-action-log.js";
import {
  MISSION_CONTROL_VIEWS,
  type MissionControlReadLayer,
  type MissionControlViewName,
} from "../domain/mission-control/mission-control-read-layer.js";
import {
  MissionControlWriteContractError,
  type MissionControlWriteContract,
} from "../domain/mission-control/mission-control-write-contract.js";
import type { MissionControlFleetCliCapability } from "../domain/mission-control/mission-control-fleet-cli-capability.js";
import type { MissionControlAuditBrowse } from "../domain/mission-control/audit-browse.js";
import type { MissionControlNotificationDispatcher } from "../domain/mission-control/notification-dispatcher.js";

/**
 * Mission Control HTTP routes (PL-005 Phase A). Backs the integrated
 * Mission Control product UI inside the existing shell.
 *
 * Per Phase A R1 (PL-004) SSE route-order lesson: SSE/literal paths
 * mounted BEFORE bare-param /:view-name catchall.
 *
 * Endpoints:
 *   GET  /api/mission-control/views/:view-name   read one of 7 views
 *   POST /api/mission-control/action              execute one of 7 verbs
 *   GET  /api/mission-control/sse                 SSE stream of mission_control.* events
 *   GET  /api/mission-control/watch               alias of /sse
 *   GET  /api/mission-control/cli-capabilities    per-rig CLI capability cache
 *   GET  /api/mission-control/views               list view names
 */
export interface MissionControlRoutesOpts {
  /**
   * PL-005 Phase B: bearer token enforced on write verbs (POST /action,
   * POST /notifications/test) when set. When null, the daemon is
   * loopback-bound and no auth is enforced (the index.ts startup
   * check guarantees this).
   */
  bearerToken?: string | null;
}

export function missionControlRoutes(opts?: MissionControlRoutesOpts): Hono {
  const app = new Hono();
  const bearerToken = opts?.bearerToken ?? null;
  // PL-005 Phase B: bearer-token middleware mounted on write verbs.
  // Reads remain open behind tailnet bind for the headed-browser-from-
  // phone case where the operator hasn't typed the token into mobile
  // yet — the bearer is for write integrity, not view confidentiality.
  // (Operator may extend gating to reads by mounting on read paths in
  // a future revision; v0 default per planner brief is gate-writes-only.)
  const requireAuth = authBearerTokenMiddleware({ expectedToken: bearerToken });

  function getReadLayer(c: { get: (key: string) => unknown }): MissionControlReadLayer {
    return c.get("missionControlReadLayer" as never) as MissionControlReadLayer;
  }
  function getAuditBrowse(c: { get: (key: string) => unknown }): MissionControlAuditBrowse {
    return c.get("missionControlAuditBrowse" as never) as MissionControlAuditBrowse;
  }
  function getNotificationDispatcher(
    c: { get: (key: string) => unknown },
  ): MissionControlNotificationDispatcher | undefined {
    return c.get("missionControlNotificationDispatcher" as never) as
      | MissionControlNotificationDispatcher
      | undefined;
  }
  function getWriteContract(c: { get: (key: string) => unknown }): MissionControlWriteContract {
    return c.get("missionControlWriteContract" as never) as MissionControlWriteContract;
  }
  function getCliCapability(c: { get: (key: string) => unknown }): MissionControlFleetCliCapability {
    return c.get("missionControlFleetCliCapability" as never) as MissionControlFleetCliCapability;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  function errorResponse(
    c: { json: (body: unknown, status?: number) => Response },
    err: unknown,
  ): Response {
    if (err instanceof MissionControlActionLogError) {
      const status =
        err.code === "verb_unknown" ? 400
        : err.code === "annotation_required" || err.code === "reason_required" ? 400
        : 500;
      return c.json(
        { error: err.code, message: err.message, ...(err.details ?? {}) },
        status as 200,
      );
    }
    if (err instanceof MissionControlWriteContractError) {
      const status =
        err.code === "qitem_not_found" ? 404
        : err.code === "qitem_already_terminal" ? 409
        : err.code === "destination_required" ? 400
        : err.code === "annotation_required" ? 400
        : 500;
      return c.json(
        { error: err.code, message: err.message, ...(err.details ?? {}) },
        status as 200,
      );
    }
    const message = err instanceof Error ? err.message : "internal error";
    return c.json({ error: "internal_error", message }, 500);
  }

  // GET /views — list view names. MUST precede /views/:view-name catchall.
  app.get("/views", (c) => {
    return c.json({ views: [...MISSION_CONTROL_VIEWS] });
  });

  // GET /cli-capabilities — fleet roll-up + drift indicator.
  app.get("/cli-capabilities", async (c) => {
    const fleet = await getCliCapability(c).rollupFleet();
    return c.json(fleet);
  });

  // SSE for mission_control.* events. MUST precede /views/:view-name
  // (per PL-004 Phase A R1 SSE route-order lesson).
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "mission_control.action_executed" &&
          event.type !== "mission_control.cli_drift_detected" &&
          event.type !== "mission_control.view_refreshed"
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

  // PL-005 Phase B: bearer-token gate on write verbs.
  app.post("/action", requireAuth);
  app.post("/notifications/test", requireAuth);

  // POST /action — execute one of 7 verbs through the atomic write contract.
  app.post("/action", async (c) => {
    const body = await c.req
      .json<{
        verb?: MissionControlVerb;
        qitemId?: string;
        actorSession?: string;
        destinationSession?: string;
        body?: string;
        annotation?: string;
        reason?: string;
        notify?: boolean;
        auditNotes?: Record<string, unknown>;
      }>()
      .catch(() => ({} as never));
    if (!body.verb) return c.json({ error: "verb is required" }, 400);
    if (!MISSION_CONTROL_VERBS.includes(body.verb)) {
      return c.json(
        {
          error: "verb_unknown",
          message: `unknown verb '${body.verb}'; supported: ${MISSION_CONTROL_VERBS.join(", ")}`,
          supported: [...MISSION_CONTROL_VERBS],
        },
        400,
      );
    }
    if (!body.qitemId) return c.json({ error: "qitemId is required" }, 400);
    if (!body.actorSession) return c.json({ error: "actorSession is required" }, 400);
    try {
      const result = await getWriteContract(c).act({
        verb: body.verb,
        qitemId: body.qitemId,
        actorSession: body.actorSession,
        destinationSession: body.destinationSession,
        body: body.body,
        annotation: body.annotation,
        reason: body.reason,
        notify: body.notify,
        auditNotes: body.auditNotes,
      });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // PL-005 Phase B: GET /audit — read-only browse over mission_control_actions.
  // MUST come BEFORE /views/:view-name catchall (route-order discipline
  // per PL-004 Phase A R1 lesson).
  app.get("/audit", async (c) => {
    const audit = getAuditBrowse(c);
    if (!audit) return c.json({ error: "audit_browse_unavailable" }, 500);
    const qitemId = c.req.query("qitem_id") || undefined;
    const actionVerb = c.req.query("action_verb") || undefined;
    const actorSession = c.req.query("actor_session") || undefined;
    const since = c.req.query("since") || undefined;
    const until = c.req.query("until") || undefined;
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    const beforeId = c.req.query("before_id") || undefined;
    try {
      const result = audit.query({ qitemId, actionVerb, actorSession, since, until, limit, beforeId });
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: "audit_query_failed",
          message: err instanceof Error ? err.message : "internal error",
        },
        500,
      );
    }
  });

  // PL-005 Phase B: POST /notifications/test — synthetic notification
  // through the configured mechanism so the operator can verify before
  // relying on it. Bearer-token gated (registered above).
  app.post("/notifications/test", async (c) => {
    const dispatcher = getNotificationDispatcher(c);
    if (!dispatcher) {
      return c.json(
        {
          error: "notifications_unconfigured",
          message:
            "notifications dispatcher is not wired; configure notifications.mechanism (ntfy|webhook) in daemon config and restart",
        },
        503,
      );
    }
    try {
      const result = await dispatcher.sendTest();
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: "notification_test_failed",
          message: err instanceof Error ? err.message : "internal error",
        },
        500,
      );
    }
  });

  // GET /views/:view-name — read one of 7 views. MUST come AFTER /views,
  // /cli-capabilities, /sse, /watch, /audit literal paths.
  app.get("/views/:view-name", async (c) => {
    const viewName = c.req.param("view-name") as MissionControlViewName;
    if (!MISSION_CONTROL_VIEWS.includes(viewName)) {
      return c.json(
        {
          error: "view_unknown",
          message: `unknown view '${viewName}'; supported: ${MISSION_CONTROL_VIEWS.join(", ")}`,
          supported: [...MISSION_CONTROL_VIEWS],
        },
        404,
      );
    }
    const operatorSession = c.req.query("operatorSession") || undefined;
    try {
      const result = await getReadLayer(c).readView(viewName, { operatorSession });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}
