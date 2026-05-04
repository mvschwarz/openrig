import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
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
export function missionControlRoutes(): Hono {
  const app = new Hono();

  function getReadLayer(c: { get: (key: string) => unknown }): MissionControlReadLayer {
    return c.get("missionControlReadLayer" as never) as MissionControlReadLayer;
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

  // GET /views/:view-name — read one of 7 views. MUST come AFTER /views,
  // /cli-capabilities, /sse, /watch literal paths.
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
