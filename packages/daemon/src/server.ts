import { Hono } from "hono";
import type { RigRepository } from "./domain/rig-repository.js";
import type { SessionRegistry } from "./domain/session-registry.js";
import type { EventBus } from "./domain/event-bus.js";
import type { NodeLauncher } from "./domain/node-launcher.js";
import type { TmuxAdapter } from "./adapters/tmux.js";
import type { CmuxAdapter } from "./adapters/cmux.js";
import type { SnapshotCapture } from "./domain/snapshot-capture.js";
import type { SnapshotRepository } from "./domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "./domain/restore-orchestrator.js";
import type { RigSpecExporter } from "./domain/rigspec-exporter.js";
import type { RigSpecPreflight } from "./domain/rigspec-preflight.js";
import type { RigInstantiator } from "./domain/rigspec-instantiator.js";
import { rigsRoutes } from "./routes/rigs.js";
import { sessionsRoutes, nodesRoutes } from "./routes/sessions.js";
import { adaptersRoutes } from "./routes/adapters.js";
import { eventsRoute } from "./routes/events.js";
import { snapshotsRoutes, restoreRoutes } from "./routes/snapshots.js";
import { handleExportYaml, handleExportJson, rigspecImportRoutes } from "./routes/rigspec.js";

export interface AppDeps {
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  tmuxAdapter: TmuxAdapter;
  cmuxAdapter: CmuxAdapter;
  snapshotCapture: SnapshotCapture;
  snapshotRepo: SnapshotRepository;
  restoreOrchestrator: RestoreOrchestrator;
  rigSpecExporter: RigSpecExporter;
  rigSpecPreflight: RigSpecPreflight;
  rigInstantiator: RigInstantiator;
}

export function createApp(deps: AppDeps): Hono {
  // Hard runtime invariant: all domain services must share the same db handle.
  if (deps.rigRepo.db !== deps.eventBus.db) {
    throw new Error("createApp: rigRepo and eventBus must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.sessionRegistry.db) {
    throw new Error("createApp: rigRepo and sessionRegistry must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.snapshotRepo.db) {
    throw new Error("createApp: snapshotRepo must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.snapshotCapture.db) {
    throw new Error("createApp: snapshotCapture must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.restoreOrchestrator.db) {
    throw new Error("createApp: restoreOrchestrator must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.rigSpecExporter.db) {
    throw new Error("createApp: rigSpecExporter must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.rigSpecPreflight.db) {
    throw new Error("createApp: rigSpecPreflight must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.rigInstantiator.db) {
    throw new Error("createApp: rigInstantiator must share the same db handle");
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
    c.set("snapshotCapture" as never, deps.snapshotCapture);
    c.set("snapshotRepo" as never, deps.snapshotRepo);
    c.set("restoreOrchestrator" as never, deps.restoreOrchestrator);
    c.set("rigSpecExporter" as never, deps.rigSpecExporter);
    c.set("rigSpecPreflight" as never, deps.rigSpecPreflight);
    c.set("rigInstantiator" as never, deps.rigInstantiator);
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
  app.route("/api/rigs/:rigId/snapshots", snapshotsRoutes);
  app.route("/api/rigs/:rigId/restore", restoreRoutes);
  app.route("/api/rigs/import", rigspecImportRoutes);
  app.get("/api/rigs/:rigId/spec", handleExportYaml);
  app.get("/api/rigs/:rigId/spec.json", handleExportJson);

  return app;
}
