import { Hono } from "hono";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";

export const activityRoutes = new Hono();

activityRoutes.post("/hooks", async (c) => {
  const store = c.get("agentActivityStore" as never) as AgentActivityStore | undefined;
  const expectedToken = c.get("activityHookToken" as never) as string | undefined;

  if (!store || !expectedToken) {
    return c.json({
      ok: false,
      code: "activity_hook_unconfigured",
      error: "Agent activity hook ingestion is not configured for this daemon.",
    }, 503);
  }

  const authHeader = c.req.header("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;
  const headerToken = c.req.header("x-openrig-activity-token") ?? null;
  if (bearerToken !== expectedToken && headerToken !== expectedToken) {
    return c.json({
      ok: false,
      code: "activity_hook_unauthorized",
      error: "Agent activity hook ingestion requires the configured local hook token.",
    }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, code: "invalid_json", error: "Request body must be JSON." }, 400);
  }

  const result = store.recordHookEvent({
    runtime: stringOrNull(body.runtime),
    sessionName: stringOrNull(body.sessionName),
    nodeId: stringOrNull(body.nodeId),
    hookEvent: typeof body.hookEvent === "string" ? body.hookEvent : "",
    subtype: stringOrNull(body.subtype),
    occurredAt: stringOrNull(body.occurredAt),
  });

  if (!result.ok) {
    const status = result.code === "missing_session_identity" ? 400 : 404;
    return c.json({ ok: false, code: result.code, error: result.error }, status);
  }

  return c.json({ ok: true, activity: result.activity });
});

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
