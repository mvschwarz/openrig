import { Hono } from "hono";
import type { RigRepository } from "./domain/rig-repository.js";
import type { SessionRegistry } from "./domain/session-registry.js";
import type { EventBus } from "./domain/event-bus.js";
import type { NodeLauncher } from "./domain/node-launcher.js";
import type { TmuxAdapter } from "./adapters/tmux.js";
import type { CmuxAdapter } from "./adapters/cmux.js";
import { rigsRoutes } from "./routes/rigs.js";
import { sessionsRoutes, nodesRoutes } from "./routes/sessions.js";
import { adaptersRoutes } from "./routes/adapters.js";
import { eventsRoute } from "./routes/events.js";

export interface AppDeps {
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  tmuxAdapter: TmuxAdapter;
  cmuxAdapter: CmuxAdapter;
}

export function createApp(deps: AppDeps): Hono {
  // Hard runtime invariant: all domain services must share the same db handle.
  // Routes that use atomic transactions across services depend on this.
  if (deps.rigRepo.db !== deps.eventBus.db) {
    throw new Error("createApp: rigRepo and eventBus must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.sessionRegistry.db) {
    throw new Error("createApp: rigRepo and sessionRegistry must share the same db handle");
  }

  const app = new Hono();

  // Inject dependencies into context for all routes
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, deps.rigRepo);
    c.set("sessionRegistry" as never, deps.sessionRegistry);
    c.set("eventBus" as never, deps.eventBus);
    c.set("nodeLauncher" as never, deps.nodeLauncher);
    c.set("tmuxAdapter" as never, deps.tmuxAdapter);
    c.set("cmuxAdapter" as never, deps.cmuxAdapter);
    await next();
  });

  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  app.route("/api/rigs", rigsRoutes);
  app.route("/api/rigs/:rigId/sessions", sessionsRoutes);
  app.route("/api/rigs/:rigId/nodes", nodesRoutes);
  app.route("/api/adapters", adaptersRoutes);
  app.route("/api/events", eventsRoute);

  return app;
}
