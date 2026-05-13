import { Hono } from "hono";
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
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
import type { RigInstantiator, PodRigInstantiator } from "./domain/rigspec-instantiator.js";
import type { PodBundleSourceResolver } from "./domain/bundle-source-resolver.js";
import type { PackageRepository } from "./domain/package-repository.js";
import type { InstallRepository } from "./domain/install-repository.js";
import type { InstallEngine } from "./domain/install-engine.js";
import type { InstallVerifier } from "./domain/install-verifier.js";
import type { BootstrapOrchestrator } from "./domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "./domain/bootstrap-repository.js";
import type { DiscoveryCoordinator } from "./domain/discovery-coordinator.js";
import type { DiscoveryRepository } from "./domain/discovery-repository.js";
import type { ClaimService } from "./domain/claim-service.js";
import type { SelfAttachService } from "./domain/self-attach-service.js";
import { rigsRoutes } from "./routes/rigs.js";
import { sessionsRoutes, nodesRoutes, sessionAdminRoutes } from "./routes/sessions.js";
import { adaptersRoutes } from "./routes/adapters.js";
import { eventsRoute } from "./routes/events.js";
import { snapshotsRoutes, restoreRoutes } from "./routes/snapshots.js";
import { handleExportYaml, handleExportJson, rigspecImportRoutes } from "./routes/rigspec.js";
import { packagesRoutes } from "./routes/packages.js";
import { bootstrapRoutes } from "./routes/bootstrap.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { bundleRoutes } from "./routes/bundles.js";
import { restoreCheckRoutes } from "./routes/restore-check.js";
import { agentsRoutes } from "./routes/agents.js";
import { psRoutes } from "./routes/ps.js";
import type { PsProjectionService } from "./domain/ps-projection.js";
import type { UpCommandRouter } from "./domain/up-command-router.js";
import type { RigTeardownOrchestrator } from "./domain/rig-teardown.js";
import { upRoutes } from "./routes/up.js";
import { downRoutes } from "./routes/down.js";
import { kernelStatusRoutes } from "./routes/kernel-status.js";
import type { TranscriptStore } from "./domain/transcript-store.js";
import type { SessionTransport } from "./domain/session-transport.js";
import type { AgentActivityStore } from "./domain/agent-activity-store.js";
import { transcriptRoutes } from "./routes/transcripts.js";
import { transportRoutes } from "./routes/transport.js";
import { activityRoutes } from "./routes/activity.js";
import { askRoutes } from "./routes/ask.js";
import type { AskService } from "./domain/ask-service.js";
import { specReviewRoutes } from "./routes/spec-review.js";
import { specLibraryRoutes } from "./routes/spec-library.js";
// Phase 3a slice 3.3 — plugin discovery routes (read-only).
// SC-29 EXCEPTION #8 verbatim: see packages/daemon/src/routes/plugins.ts
// header for full declaration.
import { pluginsRoutes } from "./routes/plugins.js";
import type { PluginDiscoveryService } from "./domain/plugin-discovery-service.js";
// Slice 28 Checkpoint C-3 — skill-library discovery routes (read-only).
// SC-29 EXCEPTION #11 cumulative; full declaration in routes/plugins.ts header.
import { skillsRoutes } from "./routes/skills.js";
import type { SkillLibraryDiscoveryService } from "./domain/skill-library-discovery.js";
import { configRoutes } from "./routes/config.js";
import { contextPacksRoutes } from "./routes/context-packs.js";
import { agentImagesRoutes } from "./routes/agent-images.js";
import type { SpecReviewService } from "./domain/spec-review-service.js";
import type { SpecLibraryService } from "./domain/spec-library-service.js";
import type { ChatRepository } from "./domain/chat-repository.js";
import { whoamiRoutes } from "./routes/whoami.js";
import type { WhoamiService } from "./domain/whoami-service.js";
import { chatRoutes } from "./routes/chat.js";
import { streamRoutes } from "./routes/stream.js";
import { queueRoutes } from "./routes/queue.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { projectsRoutes } from "./routes/projects.js";
import { viewsRoutes } from "./routes/views.js";
import { watchdogRoutes } from "./routes/watchdog.js";
import { workflowRoutes } from "./routes/workflow.js";
import { missionControlRoutes } from "./routes/mission-control.js";
import { slicesRoutes } from "./routes/slices.js";
import { missionsRoutes } from "./routes/missions.js";
import { rigCmuxRoutes } from "./routes/rig-cmux.js";
import { CmuxLayoutService } from "./domain/cmux-layout-service.js";
import { getNodeInventory } from "./domain/node-inventory.js";
import { filesRoutes } from "./routes/files.js";
import { progressRoutes } from "./routes/progress.js";
import { steeringRoutes } from "./routes/steering.js";
import { healthSummaryRoutes } from "./routes/health-summary.js";
import type { StreamStore } from "./domain/stream-store.js";
import type { QueueRepository } from "./domain/queue-repository.js";
import type { InboxHandler } from "./domain/inbox-handler.js";
import type { OutboxHandler } from "./domain/outbox-handler.js";
import type { ProjectClassifier } from "./domain/project-classifier.js";
import type { ClassifierLeaseManager } from "./domain/classifier-lease-manager.js";
import type { ViewProjector } from "./domain/view-projector.js";
import type { WatchdogJobsRepository } from "./domain/watchdog-jobs-repository.js";
import type { WatchdogHistoryLog } from "./domain/watchdog-history-log.js";
import type { WatchdogPolicyEngine } from "./domain/watchdog-policy-engine.js";
import type { WatchdogScheduler } from "./domain/watchdog-scheduler.js";
import type { WorkflowRuntime } from "./domain/workflow-runtime.js";
import { envRoutes } from "./routes/env.js";
import type { RigLifecycleService } from "./domain/rig-lifecycle-service.js";
import { seatRoutes } from "./routes/seat.js";

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
  selfAttachService?: SelfAttachService;
  rigExpansionService?: import("./domain/rig-expansion-service.js").RigExpansionService;
  rigLifecycleService?: RigLifecycleService;
  psProjectionService: PsProjectionService;
  upRouter: UpCommandRouter;
  teardownOrchestrator: RigTeardownOrchestrator;
  podInstantiator: PodRigInstantiator;
  podBundleSourceResolver: PodBundleSourceResolver | null;
  runtimeAdapters?: Record<string, import("./domain/runtime-adapter.js").RuntimeAdapter>;
  transcriptStore?: TranscriptStore;
  sessionTransport?: SessionTransport;
  askService?: AskService;
  chatRepo?: ChatRepository;
  streamStore?: StreamStore;
  queueRepo?: QueueRepository;
  inboxHandler?: InboxHandler;
  outboxHandler?: OutboxHandler;
  projectClassifier?: ProjectClassifier;
  classifierLeaseManager?: ClassifierLeaseManager;
  viewProjector?: ViewProjector;
  watchdogJobsRepo?: WatchdogJobsRepository;
  watchdogHistoryLog?: WatchdogHistoryLog;
  watchdogPolicyEngine?: WatchdogPolicyEngine;
  watchdogScheduler?: WatchdogScheduler;
  workflowRuntime?: WorkflowRuntime;
  /**
   * Absolute path to the daemon's bundled built-in workflow-specs
   * directory. Used by `GET /api/workflow/specs` to
   * compute the per-row `isBuiltIn` flag (source_path under this dir
   * → built-in; otherwise → operator-authored). Optional: when unset,
   * the route returns isBuiltIn=false for every spec (graceful — the
   * surface still works, just without the indicator).
   */
  workflowBuiltinSpecsDir?: string;
  /** Slice 11 (workflow-spec-folder-discovery) — workspace workflows
   *  folder absolute path (typically `<workspace.specs_root>/workflows`).
   *  When set, GET /api/specs/library opportunistically scans this dir
   *  on each list request and surfaces valid + diagnostic rows. Unset
   *  → no folder scan (cache-only behavior). */
  workflowsFolderDir?: string;
  /** Slice 11 — WorkflowSpecCache instance for the folder scanner to
   *  read-through valid YAML and writeDiagnostic for invalid YAML.
   *  Same singleton as workflowRuntime.specCache. */
  workflowSpecCache?: import("./domain/workflow-spec-cache.js").WorkflowSpecCache;
  missionControlReadLayer?: import("./domain/mission-control/mission-control-read-layer.js").MissionControlReadLayer;
  missionControlWriteContract?: import("./domain/mission-control/mission-control-write-contract.js").MissionControlWriteContract;
  missionControlActionLog?: import("./domain/mission-control/mission-control-action-log.js").MissionControlActionLog;
  missionControlFleetCliCapability?: import("./domain/mission-control/mission-control-fleet-cli-capability.js").MissionControlFleetCliCapability;
  // Slice Story View v0 — slice indexer + per-tab projector. Both
  // optional: when slicesRoot is unset, the routes return a clear
  // "slices_root_not_configured" 503 so the UI can surface a setup hint.
  sliceIndexer?: import("./domain/slices/slice-indexer.js").SliceIndexer;
  sliceDetailProjector?: import("./domain/slices/slice-detail-projector.js").SliceDetailProjector;
  /** User Settings v0 — daemon-side settings store (env > file > default). */
  settingsStore?: import("./domain/user-settings/settings-store.js").SettingsStore;
  /** Preview Terminal v0 (PL-018) — per-session rate limiter for /preview. */
  previewRateLimiter?: import("./domain/preview/preview-rate-limiter.js").PreviewRateLimiter<{
    content: string;
    lines: number;
    sessionName: string;
    capturedAt: string;
  }>;
  /** UI Enhancement Pack v0 — file allowlist + browser routes (item 3). */
  filesAllowlist?: import("./domain/files/path-safety.js").AllowlistRoot[];
  /** UI Enhancement Pack v0 — atomic write service (item 4). */
  fileWriteService?: import("./domain/files/file-write-service.js").FileWriteService | null;
  /** UI Enhancement Pack v0 — workspace PROGRESS.md indexer (item 1B). */
  progressIndexer?: import("./domain/progress/progress-indexer.js").ProgressIndexer;
  /** Operator Surface Reconciliation v0 — steering composer (item 1). */
  steeringComposer?: import("./domain/steering/steering-composer.js").SteeringComposer;
  missionControlAuditBrowse?: import("./domain/mission-control/audit-browse.js").MissionControlAuditBrowse;
  missionControlNotificationDispatcher?: import("./domain/mission-control/notification-dispatcher.js").MissionControlNotificationDispatcher;
  /**
   * PL-005 Phase B: bearer token (or null for loopback-only mode).
   * The mission-control routes use this to wire the
   * authBearerTokenMiddleware on write verbs.
   */
  missionControlBearerToken?: string | null;
  specReviewService?: SpecReviewService;
  specLibraryService?: SpecLibraryService;
  /**
   * Phase 3a slice 3.3 — plugin discovery service (filesystem-scan over
   * vendored + claude-cache + codex-cache; reads agent.yaml for used-by).
   * Read-only; no SQL. SC-29 #8 verbatim declaration in routes/plugins.ts.
   */
  pluginDiscoveryService?: PluginDiscoveryService;
  /**
   * Slice 28 Checkpoint C-3 — skill-library discovery service.
   * Consolidates workspace + openrig-managed skill sources; resolves
   * shared-skills via daemon install path (independent of operator's
   * OPENRIG_FILES_ALLOWLIST). Read-only; no SQL. SC-29 #11.
   */
  skillLibraryDiscoveryService?: SkillLibraryDiscoveryService;
  /** Workflows in Spec Library v0 — active workflow lens persistence. */
  activeLensStore?: import("./domain/active-lens-store.js").ActiveLensStore;
  /** Rig Context / Composable Context Injection v0 (PL-014) — context_packs library service. */
  contextPackLibrary?: import("./domain/context-packs/context-pack-library-service.js").ContextPackLibraryService;
  /** Fork Primitive + Starter Agent Images v0 (PL-016) — agent_images library service. */
  agentImageLibrary?: import("./domain/agent-images/agent-image-library-service.js").AgentImageLibraryService;
  /** Fork Primitive + Starter Agent Images v0 (PL-016) — snapshot capturer. */
  snapshotCapturer?: import("./domain/agent-images/snapshot-capturer.js").SnapshotCapturer;
  /** PL-016 evidence-guard spec-roots (lazy supplier — recomputed
   *  per scan so newly-installed specs get picked up). */
  agentImageSpecRoots?: () => readonly string[];
  whoamiService?: WhoamiService;
  contextUsageStore?: import("./domain/context-usage-store.js").ContextUsageStore;
  contextMonitor?: { pollOnce(): Promise<void> };
  nodeCmuxService?: import("./domain/node-cmux-service.js").NodeCmuxService;
  agentActivityStore?: AgentActivityStore;
  activityHookToken?: string;
  serviceOrchestrator?: import("./domain/service-orchestrator.js").ServiceOrchestrator;
  composeAdapter?: import("./adapters/compose-services-adapter.js").ComposeServicesAdapter;
  uiDistDir?: string | null;
  /** V0.3.1 slice 05 kernel-rig-as-default — forward-fix #3 architectural.
   *  Tracker exposed via GET /api/kernel/status. Optional because tests
   *  + custom daemon compositions may construct AppDeps without auto-
   *  booting the kernel; the route returns 503 with a clear message
   *  when the tracker isn't wired. */
  kernelBootTracker?: import("./domain/kernel-boot-tracker.js").KernelBootTracker;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveDefaultUiDistDir(): string {
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}

function safeResolveUiPath(uiDistDir: string, requestPath: string): string | null {
  const relativePath = requestPath.replace(/^\/+/, "") || "index.html";
  const resolvedPath = nodePath.resolve(uiDistDir, relativePath);
  const normalizedRoot = uiDistDir.endsWith(nodePath.sep) ? uiDistDir : `${uiDistDir}${nodePath.sep}`;
  if (resolvedPath !== uiDistDir && !resolvedPath.startsWith(normalizedRoot)) {
    return null;
  }
  return resolvedPath;
}

function fileResponse(filePath: string): Response {
  const ext = nodePath.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const body = fs.readFileSync(filePath);
  return new Response(body, {
    headers: {
      "content-type": contentType,
    },
  });
}

function isUiAssetRequestPath(requestPath: string): boolean {
  const relativePath = requestPath.replace(/^\/+/, "");
  return relativePath.startsWith("assets/")
    || relativePath === "favicon.ico"
    || relativePath === "robots.txt"
    || relativePath === "manifest.webmanifest";
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
  if (deps.selfAttachService && deps.rigRepo.db !== deps.selfAttachService.db) {
    throw new Error("createApp: selfAttachService must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.psProjectionService.db) {
    throw new Error("createApp: psProjectionService must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.teardownOrchestrator.db) {
    throw new Error("createApp: teardownOrchestrator must share the same db handle");
  }
  if (deps.rigRepo.db !== deps.podInstantiator.db) {
    throw new Error("createApp: podInstantiator must share the same db handle");
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
    // Slice 24 — per-rig CMUX workspace launcher wiring.
    c.set(
      "cmuxLayoutService" as never,
      new CmuxLayoutService(deps.cmuxAdapter),
    );
    c.set(
      "nodeInventoryFn" as never,
      (rigId: string) => getNodeInventory(deps.rigRepo.db, rigId),
    );
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
    c.set("selfAttachService" as never, deps.selfAttachService);
    c.set("rigExpansionService" as never, deps.rigExpansionService);
    c.set("rigLifecycleService" as never, deps.rigLifecycleService);
    c.set("psProjectionService" as never, deps.psProjectionService);
    c.set("upRouter" as never, deps.upRouter);
    c.set("teardownOrchestrator" as never, deps.teardownOrchestrator);
    c.set("podInstantiator" as never, deps.podInstantiator);
    c.set("podBundleSourceResolver" as never, deps.podBundleSourceResolver);
    c.set("runtimeAdapters" as never, deps.runtimeAdapters ?? {});
    c.set("transcriptStore" as never, deps.transcriptStore);
    c.set("sessionTransport" as never, deps.sessionTransport);
    c.set("askService" as never, deps.askService);
    c.set("chatRepo" as never, deps.chatRepo);
    c.set("streamStore" as never, deps.streamStore);
    c.set("queueRepo" as never, deps.queueRepo);
    c.set("inboxHandler" as never, deps.inboxHandler);
    c.set("outboxHandler" as never, deps.outboxHandler);
    c.set("projectClassifier" as never, deps.projectClassifier);
    c.set("classifierLeaseManager" as never, deps.classifierLeaseManager);
    c.set("viewProjector" as never, deps.viewProjector);
    c.set("watchdogJobsRepo" as never, deps.watchdogJobsRepo);
    c.set("watchdogHistoryLog" as never, deps.watchdogHistoryLog);
    c.set("watchdogPolicyEngine" as never, deps.watchdogPolicyEngine);
    c.set("watchdogScheduler" as never, deps.watchdogScheduler);
    c.set("workflowRuntime" as never, deps.workflowRuntime);
    c.set("workflowBuiltinSpecsDir" as never, deps.workflowBuiltinSpecsDir);
    c.set("workflowsFolderDir" as never, deps.workflowsFolderDir);
    c.set("workflowSpecCache" as never, deps.workflowSpecCache);
    c.set("missionControlReadLayer" as never, deps.missionControlReadLayer);
    c.set("missionControlWriteContract" as never, deps.missionControlWriteContract);
    c.set("missionControlActionLog" as never, deps.missionControlActionLog);
    c.set("missionControlFleetCliCapability" as never, deps.missionControlFleetCliCapability);
    c.set("sliceIndexer" as never, deps.sliceIndexer);
    c.set("sliceDetailProjector" as never, deps.sliceDetailProjector);
    c.set("filesAllowlist" as never, deps.filesAllowlist);
    c.set("settingsStore" as never, deps.settingsStore);
    c.set("previewRateLimiter" as never, deps.previewRateLimiter);
    c.set("fileWriteService" as never, deps.fileWriteService);
    c.set("progressIndexer" as never, deps.progressIndexer);
    c.set("steeringComposer" as never, deps.steeringComposer);
    c.set("missionControlAuditBrowse" as never, deps.missionControlAuditBrowse);
    c.set("missionControlNotificationDispatcher" as never, deps.missionControlNotificationDispatcher);
    c.set("specReviewService" as never, deps.specReviewService);
    c.set("specLibraryService" as never, deps.specLibraryService);
    c.set("pluginDiscoveryService" as never, deps.pluginDiscoveryService);
    c.set("skillLibraryDiscoveryService" as never, deps.skillLibraryDiscoveryService);
    c.set("activeLensStore" as never, deps.activeLensStore);
    c.set("contextPackLibrary" as never, deps.contextPackLibrary);
    c.set("agentImageLibrary" as never, deps.agentImageLibrary);
    c.set("snapshotCapturer" as never, deps.snapshotCapturer);
    c.set("whoamiService" as never, deps.whoamiService);
    c.set("contextUsageStore" as never, deps.contextUsageStore);
    c.set("contextMonitor" as never, deps.contextMonitor);
    c.set("nodeCmuxService" as never, deps.nodeCmuxService);
    c.set("agentActivityStore" as never, deps.agentActivityStore);
    c.set("activityHookToken" as never, deps.activityHookToken);
    c.set("serviceOrchestrator" as never, deps.serviceOrchestrator);
    c.set("composeAdapter" as never, deps.composeAdapter);
    c.set("kernelBootTracker" as never, deps.kernelBootTracker);
    c.set("db" as never, deps.rigRepo.db);
    await next();
  });

  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  app.route("/api/rigs", rigsRoutes);
  app.route("/api/rigs/:rigId/sessions", sessionsRoutes);
  // Slice 24 — per-rig CMUX workspace launcher.
  app.route("/api/rigs/:rigId/cmux", rigCmuxRoutes);
  app.route("/api/rigs/:rigId/nodes", nodesRoutes);
  app.route("/api/sessions", sessionAdminRoutes);
  app.route("/api/adapters", adaptersRoutes);
  app.route("/api/events", eventsRoute);
  app.route("/api/rigs/:rigId/snapshots", snapshotsRoutes);
  app.route("/api/rigs/:rigId/restore", restoreRoutes);
  app.route("/api/rigs/import", rigspecImportRoutes);
  app.get("/api/rigs/:rigId/spec", handleExportYaml);
  app.get("/api/rigs/:rigId/spec.json", handleExportJson);
  app.route("/api/packages", packagesRoutes);
  app.route("/api/agents", agentsRoutes);
  app.route("/api/bootstrap", bootstrapRoutes);
  app.route("/api/discovery", discoveryRoutes);
  app.route("/api/bundles", bundleRoutes);
  app.route("/api/ps", psRoutes);
  app.route("/api/up", upRoutes);
  app.route("/api/down", downRoutes);
  app.route("/api/kernel", kernelStatusRoutes);
  app.route("/api/transcripts", transcriptRoutes());
  app.route("/api/transport", transportRoutes());
  app.route("/api/activity", activityRoutes);
  app.route("/api/ask", askRoutes);
  app.route("/api/specs/review", specReviewRoutes());
  app.route("/api/specs/library", specLibraryRoutes());
  app.route("/api/plugins", pluginsRoutes());
  // Slice 28 C-3 — skill-library + per-skill file endpoints (SC-29 #11).
  app.route("/api/skills", skillsRoutes());
  app.route("/api/config", configRoutes());
  app.route("/api/context-packs", contextPacksRoutes());
  app.route("/api/agent-images", agentImagesRoutes({
    specRoots: deps.agentImageSpecRoots ?? (() => []),
  }));
  app.route("/api/whoami", whoamiRoutes());
  app.route("/api/seat", seatRoutes);
  app.route("/api/rigs/:rigId/chat", chatRoutes());
  app.route("/api/stream", streamRoutes());
  app.route("/api/queue", queueRoutes());
  app.route("/api/workspace", workspaceRoutes());
  app.route("/api/projects", projectsRoutes());
  app.route("/api/views", viewsRoutes());
  app.route("/api/watchdog", watchdogRoutes());
  app.route("/api/workflow", workflowRoutes());
  app.route(
    "/api/mission-control",
    missionControlRoutes({ bearerToken: deps.missionControlBearerToken ?? null }),
  );
  // Slice Story View v0 — slice indexer + per-tab payload routes.
  app.route("/api/slices", slicesRoutes());
  // V0.3.1 slice 12 walk-item 1 — mission scope data layer
  // (aggregated mission metadata + slices filter; pairs with
  // useScopeMarkdown for README / PROGRESS content via /api/files/read).
  app.route("/api/missions", missionsRoutes());
  // UI Enhancement Pack v0 — files (item 3 + item 4) + progress (item 1B) routes.
  app.route("/api/files", filesRoutes());
  app.route("/api/progress", progressRoutes());
  // Operator Surface Reconciliation v0 — steering composition + health summary.
  app.route("/api/steering", steeringRoutes());
  app.route("/api/health-summary", healthSummaryRoutes());
  app.route("/api/rigs/:rigId/env", envRoutes());
  app.route("/api/restore-check", restoreCheckRoutes);

  const uiDistDir = deps.uiDistDir ?? resolveDefaultUiDistDir();
  const uiIndexPath = nodePath.join(uiDistDir, "index.html");
  const hasUiBundle = !!uiDistDir && fs.existsSync(uiIndexPath);

  app.get("*", (c) => {
    const requestPath = c.req.path;

    if (requestPath === "/healthz" || requestPath.startsWith("/api/")) {
      return c.notFound();
    }

    if (!hasUiBundle) {
      return c.notFound();
    }

    const requestedFile = safeResolveUiPath(uiDistDir, requestPath);
    if (requestedFile && fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
      return fileResponse(requestedFile);
    }

    if (isUiAssetRequestPath(requestPath)) {
      return c.notFound();
    }

    return fileResponse(uiIndexPath);
  });

  return app;
}
