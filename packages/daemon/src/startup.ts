import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { ExecFn } from "./adapters/tmux.js";
import type { CmuxTransportFactory } from "./adapters/cmux.js";
import { createDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
// P8: apply the CANONICAL migration list — the single source of truth (db/all-migrations.ts),
// never an inline copy that can drift out of sync with the daemon's schema.
import { ALL_MIGRATIONS } from "./db/all-migrations.js";
import { RigRepository } from "./domain/rig-repository.js";
import { SessionRegistry } from "./domain/session-registry.js";
import { isHumanSeatSessionRef, parseSessionName } from "./domain/session-name.js";
import { resolveExternal } from "./domain/gateway/external-admission.js";
import { loadHumanRegistry } from "./domain/gateway/human-registry.js";
import { EventBus } from "./domain/event-bus.js";
import { NodeLauncher } from "./domain/node-launcher.js";
import { TmuxOptionDefaultsApplier } from "./domain/tmux-option-defaults.js";
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
import { PiResumeAdapter } from "./adapters/pi-resume.js";
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
import { SeatActivityService } from "./domain/seat-activity-service.js";
import { SeatStructuralActivityService } from "./domain/seat-structural-activity-service.js";
import { deriveSelfHostIdSource, SeatIdentityReconciler, reconcileSelfHostIdentity } from "./domain/seat-identity-reconciler.js";
import { SelfHostIdentityStore } from "./domain/seat-identity-store.js";
import { DaemonLifecycleStore } from "./domain/daemon-lifecycle-store.js";
import { randomUUID } from "node:crypto";
import { setSelfHostId, setSelfHostIdSource } from "./domain/hosts/fanout-contract.js";
import { UpCommandRouter } from "./domain/up-command-router.js";
import { RigTeardownOrchestrator } from "./domain/rig-teardown.js";
import { ResumeMetadataRefresher } from "./domain/resume-metadata-refresher.js";
import { TranscriptStore } from "./domain/transcript-store.js";
import { resumeRunningTranscriptCaptures } from "./domain/transcript-capture.js";
import { SessionTransport } from "./domain/session-transport.js";
import { AgentActivityStore } from "./domain/agent-activity-store.js";
import { HistoryQuery } from "./domain/history-query.js";
import { AskService } from "./domain/ask-service.js";
import { WakeResolveService } from "./domain/wake-resolve-service.js";
import type { WakeSessionRow } from "./domain/wake-resolver.js";
import { ChatRepository } from "./domain/chat-repository.js";
import { StreamStore } from "./domain/stream-store.js";
import { SlowOpRecorder, type SlowOperationInstrumentation } from "./domain/slow-op-recorder.js";
import { configureSyncSiteRecorder } from "./domain/sync-site-wrap.js";
import { QueueRepository } from "./domain/queue-repository.js";
import { createWorkflowFrontierPredicate } from "./domain/workflow-frontier-guard.js";
import { InboxHandler } from "./domain/inbox-handler.js";
import { OutboxHandler } from "./domain/outbox-handler.js";
import { ProjectClassifier } from "./domain/project-classifier.js";
import { ClassifierLeaseManager } from "./domain/classifier-lease-manager.js";
import { ViewProjector } from "./domain/view-projector.js";
import { wireViewEventBridge } from "./domain/view-event-bridge.js";
import { WatchdogJobsRepository } from "./domain/watchdog-jobs-repository.js";
import { WatchdogAutoRegistration } from "./domain/watchdog-auto-registration.js";
import { WatchdogHistoryLog } from "./domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "./domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "./domain/watchdog-scheduler.js";
import { WorkflowRuntime } from "./domain/workflow-runtime.js";
import { makeWorkflowKeepalivePolicy } from "./domain/policies/workflow-keepalive.js";
import { makeIdleGateQitemPolicy } from "./domain/policies/idle-gate-qitem.js";
import { SpecReviewService } from "./domain/spec-review-service.js";
import { SpecLibraryService } from "./domain/spec-library-service.js";
// Phase 3a slice 3.3 — plugin discovery service.
import { PluginDiscoveryService } from "./domain/plugin-discovery-service.js";
// Slice 28 Checkpoint C-3 — skill-library discovery (SC-29 #11 cumulative).
import { SkillLibraryDiscoveryService } from "./domain/skill-library-discovery.js";
import { ContextPackLibraryService } from "./domain/context-packs/context-pack-library-service.js";
import { AgentImageLibraryService } from "./domain/agent-images/agent-image-library-service.js";
import { SnapshotCapturer } from "./domain/agent-images/snapshot-capturer.js";
import { SettingsStore as ContextPackSettingsStore } from "./domain/user-settings/settings-store.js";
import { WhoamiService } from "./domain/whoami-service.js";
import { NodeCmuxService } from "./domain/node-cmux-service.js";
import { createAppWithWebSocket, type AppDeps } from "./server.js";
import { ProviderServiceImpl } from "./domain/provider/provider-service-impl.js";
import { collectClaudeSignalsFromProviderUsageDirectory } from "./domain/provider/claude-usage-reader.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
// Slice 11 (release-0.3.1 workflow-spec-folder-discovery) — adds
// status + error_message columns to workflow_specs so the scanner
// can record diagnostic rows. SC-29 #10 declared verbatim in commit body.
import { RigModeStore } from "./domain/rig-mode/rig-mode-store.js";
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
import { materializeBuiltinPolicyReference } from "./domain/builtin-policy-reference.js";
import { ensureActivityHookToken, writeActivityEndpointFile, deriveActivityUrl } from "./domain/activity-endpoint.js";
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
  tmuxOptionPlatform?: NodeJS.Platform;
  slowOpRecorder?: SlowOperationInstrumentation;
  /**
   * PL-005 Phase B: bearer token for Mission Control write verbs.
   * When null, the auth-bearer-token middleware passes through (the
   * index.ts startup-side check ensures this is only valid when bound
   * on loopback). When set, the middleware enforces constant-time
   * comparison + 401 on missing/mismatch.
   */
  bearerToken?: string | null;
  /**
   * Terminal bearer token for live-terminal routes. Null means the
   * daemon bind posture is already trusted (loopback/tailnet), matching
   * the Mission Control auth boundary. Non-null enforces bearer auth on
   * terminal preview/transport/websocket routes.
   */
  terminalBearerToken?: string | null;
}

interface DaemonResult {
  app: Hono;
  db: Database.Database;
  deps: AppDeps;
  contextMonitor: import("./domain/context-monitor.js").ContextMonitor;
  // OPR.0.4.3.21 — returned so index.ts can stop() it on graceful shutdown.
  eventLoopMonitor: import("./domain/event-loop-monitor.js").EventLoopMonitor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  injectWebSocket: (server: any) => void;
}

const KNOWN_PROVIDER_AUTH_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  // OPR.0.4.6.PI1 FR-7 — Pi seat providers. Without these in the KNOWN set,
  // a daemon-launched Pi seat can never receive its provider key (the
  // pi-runner's own deny-by-default allowlist then has nothing to pass
  // through). Double opt-in preserved: the operator must still name each var
  // in recovery.provider_auth_env_allowlist. OpenRouter is the founder-ruled
  // preferred path (2026-07-06); zai/kimi-coding are the secondary natives.
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
]);

export function collectAllowlistedProviderAuthEnv(
  raw: string | null | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (raw ?? "").split(",")) {
    const name = item.trim();
    if (!name) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    if (!KNOWN_PROVIDER_AUTH_ENV.has(name)) continue;
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      out[name] = value;
    }
  }
  return out;
}

export async function createDaemon(opts?: DaemonOptions): Promise<DaemonResult> {
  const daemonHome = os.homedir();
  const configuredCodexHome = process.env.CODEX_HOME;
  if (configuredCodexHome && !nodePath.isAbsolute(configuredCodexHome)) {
    throw new Error(`CODEX_HOME must be an absolute path for managed seats: ${configuredCodexHome}`);
  }
  const codexHome = configuredCodexHome || nodePath.join(daemonHome, ".codex");
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = createDb(dbPath);
  migrate(db, ALL_MIGRATIONS);

  // 51-09 increment 1 — establish the daemon's durable self-host identity at
  // boot (mint on first boot, reconcile thereafter). host.name is a display-only
  // CANDIDATE SEED (arch ruling cb19867f / DP4). Boot proceeds on a host.name
  // conflict (the stored id is kept and the conflict is surfaced loudly).
  const hostNameCandidate = new ContextPackSettingsStore().resolveOne("host.name").value as string;
  const selfHost = reconcileSelfHostIdentity(new SelfHostIdentityStore(db), {
    nowIso: new Date().toISOString(),
    hostNameCandidate,
  });
  // 51-09 increment 2 — publish the resolved self-host id so the read-through
  // (and, in increment 4, the queue-destination validator) resolve a request
  // addressed to THIS host's own id HOME, instead of dialing/validating it as a
  // remote/unknown host. Distinct spelling from the 'local' sentinel.
  setSelfHostId(selfHost.hostId);
  // Slice 14 §2c — derived from the SAME candidate the reconcile just used, so the two can never
  // disagree, and computed here rather than per request (see fanout-contract).
  setSelfHostIdSource(deriveSelfHostIdSource(selfHost.hostId, hostNameCandidate));

  // P7 — the daemon's LIFECYCLE record (distinct from the 059 identity record).
  // A new boot mints a fresh epoch, stamps started_at, and clears any prior run's
  // stopped_at/heartbeat. The heartbeat (index.ts post-bind) advances last-seen
  // while running; a clean shutdown (index.ts shutdown, AFTER stopping the timer)
  // stamps stopped_at for THIS epoch.
  const daemonLifecycleStore = new DaemonLifecycleStore(db);
  const daemonBootEpoch = randomUUID();
  daemonLifecycleStore.recordBoot(daemonBootEpoch, new Date().toISOString());

  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const streamStore = new StreamStore(db, eventBus);
  const slowOpRecorder = opts?.slowOpRecorder ?? (dbPath === ":memory:"
    ? undefined
    : new SlowOpRecorder({
        logPath: nodePath.join(OPENRIG_HOME, "logs", "slow-operations.jsonl"),
      }));
  configureSyncSiteRecorder(slowOpRecorder);
  // Instrumentation wiring is observe-only: neither a throwing registration
  // call nor a throwing callback body (streamStore.emit) may abort createDaemon
  // or later wrapped work. Guard both boundaries.
  try {
    slowOpRecorder?.setDegradedHandler?.(({ reason, site }) => {
      try {
        streamStore.emit({
          sourceSession: "daemon@kernel",
          body: `slow-operation instrumentation degraded: ${reason} at ${site}`,
          hintType: "observation",
          hintUrgency: "high",
          hintTags: ["daemon", "slow-operation", "observability-degraded"],
        });
      } catch (error) {
        console.error("[slow-operation] degradation notification failed", error);
      }
    });
  } catch (error) {
    console.error("[slow-operation] setDegradedHandler registration failed", error);
  }
  // PL-004 Phase A revision (R1): topology-backed validateRig.
  // Reject `<member>@<unknown-rig>` shapes by checking the rig portion
  // against the rig registry. Bare ids without `@` are also rejected
  // (no canonical rig binding).
  // OPR.0.4.6.MH1 FR-8: this gate is the ARCHETYPE consumer of the shared
  // parse contract — human-seat classification BEFORE parse, then the
  // greedy first-@ rig (so "member@rig@x" looks up rig "rig@x", misses,
  // and rejects with the same unknown_destination_rig as ever — BR-1).
  const topologyValidateRig = (sessionRef: string): boolean => {
    const parsed = parseSessionName(sessionRef);
    // M1 A4b — @external entity-admission (checked BEFORE the human-CLASS bare-admit,
    // which A2 also makes true for <local>@external): a queue row destinationed to
    // <local>@external is admitted ONLY if the human is REGISTERED (or it is a literal
    // scheme address); an unregistered entity is REFUSED (the 4b site carries the
    // entity-level teaching via externalAdmissionTeaching). Admission is the gateway's
    // job, never the classifier's (arch 8cd30094).
    if (parsed.kind === "external") {
      const reg = loadHumanRegistry();
      const entities = reg.ok ? reg.entities.map((e) => ({ entityId: e.entityId, address: e.address })) : [];
      return resolveExternal(parsed.local, entities).kind !== "unregistered";
    }
    if (isHumanSeatSessionRef(sessionRef)) return true;
    if (parsed.kind !== "canonical") return false;
    return rigRepo.findRigsByName(parsed.rig).length > 0;
  };
  // PL-004 Phase A — shared coordination services. Constructed early so
  // both the queueRepo dep slot and inboxHandler can share one instance.
  // Transport is wired after SessionTransport instantiation below via
  // attachTransport().
  const queueRepoInstance = new QueueRepository(db, eventBus, {
    validateRig: topologyValidateRig,
    // OPR.0.4.6.WF3 FR-6 — the frontier close-path guard's predicate,
    // INJECTED here (arch layering pin: the queue never imports the
    // workflow domain; startup wires them — the validateRig precedent).
    workflowFrontierPredicate: createWorkflowFrontierPredicate(db),
    // GHOST-STAGE (h): resolve the source seat's atom-B generation for the handoff-nudge Sent: line
    // (same injected-predicate layering — the queue never imports the session domain).
    resolveOccupantGeneration: (sessionName) => sessionRegistry.currentOccupantGenerationForSession(sessionName),
  });
  // W1 (transactional closure): ONE OutboxHandler shared between the deps slot
  // (sender-side audit surface) and the queue repo's durable wake-intent
  // staging. Same `db`, so a stageWakeIntent() call inside a terminal
  // db.transaction commits atomically with the close + successor create.
  const outboxHandlerInstance = new OutboxHandler(db);
  queueRepoInstance.attachOutbox(outboxHandlerInstance);
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
  const watchdogJobsRepoInstance = new WatchdogJobsRepository(
    db,
    undefined, // now (default clock)
    // GHOST-STAGE (e/Class-B): stamp the arming occupant's generation so a swap can drop its armed jobs.
    (sessionName) => sessionRegistry.currentOccupantGenerationForSession(sessionName),
  );
  const watchdogAutoRegistration = new WatchdogAutoRegistration({
    db,
    jobsRepo: watchdogJobsRepoInstance,
    settingsStore: new ContextPackSettingsStore(),
    warn: (message) => console.warn(message),
  });
  sessionRegistry.setWatchdogRegistrationObserver(watchdogAutoRegistration);
  // Existing sessions predate the structural mint hook. Audit them at every
  // boot without creating jobs: additive coverage stays loud, core boot stays live.
  watchdogAutoRegistration.assertLiveSeatCoverage();
  const watchdogHistoryLogInstance = new WatchdogHistoryLog(db);

  const tmuxAdapter = new TmuxAdapter(opts?.tmuxExec ?? execCommand);

  // Slice 15 — Seat-activity service for the `terminal-active` primitive.
  // Lives at module scope so the projection chain (PsProjectionService,
  // node-inventory enrichment) reads from one source. Default silence
  // window: 3s per slice 15 README. Per-seat silenceWindowSeconds from
  // AgentSpec.profile.activity is currently inert (the poller uses the
  // global default; per-seat windows are not wired to the live poll).
  const seatActivityService = new SeatActivityService({
    tmux: tmuxAdapter,
    defaultWindowSeconds: 3,
    eventBus,
  });
  // 5b82324b — the STRUCTURAL activity cache (sibling of SeatActivityService). Captures pane TEXT once
  // per running seat per tick + classifies motion STRUCTURALLY, so the `rig ps` ACTIVITY column reflects
  // real liveness for hook-less / stale-hook / turn-boundary seats WITHOUT a per-request capture storm.
  const seatStructuralActivityService = new SeatStructuralActivityService(tmuxAdapter);
  // OPR.0.4.3.19 — SeatIdentityReconciler owns the liveness identity verdict
  // (the THIRD axis). Reconciles each running seat's pane PID/command against
  // the registered binding and persists the verdict so node-inventory can gate
  // the running/active green derivations. Started post-bind in index.ts.
  const seatIdentityReconciler = new SeatIdentityReconciler({
    db,
    tmux: tmuxAdapter,
  });
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
  // OPR.0.4.3.28 B2 — self-provision a STABLE activity url+token so launched
  // seats reach the ingest endpoint without operator shell seeding (the
  // confirmed live break). The token persists across daemon restarts (matches
  // already-launched seats' frozen env); the URL derives from the daemon's
  // loopback + port (DEFAULT_PORT 7433 fallback). The SAME token becomes both
  // the ingest expected-token (server dep below) and the seats' env value, so
  // hook POSTs authenticate. Also snapshotted to activity-endpoint.json for the
  // relay file-discovery fallback used by reconcile/restored seats (B3).
  const resolvedActivityHookToken = activityHookToken ?? ensureActivityHookToken(OPENRIG_HOME);
  // Derive from the daemon's OWN bound host+port (honors an explicit OPENRIG_HOST
  // single-host bind; wildcard/absent → loopback) so seats post to a reachable
  // address — a hardcoded 127.0.0.1 breaks an explicit tailnet/hostname bind.
  const resolvedActivityHookUrl = activityHookUrl ?? deriveActivityUrl(openRigHost, openRigPort);
  writeActivityEndpointFile(OPENRIG_HOME, { baseUrl: resolvedActivityHookUrl, token: resolvedActivityHookToken });
  const startupSettings = new ContextPackSettingsStore().resolveConfig();
  const providerAuthEnv = collectAllowlistedProviderAuthEnv(
    startupSettings.recoveryProviderAuthEnvAllowlistRaw,
    process.env,
  );
  const transcriptStore = new TranscriptStore({
    enabled: transcriptsEnabled,
    transcriptsRoot: transcriptsPath,
  });

  // Shared launch identity/activity env — used by NodeLauncher at launch AND
  // by the seat-handover full-cycle composer when it creates a successor
  // session (OPR.0.4.3.04), so a handed-over successor self-identifies +
  // reports activity exactly like a launched seat.
  const launchSessionEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    OPENRIG_HOME,
    OPENRIG_PORT: openRigPort,
    OPENRIG_HOST: openRigHost,
    OPENRIG_URL: resolvedActivityHookUrl,
    OPENRIG_ACTIVITY_HOOK_TOKEN: resolvedActivityHookToken,
    ...providerAuthEnv,
    HOME: daemonHome,
    CODEX_HOME: codexHome,
  };
  // OPR.0.4.6.02 S1 — ONE shared tmux option-defaults applier, injected into
  // BOTH NodeLauncher and (via AppDeps → the seat-handover route) the fresh
  // successor launcher, so every fresh seat gets the same mouse/status/
  // clipboard defaults and the server-scope defaults assert once per daemon
  // lifetime (shared memo). The status-bar read resolves `terminal.status_bar`
  // FRESH per launch (resolveOne re-reads the config file) so an operator flip
  // applies to the NEXT launch without a daemon restart; a resolution failure
  // falls back to off (bar hidden).
  const tmuxOptionSettings = new ContextPackSettingsStore();
  const tmuxOptionDefaults = new TmuxOptionDefaultsApplier({
    tmuxAdapter,
    platform: opts?.tmuxOptionPlatform,
    readTmuxOptionDefaults: () => {
      try {
        return { statusBar: tmuxOptionSettings.resolveOne("terminal.status_bar").value === true };
      } catch {
        return { statusBar: false };
      }
    },
  });
  const nodeLauncher = new NodeLauncher({
    db,
    rigRepo,
    sessionRegistry,
    eventBus,
    tmuxAdapter,
    transcriptStore,
    sessionEnv: launchSessionEnv,
    tmuxOptionDefaults,
  });

  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const claudeResume = new ClaudeResumeAdapter(tmuxAdapter);
  const codexResume = new CodexResumeAdapter(tmuxAdapter);
  // OPR.0.4.6.PI1 — the Pi seat-state root + the compiled runner entry (daemon
  // dist). Shared by the Pi runtime adapter, the resume adapter, and the
  // resume-token capture sidecar reader.
  const piStateRoot = nodePath.join(OPENRIG_HOME, "state", "pi");
  const piRunnerEntryPath = nodePath.resolve(import.meta.dirname, "./adapters/pi-runner.js");
  const piResume = new PiResumeAdapter(
    tmuxAdapter,
    { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }) },
    { stateRoot: piStateRoot, runnerEntryPath: piRunnerEntryPath },
  );
  // Services infrastructure (RigEnv) — created early so restore/bootstrap can use it
  const { ComposeServicesAdapter } = await import("./adapters/compose-services-adapter.js");
  const { ServiceOrchestrator } = await import("./domain/service-orchestrator.js");
  const composeAdapter = new ComposeServicesAdapter(opts?.tmuxExec ?? execCommand);
  const serviceOrchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter });

  const restoreOrchestrator = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
    checkpointStore, nodeLauncher, tmuxAdapter, claudeResume, codexResume, piResume,
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

  // Transcript rotators are process-local. Reattach them after lifecycle
  // reconciliation so surviving tmux sessions keep ingesting across daemon
  // restarts while genuinely detached sessions stay excluded.
  try {
    await resumeRunningTranscriptCaptures(db, tmuxAdapter, transcriptStore);
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.warn(`startup transcript capture warning: ${err instanceof Error ? err.message : String(err)}`);
    } catch { /* logging must never throw */ }
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
  // P20 — the projection manifest: record-at-apply so the projector can later
  // discriminate a stale re-projection (safe overwrite) from an operator edit (protect).
  const { ProjectionManifestStore } = await import("./domain/projection-manifest-store.js");
  const { hashContent } = await import("./domain/conflict-detector.js");
  const projectionManifestStore = new ProjectionManifestStore(db);
  // atom-4b — probe the manifest's readability AT BOOT. A rare per-lookup throw protects that one
  // target (conflict-detector: broken≠absent → operator_conflict); but a WHOLE-TABLE-unreadable
  // manifest degrades EVERY projection to protect — no overwrite ever applies — a safe but otherwise
  // SILENT systemic degrade. Warn loudly at boot so the operator knows projections are held pending a
  // DB repair, rather than silently discovering nothing projects.
  if (!projectionManifestStore.isReadable()) {
    console.warn(
      "projection-manifest UNREADABLE at boot — every projection will degrade to PROTECT (no overwrites apply) until the DB is repaired; investigate projection_manifest (migration 064).",
    );
  }
  const { CodexRuntimeAdapter } = await import("./adapters/codex-runtime-adapter.js");
  const { PiRuntimeAdapter } = await import("./adapters/pi-runtime-adapter.js");

  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter, readFile: (p: string) => fs.readFileSync(p, "utf-8") });
  const runtimeSettings = new ContextPackSettingsStore().resolveConfig();
  const claudeAdapter = new ClaudeCodeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; }, readdir: (dir: string) => fs.readdirSync(dir), statMode: (p: string) => fs.statSync(p).mode, chmod: (p: string, m: number) => fs.chmodSync(p, m), homedir: os.homedir() }, stateDir: OPENRIG_HOME, collectorAssetPath: nodePath.resolve(import.meta.dirname, "../assets/claude-statusline-context.cjs"), autoDriveProviderPrompts: runtimeSettings.recoveryAutoDriveProviderPrompts, activityRelayPath: nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs"), claudeHooksManifestPath: nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/claude.json"), recordProjection: (targetPath: string, content: string) => projectionManifestStore.record({ targetPath, lastHash: hashContent(content), writtenAt: new Date().toISOString() }) });
  const codexAdapter = new CodexRuntimeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; }, statMode: (p: string) => fs.statSync(p).mode, chmod: (p: string, m: number) => fs.chmodSync(p, m), homedir: daemonHome }, codexHome, activityRelayPath: nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") });
  // OPR.0.4.6.PI1 — the RPC-first Pi adapter (runner-in-a-pane). Same fsOps
  // shape as the Codex adapter; seat isolation roots under piStateRoot.
  const piAdapter = new PiRuntimeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; } }, stateRoot: piStateRoot, runnerEntryPath: piRunnerEntryPath });
  // OPR.0.5.1.1 — the stub runtime adapter (Pi-shaped node-script runner in a pane).
  // Same fsOps shape as Pi; the compiled runner entry lives in the daemon dist.
  const { StubRuntimeAdapter } = await import("./adapters/stub-runtime-adapter.js");
  const stubRunnerEntryPath = nodePath.resolve(import.meta.dirname, "./adapters/stub-runner.js");
  const stubAdapter = new StubRuntimeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; } }, runnerEntryPath: stubRunnerEntryPath });

  // plugin-primitive Phase 3a slice 3.5 — ensure Codex feature flag
  // codex_hooks = true is set in ~/.codex/config.toml so plugin-shipped
  // hooks fire on Codex runtime. Slice 27 also creates the default
  // user-owned Claude compaction extra-instructions placeholder.
  // Operator can disable Codex hooks via OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED
  // or rig config set runtime.codex.hooks_enabled false.
  try {
    const {
      SettingsStore,
      ensureDefaultClaudeCompactionFiles,
    } = await import("./domain/user-settings/settings-store.js");
    ensureDefaultClaudeCompactionFiles(OPENRIG_HOME);
    const settingsStore = new SettingsStore();
    const enabled = settingsStore.resolveOne("runtime.codex.hooks_enabled").value as boolean;
    let codexVersion: string | undefined;
    const codexVersionRow = db.prepare(
      "SELECT version FROM runtime_verifications WHERE runtime = 'codex' ORDER BY verified_at DESC LIMIT 1"
    ).get() as { version: string | null } | undefined;
    if (codexVersionRow?.version) {
      codexVersion = codexVersionRow.version;
    } else {
      try {
        const verifyResult = await runtimeVerifier.verifyCodex();
        codexVersion = verifyResult.version ?? undefined;
      } catch { /* codex not available — skip feature flag */ }
    }
    codexAdapter.ensureCodexFeatureFlag(enabled, { codexVersion });
    // OPR.0.4.1.10 FR-A — project the OpenRig activity hooks into the Codex config
    // layer so Codex seats are hook-PRIMARY for the rig-send prompt guard (and gain
    // SessionStart/UserPromptSubmit/Stop observability) from clean shipped config.
    // Same enable gate as the feature flag; trust is auto-cleared at launch.
    if (enabled) {
      codexAdapter.ensureCodexActivityHooks();
    } else {
      // OPR.0.4.1.10 B3 — durable disable: strip any previously-written managed [hooks] block.
      codexAdapter.removeCodexActivityHooks();
    }
  } catch (err) {
    console.error(`[openrig] runtime setup warning: ${(err as Error).message}`);
  }

  // plugin-primitive Phase 3a slice 3.2 — vendor openrig-core plugin to
  // ~/.openrig/plugins/openrig-core/ on first launch. Auto-fetch from
  // github.com/mvschwarz/openrig-plugins is best-effort + 404-tolerant
  // (repo currently empty as of 2026-05-10; vendored
  // copy is the source of truth at v0).
  try {
    const { PluginVendorService } = await import("./domain/plugin-vendor-service.js");
    const vendoredAssetsDir = nodePath.resolve(import.meta.dirname, "../assets/plugins");
    const userPluginsDir = getDefaultOpenRigPath("plugins");
    const realFs = {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
      mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
      listFiles: (dir: string) => {
        const r: string[] = [];
        function w(d: string, pre: string) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name));
            else r.push(pre ? nodePath.join(pre, e.name) : e.name);
          }
        }
        w(dir, "");
        return r;
      },
      statMode: (p: string) => fs.statSync(p).mode,
      chmod: (p: string, m: number) => fs.chmodSync(p, m),
    };
    const httpClient = async (url: string, opts?: { timeoutMs?: number }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 5000);
      try {
        const resp = await fetch(url, { signal: ctrl.signal });
        return { ok: resp.ok, status: resp.status };
      } finally {
        clearTimeout(timer);
      }
    };
    const vendorService = new PluginVendorService({
      vendoredAssetsDir,
      userPluginsDir,
      fs: realFs,
      httpClient,
      logger: (...args) => console.log("[openrig]", ...args),
    });
    await vendorService.ensureLatest("openrig-core");
    vendorService.ensureSkillGlobally("openrig-core", "openrig-skills", [
      nodePath.join(os.homedir(), ".claude", "skills"),
      nodePath.join(os.homedir(), ".agents", "skills"),
    ]);
  } catch (err) {
    console.error(`[openrig] plugin vendor setup warning: ${(err as Error).message}`);
  }

  // PL-014: one daemon-scoped ContextPackLibraryService backs the
  // delivery-free /api/context-packs list/sync/compose/read/delete/preview/pieces
  // routes. Startup context-pack expansion is intentionally unsupported;
  // dedicated send/broadcast/walk/queue verbs own delivery.
  const contextPackLibrary = (() => {
    const userPacksRoot = getDefaultOpenRigPath("context-packs");
    try { fs.mkdirSync(userPacksRoot, { recursive: true }); } catch { /* best-effort */ }
    const roots: Array<{ path: string; sourceType: "builtin" | "user_file" | "workspace" }> = [
      { path: userPacksRoot, sourceType: "user_file" },
    ];
    try {
      const settingsStore = new ContextPackSettingsStore();
      const cfg = settingsStore.resolveConfig();
      const workspacePacksRoot = nodePath.join(cfg.workspaceRoot, ".openrig", "context-packs");
      if (workspacePacksRoot !== userPacksRoot && fs.existsSync(workspacePacksRoot)) {
        roots.push({ path: workspacePacksRoot, sourceType: "workspace" });
      }
    } catch { /* settings unavailable; fall through with user-file root only */ }
    const builtinPacksRoot = nodePath.resolve(import.meta.dirname, "../context-packs");
    if (fs.existsSync(builtinPacksRoot)) {
      roots.unshift({ path: builtinPacksRoot, sourceType: "builtin" });
    }
    const lib = new ContextPackLibraryService({ roots });
    lib.scan();
    return lib;
  })();

  // PL-016 Item 2 + Item 4: hoist AgentImageLibraryService construction
  // so the PodRigInstantiator can resolve `session_source: mode:
  // agent_image` at materialize time. Same instance returned to deps
  // below so /api/agent-images/* + the SnapshotCapturer share it.
  const agentImageRootBuilder = () => {
    const userImagesRoot = getDefaultOpenRigPath("agent-images");
    try { fs.mkdirSync(userImagesRoot, { recursive: true }); } catch { /* best-effort */ }
    const roots: Array<{ path: string; sourceType: "builtin" | "user_file" | "workspace" }> = [
      { path: userImagesRoot, sourceType: "user_file" },
    ];
    try {
      const settingsStore = new ContextPackSettingsStore();
      const cfg = settingsStore.resolveConfig();
      const workspaceImagesRoot = nodePath.join(cfg.workspaceRoot, ".openrig", "agent-images");
      if (workspaceImagesRoot !== userImagesRoot && fs.existsSync(workspaceImagesRoot)) {
        roots.push({ path: workspaceImagesRoot, sourceType: "workspace" });
      }
    } catch { /* settings unavailable */ }
    return { userImagesRoot, roots };
  };
  const agentImageLibrary = (() => {
    const { roots } = agentImageRootBuilder();
    const lib = new AgentImageLibraryService({ roots });
    lib.scan();
    return lib;
  })();
  const snapshotCapturer = new SnapshotCapturer({
    db,
    rigRepo,
    sessionRegistry,
    agentImageLibrary,
    targetRoot: getDefaultOpenRigPath("agent-images"),
  });

  const podInstantiator = new PodRigInstantiator({
    db, rigRepo, podRepo,
    sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
    adapters: { "claude-code": claudeAdapter, "codex": codexAdapter, "pi": piAdapter, "stub": stubAdapter, "terminal": new (await import("./adapters/terminal-adapter.js")).TerminalAdapter() },
    tmuxAdapter,
    agentImageLibrary,
    exec,
  });

  const podBundleSourceResolver = new PodBundleSourceResolver();

  const bootstrapOrchestrator = new BootstrapOrchestrator({
    db, bootstrapRepo, runtimeVerifier, probeRegistry,
    installPlanner: externalInstallPlanner, installExecutor: externalInstallExecutor,
    packageInstallService, rigInstantiator, fsOps: resolverFsOps,
    bundleSourceResolver, podInstantiator, podBundleSourceResolver,
    serviceOrchestrator, rigRepo,
  });

  // V0.3.1 slice 05 kernel-rig-as-default — auto-boot the kernel rig
  // on daemon-start. Forward-fix #3 architectural: the bootstrap is
  // FIRED in the background, not awaited. createDaemon completes as
  // soon as the tracker is created so server.ts can bind healthz
  // independent of kernel-agent readiness. A broken kernel agent no
  // longer keeps the daemon HTTP surface from starting.
  //
  // Tracker state is exposed via /api/kernel/status (route below) and
  // the CLI's `rig daemon start --wait-for-kernel` flag polls it.
  // After the configurable degraded-timer window (default 90s; env
  // override OPENRIG_KERNEL_DEGRADED_MS for ops + test fixtures), the
  // tracker emits a single `kernel.agent.degraded` event for
  // observability. The kernel rig is still the only rig the daemon
  // auto-boots; other rigs require explicit operator-initiated
  // `rig up` / `rig restore` per amended IMPL-PRD §16.2.
  let kernelBootTracker: import("./domain/kernel-boot-tracker.js").KernelBootTracker | undefined;
  try {
    const { bootKernelIfNeeded } = await import("./domain/kernel-boot.js");
    const degradedRaw = readOpenRigEnv("OPENRIG_KERNEL_DEGRADED_MS");
    const degradedTimeoutMs = degradedRaw && /^\d+$/.test(degradedRaw)
      ? parseInt(degradedRaw, 10)
      : undefined;
    kernelBootTracker = await bootKernelIfNeeded({
      rigRepo,
      sessionRegistry,
      eventBus,
      bootstrapOrchestrator,
      specsDir: nodePath.resolve(nodePath.dirname(new URL(import.meta.url).pathname), "..", "specs"),
      // V0.3.1 slice 05 — kernel members run against the operator's
      // workspace, not the daemon installation tree. Without this
      // cwdOverride, BootstrapOrchestrator refuses with
      // "cwd is inside the OpenRig installation". Use the resolved
      // workspace.root setting as the per-operator default.
      cwdOverride: runtimeSettings.workspaceRoot,
      degradedTimeoutMs,
    });
    try {
      // eslint-disable-next-line no-console
      console.log(`kernel-boot: tracker-state=${kernelBootTracker.getStatus().kernelState}`);
    } catch { /* logging must never throw */ }
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.warn(`kernel-boot: skipped due to error: ${err instanceof Error ? err.message : String(err)}`);
    } catch { /* logging must never throw */ }
  }

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
  // Context usage store — constructed ahead of the refresher + ClaimService so the
  // Claude status-line sidecar reader can be injected into BOTH: FR-3
  // adoption-boundary capture (ClaimService) and FR-4 snapshot null-fill (refresher).
  // Also threaded through WhoamiService + routes below (same single instance).
  const { ContextUsageStore } = await import("./domain/context-usage-store.js");
  const contextUsageStore = new ContextUsageStore(db, {
    stateDir: OPENRIG_HOME,
    // GHOST-STAGE (c-id): reject context readings from before the live occupant booted (prior
    // generation) so a frozen pre-handover sample can't drive the threshold. null = UNKNOWN (inert).
    resolveOccupantBootAt: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.bootAt ?? null,
  });
  // OPR.0.4.3.20 FR-4 — inject contextUsageStore so refresh() can null-fill a
  // Claude token from the sidecar during periodic/manual snapshot refresh.
  const resumeMetadataRefresher = new ResumeMetadataRefresher({ sessionRegistry, tmuxAdapter, contextUsageStore });
  const claimService = new ClaimService({
    db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter, transcriptStore,
    claudeContextProvisioner: claudeAdapter,
    // OPR.0.4.3.20 FR-3 — adoption-boundary resume-token capture deps
    // (Claude sidecar reader + Codex thread-id capturer, both reuse).
    contextUsageStore,
    resumeTokenCapturer: resumeMetadataRefresher,
    // OPR.0.4.6.PI1 FR-6 — pi-runner sidecar reader (the adapter exposes it).
    piRunnerStateStore: piAdapter,
  });
  const selfAttachService = new SelfAttachService({
    db, rigRepo, podRepo, sessionRegistry, eventBus, tmuxAdapter, transcriptStore,
    claudeContextProvisioner: claudeAdapter,
    // OPR.0.4.3.28 B3 — echo the resolved activity url+token into the self-attach
    // response env so the caller's shell can produce activity signal.
    activityEnv: { url: resolvedActivityHookUrl, token: resolvedActivityHookToken },
  });
  const rigLifecycleService = new RigLifecycleService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter });
  const rigExpansionService = new RigExpansionService({ db, rigRepo, eventBus, nodeLauncher, podInstantiator, sessionRegistry });

  const specReviewService = new SpecReviewService();

  // (ContextUsageStore is constructed above, ahead of ClaimService, for FR-3.)
  const whoamiService = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore, contextUsageStore });
  const nodeCmuxService = new NodeCmuxService(rigRepo, sessionRegistry, cmuxAdapter, tmuxAdapter);
  // W2a-1 — producer wiring: the live occupant generation resolves synchronously from the shipped
  // occupant-tenure ledger. generation_uuid CHANGES for a new occupant and persists only within one
  // tenure (a same-session relaunch is a continuation with no new generation); node_id is the stable-
  // across-handover key, not this. null = UNKNOWN, honored by the store as abstain (never a stale claim
  // rendered live). No tmux exec — a better-sqlite3 read on the hot path.
  const agentActivityStore = new AgentActivityStore({
    db,
    eventBus,
    resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (nodeId, generation) =>
      sessionRegistry.isOccupantGenerationRegistered(nodeId, generation),
  });
  const { SeatAttentionReconciler } = await import("./domain/seat-attention-reconciler.js");
  const seatAttentionReconciler = new SeatAttentionReconciler({
    sessionRegistry, eventBus, agentActivityStore, db,
    sendVerify: async (session, text, opts) => {
      const transport = deps.sessionTransport;
      if (!transport) return { ok: false, outcome: "failed" };
      return transport.send(session, text, { verify: opts?.verify });
    },
    capture: async (session, opts) => {
      const transport = deps.sessionTransport;
      if (!transport) return { ok: false, sessionName: session, error: "transport_unavailable" };
      return transport.capture(session, opts);
    },
  });

  const deps: AppDeps = {
    rigRepo,
    sessionRegistry,
    daemonLifecycleStore,
    daemonBootEpoch,
    eventBus,
    nodeLauncher,
    tmuxAdapter,
    tmuxOptionDefaults,
    sessionEnv: launchSessionEnv,
    cmuxAdapter,
    snapshotCapture,
    snapshotRepo,
    // Slice-04 OPR.0.5.0.4: production provider service — getReadModel over the codex-auth reader
    // + node-inventory across rigs; precheck via the pure gate; switch honest-interim (D seam).
    // C3: the Claude statusline provider_usage cache lane. Cache files are seat-keyed and the
    // reader normalizes valid subscription windows. Live-seat fallback is owned by provider-collect.
    providerService: new ProviderServiceImpl({
      db,
      listRigs: () => rigRepo.listRigs(),
      collectClaudeSignals: () => collectClaudeSignalsFromProviderUsageDirectory(
        nodePath.join(OPENRIG_HOME, "provider-usage"),
      ),
      agentActivityStore,
    }),
    restoreOrchestrator,
    resumeMetadataRefresher, // OPR.0.4.3.20 FR-4 — manual snapshot refresh-before-serialize
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
    // Slice 15 — SeatActivityService owns the `terminal-active` primitive
    // (tmux byte-stream). Wired into PsProjectionService so `rig ps`
    // + UI surfaces read the latest observation per seat. NEVER reads
    // queue/assignment state (non-inference contract; see slice 15 IMPL-PRD §2.3).
    seatActivityService,
    seatStructuralActivityService,
    seatIdentityReconciler,
    // OPR.0.4.4.21 — agentActivity feeds the rig-rollup attention
    // predicate's needs_input signal (synchronous events lookup only).
    psProjectionService: new PsProjectionService({ db, seatActivity: seatActivityService, agentActivity: agentActivityStore }),
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
    runtimeAdapters: { "claude-code": claudeAdapter, "codex": codexAdapter, "pi": piAdapter, "stub": stubAdapter, "terminal": new (await import("./adapters/terminal-adapter.js")).TerminalAdapter() },
    transcriptStore,
    sessionTransport: (() => {
      const t = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter, agentActivityStore, eventBus, slowOpRecorder });
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
    streamStore,
    slowOpRecorder,
    queueRepo: queueRepoInstance,
    inboxHandler: new InboxHandler(db, eventBus, queueRepoInstance),
    outboxHandler: outboxHandlerInstance,
    classifierLeaseManager: classifierLeaseManagerInstance,
    projectClassifier: new ProjectClassifier(db, eventBus, classifierLeaseManagerInstance),
    viewProjector: viewProjectorInstance,
    watchdogJobsRepo: watchdogJobsRepoInstance,
    watchdogHistoryLog: watchdogHistoryLogInstance,
    wakeResolveService: new WakeResolveService({
      listSessionsBySeat: (seat: string) =>
        db
          .prepare(
            `SELECT s.id AS id, s.session_name AS sessionName, s.resume_token AS resumeToken,
                    n.runtime AS runtime, s.created_at AS createdAt
               FROM sessions s JOIN nodes n ON s.node_id = n.id
              WHERE s.session_name = ? ORDER BY s.id DESC`,
          )
          .all(seat) as WakeSessionRow[],
    }),
    askService: (() => {
      // P19 A5 (finding graduated): inject seatActivity like the attention path
      // (line ~919) — one terminalActive truth, never two divergent projections.
      const psProjectionService = new PsProjectionService({ db, seatActivity: seatActivityService, agentActivity: agentActivityStore });
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
    seatAttentionReconciler,
    activityHookToken: resolvedActivityHookToken,
    contextUsageStore,
    serviceOrchestrator,
    composeAdapter,
    kernelBootTracker,
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
    // Phase 3a slice 3.3 — plugin discovery service.
    // SC-29 EXCEPTION #8 verbatim: see packages/daemon/src/routes/plugins.ts
    // header. Filesystem-scan over 3 source roots + agent.yaml-parse for
    // used-by reverse query. No SQL; no mutation. Spec library directory
    // for used-by uses the same default user spec root as SpecLibraryService
    // above; one root at v0 (multi-root expansion deferred to a later slice
    // when spec library hooks its full root list through to discovery).
    // bug-fix slice plugin-discovery-respects-openrig-home: route the
    // openrigPluginsDir through the OPENRIG_HOME-aware resolver so
    // discovery + vendor (which already uses the helper at line 428)
    // resolve to the same root. Operator-level test isolation + the
    // slice 22 populated-VM-env story both depend on this symmetry.
    // claudeCacheDir / codexCacheDir remain homedir-anchored because
    // those cache locations belong to the runtime tools, not to the
    // OpenRig state root.
    pluginDiscoveryService: new PluginDiscoveryService({
      openrigPluginsDir: getDefaultOpenRigPath("plugins"),
      claudeCacheDir: nodePath.join(os.homedir(), ".claude", "plugins", "cache"),
      codexCacheDir: nodePath.join(os.homedir(), ".codex", "plugins", "cache"),
      specLibraryDir: getDefaultOpenRigPath("specs"),
    }),
    // Slice 28 Checkpoint C-3 — skillLibraryDiscoveryService is constructed
    // AFTER filesAllowlist resolution below (deps.skillLibraryDiscoveryService
    // assignment near filesAllowlist binding).
    // Shared context library backing the delivery-free context routes.
    contextPackLibrary,
    // PL-016 — agent_image typed primitive. Shared library + capturer
    // + spec-roots supplier across /api/agent-images/* and the
    // PodRigInstantiator's session_source: mode: agent_image dispatch.
    agentImageLibrary,
    snapshotCapturer,
    // Slice 09 (OPR.0.3.2.9) — operator-context-mode bindings store
    // (typed primitive on the shared db handle; HG-5: no parallel store).
    rigModeStore: new RigModeStore(db),
    agentImageSpecRoots: () => {
      // Spec-library roots scanned by the evidence guard. v0: user
      // specs under ~/.openrig/specs + workspace-local specs root
      // (from the SettingsStore-resolved workspace.specsRoot).
      const userSpecsRoot = getDefaultOpenRigPath("specs");
      const roots: string[] = [userSpecsRoot];
      try {
        const settingsStore = new ContextPackSettingsStore();
        const cfg = settingsStore.resolveConfig();
        if (cfg.workspaceSpecsRoot && cfg.workspaceSpecsRoot !== userSpecsRoot) {
          roots.push(cfg.workspaceSpecsRoot);
        }
      } catch { /* settings unavailable */ }
      return roots;
    },
  };
  Object.assign(deps, { watchdogAutoRegistration });

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

  // OPR.0.4.8.3 — materialize the packaged built-in policies as read-only
  // inspection copies at $OPENRIG_HOME/reference/policies/builtin/ (same
  // best-effort posture as the reference docs above; ../policies/builtin
  // resolves from the compiled dist in BOTH the repo-run and assembled layouts)
  try {
    materializeBuiltinPolicyReference({
      bundledDir: nodePath.resolve(import.meta.dirname, "../policies/builtin"),
      targetDir: getDefaultOpenRigPath(nodePath.join("reference", "policies", "builtin")),
    });
  } catch { /* best-effort — inspection copies are not critical to daemon operation */ }

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
  let workflowExceptionEnsurer:
    | import("./domain/workflow-exception-escalation.js").EnsureStuckExceptionItem
    | undefined;
  if (queueRepoForWorkflow) {
    workflowRuntime = new WorkflowRuntime({
      db,
      eventBus,
      queueRepo: queueRepoForWorkflow,
      // OPR.0.4.6.WF1 FR-3: instantiate/handoff auto-arm the
      // per-instance workflow-keepalive job in-txn; terminal disarms.
      watchdogJobsRepo: watchdogJobsRepoInstance,
      // OPR.0.4.6.WF5 FR-2: the maturity dial — host default read LIVE
      // per exception from the settings twin (dial flips affect future
      // items only, never retroactive re-routing).
      exceptionDial: {
        hostDefault: () => {
          const v = new ContextPackSettingsStore().resolveOne("workflow.exception_routing")
            .value as string | undefined;
          return v === "orchestrator" || v === "human_only" ? v : null;
        },
        humanFallbackSeat: "human@host",
      },
    });
    deps.workflowRuntime = workflowRuntime;

    // OPR.0.4.6.WF5 FR-2 class (b): the shared detection-time exception
    // ensurer — sweep + keepalive both call it; dedup by occurrence tags.
    {
      const { makeEnsureStuckExceptionItem } = await import(
        "./domain/workflow-exception-escalation.js"
      );
      workflowExceptionEnsurer = makeEnsureStuckExceptionItem({
        db,
        queueRepo: queueRepoForWorkflow,
        resolveRoute: (name, version, cls, boundRig) =>
          workflowRuntime!.resolveExceptionRouteFor(name, version, cls, boundRig),
        humanFallbackSeat: "human@host",
        log: (line) => console.log(line),
      });
    }

    // Seed built-in starter workflow_specs into the cache. Idempotent
    // + workspace-surface-respecting — operator
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

    // Slice 11 (workflow-spec-folder-discovery) — expose the shared
    // WorkflowSpecCache + the resolved workspace workflows folder so
    // GET /api/specs/library can opportunistically discover operator-
    // dropped YAML on each list request. Folder path is
    // `<workspace.specs_root>/workflows`; SettingsStore resolves
    // workspaceSpecsRoot from env > config > workspace-default.
    deps.workflowSpecCache = workflowRuntime.specCache;

    // OPR.0.3.2.22 Bug 4 — one-time prune of cache rows whose source_path
    // lives in noise directories (.worktrees, node_modules, etc.). The
    // post-Bug-4 walkYamlFiles SKIP_DIRS guard prevents NEW rows from
    // those locations, but legacy rows from prior daemon versions (or
    // operators who hand-imported a spec via path-form before SKIP_DIRS
    // shipped) would persist without this prune. Cheap (single DELETE
    // with bounded LIKE patterns) and safe (matches only the same
    // directories the walker now refuses to enter).
    //
    // installRoot guard: shipped built-in workflow specs live at
    // `<pkg>/dist/builtins/workflow-specs/` in production. Without the
    // install-root preservation clause, the `%/dist/%` pattern would
    // delete them on every boot (then loadStarterWorkflowSpecs re-seeds
    // — wasteful at best, broken if the loader ever skips re-seeding).
    // Pass the resolved install root so rows under it are preserved.
    const { getOpenRigInstallRoot } = await import("./domain/cwd-resolution.js");
    workflowRuntime.specCache.pruneNoiseDirRows(getOpenRigInstallRoot());

    try {
      const settingsStore = new ContextPackSettingsStore();
      const cfg = settingsStore.resolveConfig();
      if (cfg.workspaceSpecsRoot) {
        deps.workflowsFolderDir = nodePath.join(cfg.workspaceSpecsRoot, "workflows");
      }
    } catch { /* settings unavailable — folder scan stays disabled */ }

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
    // V0.3.1 slice 05 kernel-rig-as-default — cascade the resolved
    // workspace.operator_seat_name setting into the mission-control
    // read layer so my-queue routes to the operator's configured seat
    // (default `operator-${USER}@kernel`) instead of the legacy
    // hardcoded constant. The setting reads OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME
    // env var first, then ~/.openrig/config.json, then the derived
    // default — same cascade as every other typed setting.
    const mcReadLayer = new MissionControlReadLayer({
      db,
      queueRepo: deps.queueRepo,
      viewProjector: deps.viewProjector,
      streamStore: deps.streamStore,
      fleetCliCapability: mcFleetCliCapability,
      defaultOperatorSession: runtimeSettings.workspaceOperatorSeatName,
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

    const terminalTokenEnv = process.env.OPENRIG_TERMINAL_BEARER_TOKEN?.trim();
    deps.terminalBearerToken =
      opts && Object.prototype.hasOwnProperty.call(opts, "terminalBearerToken")
        ? opts.terminalBearerToken ?? null
        : terminalTokenEnv || null;

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
  // User Settings v0 graduates `OPENRIG_SLICES_ROOT` env-var into the
  // typed `workspace.slices_root` setting (resolution chain: env >
  // config-file > default `<workspace.root>/missions`). Backward-compat:
  // operators with OPENRIG_SLICES_ROOT set continue to work because the
  // settings store reads env in the same resolution slot. Operators
  // setting via `rig config set workspace.slices_root <path>` or via the
  // System drawer Settings panel UI now flow through the indexer too —
  // closes the PRD § Scenario B requirement that wasn't wired in v0.
  //
  //   OPENRIG_SLICES_ROOT             legacy short env var (still honored
  //                                   if set; preferred route is settings)
  //   OPENRIG_WORKSPACE_SLICES_ROOT   typed-key env override
  //   workspace.slices_root           typed setting in ~/.openrig/config.json
  //   workspace.root                  cascade fallback (default ~/.openrig/workspace)
  //   workspace.dogfood_evidence_root typed setting for proof packet assets
  //   OPENRIG_DOGFOOD_EVIDENCE_ROOT   env override for compatibility
  //
  // When the resolved slicesRoot path doesn't exist on disk, the indexer
  // is still constructed but isReady() returns false — the routes return
  // a clear "slices_root_not_configured" 503 with a setup hint.
  {
    // Prefer the legacy short env var if explicitly set (existing
    // dogfood / test daemons rely on it). Otherwise fall back to the
    // settings-resolved path (env > file > default cascade inside
    // SettingsStore). The SettingsStore is constructed locally here
    // so the slices block doesn't depend on the User Settings v0 wiring
    // block ordering further below.
    const legacyEnvSlicesRoot = readOpenRigEnv("OPENRIG_SLICES_ROOT", "RIGGED_SLICES_ROOT") ?? "";
    let resolvedSlicesRoot = "";
    let resolvedWorkspaceRoot = "";
    let resolvedDogfoodRoot = "";
    if (!legacyEnvSlicesRoot) {
      try {
        const { SettingsStore: SettingsStoreCtor } = await import("./domain/user-settings/settings-store.js");
        const resolvedConfig = new SettingsStoreCtor().resolveConfig();
        resolvedSlicesRoot = resolvedConfig.workspaceSlicesRoot;
        resolvedWorkspaceRoot = resolvedConfig.workspaceRoot;
        resolvedDogfoodRoot = resolvedConfig.workspaceDogfoodEvidenceRoot;
      } catch {
        // SettingsStore unavailable — keep slicesRoot empty; routes return 503.
      }
    } else {
      try {
        const { SettingsStore: SettingsStoreCtor } = await import("./domain/user-settings/settings-store.js");
        const resolvedConfig = new SettingsStoreCtor().resolveConfig();
        resolvedDogfoodRoot = resolvedConfig.workspaceDogfoodEvidenceRoot;
      } catch {
        // SettingsStore unavailable — proof packets remain disabled.
      }
    }
    const slicesRoot = legacyEnvSlicesRoot || resolvedSlicesRoot;
    const additionalSliceRoots = resolvedWorkspaceRoot
      ? [
          nodePath.join(resolvedWorkspaceRoot, "missions"),
          nodePath.join(resolvedWorkspaceRoot, "slices"),
        ].filter((root) => root !== slicesRoot)
      : [];
    const { SliceIndexer } = await import("./domain/slices/slice-indexer.js");
    const { SliceDetailProjector } = await import("./domain/slices/slice-detail-projector.js");
    const sliceIndexer = new SliceIndexer({
      slicesRoot,
      additionalSliceRoots,
      dogfoodEvidenceRoot: resolvedDogfoodRoot || null,
      db,
    });
    // Slice Story View v1: pass workflowRuntime.specCache so the
    // projector can resolve a bound workflow_instance's spec for
    // spec-graph + phase + current-step projection. When the workflow
    // runtime is not constructed (queueRepo absent — same condition
    // already guards the workflowRuntime block above), the projector
    // silently degrades to v0 behavior (workflowBinding=null,
    // specGraph=null, phaseDefinitions=null, currentStep=null).
    const sliceDetailProjector = new SliceDetailProjector({
      db,
      indexer: sliceIndexer,
      workflowSpecCache: workflowRuntime?.specCache,
    });
    deps.sliceIndexer = sliceIndexer;
    deps.sliceDetailProjector = sliceDetailProjector;
    // Living Notes Packet 2 (OPR.0.4.4.20): the composed-review gatherer.
    // Git lineage facts come from OPENRIG_REVIEW_GIT_REPO when set; else
    // lineage degrades honestly to unknown.
    const { ReviewGatherer } = await import("./domain/review/gather.js");
    deps.reviewGatherer = new ReviewGatherer({
      db,
      indexer: sliceIndexer,
      gitRepoPath: process.env["OPENRIG_REVIEW_GIT_REPO"] ?? null,
      // OPR.0.4.4.22 FR-2: the agent state glyph reads recorded hook
      // activity (honest-unknown when absent) - synchronous, never polls.
      activityStore: agentActivityStore,
    });
  }

  // OPR.0.4.6.02 C3 — the terminal-provider-ride service (ONE composer for
  // every view kind). Built here (post-hoc) so it can read the lazily-built
  // reviewGatherer for derived mission/slice views; if the gatherer never
  // built, those scopes honestly return not-found rather than throwing.
  {
    const { TerminalService } = await import("./domain/terminal/terminal-service.js");
    const { HerdrAdapter } = await import("./domain/terminal/herdr-adapter.js");
    const { createHerdrSocketRpc, createHerdrSocketTransport } = await import(
      "./domain/terminal/herdr-transport.js"
    );
    const { CmuxProviderAdapter } = await import("./domain/terminal/cmux-provider-adapter.js");
    const { CmuxLayoutService } = await import("./domain/cmux-layout-service.js");
    const { TerminalViewsStore } = await import("./domain/terminal/terminal-views-store.js");
    const { getNodeInventory } = await import("./domain/node-inventory.js");
    const { loadHostRegistry, resolveHost: resolveHostInRegistry } = await import(
      "./domain/hosts/hosts-registry-reader.js"
    );

    // NodeInventoryEntry → the composer's minimal LiveSeatRow (single-host
    // inventory: the canonical session name IS the tmux session; no host field).
    const toLiveSeatRow = (e: {
      canonicalSessionName: string | null;
      attachmentType?: "tmux" | "external_cli" | null;
      rigName: string;
      logicalId: string;
    }) => ({
      canonicalSessionName: e.canonicalSessionName,
      attachmentType: e.attachmentType ?? null,
      tmuxSession: e.canonicalSessionName,
      rigName: e.rigName,
      logicalId: e.logicalId,
    });

    const herdrProvider = new HerdrAdapter({
      // FB4: herdr speaks its unix control socket (there is no `layout` CLI).
      transportFactory: createHerdrSocketTransport(createHerdrSocketRpc()),
    });
    const cmuxProvider = new CmuxProviderAdapter({
      cmuxAdapter,
      // One gridded workspace per composed page — the same grid machinery as
      // the rig-scope /cmux/launch endpoint, never one window per seat.
      layoutService: new CmuxLayoutService(cmuxAdapter),
    });
    const providerMap: Record<string, typeof herdrProvider | typeof cmuxProvider> = {
      herdr: herdrProvider,
      cmux: cmuxProvider,
    };

    deps.terminalService = new TerminalService({
      resolveProvider: (name) => providerMap[name] ?? null,
      viewsStore: new TerminalViewsStore(),
      listRigSeats: (rigArg) => {
        const rigs = rigRepo.listRigs();
        const rig = rigs.find((r) => r.name === rigArg) ?? rigs.find((r) => r.id === rigArg);
        if (!rig) return null;
        return getNodeInventory(db, rig.id).map(toLiveSeatRow);
      },
      listPodSeats: (rigArg, pod) => {
        const rigs = rigRepo.listRigs();
        const rig = rigs.find((r) => r.name === rigArg) ?? rigs.find((r) => r.id === rigArg);
        if (!rig) return null;
        const rows = getNodeInventory(db, rig.id)
          .filter((e) => e.podNamespace === pod)
          .map(toLiveSeatRow);
        // No node carries that pod namespace → an unknown pod (not an empty view).
        return rows.length > 0 ? rows : null;
      },
      listScopeSeats: (scope) => {
        const gatherer = deps.reviewGatherer;
        if (!gatherer) return null;
        // N1 (dev44-driver2 pre-guard): cast to the real AgentsScope union (not
        // `never`) so the compile guard on the scope grammar is restored.
        const band = gatherer.composeAgents(scope as import("./domain/review/types.js").AgentsScope);
        if (!band) return null;
        const wanted = new Set(band.rows.map((r) => r.sessionName));
        const rows: ReturnType<typeof toLiveSeatRow>[] = [];
        for (const rig of rigRepo.listRigs()) {
          for (const e of getNodeInventory(db, rig.id)) {
            if (e.canonicalSessionName && wanted.has(e.canonicalSessionName)) rows.push(toLiveSeatRow(e));
          }
        }
        return rows;
      },
      listRigNames: () => rigRepo.listRigs().map((r) => r.name),
      resolveHost: (id) => {
        const res = loadHostRegistry();
        if (!res.ok) return null;
        const r = resolveHostInRegistry(res.registry, id);
        return r.ok ? r.host : null;
      },
      hasSession: (session) => tmuxAdapter.hasSession(session),
    });
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
    const { decodeAllowlist } = await import("./domain/files/path-safety.js");
    const { FileWriteService } = await import("./domain/files/file-write-service.js");
    const { ProgressIndexer, decodeProgressScanRoots } = await import("./domain/progress/progress-indexer.js");
    // User Settings v0 — UEP env-vars graduated to typed settings.
    // Resolution: env > settings file > empty. SettingsStore handles
    // the env > file > default precedence; we just decode the raw
    // string into structured roots.
    const { SettingsStore } = await import("./domain/user-settings/settings-store.js");
    const settingsStore = new SettingsStore();
    deps.settingsStore = settingsStore;
    const cfg = settingsStore.resolveConfig();

    // Preview Terminal v0 (PL-018) — per-session rate limiter for the
    // /preview route. 1-second window per (session, lines) cache key:
    // short enough that legitimate polling at the operator's refresh
    // interval (`ui.preview.refresh_interval_seconds`, default 3s) always
    // sees fresh content, but multiple pinned-pane requests for the same
    // seat within a single second collapse to one tmux capture.
    const { PreviewRateLimiter } = await import("./domain/preview/preview-rate-limiter.js");
    deps.previewRateLimiter = new PreviewRateLimiter(1000);
    const filesAllowlist = decodeAllowlist(cfg.filesAllowlistRaw);
    deps.filesAllowlist = filesAllowlist;
    deps.fileWriteService = filesAllowlist.length > 0
      ? new FileWriteService({
          allowlist: filesAllowlist,
          auditFilePath: nodePath.join(OPENRIG_HOME, "file-edit-audit.jsonl"),
        })
      : null;
    // Slice 28 Checkpoint C-3 — SkillLibraryDiscoveryService. sharedSkillsDir
    // resolves to the daemon's bundled `specs/agents/shared/skills/`
    // directory via import.meta.url (independent of operator allowlist
    // configuration; closes HG-5 on the founder-walk VM where the operator
    // allowlist doesn't include the daemon source tree). filesAllowlist
    // is also passed so workspace `.openrig/skills/` skills surface via
    // the same daemon endpoint.
    deps.skillLibraryDiscoveryService = new SkillLibraryDiscoveryService({
      sharedSkillsDir: nodePath.resolve(
        nodePath.dirname(new URL(import.meta.url).pathname),
        "..",
        "specs",
        "agents",
        "shared",
        "skills",
      ),
      filesAllowlist,
    });
    deps.progressIndexer = new ProgressIndexer({ roots: decodeProgressScanRoots(cfg.progressScanRootsRaw) });

    // Operator Surface Reconciliation v0 — steering composer (item 1).
    // Reads typed workspace settings by default while preserving the
    // OPENRIG_STEERING_* env override family for non-canonical layouts.
    const { SteeringComposer, steeringOptsFromSettings } = await import("./domain/steering/steering-composer.js");
    deps.steeringComposer = new SteeringComposer(steeringOptsFromSettings({
      workspaceRoot: cfg.workspaceRoot,
      workspaceSteeringPath: cfg.workspaceSteeringPath,
    }));

    // Workflows in Spec Library + Activation Lens v0 — active lens
    // persistence under OPENRIG_HOME/active-workflow-lens.json. Same
    // file-backed pattern as UI Enhancement Pack v0's audit JSONL —
    // honors OPENRIG_HOME so isolated test/dogfood daemons keep their
    // own lens state instead of bleeding into the operator's host.
    const { ActiveLensStore } = await import("./domain/active-lens-store.js");
    deps.activeLensStore = new ActiveLensStore({
      filePath: nodePath.join(OPENRIG_HOME, "active-workflow-lens.json"),
    });
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
      // (i-c) fire-time target-generation gate: resolve the target's LIVE occupant-generation (P12
      // occupant_tenures) so a generation-bound wake is refused once the target has handed over.
      // UNKNOWN (null) fails open → deliver. A drop of this line disables the gate silently (gen-bound
      // wakes would fire at the successor) — pinned in watchdog-target-gen-wiring.test.ts.
      resolveTargetGeneration: (s) => sessionRegistry.currentOccupantGenerationForSession(s),
      // PL-004 Phase D: register workflow-keepalive policy alongside
      // Phase C's three built-in policies. workflow-keepalive reads
      // SQLite workflow_instances directly via the new Phase D tables
      // (audit row 18: SQLite-source-only, no markdown read).
      // OPR.0.4.3.16: register idle-gate-qitem — joins pending gate:*
      // qitems (queue_items) with a FRESH idle runtime signal from the
      // shared AgentActivityStore (constructed above, before the engine)
      // into one bounded wake. Wakes/flags only; cooldown via engine throttle.
      additionalPolicies: [
        makeWorkflowKeepalivePolicy({
          db,
          // OPR.0.4.6.WF5 FR-2 class (b): detection-time exception items,
          // dedup by occurrence; dial resolved via the runtime's cached
          // spec (never-lost fallback inside the helper).
          ensureStuckExceptionItem: workflowExceptionEnsurer,
        }),
        makeIdleGateQitemPolicy({ db, agentActivityStore }),
      ],
    });
    const watchdogScheduler = new WatchdogScheduler({
      jobsRepo: watchdogJobsRepoInstance,
      policyEngine: watchdogPolicyEngine,
    });
    deps.watchdogPolicyEngine = watchdogPolicyEngine;
    deps.watchdogScheduler = watchdogScheduler;

    // B8 / slice-07 A3 — the MODEL-DIVERGENCE MONITOR: cause-agnostic effective-vs-pinned
    // comparison at the earliest reliable per-runtime read, one verdict per occupant generation,
    // LOUD four-channel proclamation on divergence (orch seats + operator + oversight + the named
    // Slack deferral per DS2). Channel targets per the desk ruling 2026-08-21: orch = the seat's
    // own rig's orch.* seats; operator = derived from workspace.operator_seat_name (never
    // hardcoded); oversight = the fleet judgment seat, locally resolvable or a NAMED deferral
    // (no daemon-side cross-host send seam exists yet — the deferral names that, never silence).
    {
      const { ModelDivergenceMonitor } = await import("./domain/model-divergence/model-divergence-monitor.js");
      const { readClaudeEffectiveModel, readCodexEffectiveModel } = await import("./domain/model-divergence/effective-model-readers.js");
      const { paneClaudeSessionIdArgument, selectLiveClaudeRecord, resolveLiveCodexThreadId } = await import("./domain/model-divergence/current-generation-record.js");
      const { defaultListProcesses } = await import("./domain/resume-metadata-refresher.js");
      const { readCodexThreadIdFromCandidateHomes, defaultResolveHomeDirByPid } = await import("./domain/codex-thread-id.js");
      const nodeOs = await import("node:os");
      const nodePathMod = await import("node:path");
      const nodeFs = await import("node:fs");
      const currentGenDeps = {
        getPanePid: async (sessionTarget: string) => tmuxAdapter.getPanePid ? tmuxAdapter.getPanePid(sessionTarget) : null,
        listProcesses: defaultListProcesses,
        readThreadIdByPid: async (pid: number) =>
          readCodexThreadIdFromCandidateHomes(pid, [await defaultResolveHomeDirByPid(pid), nodeOs.homedir()]),
      };
      const OVERSIGHT_SEAT = "watch-lead@oversight";
      const modelDivergenceMonitor = new ModelDivergenceMonitor({
        listPinnedSeats: () => {
          const rows = db.prepare(`
            SELECT n.id AS nodeId, r.id AS rigId, r.name AS rigName, n.runtime AS runtime, n.model AS pinnedModel,
                   (SELECT s.session_name FROM sessions s
                     WHERE s.node_id = n.id AND s.status = 'running'
                     ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS sessionName
              FROM nodes n JOIN rigs r ON r.id = n.rig_id
             WHERE n.model IS NOT NULL AND n.model <> ''
          `).all() as Array<{ nodeId: string; rigId: string; rigName: string; runtime: string | null; pinnedModel: string; sessionName: string | null }>;
          return rows
            .filter((row): row is typeof row & { sessionName: string } => row.sessionName !== null)
            .map((row) => ({ ...row, generation: sessionRegistry.currentOccupantGenerationForSession(row.sessionName) }));
        },
        // D-a — the CURRENT GENERATION's record via the live pane process, never a name/token
        // lookup alone: on the live specimen (dev.planner) the name-keyed sidecar AND the newest
        // registry row were stale TOGETHER while the pane ran a different session — the old wiring
        // read the old generation's transcript and MASKED a real divergence. The stored records are
        // now only corroboration; the pane process is the join. Every no-answer is a named reason.
        readEffectiveModel: async (seat) => {
          if (seat.runtime === "codex") {
            const live = await resolveLiveCodexThreadId(seat.sessionName, currentGenDeps);
            if (!live.ok) return { ok: false as const, reason: live.reason };
            const rollout = contextUsageStore.readCodexAndNormalize({ threadId: live.id, sessionName: seat.sessionName }).transcriptPath;
            if (!rollout) return { ok: false as const, reason: `live thread ${live.id.slice(0, 8)}… has no readable rollout` };
            const model = readCodexEffectiveModel(rollout);
            return model ? { ok: true as const, model } : { ok: false as const, reason: `no model signal in the bounded read of ${rollout}` };
          }
          if (seat.runtime === "claude-code") {
            // D-a — RECORD-LIVENESS selection: no single pointer (sidecar, registry row, pane
            // argument) is generation-true; the transcript being WRITTEN is. Gather all candidate
            // ids, anchor paths beside the sidecar's project dir, pick the freshest-mtime record.
            const usage = contextUsageStore.readAndNormalize(seat.sessionName);
            const projectDir = usage.transcriptPath ? nodePathMod.dirname(usage.transcriptPath) : null;
            const pathFor = (id: string | null | undefined): string | null =>
              id && projectDir ? nodePathMod.join(projectDir, `${id}.jsonl`) : null;
            const tokenRow = db.prepare("SELECT resume_token FROM sessions WHERE node_id = ? AND session_name = ? ORDER BY id DESC LIMIT 1")
              .get(seat.nodeId, seat.sessionName) as { resume_token: string | null } | undefined;
            const paneArg = await paneClaudeSessionIdArgument(seat.sessionName, currentGenDeps);
            const selection = await selectLiveClaudeRecord(
              [
                { source: "sidecar", id: usage.sessionId ?? "", path: usage.transcriptPath ?? pathFor(usage.sessionId) },
                { source: "registry", id: tokenRow?.resume_token ?? "", path: pathFor(tokenRow?.resume_token) },
                { source: "pane-argument", id: paneArg.ok ? paneArg.id : "", path: pathFor(paneArg.ok ? paneArg.id : null) },
              ],
              (path) => { try { const st = nodeFs.statSync(path); return { mtimeMs: st.mtimeMs, size: st.size }; } catch { return null; } },
            );
            if (!selection.ok) return { ok: false as const, reason: selection.reason };
            const model = readClaudeEffectiveModel(selection.path);
            return model
              ? { ok: true as const, model }
              : { ok: false as const, reason: `no assistant turn yet in the live record ${selection.path} (selected by liveness from ${selection.source})` };
          }
          return { ok: false as const, reason: `runtime ${seat.runtime ?? "unknown"} has no effective-model reader yet` };
        },
        sendToSession: async (target, message) => {
          try {
            const result = await sessionTransport.send(target, message);
            return result.ok ? { ok: true } : { ok: false, error: result.error };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
        resolveOrchSeats: (rigName) => (db.prepare(`
          SELECT s.session_name AS sessionName
            FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
           WHERE r.name = ? AND s.status = 'running' AND n.logical_id LIKE 'orch.%'
        `).all(rigName) as Array<{ sessionName: string }>).map((row) => row.sessionName),
        resolveOperatorSeat: () => {
          const value = deps.settingsStore?.resolveOne("workspace.operator_seat_name").value;
          return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
        },
        resolveOversightSeat: () => {
          const row = db.prepare("SELECT session_name FROM sessions WHERE session_name = ? AND status = 'running' LIMIT 1").get(OVERSIGHT_SEAT);
          return row ? OVERSIGHT_SEAT : null;
        },
        recordProclamation: (proclamation) => {
          eventBus.emit({
            type: "seat.model_divergence",
            rigId: proclamation.rigId,
            nodeId: proclamation.nodeId,
            sessionName: proclamation.sessionName,
            runtime: proclamation.runtime,
            pinnedModel: proclamation.pinnedModel,
            effectiveModel: proclamation.effectiveModel,
            diagnosis: proclamation.diagnosis,
            channels: proclamation.channels,
          });
        },
      });
      modelDivergenceMonitor.startPolling(60_000);
      deps.modelDivergenceMonitor = modelDivergenceMonitor;
    }

    // OPR.0.4.6.WF1 FR-4: the workflow startup resume sweep — re-arm
    // keepalives, reissue lost post-commit nudges (pending frontier
    // packets never nudged), surface stuck instances. Runs after the
    // watchdog + transport are wired so re-nudges actually deliver.
    // Failures are logged, never fatal: a sweep problem must not
    // bring the daemon down.
    if (workflowRuntime && queueRepoForWorkflow) {
      try {
        const { runWorkflowBootSweep } = await import("./domain/workflow-boot-sweep.js");
        await runWorkflowBootSweep({
          instanceStore: workflowRuntime.instanceStore,
          queueRepo: queueRepoForWorkflow,
          watchdogJobsRepo: watchdogJobsRepoInstance,
          log: (line) => console.log(line),
          // OPR.0.4.6.WF5 FR-2 class (b): the sweep leg of detection.
          ensureStuckExceptionItem: workflowExceptionEnsurer,
        });
      } catch (err) {
        console.warn(
          `workflow boot sweep: failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // W1 (transactional closure) FR — the wake-intent RECOVERY SWEEP. Deliver
    // any wake intents a crash left committed-but-undelivered (the terminal txn
    // committed, so the intent is durable, but the process died before the
    // post-commit deliver). Runs after transport is wired so the re-deliveries
    // actually land. Non-fatal — a sweep failure must not bring the daemon down.
    // No periodic timer (ruled out of scope): a transient failure lands the row
    // in a VISIBLE state and is retried on the next start.
    try {
      // BLOCKING 1: reconcile abandoned `sending` claims (a prior crash) FIRST,
      // then drain committed `pending` intents. Reconcile is a one-time boundary
      // step, separate from the drain.
      const reconciled = queueRepoInstance.reconcileAbandonedWakeIntents();
      const drained = await queueRepoInstance.drainPendingWakeIntents();
      if (drained.delivered || drained.indeterminate || drained.failed || reconciled) {
        console.log(
          `wake-intent recovery sweep: delivered=${drained.delivered} indeterminate=${drained.indeterminate} failed=${drained.failed} reconciled=${reconciled}`,
        );
      }
    } catch (err) {
      console.warn(
        `wake-intent recovery sweep: failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Context monitor — constructed before createApp so routes can access pollOnce for refresh.
  // Caller (index.ts) starts polling after listen.
  // Slice 27: wire ClaudeCompactionEnforcer when sessionTransport is
  // available (it always is in the assembled deps; the conditional keeps
  // the type narrow for downstream consumers).
  const { ContextMonitor } = await import("./domain/context-monitor.js");
  const { ClaudeCompactionEnforcer } = await import("./domain/claude-compaction-enforcer.js");
  const compactionEnforcer = deps.sessionTransport
    ? new ClaudeCompactionEnforcer(
        new ContextPackSettingsStore(),
        deps.sessionTransport,
        // GHOST-STAGE (b): resolve the LIVE occupant generation (atom-B tenure ledger) for a session
        // so a stage minted by a retired generation is refused for the successor. null = UNKNOWN → the
        // gate is inert (never compares a stale generation as if live).
        { resolveOccupantGeneration: (sessionName) => sessionRegistry.currentOccupantGenerationForSession(sessionName) },
      )
    : undefined;
  // 51-08 A1 — the over-time series rides the SAME 30s tick (PM decision 1):
  // context lane appends beside the existing persist; the provider-window lane
  // drains the same statusline cache directory the read model scans.
  const { UsageSamplesStore, providerWindowSamplesFromSignals } = await import("./domain/usage-samples-store.js");
  const usageSamplesStore = new UsageSamplesStore(db);
  const contextMonitor = new ContextMonitor(db, contextUsageStore, claudeAdapter, compactionEnforcer, {
    "claude-code": claudeAdapter,
    codex: codexAdapter,
    pi: piAdapter,
  }, usageSamplesStore, () => providerWindowSamplesFromSignals(
    collectClaudeSignalsFromProviderUsageDirectory(nodePath.join(OPENRIG_HOME, "provider-usage")),
  ));
  deps.contextMonitor = contextMonitor;
  // OPR.0.4.3.14 — expose the SAME enforcer instance to routes for the manual
  // compaction trigger. Sharing one instance with ContextMonitor is what makes
  // the manual back-half drain through the auto poll loop (no second path).
  deps.compactionEnforcer = compactionEnforcer;

  // GHOST-STAGE (e/Class-B) — construct the canonical OccupantInvalidator now that both Class-A deps
  // exist (the enforcer's in-mem maps 1a-1f + the context sidecar 2a). Injected into SeatHandoverService
  // via the app context so commit()'s re-key call FIRES (it was a no-op until wired). An absent enforcer
  // (degraded boot, no sessionTransport) falls back to a sidecar-only invalidator — never throws.
  const { DefaultOccupantInvalidator } = await import("./domain/occupant-invalidator.js");
  deps.occupantInvalidator = new DefaultOccupantInvalidator({
    enforcer: compactionEnforcer ?? { invalidateOccupant: () => {} },
    contextUsage: contextUsageStore,
    // (e/Class-B) watchdog store — armed jobs registered by the retiring generation stop at swap.
    watchdog: watchdogJobsRepoInstance,
    // (e/Class-B) queue store — in-progress items claimed by the retiring generation release to pending.
    queue: queueRepoInstance,
    log: (msg) => console.warn(msg),
  });

  // OPR.0.3.4.9 — periodic snapshot scheduler (crash-insurance floor).
  const { PeriodicSnapshotScheduler } = await import("./domain/periodic-snapshot-scheduler.js");
  const periodicSnapshotScheduler = new PeriodicSnapshotScheduler({
    db, snapshotCapture, snapshotRepo,
    // OPR.0.4.3.20 FR-4 — refresh live tokens before each periodic snapshot serializes.
    sessionRegistry, resumeMetadataRefresher,
  });
  deps.periodicSnapshotScheduler = periodicSnapshotScheduler;

  // OPR.0.4.3.21 — daemon event-loop health instrumentation. Constructed once
  // per daemon and wired into deps so `/healthz` can surface wedge evidence
  // (loop lag / last-tick age) and the expensive topology routes are timed.
  const { EventLoopMonitor } = await import("./domain/event-loop-monitor.js");
  const { RouteTimingRecorder } = await import("./domain/route-timing-recorder.js");
  const eventLoopMonitor = new EventLoopMonitor();
  const routeTimingRecorder = new RouteTimingRecorder();
  deps.eventLoopMonitor = eventLoopMonitor;
  deps.routeTimingRecorder = routeTimingRecorder;

  const { app, injectWebSocket } = createAppWithWebSocket(deps);

  return { app, db, deps, contextMonitor, eventLoopMonitor, injectWebSocket };
}
