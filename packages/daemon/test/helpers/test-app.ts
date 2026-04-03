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
import { podNamespaceSchema } from "../../src/db/migrations/017_pod_namespace.js";
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
import { createApp } from "../../src/server.js";
import fs from "node:fs";

export function createFullTestDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema, startupContextSchema, podNamespaceSchema]);
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
  } as unknown as TmuxAdapter;
}

export function unavailableCmuxAdapter(): CmuxAdapter {
  const factory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  return new CmuxAdapter(factory, { timeoutMs: 50 });
}

export function createTestApp(db: Database.Database, opts?: { cmux?: CmuxAdapter; tmux?: TmuxAdapter }) {
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = opts?.tmux ?? mockTmuxAdapter();
  const cmux = opts?.cmux ?? unavailableCmuxAdapter();
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
  const mockAdapter = {
    runtime: "claude-code",
    listInstalled: async () => [],
    project: async () => ({ projected: [], skipped: [], failed: [] }),
    deliverStartup: async () => ({ delivered: 0, failed: [] }),
    checkReady: async () => ({ ready: true }),
  };
  const podInstantiator = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
    startupOrchestrator,
    fsOps: { readFile: () => "", exists: () => false },
    adapters: { "claude-code": mockAdapter, "codex": { ...mockAdapter, runtime: "codex" } },
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
  const claimService = new ClaimService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus });

  const podBundleSourceResolver = new PodBundleSourceResolver();

  const app = createApp({
    rigRepo, sessionRegistry, eventBus, nodeLauncher, tmuxAdapter: tmux, cmuxAdapter: cmux,
    snapshotCapture, snapshotRepo, restoreOrchestrator,
    rigSpecExporter, rigSpecPreflight, rigInstantiator,
    packageRepo, installRepo, installEngine, installVerifier,
    bootstrapOrchestrator, bootstrapRepo,
    discoveryCoordinator, discoveryRepo, claimService,
    psProjectionService: new PsProjectionService({ db }),
    upRouter: new UpCommandRouter({ fsOps: { exists: () => false, readFile: () => "", readHead: () => Buffer.alloc(0) } }),
    teardownOrchestrator: new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus }),
    podInstantiator,
    podBundleSourceResolver,
  });
  return {
    app, rigRepo, sessionRegistry, eventBus, nodeLauncher, snapshotRepo,
    snapshotCapture, checkpointStore, restoreOrchestrator,
    rigSpecExporter, rigSpecPreflight, rigInstantiator,
    packageRepo, installRepo, installEngine, installVerifier,
    bootstrapOrchestrator, bootstrapRepo,
    discoveryCoordinator, discoveryRepo, claimService, tmuxScanner,
    psProjectionService: new PsProjectionService({ db }),
    upRouter: new UpCommandRouter({ fsOps: { exists: () => false, readFile: () => "", readHead: () => Buffer.alloc(0) } }),
    teardownOrchestrator: new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus }),
    podInstantiator, podBundleSourceResolver, db,
  };
}
