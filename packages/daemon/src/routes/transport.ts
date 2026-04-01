import { Hono } from "hono";
import type { SessionTransport, TargetSpec } from "../domain/session-transport.js";

export function transportRoutes(): Hono {
  const router = new Hono();

  router.post("/send", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      session?: string;
      text: string;
      verify?: boolean;
      force?: boolean;
    }>();

    if (!body.session || !body.text) {
      return c.json({ error: "Missing required fields: session, text" }, 400);
    }

    // Check for ambiguity first
    const resolved = await transport.resolveSessions({ session: body.session });
    if (!resolved.ok) {
      const status = resolved.code === "ambiguous" ? 409 : 404;
      return c.json({ ok: false, error: resolved.error }, status);
    }

    const result = await transport.send(body.session, body.text, {
      verify: body.verify,
      force: body.force,
    });

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        session_missing: 404,
        tmux_unavailable: 503,
        mid_work: 409,
        submit_failed: 502,
        send_failed: 502,
      };
      const status = statusMap[result.reason ?? ""] ?? 500;
      return c.json(result, status as 404);
    }

    return c.json(result);
  });

  router.post("/capture", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      session?: string;
      rig?: string;
      pod?: string;
      lines?: number;
    }>();

    // Multi-target: rig or pod
    if (body.rig || body.pod) {
      const target: TargetSpec = body.pod
        ? { pod: body.pod, rig: body.rig }
        : { rig: body.rig! };

      const resolved = await transport.resolveSessions(target);
      if (!resolved.ok) {
        return c.json({ ok: false, error: resolved.error }, 404);
      }

      const results = [];
      for (const session of resolved.sessions) {
        const result = await transport.capture(session.sessionName, { lines: body.lines });
        results.push(result);
      }
      return c.json({ results });
    }

    // Single target: session
    if (!body.session) {
      return c.json({ error: "Provide session, rig, or pod to capture" }, 400);
    }

    const result = await transport.capture(body.session, { lines: body.lines });
    if (!result.ok) {
      return c.json(result, 404);
    }
    return c.json(result);
  });

  router.post("/broadcast", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      rig?: string;
      pod?: string;
      text: string;
      verify?: boolean;
      force?: boolean;
    }>();

    if (!body.text) {
      return c.json({ error: "Missing required field: text" }, 400);
    }

    const target: TargetSpec = body.pod
      ? { pod: body.pod, rig: body.rig }
      : body.rig
        ? { rig: body.rig }
        : { global: true };

    const result = await transport.broadcast(target, body.text, {
      verify: body.verify,
      force: body.force,
    });

    return c.json(result);
  });

  return router;
}
