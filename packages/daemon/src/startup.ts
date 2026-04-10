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
import { HistoryQuery } from "./domain/history-query.js";
import { AskService } from "./domain/ask-service.js";
import { ChatRepository } from "./domain/chat-repository.js";
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
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema, startupContextSchema, chatMessagesSchema, podNamespaceSchema, contextUsageSchema, externalCliAttachmentSchema, rigServicesSchema]);

  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);

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

  // Reconcile all managed rigs — marks stale sessions as detached
  const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter });
  const rigs = rigRepo.listRigs();
  for (const rig of rigs) {
    await reconciler.reconcile(rig.id);
  }

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
  const claudeAdapter = new ClaudeCodeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; }, readdir: (dir: string) => fs.readdirSync(dir), homedir: os.homedir() }, stateDir: OPENRIG_HOME, collectorAssetPath: nodePath.resolve(import.meta.dirname, "../assets/claude-statusline-context.cjs") });
  const codexAdapter = new CodexRuntimeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; } } });

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
    sessionTransport: new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter }),
    chatRepo: new ChatRepository(db),
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

  const app = createApp(deps);

  // Context monitor — caller (index.ts) starts polling after listen
  const { ContextMonitor } = await import("./domain/context-monitor.js");
  const contextMonitor = new ContextMonitor(db, contextUsageStore, claudeAdapter);

  return { app, db, deps, contextMonitor };
}
