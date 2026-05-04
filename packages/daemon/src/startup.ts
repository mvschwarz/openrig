import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { ExecFn } from "./adapters/tmux.js";
import type { CmuxTransportFactory } from "./adapters/cmux.js";
import { createDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { coreSchema } from "./db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "./db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "./db/migrations/003_events.js";
import { RigRepository } from "./domain/rig-repository.js";
import { SessionRegistry } from "./domain/session-registry.js";
import { EventBus } from "./domain/event-bus.js";
import { NodeLauncher } from "./domain/node-launcher.js";
import { TmuxAdapter } from "./adapters/tmux.js";
import { CmuxAdapter } from "./adapters/cmux.js";
import { execCommand } from "./adapters/tmux-exec.js";
import { createCmuxCliTransport } from "./adapters/cmux-transport.js";
import { SnapshotRepository } from "./domain/snapshot-repository.js";
import { CheckpointStore } from "./domain/checkpoint-store.js";
import { SnapshotCapture } from "./domain/snapshot-capture.js";
import { RestoreOrchestrator } from "./domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "./adapters/claude-resume.js";
import { CodexResumeAdapter } from "./adapters/codex-resume.js";
import { RigSpecExporter } from "./domain/rigspec-exporter.js";
import { PodRepository } from "./domain/pod-repository.js";
import { RigSpecPreflight } from "./domain/rigspec-preflight.js";
import { RigInstantiator } from "./domain/rigspec-instantiator.js";
import { Reconciler } from "./domain/reconciler.js";
import { PackageRepository } from "./domain/package-repository.js";
import { InstallRepository } from "./domain/install-repository.js";
import { InstallEngine } from "./domain/install-engine.js";
import { InstallVerifier } from "./domain/install-verifier.js";
import { BootstrapRepository } from "./domain/bootstrap-repository.js";
import { RuntimeVerifier } from "./domain/runtime-verifier.js";
import { RequirementsProbeRegistry } from "./domain/requirements-probe.js";
import { ExternalInstallPlanner } from "./domain/external-install-planner.js";
import { ExternalInstallExecutor } from "./domain/external-install-executor.js";
import { PackageInstallService } from "./domain/package-install-service.js";
import { BootstrapOrchestrator } from "./domain/bootstrap-orchestrator.js";
import { TmuxDiscoveryScanner } from "./domain/tmux-discovery-scanner.js";
import { SessionFingerprinter } from "./domain/session-fingerprinter.js";
import { SessionEnricher } from "./domain/session-enricher.js";
import { DiscoveryRepository } from "./domain/discovery-repository.js";
import { DiscoveryCoordinator } from "./domain/discovery-coordinator.js";
import { ClaimService } from "./domain/claim-service.js";
import { SelfAttachService } from "./domain/self-attach-service.js";
import { RigLifecycleService } from "./domain/rig-lifecycle-service.js";
import { RigExpansionService } from "./domain/rig-expansion-service.js";
// TODO: AS-T12 — migrate to pod-aware bundle source resolver
import { LegacyBundleSourceResolver as BundleSourceResolver } from "./domain/bundle-source-resolver.js";
import { PodBundleSourceResolver } from "./domain/bundle-source-resolver.js";
import { PsProjectionService } from "./domain/ps-projection.js";
import { UpCommandRouter } from "./domain/up-command-router.js";
import { RigTeardownOrchestrator } from "./domain/rig-teardown.js";
import { ResumeMetadataRefresher } from "./domain/resume-metadata-refresher.js";
import { TranscriptStore } from "./domain/transcript-store.js";
import { SessionTransport } from "./domain/session-transport.js";
import { AgentActivityStore } from "./domain/agent-activity-store.js";
import { HistoryQuery } from "./domain/history-query.js";
import { AskService } from "./domain/ask-service.js";
import { ChatRepository } from "./domain/chat-repository.js";
import { StreamStore } from "./domain/stream-store.js";
import { QueueRepository } from "./domain/queue-repository.js";
import { InboxHandler } from "./domain/inbox-handler.js";
import { OutboxHandler } from "./domain/outbox-handler.js";
import { ProjectClassifier } from "./domain/project-classifier.js";
import { ClassifierLeaseManager } from "./domain/classifier-lease-manager.js";
import { ViewProjector } from "./domain/view-projector.js";
import { wireViewEventBridge } from "./domain/view-event-bridge.js";
import { WatchdogJobsRepository } from "./domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "./domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "./domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "./domain/watchdog-scheduler.js";
import { WorkflowRuntime } from "./domain/workflow-runtime.js";
import { makeWorkflowKeepalivePolicy } from "./domain/policies/workflow-keepalive.js";
import { SpecReviewService } from "./domain/spec-review-service.js";
import { SpecLibraryService } from "./domain/spec-library-service.js";
import { WhoamiService } from "./domain/whoami-service.js";
import { NodeCmuxService } from "./domain/node-cmux-service.js";
import { createApp, type AppDeps } from "./server.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { snapshotsSchema } from "./db/migrations/004_snapshots.js";
import { checkpointsSchema } from "./db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "./db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "./db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "./db/migrations/008_packages.js";
import { installJournalSchema } from "./db/migrations/009_install_journal.js";
import { journalSeqSchema } from "./db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "./db/migrations/011_bootstrap.js";
import { discoverySchema } from "./db/migrations/012_discovery.js";
import { discoveryFkFix } from "./db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "./db/migrations/014_agentspec_reboot.js";
import { startupContextSchema } from "./db/migrations/015_startup_context.js";
import { chatMessagesSchema } from "./db/migrations/016_chat_messages.js";
import { podNamespaceSchema } from "./db/migrations/017_pod_namespace.js";
import { contextUsageSchema } from "./db/migrations/018_context_usage.js";
import { externalCliAttachmentSchema } from "./db/migrations/019_external_cli_attachment.js";
import { rigServicesSchema } from "./db/migrations/020_rig_services.js";
import { seatHandoverObservabilitySchema } from "./db/migrations/021_seat_handover_observability.js";
import { nodeCodexConfigProfileSchema } from "./db/migrations/022_node_codex_config_profile.js";
import { streamItemsSchema } from "./db/migrations/023_stream_items.js";
import { queueItemsSchema } from "./db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "./db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "./db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "./db/migrations/027_outbox_entries.js";
import { projectClassificationsSchema } from "./db/migrations/028_project_classifications.js";
import { classifierLeasesSchema } from "./db/migrations/029_classifier_leases.js";
import { viewsCustomSchema } from "./db/migrations/030_views_custom.js";
import { watchdogJobsSchema } from "./db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "./db/migrations/032_watchdog_history.js";
import { workflowSpecsSchema } from "./db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "./db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "./db/migrations/035_workflow_step_trails.js";
import { watchdogPolicyEnumExtensionSchema } from "./db/migrations/036_watchdog_policy_enum_extension.js";
import { missionControlActionsSchema } from "./db/migrations/037_mission_control_actions.js";
import { MissionControlActionLog } from "./domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "./domain/mission-control/mission-control-write-contract.js";
import { MissionControlReadLayer } from "./domain/mission-control/mission-control-read-layer.js";
import {
  MissionControlFleetCliCapability,
  makeLocalCliCapabilityProbe,
} from "./domain/mission-control/mission-control-fleet-cli-capability.js";
import { MissionControlAuditBrowse } from "./domain/mission-control/audit-browse.js";
import { MissionControlNotificationDispatcher } from "./domain/mission-control/notification-dispatcher.js";
import { NtfyNotificationAdapter } from "./domain/mission-control/notification-adapter-ntfy.js";
import { WebhookNotificationAdapter } from "./domain/mission-control/notification-adapter-webhook.js";
import type { NotificationAdapter } from "./domain/mission-control/notification-adapter-types.js";
import { OPENRIG_HOME } from "./openrig-compat.js";
import {
  getCompatibleOpenRigPath,
  getDefaultOpenRigPath,
  readOpenRigEnv,
} from "./openrig-compat.js";

interface DaemonOptions {
  dbPath?: string;
  tmuxExec?: ExecFn;
  cmuxExec?: ExecFn;
  cmuxFactory?: CmuxTransportFactory;
  cmuxTimeoutMs?: number;
  /**
   * PL-005 Phase B: bearer token for Mission Control write verbs.
   * When null, the auth-bearer-token middleware passes through (the
   * index.ts startup-side check ensures this is only valid when bound
   * on loopback). When set, the middleware enforces constant-time
   * comparison + 401 on missing/mismatch.
   */
  bearerToken?: string | null;
}

interface DaemonResult {
  app: Hono;
  db: Database.Database;
  deps: AppDeps;
  contextMonitor: import("./domain/context-monitor.js").ContextMonitor;
}

export async function createDaemon(opts?: DaemonOptions): Promise<DaemonResult> {
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = createDb(dbPath);
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema, startupContextSchema, chatMessagesSchema, podNamespaceSchema, contextUsageSchema, externalCliAttachmentSchema, rigServicesSchema, seatHandoverObservabilitySchema, nodeCodexConfigProfileSchema, streamItemsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema, outboxEntriesSchema, projectClassificationsSchema, classifierLeasesSchema, viewsCustomSchema, watchdogJobsSchema, watchdogHistorySchema, workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema, watchdogPolicyEnumExtensionSchema, missionControlActionsSchema]);

  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  // PL-004 Phase A revision (R1): topology-backed validateRig.
  // Reject `<member>@<unknown-rig>` shapes by checking the rig portion
  // against the rig registry. Bare ids without `@` are also rejected
  // (no canonical rig binding).
  const topologyValidateRig = (sessionRef: string): boolean => {
    const m = /^[^@]+@(.+)$/.exec(sessionRef);
    if (!m) return false;
    const rigName = m[1]!;
    return rigRepo.findRigsByName(rigName).length > 0;
  };
  // PL-004 Phase A — shared coordination services. Constructed early so
  // both the queueRepo dep slot and inboxHandler can share one instance.
  // Transport is wired after SessionTransport instantiation below via
  // attachTransport().
  const queueRepoInstance = new QueueRepository(db, eventBus, {
    validateRig: topologyValidateRig,
  });
  // PL-004 Phase B — classifier lease manager. Constructed early so both
  // the leaseManager dep slot and project-classifier can share one instance.
  // isAlive is post-attached after whoami-service is constructed.
  const classifierLeaseManagerInstance = new ClassifierLeaseManager(db, eventBus);
  // PL-004 Phase B — view-projector. Constructed early so both the
  // viewProjector dep slot and the view-event-bridge can share one instance.
  const viewProjectorInstance = new ViewProjector(db, eventBus);
  // PL-004 Phase B R1 (closes guard BLOCKER 2): wire the view event bridge
  // so queue/inbox/project mutations emit view.changed for affected built-in
  // views. SSE consumers on /api/views/:name/sse now receive change events
  // when underlying state mutates.
  wireViewEventBridge(eventBus, viewProjectorInstance);

  // PL-004 Phase C — watchdog supervision tree. Repository + history-log
  // are constructed early; the policy engine + scheduler are constructed
  // after SessionTransport is available so the engine can wire delivery.
  const watchdogJobsRepoInstance = new WatchdogJobsRepository(db);
  const watchdogHistoryLogInstance = new WatchdogHistoryLog(db);

  const tmuxAdapter = new TmuxAdapter(opts?.tmuxExec ?? execCommand);
  // cmuxFactory takes precedence (for tests), then cmuxExec-based CLI transport, then default
  const cmuxFactory = opts?.cmuxFactory
    ?? createCmuxCliTransport(opts?.cmuxExec ?? execCommand);
  const cmuxAdapter = new CmuxAdapter(
    cmuxFactory,
    { timeoutMs: opts?.cmuxTimeoutMs ?? 5000 }
  );

  // Read transcript config from env (passed by CLI via PNS-T02 config surface)
  const transcriptsEnabled = readOpenRigEnv("OPENRIG_TRANSCRIPTS_ENABLED", "RIGGED_TRANSCRIPTS_ENABLED") !== "false";
  const transcriptsPath = readOpenRigEnv("OPENRIG_TRANSCRIPTS_PATH", "RIGGED_TRANSCRIPTS_PATH") || undefined;
  const activityHookToken = readOpenRigEnv("OPENRIG_ACTIVITY_HOOK_TOKEN", "RIGGED_ACTIVITY_HOOK_TOKEN") || undefined;
  const activityHookUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL") || undefined;
  const openRigPort = readOpenRigEnv("OPENRIG_PORT", "RIGGED_PORT") || undefined;
  const openRigHost = readOpenRigEnv("OPENRIG_HOST", "RIGGED_HOST") || undefined;
  const transcriptStore = new TranscriptStore({
    enabled: transcriptsEnabled,
    transcriptsRoot: transcriptsPath,
  });

  const nodeLauncher = new NodeLauncher({
    db,
    rigRepo,
    sessionRegistry,
    eventBus,
    tmuxAdapter,
    transcriptStore,
    sessionEnv: {
      PATH: process.env.PATH,
      OPENRIG_HOME,
      OPENRIG_PORT: openRigPort,
      OPENRIG_HOST: openRigHost,
      OPENRIG_URL: activityHookUrl,
      OPENRIG_ACTIVITY_HOOK_TOKEN: activityHookToken,
    },
  });

  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const claudeResume = new ClaudeResumeAdapter(tmuxAdapter);
  const codexResume = new CodexResumeAdapter(tmuxAdapter);
  // Services infrastructure (RigEnv) — created early so restore/bootstrap can use it
  const { ComposeServicesAdapter } = await import("./adapters/compose-services-adapter.js");
  const { ServiceOrchestrator } = await import("./domain/service-orchestrator.js");
  const composeAdapter = new ComposeServicesAdapter(opts?.tmuxExec ?? execCommand);
  const serviceOrchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter });

  const restoreOrchestrator = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
    checkpointStore, nodeLauncher, tmuxAdapter, claudeResume, codexResume,
    transcriptStore, serviceOrchestrator,
  });

  // Connect to cmux at startup — degrades gracefully if absent
  await cmuxAdapter.connect();

  // Reconcile all managed rigs — marks stale sessions as detached.
  // Capture aggregate counts and log a compact summary so cold-start truth
  // repair is visible in daemon output instead of silently swallowed.
  const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter });
  const rigs = rigRepo.listRigs();
  let reconcileChecked = 0;
  let reconcileDetached = 0;
  let reconcileErrors = 0;
  for (const rig of rigs) {
    try {
      const result = await reconciler.reconcile(rig.id);
      reconcileChecked += result.checked;
      reconcileDetached += result.detached;
      reconcileErrors += result.errors.length;
      for (const e of result.errors) {
        try {
          // eslint-disable-next-line no-console
          console.warn(`startup reconcile warning: rig=${rig.id} session=${e.sessionId} error=${e.error}`);
        } catch { /* logging must never throw */ }
      }
    } catch (err) {
      reconcileErrors += 1;
      try {
        // eslint-disable-next-line no-console
        console.warn(`startup reconcile warning: rig=${rig.id} error=${err instanceof Error ? err.message : String(err)}`);
      } catch { /* logging must never throw */ }
    }
  }
  try {
    // eslint-disable-next-line no-console
    console.log(`startup reconcile: rigs=${rigs.length} checked=${reconcileChecked} detached=${reconcileDetached} errors=${reconcileErrors}`);
  } catch { /* logging must never throw */ }

  const podRepo = new PodRepository(db);
  const rigSpecExporter = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo });
  const rigSpecPreflight = new RigSpecPreflight({
    rigRepo, tmuxAdapter, exec: opts?.tmuxExec ?? execCommand, cmuxExec: opts?.cmuxExec ?? execCommand,
  });
  const rigInstantiator = new RigInstantiator({
    db, rigRepo, sessionRegistry, eventBus, nodeLauncher, preflight: rigSpecPreflight, tmuxAdapter,
  });

  // Phase 4: Package install services
  const packageRepo = new PackageRepository(db);
  const installRepo = new InstallRepository(db);
  const engineFsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, content: string) => fs.writeFileSync(p, content, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
    deleteFile: (p: string) => fs.unlinkSync(p),
  };
  const installEngine = new InstallEngine(installRepo, engineFsOps);
  const verifierFsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
  };
  const installVerifier = new InstallVerifier(installRepo, packageRepo, verifierFsOps);

  // Phase 5: Bootstrap services
  const bootstrapRepo = new BootstrapRepository(db);
  const exec = opts?.tmuxExec ?? execCommand;
  const runtimeVerifier = new RuntimeVerifier({ exec, db });
  const probeRegistry = new RequirementsProbeRegistry(exec);
  const externalInstallPlanner = new ExternalInstallPlanner();
  const externalInstallExecutor = new ExternalInstallExecutor({ exec, db });
  const packageInstallService = new PackageInstallService({ packageRepo, installRepo, installEngine, installVerifier });
  const resolverFsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    listFiles: (dirPath: string) => {
      const results: string[] = [];
      function walk(dir: string, prefix: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(nodePath.join(dir, entry.name), nodePath.join(prefix, entry.name));
          else results.push(prefix ? nodePath.join(prefix, entry.name) : entry.name);
        }
      }
      walk(dirPath, "");
      return results;
    },
  };
  const bundleSourceResolver = new BundleSourceResolver({ fsOps: resolverFsOps });
  // Pod-aware instantiator (AgentSpec reboot)
  const { PodRigInstantiator } = await import("./domain/rigspec-instantiator.js");
  const { StartupOrchestrator } = await import("./domain/startup-orchestrator.js");
  const { ClaudeCodeAdapter } = await import("./adapters/claude-code-adapter.js");
  const { CodexRuntimeAdapter } = await import("./adapters/codex-runtime-adapter.js");

  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter, readFile: (p: string) => fs.readFileSync(p, "utf-8") });
  const activityHookRelayAssetPath = nodePath.resolve(import.meta.dirname, "../assets/openrig-activity-hook-relay.cjs");
  const claudeAdapter = new ClaudeCodeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; }, readdir: (dir: string) => fs.readdirSync(dir), homedir: os.homedir() }, stateDir: OPENRIG_HOME, collectorAssetPath: nodePath.resolve(import.meta.dirname, "../assets/claude-statusline-context.cjs"), activityHookRelayAssetPath });
  const codexAdapter = new CodexRuntimeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; } }, activityHookRelayAssetPath });

  const podInstantiator = new PodRigInstantiator({
    db, rigRepo, podRepo,
    sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
    adapters: { "claude-code": claudeAdapter, "codex": codexAdapter, "terminal": new (await import("./adapters/terminal-adapter.js")).TerminalAdapter() },
    tmuxAdapter,
  });

  const podBundleSourceResolver = new PodBundleSourceResolver();

  const bootstrapOrchestrator = new BootstrapOrchestrator({
    db, bootstrapRepo, runtimeVerifier, probeRegistry,
    installPlanner: externalInstallPlanner, installExecutor: externalInstallExecutor,
    packageInstallService, rigInstantiator, fsOps: resolverFsOps,
    bundleSourceResolver, podInstantiator, podBundleSourceResolver,
    serviceOrchestrator, rigRepo,
  });

  // Discovery services
  const tmuxScanner = new TmuxDiscoveryScanner({ tmuxAdapter });
  const sessionFingerprinter = new SessionFingerprinter({
    cmuxAdapter, tmuxAdapter, fsExists: (p: string) => fs.existsSync(p),
  });
  const sessionEnricher = new SessionEnricher({
    fsExists: (p: string) => fs.existsSync(p),
    fsReaddir: (p: string) => fs.readdirSync(p),
  });
  const discoveryRepo = new DiscoveryRepository(db);
  const discoveryCoordinator = new DiscoveryCoordinator({
    scanner: tmuxScanner, fingerprinter: sessionFingerprinter, enricher: sessionEnricher,
    discoveryRepo, sessionRegistry, eventBus,
  });
  const resumeMetadataRefresher = new ResumeMetadataRefresher({ sessionRegistry, tmuxAdapter });
  const claimService = new ClaimService({
    db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter, transcriptStore,
    claudeContextProvisioner: claudeAdapter,
  });
  const selfAttachService = new SelfAttachService({
    db, rigRepo, podRepo, sessionRegistry, eventBus, tmuxAdapter, transcriptStore,
    claudeContextProvisioner: claudeAdapter,
  });
  const rigLifecycleService = new RigLifecycleService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter });
  const rigExpansionService = new RigExpansionService({ db, rigRepo, eventBus, nodeLauncher, podInstantiator, sessionRegistry });

  const specReviewService = new SpecReviewService();

  // Context usage store — created before deps so it can be threaded through WhoamiService + routes
  const { ContextUsageStore } = await import("./domain/context-usage-store.js");
  const contextUsageStore = new ContextUsageStore(db, { stateDir: OPENRIG_HOME });
  const whoamiService = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore, contextUsageStore });
  const nodeCmuxService = new NodeCmuxService(rigRepo, sessionRegistry, cmuxAdapter);
  const agentActivityStore = new AgentActivityStore({ db, eventBus });

  const deps: AppDeps = {
    rigRepo,
    sessionRegistry,
    eventBus,
    nodeLauncher,
    tmuxAdapter,
    cmuxAdapter,
    snapshotCapture,
    snapshotRepo,
    restoreOrchestrator,
    rigSpecExporter,
    rigSpecPreflight,
    rigInstantiator,
    packageRepo,
    installRepo,
    installEngine,
    installVerifier,
    bootstrapOrchestrator,
    bootstrapRepo,
    discoveryCoordinator,
    discoveryRepo,
    claimService,
    selfAttachService,
    rigLifecycleService,
    rigExpansionService,
    psProjectionService: new PsProjectionService({ db }),
    upRouter: new UpCommandRouter({
      fsOps: {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        readHead: (p: string, bytes: number) => { const fd = fs.openSync(p, "r"); const buf = Buffer.alloc(bytes); fs.readSync(fd, buf, 0, bytes, 0); fs.closeSync(fd); return buf; },
      },
    }),
    teardownOrchestrator: new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry, tmuxAdapter, snapshotCapture, eventBus, resumeMetadataRefresher, serviceOrchestrator,
    }),
    podInstantiator,
    podBundleSourceResolver,
    runtimeAdapters: { "claude-code": claudeAdapter, "codex": codexAdapter, "terminal": new (await import("./adapters/terminal-adapter.js")).TerminalAdapter() },
    transcriptStore,
    sessionTransport: (() => {
      const t = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter, agentActivityStore });
      // PL-004 Phase A revision (R1): wire QueueRepository's wake-path so
      // create / handoff / handoff-and-complete nudge by default.
      queueRepoInstance.attachTransport(t);
      // PL-004 Phase B: wire classifier-lease-manager liveness check from
      // the sessions table. Lease holder is "alive" iff there is at least
      // one row in `sessions` with session_name == classifierSession AND
      // status == 'running'.
      classifierLeaseManagerInstance.attachIsAlive((classifierSession: string): boolean => {
        try {
          const row = db
            .prepare(
              `SELECT 1 FROM sessions WHERE session_name = ? AND status = 'running' LIMIT 1`,
            )
            .get(classifierSession) as { 1: number } | undefined;
          return row !== undefined;
        } catch {
          // Conservative: on lookup error, treat as alive (do not falsely
          // trigger deadness-based lease expiry).
          return true;
        }
      });
      return t;
    })(),
    chatRepo: new ChatRepository(db),
    streamStore: new StreamStore(db, eventBus),
    queueRepo: queueRepoInstance,
    inboxHandler: new InboxHandler(db, eventBus, queueRepoInstance),
    outboxHandler: new OutboxHandler(db),
    classifierLeaseManager: classifierLeaseManagerInstance,
    projectClassifier: new ProjectClassifier(db, eventBus, classifierLeaseManagerInstance),
    viewProjector: viewProjectorInstance,
    watchdogJobsRepo: watchdogJobsRepoInstance,
    watchdogHistoryLog: watchdogHistoryLogInstance,
    askService: (() => {
      const psProjectionService = new PsProjectionService({ db });
      const execDep = (cmd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> =>
        new Promise((resolve) => {
          execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err && typeof (err as NodeJS.ErrnoException).code === "string" && (err as NodeJS.ErrnoException).code === "ENOENT") {
              resolve({ stdout: "", exitCode: 2 });
              return;
            }
            const exitCode = err ? (err as { code?: number }).code ?? 1 : 0;
            resolve({ stdout: stdout ?? "", exitCode: typeof exitCode === "number" ? exitCode : 1 });
          });
        });
      const chatRepoForAsk = new ChatRepository(db);
      const historyQuery = new HistoryQuery({
        transcriptsRoot: transcriptStore.enabled
          ? (transcriptsPath ?? getCompatibleOpenRigPath("transcripts"))
          : getCompatibleOpenRigPath("transcripts"),
        exec: execDep,
        chatSearchFn: (rigId: string, pattern: string) =>
          chatRepoForAsk.searchChat(rigId, pattern).map((m) => ({
            sender: m.sender,
            body: m.body,
            createdAt: m.createdAt,
          })),
      });
      return new AskService({
        psProjectionService,
        rigRepo,
        historyQuery,
        transcriptsEnabled: transcriptStore.enabled,
        whoamiService,
      });
    })(),
    whoamiService,
    nodeCmuxService,
    agentActivityStore,
    activityHookToken,
    contextUsageStore,
    serviceOrchestrator,
    composeAdapter,
    specReviewService,
    specLibraryService: (() => {
      const userSpecsRoot = getDefaultOpenRigPath("specs");
      const legacySpecsRoot = getCompatibleOpenRigPath("specs");
      try { fs.mkdirSync(userSpecsRoot, { recursive: true }); } catch { /* best-effort */ }
      // From src/ or dist/, ../specs points to packages/daemon/specs/
      const builtinSpecsRoot = nodePath.resolve(import.meta.dirname, "../specs");
      const roots: Array<{ path: string; sourceType: "builtin" | "user_file" }> = [
        { path: userSpecsRoot, sourceType: "user_file" },
      ];
      if (legacySpecsRoot !== userSpecsRoot && fs.existsSync(legacySpecsRoot)) {
        roots.push({ path: legacySpecsRoot, sourceType: "user_file" });
      }
      // Only add builtin root if it exists
      if (fs.existsSync(builtinSpecsRoot)) {
        roots.unshift({ path: builtinSpecsRoot, sourceType: "builtin" });
      }
      const lib = new SpecLibraryService({ roots, specReviewService });
      lib.scan();
      return lib;
    })(),
  };

  // Copy bundled reference docs to ~/.openrig/reference/ so agents can find them at a stable path
  try {
    const bundledDocsDir = nodePath.resolve(import.meta.dirname, "../docs/reference");
    if (fs.existsSync(bundledDocsDir)) {
      const referenceDir = getDefaultOpenRigPath("reference");
      fs.mkdirSync(referenceDir, { recursive: true });
      for (const file of fs.readdirSync(bundledDocsDir)) {
        if (file.endsWith(".md")) {
          fs.copyFileSync(nodePath.join(bundledDocsDir, file), nodePath.join(referenceDir, file));
        }
      }
    }
  } catch { /* best-effort — reference docs are not critical to daemon operation */ }

  // PL-004 Phase C — watchdog policy engine + scheduler. Wired here
  // (after deps construction) so the engine can dispatch deliveries
  // through the live SessionTransport. Scheduler is started by
  // index.ts after listen() so the daemon's HTTP surface is ready
  // before the scheduler's first tick.
  // PL-004 Phase D — workflow runtime + workflow-keepalive policy.
  // Workflow runtime is constructed first; then the watchdog policy
  // engine is constructed with workflow-keepalive injected via
  // additionalPolicies (orch-ratified Phase D extension point per
  // slice IMPL § Write Set / § Driver Handoff Contract).
  const queueRepoForWorkflow = deps.queueRepo;
  let workflowRuntime: WorkflowRuntime | undefined;
  if (queueRepoForWorkflow) {
    workflowRuntime = new WorkflowRuntime({
      db,
      eventBus,
      queueRepo: queueRepoForWorkflow,
    });
    deps.workflowRuntime = workflowRuntime;

    // RSI v2 starter v0: seed built-in starter workflow_specs into the
    // cache. Idempotent + workspace-surface-respecting — operator
    // overrides at workspace paths are preserved (skip-if-cached).
    // Errors are collected into the result for diagnostic logging but
    // do NOT block startup; a malformed bundled spec should not bring
    // the daemon down.
    const { loadStarterWorkflowSpecs, defaultBuiltinSpecsDir } = await import(
      "./domain/workflow/starter-spec-loader.js"
    );
    const builtinSpecsDir = defaultBuiltinSpecsDir();
    const starterResult = loadStarterWorkflowSpecs({
      cache: workflowRuntime.specCache,
      builtinDir: builtinSpecsDir,
    });
    // Surface the resolved path to the routes layer so
    // GET /api/workflow/specs can compute the per-row isBuiltIn flag.
    deps.workflowBuiltinSpecsDir = builtinSpecsDir;
    if (starterResult.errors.length > 0) {
      console.warn(
        `[starter-spec-loader] ${starterResult.errors.length} spec(s) failed to load:`,
        starterResult.errors,
      );
    }
  }

  // PL-005 Phase A: Mission Control / Queue Observability services.
  // Wired AFTER WorkflowRuntime so all PL-004 daemon-backed coordination
  // surfaces are available. Mission Control reads from queue/view/stream
  // surfaces and writes through the atomic 7-verb contract.
  if (deps.queueRepo && deps.viewProjector) {
    const mcActionLog = new MissionControlActionLog(db);
    const mcWriteContract = new MissionControlWriteContract({
      db,
      eventBus,
      queueRepo: deps.queueRepo,
      actionLog: mcActionLog,
    });
    const mcFleetCliCapability = new MissionControlFleetCliCapability({
      db,
      eventBus,
      rigRepo,
      // R1 fix per guard PL-005 Phase A review: wire the production
      // capability probe so /api/mission-control/cli-capabilities
      // honestly reports drift when MISSION_CONTROL_DESIRED_FIELDS
      // are missing from the local CLI's allow-list. Without this
      // probe injection, the production path defaulted to a no-op
      // that always reported staleCliCount=0 even when the audit-
      // row-5 case (recoveryGuidance not in CLI allow-list) was
      // present.
      probeRig: makeLocalCliCapabilityProbe(),
    });
    const mcReadLayer = new MissionControlReadLayer({
      db,
      queueRepo: deps.queueRepo,
      viewProjector: deps.viewProjector,
      streamStore: deps.streamStore,
      fleetCliCapability: mcFleetCliCapability,
    });
    deps.missionControlActionLog = mcActionLog;
    deps.missionControlWriteContract = mcWriteContract;
    deps.missionControlFleetCliCapability = mcFleetCliCapability;
    deps.missionControlReadLayer = mcReadLayer;

    // PL-005 Phase B: audit-history browse layer (read-only) +
    // notification dispatcher + bearer-token plumbing.
    const mcAuditBrowse = new MissionControlAuditBrowse(db);
    deps.missionControlAuditBrowse = mcAuditBrowse;

    // Bearer token from createDaemon options is propagated to the
    // routes constructor via deps so the auth middleware is mounted
    // at route mount time (not per-request).
    deps.missionControlBearerToken = opts?.bearerToken ?? null;

    // Notification dispatcher: chosen mechanism via env config.
    // OPENRIG_NOTIFICATIONS_MECHANISM=ntfy|webhook|none (default none).
    // OPENRIG_NOTIFICATIONS_TARGET=<topic url | webhook url>.
    // OPENRIG_NOTIFICATIONS_INCLUDE_VERB_COMPLETION=1 to opt into the
    // verb-completion trigger (default off; only human-gate arrivals
    // trigger by default per planner brief).
    // No legacy alias for these env vars (new in Phase B).
    const mechanism = process.env.OPENRIG_NOTIFICATIONS_MECHANISM ?? "none";
    const target = process.env.OPENRIG_NOTIFICATIONS_TARGET ?? "";
    const missionControlBaseUrl =
      process.env.OPENRIG_MISSION_CONTROL_BASE_URL ??
      process.env.OPENRIG_URL ??
      process.env.RIGGED_URL;
    const includeVerbCompletion =
      process.env.OPENRIG_NOTIFICATIONS_INCLUDE_VERB_COMPLETION === "1";
    if (mechanism !== "none" && target.length > 0) {
      let adapter: NotificationAdapter;
      if (mechanism === "ntfy") {
        adapter = new NtfyNotificationAdapter({ topicUrl: target });
      } else if (mechanism === "webhook") {
        adapter = new WebhookNotificationAdapter({ endpointUrl: target });
      } else {
        throw new Error(
          `OPENRIG_NOTIFICATIONS_MECHANISM='${mechanism}' is not recognized; supported: ntfy | webhook | none`,
        );
      }
      const dispatcher = new MissionControlNotificationDispatcher({
        db,
        eventBus,
        adapter,
        includeVerbCompletion,
        missionControlBaseUrl,
      });
      dispatcher.start();
      deps.missionControlNotificationDispatcher = dispatcher;
    }
  }

  // Slice Story View v0 — slice indexer + per-tab projector.
  //
  // Configured via env (single-host MVP; no per-rig override at v0):
  //   OPENRIG_SLICES_ROOT             absolute path to slices folder root
  //   OPENRIG_DOGFOOD_EVIDENCE_ROOT   absolute path to dogfood-evidence root
  //
  // When OPENRIG_SLICES_ROOT is unset, the indexer is still constructed
  // but isReady() returns false — the routes return a clear
  // "slices_root_not_configured" 503 with a setup hint, so the operator
  // can wire the env vars without daemon-restart-debug-loop.
  {
    const slicesRoot = readOpenRigEnv("OPENRIG_SLICES_ROOT", "RIGGED_SLICES_ROOT") ?? "";
    const dogfoodRoot = readOpenRigEnv("OPENRIG_DOGFOOD_EVIDENCE_ROOT", "RIGGED_DOGFOOD_EVIDENCE_ROOT") ?? "";
    const { SliceIndexer } = await import("./domain/slices/slice-indexer.js");
    const { SliceDetailProjector } = await import("./domain/slices/slice-detail-projector.js");
    const sliceIndexer = new SliceIndexer({
      slicesRoot,
      dogfoodEvidenceRoot: dogfoodRoot || null,
      db,
    });
    const sliceDetailProjector = new SliceDetailProjector({ db, indexer: sliceIndexer });
    deps.sliceIndexer = sliceIndexer;
    deps.sliceDetailProjector = sliceDetailProjector;
  }

  // UI Enhancement Pack v0:
  //   - file allowlist (item 3) from OPENRIG_FILES_ALLOWLIST
  //   - atomic write service (item 4) wired only when allowlist non-empty
  //   - progress scan-roots (item 1B) from OPENRIG_PROGRESS_SCAN_ROOTS
  //
  // Empty env → empty allowlist / no-roots indexer; routes return 503
  // with structured config hints so the UI can surface a setup message
  // instead of a generic error.
  {
    const { readAllowlistFromEnv } = await import("./domain/files/path-safety.js");
    const { FileWriteService } = await import("./domain/files/file-write-service.js");
    const { ProgressIndexer, readProgressRootsFromEnv } = await import("./domain/progress/progress-indexer.js");
    const filesAllowlist = readAllowlistFromEnv();
    deps.filesAllowlist = filesAllowlist;
    deps.fileWriteService = filesAllowlist.length > 0
      ? new FileWriteService({ allowlist: filesAllowlist })
      : null;
    deps.progressIndexer = new ProgressIndexer({ roots: readProgressRootsFromEnv() });
  }

  const sessionTransport = deps.sessionTransport;
  if (sessionTransport) {
    const watchdogPolicyEngine = new WatchdogPolicyEngine({
      jobsRepo: watchdogJobsRepoInstance,
      historyLog: watchdogHistoryLogInstance,
      eventBus,
      deliver: async ({ targetSession, message }) => {
        try {
          const result = await sessionTransport.send(targetSession, message);
          return result.ok ? { status: "ok" } : { status: "failed", error: result.error };
        } catch (err) {
          return { status: "failed", error: err instanceof Error ? err.message : String(err) };
        }
      },
      // PL-004 Phase D: register workflow-keepalive policy alongside
      // Phase C's three built-in policies. workflow-keepalive reads
      // SQLite workflow_instances directly via the new Phase D tables
      // (audit row 18: SQLite-source-only, no markdown read).
      additionalPolicies: [makeWorkflowKeepalivePolicy({ db })],
    });
    const watchdogScheduler = new WatchdogScheduler({
      jobsRepo: watchdogJobsRepoInstance,
      policyEngine: watchdogPolicyEngine,
    });
    deps.watchdogPolicyEngine = watchdogPolicyEngine;
    deps.watchdogScheduler = watchdogScheduler;
  }

  // Context monitor — constructed before createApp so routes can access pollOnce for refresh.
  // Caller (index.ts) starts polling after listen.
  const { ContextMonitor } = await import("./domain/context-monitor.js");
  const contextMonitor = new ContextMonitor(db, contextUsageStore, claudeAdapter);
  deps.contextMonitor = contextMonitor;

  const app = createApp(deps);

  return { app, db, deps, contextMonitor };
}
