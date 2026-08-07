import { Hono } from "hono";
import type { WakeResolveService } from "../domain/wake-resolve-service.js";

export const wakeResolveRoutes = new Hono();

// L3b — resolve a seat[@generation] to a resume token (or a refuse-and-teach
// listing) for `rig ask --wake <seat>`. Read-only; no execution here (the CLI
// runs the wake with the returned token).
wakeResolveRoutes.post("/", async (c) => {
  const svc = c.get("wakeResolveService" as never) as WakeResolveService;
  const body = await c.req.json<{ seat?: string; generation?: number }>().catch(() => ({}) as { seat?: string; generation?: number });

  if (!body.seat) {
    return c.json({ error: "Missing required field: seat" }, 400);
  }

  return c.json(svc.resolve(body.seat, body.generation));
});
