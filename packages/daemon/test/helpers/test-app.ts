import { mockShellCommand } from "./shell-command-mock.js";
import { vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../src/db/all-migrations.js";
// PL-019: GET /api/rigs/:id/graph + GET /api/rigs/:rigId/nodes/:logicalId
// now perform a read-side join over queue_items (in-progress qitem
// ownership per session). The route returns 500 if the table is absent,
// so the integration harness needs the queue migrations through 025.
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
import { HealthProjectionService, LiveContextHealthSource } from "../../src/domain/health-detectors.js";
import { WhoamiService } from "../../src/domain/whoami-service.js";
import { TranscriptStore } from "../../src/domain/transcript-store.js";
import { RigLifecycleService } from "../../src/domain/rig-lifecycle-service.js";
import { RigRepository } from "../../src/domain/rig-repository.js";
import { SessionRegistry } from "../../src/domain/session-registry.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { QueueRepository } from "../../src/domain/queue-repository.js";
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
import { SeatAttentionReconciler } from "../../src/domain/seat-attention-reconciler.js";
import { createApp, createAppWithWebSocket } from "../../src/server.js";
import fs from "node:fs";

/**
 * P24 — the DECLARED exclusions for {@link migrationsForFullTestDb}. That list is deliberately a
 * schema-MINIMAL core-topology DB (node / rig / session / pod / discovery / stream / queue items+
 * transitions / projection) shared by ~135 suites; each per-subsystem table below is a shipped
 * migration intentionally omitted so the shared fixture stays lean. The exclusion is SAFE evidence,
 * not a guess: the fixture omits these AND all ~135 consumers pass, which proves no createFullTestDb
 * consumer reads them — a subsystem that needs its table migrates that migration in its own suite's
 * inline list. migrationsForFullTestDb below is every shipped migration except these, so a new migration
 * joins the fixture with no edit here; the P24 guard (migration-fixture-parity.test.ts) still fails loud on a
 * stale entry (one naming no shipped migration).
 *
 * TO RE-EVALUATE any entry: check whether a createFullTestDb consumer now reads that table/column
 * (e.g. a new shared read). If one does, delete its exclusion and the fixture carries it.
 */
export const migrationsForFullTestDbExclusions: Record<string, string> = {
  "171_seat_hook_bridge.sql": "the hook bridge's own tables (slice 13), read only by its suites, which migrate ALL_MIGRATIONS (they also need outbox_entries).",
  "166_queue_list_read_indexes.sql": "read indexes depend on owner-notification columns/archive omitted here (054/076); startup and queue-list-order-indexes.test.ts exercise ALL_MIGRATIONS.",
  "156_queue_erasure_link_indexes.sql": "indexes outbox_entries, inbox_entries and the stream tables (all excluded from the core edge) for queue erasure's lookups; erasure tests migrate the canonical full schema.",
  "082_archive_identity_provenance.sql": "archive extension; 054 is excluded from this core fixture. Archive identity regressions use ALL_MIGRATIONS.",
  "026_inbox_entries.sql": "inbox subsystem table — not on the shared core edge (inbox suites migrate it inline).",
  "027_outbox_entries.sql": "outbox subsystem table — not on the shared core edge (outbox suites migrate it inline).",
  "028_project_classifications.sql": "project-classification subsystem table — classifier suites migrate it inline.",
  "029_classifier_leases.sql": "project-classification subsystem table — classifier-lease suites migrate it inline.",
  "086_classification_fields_and_attempts.sql": "extends 028 (excluded here) and adds the S02 attempt ledger — classifier suites migrate it inline.",
  "087_seat_delivery_guard.sql": "extends outbox_entries (027 is excluded); delivery-guard suites use ALL_MIGRATIONS. Revisit if a core-fixture consumer uses retained delivery.",
  "100_typing_guard_modes.sql": "extends outbox_entries and its typing guard (027 and 087 are excluded); guard-mode and retry suites use ALL_MIGRATIONS.",
  "148_outbox_dispatched_index.sql": "indexes outbox_entries (027 is excluded); outbox suites migrate it inline.",
  "089_classification_identity_provenance.sql": "extends project_classifications (028 is excluded); classifier fixtures migrate it inline.",
  "129_stream_dispositions.sql": "companion of project_classifications (028 is excluded); stream-disposition suites migrate it inline.",
  "130_stream_subscriptions.sql": "stream reader subscriptions and retention marks; stream suites migrate it inline.",
  "131_stream_retention_floor.sql": "stream retention's pre-upgrade floor; stream suites migrate it inline.",
  "133_stream_reader_actions.sql": "stream reader actions; stream suites migrate it inline.",
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
  "196_queue_item_evidence_ref_roots.sql": "queue-spine EXTENSION column beside evidence_ref (048) — suites needing evidence_ref migrate both inline.",
  "049_workflow_instance_version.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "050_workflow_spec_json.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "051_workflow_resume.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "052_workflow_instance_bound_rig.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "177_workflow_bound_pod.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "194_workflow_run_title.sql": "workflow instance column — workflow suites migrate the workflow schema.",
  "195_workflow_start_operations.sql": "workflow receipt table — workflow suites migrate the workflow schema.",
  "053_sessions_node_id_index.sql": "sessions perf index — index/perf suites add it inline; the core edge uses the base sessions table.",
  "054_queue_transitions_archive.sql": "queue-retention EXTENSION table — queue-retention suites migrate it inline.",
  "112_queue_transitions_ts_qitem.sql": "indexes queue transitions plus the archive table (054 is excluded). Speed only: the recent-activity read returns the same rows without these indexes, and queue-recent-transitions.test.ts tests that read without them (it migrates 054 inline, not 112).",
  "062_usage_samples.sql": "usage-metering subsystem table — usage suites migrate it inline.",
  "094_usage_samples_latest_indexes.sql": "indexes usage_samples (062 is excluded); usage index tests migrate the canonical full schema.",
  "105_usage_samples_client_cost.sql": "adds cost columns to usage_samples (062 is excluded); cost tests migrate the canonical full schema.",
  "107_pi_usage_entries.sql": "Pi usage-facts table for the cost view; its tests migrate the canonical full schema.",
  "108_pi_usage_charges.sql": "OpenRouter charges for Pi entries, for the cost view; its tests migrate the canonical full schema.",
  "110_workflow_instance_scope.sql": "adds scope_json to workflow_instances (034 is excluded); workflow suites migrate the canonical workflow schema inline.",
  "152_workflow_instance_spec.sql": "adds spec_source_path and spec_json to workflow_instances (034 is excluded); workflow suites migrate the canonical workflow schema inline.",
  "154_workflow_instance_root_objective.sql": "adds root_objective to workflow_instances (034 is excluded); workflow suites migrate the canonical workflow schema inline.",
  "065_identity_provenance.sql": "P21 additive era-stamp column on 037_mission_control_actions (itself excluded) — mission-control / review-freeze / scope suites migrate it inline where they assert provenance.",
  "067_i3_identity_provenance.sql": "P21 additive era-stamp columns; it ALTERs inbox_entries + outbox_entries (both excluded from the core edge) alongside queue_transitions/stream_items, so it cannot ride the core-edge list — queue / inbox / outbox / stream suites asserting provenance migrate it inline.",
  "140_identity_principal.sql": "the MCP adapter's principal beside 067's stamp (itself excluded); it ALTERs inbox_entries, outbox_entries and queue_transitions_archive (all excluded from the core edge) alongside queue_transitions/stream_items — suites asserting the principal migrate ALL_MIGRATIONS.",
  "068_enforcer_decisions.sql": "W4 compaction-enforcement decision table — the suite was unbuilt and 071 drops the table forward; 068 stays as applied history. No consumer reads it, and 071 is IF EXISTS so it is a no-op on this fixture.",
  "071_drop_enforcer_decisions.sql": "The forward drop of 068, excluded above — this fixture never creates enforcer_decisions, so applying its drop would be a no-op (the DROP is IF EXISTS). Re-check together with 068: if 068 is ever added to the core edge, add this one too or the fixture keeps a table the shipped schema has dropped.",
  "074_context_usage_watchdog.sql": "watchdog extension migrated inline by context-usage watchdog suites.",
  "075_context_usage_watchdog_generation.sql": "context watchdog generation-binding extension migrated inline by context-usage watchdog suites.",
  "076_owner_notification_levels.sql": "owner-notification columns extend queue transitions plus the archive table (054 is excluded); focused S14 suites use the canonical full migration list.",
  "078_idle_gate_fired_condition.sql": "idle-gate watchdog extension migrated inline by the idle-gate policy suite.",
  "124_context_usage_watchdog_units.sql": "context watchdog token and percent units, extending 074 and 075 (excluded here); migrated inline by the context-usage watchdog units suite.",
  "079_workflow_lifecycle_parallel.sql": "workflow lifecycle identity, frontier, and failure tables — workflow suites migrate the canonical workflow schema inline; the shared core fixture does not read them.",
};

/** Seam B R6: the full-fixture migration list, exported so file-backed DB-reopen tests migrate IDENTICALLY to
 *  createFullTestDb: every shipped migration except the declared exclusions above. */
export const migrationsForFullTestDb = ALL_MIGRATIONS.filter((migration) => !(migration.name in migrationsForFullTestDbExclusions));

export function createFullTestDb(): Database.Database {
  const db = createDb();
  migrate(db, migrationsForFullTestDb);
  return db;
}

export function mockTmuxAdapter(): TmuxAdapter {
  return mockShellCommand({
    startServer: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    // The default ready adapters below model a live local runtime. Tests for
    // absent panes/processes override this evidence explicitly.
    listPanes: async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }],
    getPanePid: vi.fn(async () => 4242),
    getPaneCommand: vi.fn(async () => "claude"),
    listClients: vi.fn(async () => []),
    switchClient: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => false),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    startPipePane: vi.fn(async () => ({ ok: true as const })),
    setSessionOption: vi.fn(async () => ({ ok: true as const })),
    getSessionOption: vi.fn(async () => null),
  } as unknown as TmuxAdapter);
}

export function unavailableCmuxAdapter(): CmuxAdapter {
  const factory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  return new CmuxAdapter(factory, { timeoutMs: 50 });
}

/** Fresh ready-adapter fixtures with matching, per-session local process evidence.
 * Exact resume, process-loss and turnover tests supply their own observations. */
export function mockNativeRuntime(runtimeForSession: (session: string) => "claude-code" | "codex" | "terminal") {
  const tmux = mockTmuxAdapter();
  const panes = new Map<string, { id: string; pid: number; command: string }>();
  const forSession = (session: string) => {
    let pane = panes.get(session);
    if (!pane) {
      const runtime = runtimeForSession(session);
      const pid = 4242 + panes.size;
      pane = { id: `%${pid}`, pid, command: runtime === "claude-code" ? "claude" : runtime === "terminal" ? "bash" : "codex" };
      panes.set(session, pane);
    }
    return pane;
  };
  const forTarget = (target: string) => target.startsWith("%")
    ? [...panes.values()].find(pane => pane.id === target) : forSession(target);
  tmux.listPanes = vi.fn(async session => [{ ...forSession(session), index: 0, cwd: "/", width: 80, height: 24, active: true }]);
  tmux.getPanePid = vi.fn(async target => forTarget(target)?.pid ?? null);
  tmux.getPaneCommand = vi.fn(async target => forTarget(target)?.command ?? null);
  const listProcesses = async () => [...panes.values()].map(({ pid, command }) => ({
    pid, ppid: 1, pgid: pid, tpgid: pid, command, argv: [command], executableName: command,
    startedAt: "Tue Oct 20 05:00:01 2026",
  }));
  return { tmux, listProcesses };
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
    terminalReachability?: import("../../src/domain/terminal-server-reachability.js").TerminalServerReachability;
    routeTimingRecorder?: import("../../src/domain/route-timing-recorder.js").RouteTimingRecorder;
    permissionDriftObserver?: {
      diagnose(nodeId: string): import("../../src/domain/permission-drift.js").PermissionDriftDiagnostic | null;
    };
    listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>;
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
    /** Optional persisted fresh-launch callbacks for restore-to-instantiator integration tests. */
    freshLaunch?: import("../../src/domain/restore-orchestrator.js").RestoreOrchestratorDeps["freshLaunch"];
    freshLaunchAvailable?: (rigId: string, nodeId: string) => boolean;
    /** The launcher's folder creation, as startup wires it; omitted, a launch creates no folder. */
    createFolder?: (path: string) => void;
    /** Wire the ready runtime adapters into the routes' `runtimeAdapters`, as startup does, so a
     *  route launch can start harnesses. Off by default: existing tests keep no route adapters. */
    wireRuntimeAdapters?: boolean;
    /** The transcript store the claim, self-attach and whoami services write to. Pass the same one in `appDeps`
     *  for the transcript routes to read what they write. */
    transcriptStore?: TranscriptStore;
    /** Extra or overriding createApp deps (browser-boundary route tests inject inert spies). */
    appDeps?: Partial<import("../../src/server.js").AppDeps>;
    /** Build through createAppWithWebSocket (production upgrade path) and return injectWebSocket. */
    withWebSocket?: boolean;
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
  const queueRepo = new QueueRepository(db, eventBus);
  const tmux = opts?.tmux ?? mockTmuxAdapter();
  const cmux = opts?.cmux ?? unavailableCmuxAdapter();
  const transcriptStore = opts?.transcriptStore ?? new TranscriptStore("/tmp/openrig-test-transcripts");
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux,
    ...(opts?.createFolder ? { createFolder: opts.createFolder } : {}) });
  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const claudeResume = new ClaudeResumeAdapter(tmux);
  const codexResume = new CodexResumeAdapter(tmux);
  const restoreOrchestrator = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
    checkpointStore, nodeLauncher, tmuxAdapter: tmux, claudeResume, codexResume,
    ...(opts?.listProcesses ? { listProcesses: opts.listProcesses } : {}),
    ...(opts?.freshLaunch ? { freshLaunch: opts.freshLaunch } : {}),
    ...(opts?.freshLaunchAvailable ? { freshLaunchAvailable: opts.freshLaunchAvailable } : {}),
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
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux,
    ...(opts?.listProcesses ? { listProcesses: opts.listProcesses } : {}) });
  const adapters: Record<string, RuntimeAdapter> = {
    terminal: readyRuntimeAdapter("terminal"),
    "claude-code": readyRuntimeAdapter("claude-code"),
    codex: readyRuntimeAdapter("codex"),
    ...opts?.adapters,
  };
  const podInstantiator = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
    tmuxAdapter: tmux,
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
  const rigLifecycleService = new RigLifecycleService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus, queueRepo, tmuxAdapter: tmux });
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
    isOccupantContinuedByAdoption: (nodeId, generation) =>
      sessionRegistry.isOccupantContinuedByAdoption(nodeId, generation),
  });
  const contextUsageStore = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test", runnerObservations: agentActivityStore });
  const healthProjection = new HealthProjectionService(new LiveContextHealthSource({
    db,
    rigRepo,
    sessionRegistry,
    contextUsageStore,
  }));
  const whoamiService = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore, contextUsageStore });
  const cmuxTmux = { ...tmux, hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
  const nodeCmuxService = new NodeCmuxService(rigRepo, sessionRegistry, cmux, cmuxTmux);
  const seatAttentionReconciler = new SeatAttentionReconciler({
    sessionRegistry,
    eventBus,
    agentActivityStore,
    db,
    tmux,
    reconcileRestoreOutcome: (rigId, nodeId) => restoreOrchestrator.reconcileNodeRuntimeTruth(rigId, nodeId),
  });

  const podBundleSourceResolver = new PodBundleSourceResolver();

  const upRouterFs = opts?.upRouterFsOps ?? {
    exists: (_p: string) => false,
    readFile: (_p: string) => "",
    readHead: (_p: string, _n: number) => Buffer.alloc(0),
  };
  const upRouter = new UpCommandRouter({ fsOps: upRouterFs });

  const testAppDeps = {
    rigRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator, tmuxAdapter: tmux, cmuxAdapter: cmux,
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
    healthProjection,
    whoamiService,
    nodeCmuxService,
    agentActivityStore,
    seatAttentionReconciler,
    seatStructuralActivityService: opts?.seatStructuralActivityService,
    activityHookToken: opts?.activityHookToken,
    eventLoopMonitor: opts?.eventLoopMonitor,
    terminalReachability: opts?.terminalReachability,
    routeTimingRecorder: opts?.routeTimingRecorder,
    // Hermeticity (hotfix qitem-20260822230440-da0d2ad6 FIX 2): default to a
    // null observer — leaving this undefined makes createApp construct the
    // PRODUCTION PermissionDriftObserver, whose constructor warms the claude
    // permission-mode cache via execFile("claude","--help") (162 real launches
    // across the suite). Tests for the observer itself construct it directly
    // and pass it here explicitly.
    permissionDriftObserver: opts?.permissionDriftObserver ?? { diagnose: () => null },
    // Caller-supplied adapters always reach route handlers; the always-ready
    // instantiator stubs only when explicitly wired, since they would make
    // restore routes report resumes.
    runtimeAdapters: opts?.wireRuntimeAdapters ? adapters : opts?.adapters as Record<string, RuntimeAdapter> | undefined,
    ...opts?.appDeps,
  };
  // withWebSocket: the production createAppWithWebSocket path, returning its injectWebSocket.
  const built = opts?.withWebSocket
    ? createAppWithWebSocket(testAppDeps as never)
    : { app: createApp(testAppDeps as never), injectWebSocket: undefined };
  const app = built.app;
  return {
    app, injectWebSocket: built.injectWebSocket, rigRepo, sessionRegistry, eventBus, nodeLauncher, snapshotRepo,
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
