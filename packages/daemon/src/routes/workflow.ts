import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as path from "node:path";
import type { EventBus } from "../domain/event-bus.js";
import { QueueRepositoryError } from "../domain/queue-repository.js";
import {
  WorkflowInstanceError,
  WorkflowProjectorError,
  type WorkflowRuntime,
} from "../domain/workflow-runtime.js";
import { WorkflowSpecError } from "../domain/workflow-spec-cache.js";

/**
 * Workflow runtime HTTP routes (PL-004 Phase D). Backs `rig workflow` CLI.
 *
 * Per Phase A R1 SSE route-order lesson: SSE/literal paths mounted
 * BEFORE bare-param /:instance_id catchall.
 *
 * Endpoints:
 *   POST /api/workflow/validate         validate a spec by file path
 *   POST /api/workflow/instantiate      create instance + entry qitem
 *   POST /api/workflow/project          close packet + project next (transactional-scribe)
 *   GET  /api/workflow/list             list instances by status
 *   GET  /api/workflow/sse              SSE stream of workflow.* events
 *   GET  /api/workflow/watch            alias of /sse
 *   GET  /api/workflow/:instance_id     show one instance
 *   GET  /api/workflow/:instance_id/trace  instance + trail
 *   POST /api/workflow/:instance_id/continue  inspect (idempotent)
 */
export function workflowRoutes(): Hono {
  const app = new Hono();

  function getRuntime(c: { get: (key: string) => unknown }): WorkflowRuntime {
    return c.get("workflowRuntime" as never) as WorkflowRuntime;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  function errorResponse(
    c: { json: (body: unknown, status?: number) => Response },
    err: unknown,
  ): Response {
    if (err instanceof WorkflowSpecError) {
      const status =
        err.code === "spec_file_missing" ? 404
        : err.code === "spec_yaml_invalid" || err.code === "spec_shape_invalid" || err.code === "spec_field_missing" ? 400
        : err.code === "spec_not_found" ? 404
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
    }
    if (err instanceof WorkflowInstanceError) {
      const status = err.code === "instance_not_found" ? 404 : 500;
      return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
    }
    if (err instanceof WorkflowProjectorError) {
      const status =
        err.code === "instance_not_active" || err.code === "packet_not_on_frontier" ? 409
        : err.code === "spec_not_cached" || err.code === "current_step_unknown" ? 409
        : err.code === "no_next_step" || err.code === "next_owner_unresolved" ? 400
        : err.code === "spec_invalid" || err.code === "entry_owner_unresolved" || err.code === "spec_no_steps" ? 400
        // R3 fix (guard blocker): map allowed_exits projection-time
        // rejection to 400 so the public surface (HTTP API + CLI) is
        // honest about operator/spec misuse instead of falsifying it
        // as 500 internal-server-error.
        : err.code === "exit_not_allowed" ? 400
        : err.code === "packet_not_found" ? 404
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
    }
    if (err instanceof QueueRepositoryError) {
      const status =
        err.code === "unknown_destination_rig" ? 400
        : err.code === "qitem_not_found" ? 404
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    const message = err instanceof Error ? err.message : "internal error";
    return c.json({ error: "internal_error", message }, 500);
  }

  app.post("/validate", async (c) => {
    const body = await c.req.json<{ specPath?: string }>().catch(() => ({} as never));
    if (!body.specPath) return c.json({ error: "specPath is required" }, 400);
    try {
      const result = getRuntime(c).validate(body.specPath);
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/instantiate", async (c) => {
    const body = await c.req
      .json<{
        specPath?: string;
        rootObjective?: string;
        createdBySession?: string;
        entryOwnerSession?: string;
      }>()
      .catch(() => ({} as never));
    if (!body.specPath) return c.json({ error: "specPath is required" }, 400);
    if (!body.rootObjective) return c.json({ error: "rootObjective is required" }, 400);
    if (!body.createdBySession) return c.json({ error: "createdBySession is required" }, 400);
    try {
      const result = await getRuntime(c).instantiate({
        specPath: body.specPath,
        rootObjective: body.rootObjective,
        createdBySession: body.createdBySession,
        entryOwnerSession: body.entryOwnerSession,
      });
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/project", async (c) => {
    const body = await c.req
      .json<{
        instanceId?: string;
        currentPacketId?: string;
        exit?: "handoff" | "waiting" | "done" | "failed";
        resultNote?: string;
        blockedOn?: string;
        closureEvidence?: Record<string, unknown>;
        actorSession?: string;
        nextOwnerSession?: string;
      }>()
      .catch(() => ({} as never));
    if (!body.instanceId) return c.json({ error: "instanceId is required" }, 400);
    if (!body.currentPacketId) return c.json({ error: "currentPacketId is required" }, 400);
    if (!body.exit) return c.json({ error: "exit is required" }, 400);
    if (!body.actorSession) return c.json({ error: "actorSession is required" }, 400);
    try {
      const result = await getRuntime(c).project({
        instanceId: body.instanceId,
        currentPacketId: body.currentPacketId,
        exit: body.exit,
        resultNote: body.resultNote,
        blockedOn: body.blockedOn,
        closureEvidence: body.closureEvidence,
        actorSession: body.actorSession,
        nextOwnerSession: body.nextOwnerSession,
      });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/list", (c) => {
    const status = c.req.query("status");
    if (status === "active" || status === "waiting" || status === "completed" || status === "failed") {
      return c.json(getRuntime(c).instanceStore.listByStatus(status));
    }
    return c.json(getRuntime(c).instanceStore.listAll());
  });

  // RSI v2 starter v0: lists every cached workflow_spec with an
  // `isBuiltIn` flag computed from whether the spec's source_path is
  // under the daemon's built-in starter directory. Mounted BEFORE
  // /:instance_id (Phase A R1 SSE route-order lesson) so the literal
  // `/specs` path isn't shadowed by the bare-param catchall.
  app.get("/specs", (c) => {
    const runtime = getRuntime(c);
    const builtinDirAbs = c.get("workflowBuiltinSpecsDir" as never) as string | undefined;
    const rows = runtime.specCache.listAll();
    const payload = rows.map((row) => ({
      name: row.name,
      version: row.version,
      purpose: row.purpose,
      targetRig: row.targetRig,
      coordinationTerminalTurnRule: row.coordinationTerminalTurnRule,
      sourcePath: row.sourcePath,
      cachedAt: row.cachedAt,
      isBuiltIn: builtinDirAbs ? isUnderDir(row.sourcePath, builtinDirAbs) : false,
    }));
    return c.json({ specs: payload });
  });

  // SSE for workflow.* events. MUST precede /:instance_id (Phase A R1 lesson).
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "workflow.instantiated" &&
          event.type !== "workflow.step_closed" &&
          event.type !== "workflow.next_qitem_projected" &&
          event.type !== "workflow.completed" &&
          event.type !== "workflow.failed" &&
          event.type !== "workflow.routing_table_changed"
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

  app.get("/:instance_id/trace", (c) => {
    const instanceId = c.req.param("instance_id");
    try {
      const result = getRuntime(c).continue(instanceId);
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/:instance_id/continue", (c) => {
    const instanceId = c.req.param("instance_id");
    try {
      const result = getRuntime(c).continue(instanceId);
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/:instance_id", (c) => {
    const instanceId = c.req.param("instance_id");
    const inst = getRuntime(c).instanceStore.getById(instanceId);
    if (!inst) return c.json({ error: "instance_not_found", instanceId }, 404);
    return c.json(inst);
  });

  return app;
}

/**
 * Returns true when childPath resolves to a location strictly underneath
 * parentDir on disk. Both inputs are resolved to absolute paths first;
 * the parent comparison appends a trailing path.sep to avoid the
 * `/foo/bar-other` matching `/foo/bar` false-positive case.
 */
function isUnderDir(childPath: string, parentDir: string): boolean {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentDir);
  if (child === parent) return false;
  const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(parentWithSep);
}
