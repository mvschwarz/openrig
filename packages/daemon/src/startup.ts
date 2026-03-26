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
import { createApp, type AppDeps } from "./server.js";
import fs from "node:fs";
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
}

export async function createDaemon(opts?: DaemonOptions): Promise<DaemonResult> {
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = createDb(dbPath);
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema]);

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

  const nodeLauncher = new NodeLauncher({
    db,
    rigRepo,
    sessionRegistry,
    eventBus,
    tmuxAdapter,
  });

  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const claudeResume = new ClaudeResumeAdapter(tmuxAdapter);
  const codexResume = new CodexResumeAdapter(tmuxAdapter);
  const restoreOrchestrator = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
    checkpointStore, nodeLauncher, tmuxAdapter, claudeResume, codexResume,
  });

  // Connect to cmux at startup — degrades gracefully if absent
  await cmuxAdapter.connect();

  // Reconcile all managed rigs — marks stale sessions as detached
  const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter });
  const rigs = rigRepo.listRigs();
  for (const rig of rigs) {
    await reconciler.reconcile(rig.id);
  }

  const rigSpecExporter = new RigSpecExporter({ rigRepo, sessionRegistry });
  const rigSpecPreflight = new RigSpecPreflight({
    rigRepo, tmuxAdapter, exec: opts?.tmuxExec ?? execCommand, cmuxExec: opts?.cmuxExec ?? execCommand,
  });
  const rigInstantiator = new RigInstantiator({
    db, rigRepo, sessionRegistry, eventBus, nodeLauncher, preflight: rigSpecPreflight,
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
  const bootstrapOrchestrator = new BootstrapOrchestrator({
    db, bootstrapRepo, runtimeVerifier, probeRegistry,
    installPlanner: externalInstallPlanner, installExecutor: externalInstallExecutor,
    packageInstallService, rigInstantiator, fsOps: resolverFsOps,
  });

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
  };

  const app = createApp(deps);

  return { app, db, deps };
}
