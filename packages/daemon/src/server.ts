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
import type { PackageRepository } from "./domain/package-repository.js";
import type { InstallRepository } from "./domain/install-repository.js";
import type { InstallEngine } from "./domain/install-engine.js";
import type { InstallVerifier } from "./domain/install-verifier.js";
import type { BootstrapOrchestrator } from "./domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "./domain/bootstrap-repository.js";
import type { DiscoveryCoordinator } from "./domain/discovery-coordinator.js";
import type { DiscoveryRepository } from "./domain/discovery-repository.js";
import type { ClaimService } from "./domain/claim-service.js";
import { rigsRoutes } from "./routes/rigs.js";
import { sessionsRoutes, nodesRoutes } from "./routes/sessions.js";
import { adaptersRoutes } from "./routes/adapters.js";
import { eventsRoute } from "./routes/events.js";
import { snapshotsRoutes, restoreRoutes } from "./routes/snapshots.js";
import { handleExportYaml, handleExportJson, rigspecImportRoutes } from "./routes/rigspec.js";
import { packagesRoutes } from "./routes/packages.js";
import { bootstrapRoutes } from "./routes/bootstrap.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { bundleRoutes } from "./routes/bundles.js";
import { psRoutes } from "./routes/ps.js";
import type { PsProjectionService } from "./domain/ps-projection.js";
import type { UpCommandRouter } from "./domain/up-command-router.js";
import type { RigTeardownOrchestrator } from "./domain/rig-teardown.js";
import { upRoutes } from "./routes/up.js";
import { downRoutes } from "./routes/down.js";

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
  packageRepo: PackageRepository;
  installRepo: InstallRepository;
  installEngine: InstallEngine;
  installVerifier: InstallVerifier;
  bootstrapOrchestrator: BootstrapOrchestrator;
  bootstrapRepo: BootstrapRepository;
  discoveryCoordinator: DiscoveryCoordinator;
  discoveryRepo: DiscoveryRepository;
  claimService: ClaimService;
  psProjectionService: PsProjectionService;
  upRouter: UpCommandRouter;
  teardownOrchestrator: RigTeardownOrchestrator;
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
  if (deps.rigRepo.db !== deps.packageRepo.db) {
    throw new Error("createApp: packageRepo must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.installRepo.db) {
    throw new Error("createApp: installRepo must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.bootstrapRepo.db) {
    throw new Error("createApp: bootstrapRepo must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.discoveryRepo.db) {
    throw new Error("createApp: discoveryRepo must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.claimService.db) {
    throw new Error("createApp: claimService must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.psProjectionService.db) {
    throw new Error("createApp: psProjectionService must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.teardownOrchestrator.db) {
    throw new Error("createApp: teardownOrchestrator must share the same db handle");
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
    c.set("packageRepo" as never, deps.packageRepo);
    c.set("installRepo" as never, deps.installRepo);
    c.set("installEngine" as never, deps.installEngine);
    c.set("installVerifier" as never, deps.installVerifier);
    c.set("bootstrapOrchestrator" as never, deps.bootstrapOrchestrator);
    c.set("bootstrapRepo" as never, deps.bootstrapRepo);
    c.set("discoveryCoordinator" as never, deps.discoveryCoordinator);
    c.set("discoveryRepo" as never, deps.discoveryRepo);
    c.set("claimService" as never, deps.claimService);
    c.set("psProjectionService" as never, deps.psProjectionService);
    c.set("upRouter" as never, deps.upRouter);
    c.set("teardownOrchestrator" as never, deps.teardownOrchestrator);
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
  app.route("/api/packages", packagesRoutes);
  app.route("/api/bootstrap", bootstrapRoutes);
  app.route("/api/discovery", discoveryRoutes);
  app.route("/api/bundles", bundleRoutes);
  app.route("/api/ps", psRoutes);
  app.route("/api/up", upRoutes);
  app.route("/api/down", downRoutes);

  return app;
}
