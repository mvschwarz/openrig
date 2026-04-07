import { Hono } from "hono";
import { WhoamiService, WhoamiAmbiguousError } from "../domain/whoami-service.js";

export function whoamiRoutes(): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    const svc = c.get("whoamiService" as never) as WhoamiService;
    const nodeId = c.req.query("nodeId");
    const sessionName = c.req.query("sessionName");

    if (!nodeId && !sessionName) {
      return c.json({
        error: "Missing query parameter: provide nodeId or sessionName. Run rig ps --nodes to find available sessions.",
      }, 400);
    }

    try {
      const result = svc.resolve({ nodeId: nodeId ?? undefined, sessionName: sessionName ?? undefined });

      if (!result) {
        const identifier = nodeId ?? sessionName;
        return c.json({
          error: `Session or node '${identifier}' not found in any managed rig. Check available sessions with: rig ps --nodes`,
        }, 404);
      }

      return c.json(result);
    } catch (err) {
      if (err instanceof WhoamiAmbiguousError) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return router;
}
