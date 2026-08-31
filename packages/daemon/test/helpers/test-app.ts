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
import { nodePermissionPolicySchema } from "../../src/db/migrations/055_node_permission_policy.js";
import { rigPermissionPolicySchema } from "../../src/db/migrations/056_rig_permission_policy.js";
import { nodePolicyProvenanceSchema } from "../../src/db/migrations/057_node_policy_provenance.js";
import { rigPolicyProvenanceSchema } from "../../src/db/migrations/058_rig_policy_provenance.js";
import { selfHostIdentitySchema } from "../../src/db/migrations/059_self_host_identity.js";
import { occupantTenuresSchema } from "../../src/db/migrations/060_occupant_tenures.js";
import { daemonLifecycleSchema } from "../../src/db/migrations/061_daemon_lifecycle.js";
import { watchdogJobsSchema } from "../../src/db/migrations/031_watchdog_jobs.js";
import { occupantGenerationStampsSchema } from "../../src/db/migrations/063_occupant_generation_stamps.js";
import { projectionManifestSchema } from "../../src/db/migrations/064_projection_manifest.js";
import { watchdogTargetGenerationSchema } from "../../src/db/migrations/066_watchdog_target_generation.js";
import { appliedLaunchObservationsSchema } from "../../src/db/migrations/069_applied_launch_observations.js";
import { appliedLaunchObservationInvalidationsSchema } from "../../src/db/migrations/070_applied_launch_observation_invalidations.js";
import { threadSeatMapSchema } from "../../src/db/migrations/072_thread_seat_map.js";
import { queueTransitionWakesSchema } from "../../src/db/migrations/073_queue_transition_wakes.js";
import { nodeCodexConfigProfileSchema } from "../../src/db/migrations/022_node_codex_config_profile.js";
import { nodeSessionSourceSchema } from "../../src/db/migrations/077_node_session_source.js";
// PL-019: GET /api/rigs/:id/graph + GET /api/rigs/:rigId/nodes/:logicalId
// now perform a read-side join over queue_items (in-progress qitem
// ownership per session). The route returns 500 if the table is absent,
// so the integration harness needs the queue migrations through 025.
import { streamItemsSchema } from "../../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../../src/db/migrations/025_queue_transitions.js";
import { rigPolicySchema } from "../../src/db/migrations/041_rig_policy.js";
import { rigArchiveSchema } from "../../src/db/migrations/042_rig_archive.js";
import { resumeProvenanceSchema } from "../../src/db/migrations/043_resume_provenance.js";
import { resumeVerificationSchema } from "../../src/db/migrations/045_resume_verification.js";
import { seatIdentityVerdictsSchema } from "../../src/db/migrations/046_seat_identity_verdicts.js";
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

/** Seam B R6: the canonical full-fixture migration list, exported so file-backed
 *  DB-reopen tests migrate IDENTICALLY to createFullTestDb. */
export const migrationsForFullTestDb = [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema, startupContextSchema, chatMessagesSchema, podNamespaceSchema, contextUsageSchema, externalCliAttachmentSchema, rigServicesSchema, seatHandoverObservabilitySchema, nodeCodexConfigProfileSchema, nodePermissionPolicySchema, rigPermissionPolicySchema, nodePolicyProvenanceSchema, rigPolicyProvenanceSchema, streamItemsSchema, queueItemsSchema, queueTransitionsSchema, rigPolicySchema, rigArchiveSchema, resumeProvenanceSchema, resumeVerificationSchema, seatIdentityVerdictsSchema, selfHostIdentitySchema, occupantTenuresSchema, daemonLifecycleSchema, watchdogJobsSchema, occupantGenerationStampsSchema, projectionManifestSchema, watchdogTargetGenerationSchema, appliedLaunchObservationsSchema, appliedLaunchObservationInvalidationsSchema, threadSeatMapSchema, queueTransitionWakesSchema, nodeSessionSourceSchema];

/**
 * P24 — the DECLARED exclusions for {@link migrationsForFullTestDb}. That list is deliberately a
 * schema-MINIMAL core-topology DB (node / rig / session / pod / discovery / stream / queue items+
 * transitions / projection) shared by ~135 suites; each per-subsystem table below is a shipped
 * migration intentionally omitted so the shared fixture stays lean. The exclusion is SAFE evidence,
 * not a guess: the fixture omits these AND all ~135 consumers pass, which proves no createFullTestDb
 * consumer reads them — a subsystem that needs its table migrates that migration in its own suite's
 * inline list. The P24 guard (migration-fixture-parity.test.ts) fails LOUD if a shipped migration is
 * neither in the list above nor declared here (the 064/066/067 silent-omission tax).
 *
 * TO RE-EVALUATE any entry: check whether a createFullTestDb consumer now reads that table/column
 * (e.g. a new shared read). If one does, the migration must MOVE INTO migrationsForFullTestDb (delete
 * its exclusion); the guard's redundant-exclusion check then keeps the two in sync.
 */
export const migrationsForFullTestDbExclusions: Record<string, string> = {
  "026_inbox_entries.sql": "inbox subsystem table — not on the shared core edge (inbox suites migrate it inline).",
  "027_outbox_entries.sql": "outbox subsystem table — not on the shared core edge (outbox suites migrate it inline).",
  "028_project_classifications.sql": "project-classification subsystem table — classifier suites migrate it inline.",
  "029_classifier_leases.sql": "project-classification subsystem table — classifier-lease suites migrate it inline.",
  "030_views_custom.sql": "custom-views subsystem table — views suites migrate it inline.",
  "032_watchdog_history.sql": "watchdog history table — watchdog suites migrate it inline (watchdog_jobs is the only watchdog base the core edge carries).",
  "033_workflow_specs.sql": "workflow subsystem table — workflow-* suites migrate the workflow schema inline.",
  "034_workflow_instances.sql": "workflow subsystem table — workflow-* suites migrate the workflow schema inline.",
  "035_workflow_step_trails.sql": "workflow subsystem table — workflow-* suites migrate the workflow schema inline.",
  "036_watchdog_policy_enum_extension.sql": "watchdog policy extension — watchdog suites migrate it inline.",
  "037_mission_control_actions.sql": "mission-control subsystem table — mission-control + review-freeze suites migrate it inline.",
  "038_workspace_primitive.sql": "workspace subsystem table — workspace suites migrate it inline.",
  "039_queue_target_repo.sql": "queue-spine EXTENSION beyond core items+transitions — suites needing target_repo (queue-routes, queue-target-repo) migrate it inline.",
  "040_workflow_specs_diagnostic.sql": "workflow subsystem table — workflow-* suites migrate the workflow schema inline.",
  "044_queue_item_summary.sql": "queue-spine EXTENSION column — suites needing the summary column migrate it inline.",
  "047_events_node_type_index.sql": "events perf index — index/perf suites add it inline; the core edge uses the base events table.",
  "048_queue_item_evidence_ref.sql": "queue-spine EXTENSION column — suites needing evidence_ref migrate it inline.",
  "049_workflow_instance_version.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "050_workflow_spec_json.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "051_workflow_resume.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "052_workflow_instance_bound_rig.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "053_sessions_node_id_index.sql": "sessions perf index — index/perf suites add it inline; the core edge uses the base sessions table.",
  "054_queue_transitions_archive.sql": "queue-retention EXTENSION table — queue-retention suites migrate it inline.",
  "062_usage_samples.sql": "usage-metering subsystem table — usage suites migrate it inline.",
  "065_identity_provenance.sql": "P21 additive era-stamp column on 037_mission_control_actions (itself excluded) — mission-control / review-freeze / scope suites migrate it inline where they assert provenance.",
  "067_i3_identity_provenance.sql": "P21 additive era-stamp columns; it ALTERs inbox_entries + outbox_entries (both excluded from the core edge) alongside queue_transitions/stream_items, so it cannot ride the core-edge list — queue / inbox / outbox / stream suites asserting provenance migrate it inline.",
  "068_enforcer_decisions.sql": "W4 compaction-enforcement decision table — the suite was unbuilt and 071 drops the table forward; 068 stays as applied history. No consumer reads it, and 071 is IF EXISTS so it is a no-op on this fixture.",
  "071_drop_enforcer_decisions.sql": "The forward drop of 068, excluded above — this fixture never creates enforcer_decisions, so applying its drop would be a no-op (the DROP is IF EXISTS). Re-check together with 068: if 068 is ever added to the core edge, add this one too or the fixture keeps a table the shipped schema has dropped.",
  "074_context_usage_watchdog.sql": "watchdog extension migrated inline by context-usage watchdog suites.",
  "075_context_usage_watchdog_generation.sql": "context watchdog generation-binding extension migrated inline by context-usage watchdog suites.",
  "076_owner_notification_levels.sql": "owner-notification columns extend queue transitions plus the archive table (054 is excluded); focused S14 suites use the canonical full migration list.",
};

export function createFullTestDb(): Database.Database {
  const db = createDb();
  migrate(db, migrationsForFullTestDb);
  return db;
}

export function mockTmuxAdapter(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: async () => [],
    listClients: vi.fn(async () => []),
    switchClient: vi.fn(async () => ({ ok: true as const })),
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
    /** 5b82324b — inject a structural activity cache so route tests can prove the default /nodes ACTIVITY consumes it. */
    seatStructuralActivityService?: import("../../src/domain/seat-structural-activity-service.js").SeatStructuralActivityService;
    // OPR.0.4.3.21 — opt-in event-loop health instrumentation for the health/
    // stress proofs. Omitted by default so every existing test keeps the exact
    // legacy `/healthz` `{ status: "ok" }` body.
    eventLoopMonitor?: import("../../src/domain/event-loop-monitor.js").EventLoopMonitor;
    routeTimingRecorder?: import("../../src/domain/route-timing-recorder.js").RouteTimingRecorder;
    permissionDriftObserver?: {
      diagnose(nodeId: string): import("../../src/domain/permission-drift.js").PermissionDriftDiagnostic | null;
    };
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
    /** Managed Claude activity-hook delivery asset paths, forwarded to the PodRigInstantiator
     *  (defaults to daemon-shipped assets). Tests inject fixtures to exercise the nonfatal
     *  delivery-gap warning through the real /api/up route. */
    claudeActivityAssets?: { relayPath?: string; manifestPath?: string };
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
    claudeActivityAssets: opts?.claudeActivityAssets,
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
  const cmuxTmux = { ...tmux, hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
  const nodeCmuxService = new NodeCmuxService(rigRepo, sessionRegistry, cmux, cmuxTmux);
  const agentActivityStore = new AgentActivityStore({
    db,
    eventBus,
    freshnessMs: opts?.activityFreshnessMs,
    // W2a-1 — mirror the production producer wiring so integration tests exercise generation-honesty.
    // Fixtures mint occupant tenures at registerSession, so same-tenure reads stay fresh; a test that
    // reads across a minted new generation (or with no tenure) sees the honest UNKNOWN.
    resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (nodeId, generation) =>
      sessionRegistry.isOccupantGenerationRegistered(nodeId, generation),
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
    seatStructuralActivityService: opts?.seatStructuralActivityService,
    activityHookToken: opts?.activityHookToken,
    eventLoopMonitor: opts?.eventLoopMonitor,
    routeTimingRecorder: opts?.routeTimingRecorder,
    // Hermeticity (hotfix qitem-20260822230440-da0d2ad6 FIX 2): default to a
    // null observer — leaving this undefined makes createApp construct the
    // PRODUCTION PermissionDriftObserver, whose constructor warms the claude
    // permission-mode cache via execFile("claude","--help") (162 real launches
    // across the suite). Tests for the observer itself construct it directly
    // and pass it here explicitly.
    permissionDriftObserver: opts?.permissionDriftObserver ?? { diagnose: () => null },
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
