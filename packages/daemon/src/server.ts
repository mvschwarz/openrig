import { Hono } from "hono";
import type { RigRepository } from "./domain/rig-repository.js";
import { rigsRoutes } from "./routes/rigs.js";

export interface AppDeps {
  rigRepo: RigRepository;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Inject dependencies into context for all routes
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, deps.rigRepo);
    await next();
  });

  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  app.route("/api/rigs", rigsRoutes);

  return app;
}
