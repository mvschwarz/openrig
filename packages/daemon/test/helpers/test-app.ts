import { vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { coreSchema } from "../../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../../src/db/migrations/011_bootstrap.js";
import { discoverySchema } from "../../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../../src/db/migrations/014_agentspec_reboot.js";
import { startupContextSchema } from "../../src/db/migrations/015_startup_context.js";
import { chatMessagesSchema } from "../../src/db/migrations/016_chat_messages.js";
import { podNamespaceSchema } from "../../src/db/migrations/017_pod_namespace.js";
import { contextUsageSchema } from "../../src/db/migrations/018_context_usage.js";
import { externalCliAttachmentSchema } from "../../src/db/migrations/019_external_cli_attachment.js";
import { rigServicesSchema } from "../../src/db/migrations/020_rig_services.js";
import { seatHandoverObservabilitySchema } from "../../src/db/migrations/021_seat_handover_observability.js";
import { nodeCodexConfigProfileSchema } from "../../src/db/migrations/022_node_codex_config_profile.js";
import { BootstrapRepository } from "../../src/domain/bootstrap-repository.js";
import { RuntimeVerifier } from "../../src/domain/runtime-verifier.js";
import { RequirementsProbeRegistry } from "../../src/domain/requirements-probe.js";
import { ExternalInstallPlanner } from "../../src/domain/external-install-planner.js";
import { ExternalInstallExecutor } from "../../src/domain/external-install-executor.js";
import { PackageInstallService } from "../../src/domain/package-install-service.js";
import { BootstrapOrchestrator } from "../../src/domain/bootstrap-orchestrator.js";
import { TmuxDiscoveryScanner } from "../../src/domain/tmux-discovery-scanner.js";
import { SessionFingerprinter } from "../../src/domain/session-fingerprinter.js";
import { SessionEnricher } from "../../src/domain/session-enricher.js";
import { DiscoveryRepository } from "../../src/domain/discovery-repository.js";
import { PsProjectionService } from "../../src/domain/ps-projection.js";
import { UpCommandRouter } from "../../src/domain/up-command-router.js";
import { RigTeardownOrchestrator } from "../../src/domain/rig-teardown.js";
import { DiscoveryCoordinator } from "../../src/domain/discovery-coordinator.js";
import { ClaimService } from "../../src/domain/claim-service.js";
import { SelfAttachService } from "../../src/domain/self-attach-service.js";
import { RigExpansionService } from "../../src/domain/rig-expansion-service.js";
import { ContextUsageStore } from "../../src/domain/context-usage-store.js";
import { WhoamiService } from "../../src/domain/whoami-service.js";
import { TranscriptStore } from "../../src/domain/transcript-store.js";
import { RigLifecycleService } from "../../src/domain/rig-lifecycle-service.js";
import { RigRepository } from "../../src/domain/rig-repository.js";
import { SessionRegistry } from "../../src/domain/session-registry.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { NodeLauncher } from "../../src/domain/node-launcher.js";
import { SnapshotRepository } from "../../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../../src/domain/snapshot-capture.js";
import { RestoreOrchestrator } from "../../src/domain/restore-orchestrator.js";
import { RigSpecExporter } from "../../src/domain/rigspec-exporter.js";
import { RigSpecPreflight } from "../../src/domain/rigspec-preflight.js";
import { RigInstantiator, PodRigInstantiator } from "../../src/domain/rigspec-instantiator.js";
import { PodRepository } from "../../src/domain/pod-repository.js";
import { StartupOrchestrator } from "../../src/domain/startup-orchestrator.js";
import type { RuntimeAdapter } from "../../src/domain/runtime-adapter.js";
import { ClaudeResumeAdapter } from "../../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../../src/adapters/codex-resume.js";
import { CmuxAdapter } from "../../src/adapters/cmux.js";
import type { TmuxAdapter } from "../../src/adapters/tmux.js";
import type { ExecFn } from "../../src/adapters/tmux.js";
import type { CmuxTransportFactory } from "../../src/adapters/cmux.js";
import { PackageRepository } from "../../src/domain/package-repository.js";
import { InstallRepository } from "../../src/domain/install-repository.js";
import { InstallEngine } from "../../src/domain/install-engine.js";
import { InstallVerifier } from "../../src/domain/install-verifier.js";
import { PodBundleSourceResolver } from "../../src/domain/bundle-source-resolver.js";
import { NodeCmuxService } from "../../src/domain/node-cmux-service.js";
import { AgentActivityStore } from "../../src/domain/agent-activity-store.js";
import { createApp } from "../../src/server.js";
import fs from "node:fs";

export function createFullTestDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema, startupContextSchema, chatMessagesSchema, podNamespaceSchema, contextUsageSchema, externalCliAttachmentSchema, rigServicesSchema, seatHandoverObservabilitySchema, nodeCodexConfigProfileSchema]);
  return db;
}

export function mockTmuxAdapter(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: vi.fn(async () => false),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    startPipePane: vi.fn(async () => ({ ok: true as const })),
    setSessionOption: vi.fn(async () => ({ ok: true as const })),
    getSessionOption: vi.fn(async () => null),
  } as unknown as TmuxAdapter;
}

export function unavailableCmuxAdapter(): CmuxAdapter {
  const factory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  return new CmuxAdapter(factory, { timeoutMs: 50 });
}

function readyRuntimeAdapter(runtime: string): RuntimeAdapter {
  return {
    runtime,
    listInstalled: async () => [],
    project: async () => ({ projected: [], skipped: [], failed: [] }),
    deliverStartup: async () => ({ delivered: 0, failed: [] }),
    launchHarness: async () => ({ ok: true }),
    checkReady: async () => ({ ready: true }),
  };
}

export function createTestApp(
  db: Database.Database,
  opts?: {
    cmux?: CmuxAdapter;
    tmux?: TmuxAdapter;
    adapters?: Partial<Record<string, RuntimeAdapter>>;
    activityHookToken?: string;
    activityFreshnessMs?: number;
    /**
     * Agent Starter v1 vertical M2: optional real-fs upRouter for tests
     * that POST /api/up with a YAML spec on disk. Default behavior
     * (always-false fsOps) preserved when this is omitted, so existing
     * rig-name-path tests are not affected.
     */
    upRouterFsOps?: {
      exists: (p: string) => boolean;
      readFile: (p: string) => string;
      readHead: (p: string, n: number) => Buffer;
    };
    /**
     * Agent Starter v1 vertical M2 R2: optional fsOps for the
     * PodRigInstantiator used by /api/up apply-mode tests that need
     * real agent.yaml resolution. Default (always-false) preserved.
     */
    podInstantiatorFsOps?: {
      exists: (p: string) => boolean;
      readFile: (p: string) => string;
    };
    /**
     * Agent Starter v1 vertical M2 R2: optionally expose the in-test
     * StartupOrchestrator + PodRigInstantiator so callers can spy on
     * `startNode` / inspect node_startup_context end-to-end.
     */
  },
) {
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = opts?.tmux ?? mockTmuxAdapter();
  const cmux = opts?.cmux ?? unavailableCmuxAdapter();
  const transcriptStore = new TranscriptStore("/tmp/openrig-test-transcripts");
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const claudeResume = new ClaudeResumeAdapter(tmux);
  const codexResume = new CodexResumeAdapter(tmux);
  const restoreOrchestrator = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
    checkpointStore, nodeLauncher, tmuxAdapter: tmux, claudeResume, codexResume,
  });
  const podRepo = new PodRepository(db);
  const rigSpecExporter = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo });
  const exec: ExecFn = async () => "";
  const rigSpecPreflight = new RigSpecPreflight({ rigRepo, tmuxAdapter: tmux, exec, cmuxExec: exec });
  const rigInstantiator = new RigInstantiator({ db, rigRepo, sessionRegistry, eventBus, nodeLauncher, preflight: rigSpecPreflight });

  // Phase 4: Package install services
  const packageRepo = new PackageRepository(db);
  const installRepo = new InstallRepository(db);
  const realEngineFsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, content: string) => fs.writeFileSync(p, content, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
    deleteFile: (p: string) => fs.unlinkSync(p),
  };
  const installEngine = new InstallEngine(installRepo, realEngineFsOps);
  const realVerifierFsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
  };
  const installVerifier = new InstallVerifier(installRepo, packageRepo, realVerifierFsOps);

  // Phase 5: Bootstrap services
  const bootstrapRepo = new BootstrapRepository(db);
  const runtimeVerifier = new RuntimeVerifier({ exec, db });
  const probeRegistry = new RequirementsProbeRegistry(exec);
  const externalInstallPlanner = new ExternalInstallPlanner();
  const externalInstallExecutor = new ExternalInstallExecutor({ exec, db });
  const packageInstallService = new PackageInstallService({ packageRepo, installRepo, installEngine, installVerifier });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const adapters: Record<string, RuntimeAdapter> = {
    terminal: readyRuntimeAdapter("terminal"),
    "claude-code": readyRuntimeAdapter("claude-code"),
    codex: readyRuntimeAdapter("codex"),
    ...opts?.adapters,
  };
  const podInstantiator = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
    startupOrchestrator,
    fsOps: opts?.podInstantiatorFsOps ?? { readFile: () => "", exists: () => false },
    adapters,
  });

  const bootstrapOrchestrator = new BootstrapOrchestrator({
    db, bootstrapRepo, runtimeVerifier, probeRegistry,
    installPlanner: externalInstallPlanner, installExecutor: externalInstallExecutor,
    packageInstallService, rigInstantiator, fsOps: {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
      listFiles: () => [],
    },
    bundleSourceResolver: null,
    podInstantiator,
    podBundleSourceResolver: new PodBundleSourceResolver(),
  });

  // Discovery services
  const tmuxScanner = new TmuxDiscoveryScanner({ tmuxAdapter: tmux });
  const fingerprinter = new SessionFingerprinter({
    cmuxAdapter: cmux, tmuxAdapter: tmux, fsExists: () => false,
  });
  const enricher = new SessionEnricher({ fsExists: () => false, fsReaddir: () => [] });
  const discoveryRepo = new DiscoveryRepository(db);
  const discoveryCoordinator = new DiscoveryCoordinator({
    scanner: tmuxScanner, fingerprinter, enricher, discoveryRepo, sessionRegistry, eventBus,
  });
  const claimService = new ClaimService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: tmux, transcriptStore });
  const selfAttachService = new SelfAttachService({ db, rigRepo, podRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, transcriptStore });
  const rigExpansionService = new RigExpansionService({ db, rigRepo, eventBus, nodeLauncher, podInstantiator, sessionRegistry });
  const rigLifecycleService = new RigLifecycleService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: tmux });
  const contextUsageStore = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test" });
  const whoamiService = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore, contextUsageStore });
  const nodeCmuxService = new NodeCmuxService(rigRepo, sessionRegistry, cmux);
  const agentActivityStore = new AgentActivityStore({
    db,
    eventBus,
    freshnessMs: opts?.activityFreshnessMs,
  });

  const podBundleSourceResolver = new PodBundleSourceResolver();

  const upRouterFs = opts?.upRouterFsOps ?? {
    exists: (_p: string) => false,
    readFile: (_p: string) => "",
    readHead: (_p: string, _n: number) => Buffer.alloc(0),
  };
  const upRouter = new UpCommandRouter({ fsOps: upRouterFs });

  const app = createApp({
    rigRepo, sessionRegistry, eventBus, nodeLauncher, tmuxAdapter: tmux, cmuxAdapter: cmux,
    snapshotCapture, snapshotRepo, restoreOrchestrator,
    rigSpecExporter, rigSpecPreflight, rigInstantiator,
    packageRepo, installRepo, installEngine, installVerifier,
    bootstrapOrchestrator, bootstrapRepo,
    discoveryCoordinator, discoveryRepo, claimService, selfAttachService, rigExpansionService,
    rigLifecycleService,
    psProjectionService: new PsProjectionService({ db }),
    upRouter,
    teardownOrchestrator: new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus }),
    podInstantiator,
    podBundleSourceResolver,
    contextUsageStore,
    whoamiService,
    nodeCmuxService,
    agentActivityStore,
    activityHookToken: opts?.activityHookToken,
  });
  return {
    app, rigRepo, sessionRegistry, eventBus, nodeLauncher, snapshotRepo,
    snapshotCapture, checkpointStore, restoreOrchestrator,
    rigSpecExporter, rigSpecPreflight, rigInstantiator,
    packageRepo, installRepo, installEngine, installVerifier,
    bootstrapOrchestrator, bootstrapRepo,
    discoveryCoordinator, discoveryRepo, claimService, selfAttachService, rigExpansionService, tmuxScanner,
    rigLifecycleService,
    psProjectionService: new PsProjectionService({ db }),
    upRouter,
    teardownOrchestrator: new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus }),
    podInstantiator, podBundleSourceResolver, db, tmuxAdapter: tmux,
    agentActivityStore,
    startupOrchestrator,
  };
}
