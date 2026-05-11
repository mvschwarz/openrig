export interface Rig {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pod {
  id: string;
  rigId: string;
  namespace: string;
  label: string;
  summary: string | null;
  continuityPolicyJson: string | null;
  createdAt: string;
}

export interface ContinuityState {
  podId: string;
  nodeId: string;
  status: "healthy" | "degraded" | "restoring";
  artifactsJson: string | null;
  lastSyncAt: string | null;
  updatedAt: string;
}

export interface Node {
  id: string;
  rigId: string;
  logicalId: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  codexConfigProfile?: string | null;
  cwd: string | null;
  surfaceHint: string | null;
  workspace: string | null;
  restorePolicy: string | null;
  packageRefs: string[];
  podId: string | null;
  agentRef: string | null;
  profile: string | null;
  label: string | null;
  resolvedSpecName: string | null;
  resolvedSpecVersion: string | null;
  resolvedSpecHash: string | null;
  occupantLifecycle: OccupantLifecycle | null;
  continuityOutcome: ContinuityOutcome | null;
  handoverResult: HandoverResult;
  previousOccupant: string | null;
  handoverAt: string | null;
  createdAt: string;
}

export interface Edge {
  id: string;
  rigId: string;
  sourceId: string;
  targetId: string;
  kind: string;
  createdAt: string;
}

export interface Binding {
  id: string;
  nodeId: string;
  attachmentType?: "tmux" | "external_cli";
  tmuxSession: string | null;
  tmuxWindow: string | null;
  tmuxPane: string | null;
  externalSessionName?: string | null;
  cmuxWorkspace: string | null;
  cmuxSurface: string | null;
  updatedAt: string;
}

export interface Session {
  id: string;
  nodeId: string;
  sessionName: string;
  status: string;
  resumeType: string | null;
  resumeToken: string | null;
  restorePolicy: string;
  lastSeenAt: string | null;
  createdAt: string;
  origin: "launched" | "claimed";
  startupStatus: "pending" | "ready" | "attention_required" | "failed";
  startupCompletedAt: string | null;
}

// -- Event types --

export type RigEvent =
  | { type: "rig.created"; rigId: string }
  | { type: "rig.deleted"; rigId: string }
  | { type: "node.added"; rigId: string; nodeId: string; logicalId: string }
  | { type: "node.removed"; rigId: string; nodeId: string }
  | { type: "binding.updated"; rigId: string; nodeId: string }
  | { type: "session.status_changed"; rigId: string; nodeId: string; status: string }
  | { type: "session.detached"; rigId: string; nodeId: string; sessionName: string }
  | { type: "node.launched"; rigId: string; nodeId: string; logicalId: string; sessionName: string }
  | { type: "snapshot.created"; rigId: string; snapshotId: string; kind: string }
  | { type: "restore.started"; rigId: string; snapshotId: string }
  | { type: "restore.completed"; rigId: string; snapshotId: string; result: RestoreResult }
  // L3: appended (never replaces) when reconcileNodeRuntimeTruth upgrades a
  // failed/attention_required restoreOutcome to operator_recovered after
  // visible-runtime-evidence preconditions hold. The original failure event
  // is preserved in the log; this event records the audit trail of the upgrade.
  | { type: "restore.outcome_reconciled"; rigId: string; nodeId: string; attemptId: number; from: "failed" | "attention_required"; to: "operator_recovered"; evidence: { tmux: boolean; fgProcess: "claude" | "codex" | string; resumeTokenUsed: boolean; paneState: "usable" } }
  | { type: "agent.activity"; rigId: string; nodeId: string; sessionName: string; runtime: string | null; activity: AgentActivity }
  | { type: "rig.imported"; rigId: string; specName: string; specVersion: string }
  // Package events (cross-rig, no rigId)
  | { type: "package.validated"; packageName: string; valid: boolean }
  | { type: "package.planned"; packageName: string; actionable: number; deferred: number; conflicts: number }
  | { type: "package.installed"; packageName: string; packageVersion: string; installId: string; applied: number; deferred: number }
  | { type: "package.rolledback"; installId: string; restored: number }
  | { type: "package.install_failed"; packageName: string; code: string; message: string }
  // Bootstrap events (cross-rig, no rigId)
  | { type: "bootstrap.planned"; runId: string; sourceRef: string; stages: number }
  | { type: "bootstrap.started"; runId: string; sourceRef: string }
  | { type: "bootstrap.completed"; runId: string; rigId: string; sourceRef: string }
  | { type: "bootstrap.partial"; runId: string; sourceRef: string; rigId?: string; completed: number; failed: number }
  | { type: "bootstrap.failed"; runId: string; sourceRef: string; error: string }
  // Discovery events (cross-rig, no rigId)
  | { type: "session.discovered"; discoveredId: string; tmuxSession: string; tmuxPane: string; runtimeHint: string; confidence: string }
  | { type: "session.vanished"; tmuxSession: string; tmuxPane: string }
  | { type: "node.claimed"; rigId: string; nodeId: string; logicalId: string; discoveredId: string }
  | { type: "seat.handover_completed"; rigId: string; nodeId: string; logicalId: string; previousOccupant: string; currentOccupant: string; source: string; reason: string; operator: string | null }
  // Bundle events (cross-rig)
  | { type: "bundle.created"; bundleName: string; bundleVersion: string; archiveHash: string }
  // Teardown events
  | { type: "rig.stopped"; rigId: string }
  // AgentSpec reboot events — pods + startup + continuity
  | { type: "pod.created"; rigId: string; podId: string; namespace: string; label: string }
  | { type: "pod.deleted"; rigId: string; podId: string }
  | { type: "node.startup_pending"; rigId: string; nodeId: string }
  | { type: "node.startup_ready"; rigId: string; nodeId: string }
  | { type: "node.startup_failed"; rigId: string; nodeId: string; error: string }
  | { type: "continuity.sync"; rigId: string; podId: string; nodeId: string }
  | { type: "continuity.degraded"; rigId: string; podId: string; nodeId: string; reason: string }
  // V0.3.1 slice 05 kernel-rig-as-default — forward-fix #3 architectural.
  // Emitted exactly once by KernelBootTracker when the kernel rig fails to
  // reach ready / partial_ready within the configurable degraded-timer
  // window (default 90s). Observability signal that healthz bound cleanly
  // but the kernel itself is stuck — operator triage with `rig ps --rig kernel`.
  | { type: "kernel.agent.degraded"; agents: Array<{ sessionName: string; runtime: string; startupStatus: string }>; firstUnreadySince: string | null; detail: string | null }
  // Chat events
  | { type: "chat.message"; rigId: string; messageId: string; sender: string; kind: string; body: string; topic?: string }
  // Expansion events
  | { type: "rig.expanded"; rigId: string; podId: string; podNamespace: string; nodes: Array<{ logicalId: string; status: string }>; status: string }
  // Coordination primitive (PL-004 Phase A) — stream / queue / inbox.
  // Host-scoped; rigId is left null because items reference seats by string
  // (`<member>@<rig>`) and can cross rigs.
  | { type: "stream.emitted"; streamItemId: string; sourceSession: string; hintDestination: string | null; hintType: string | null; hintUrgency: string | null; interrupt: boolean }
  | { type: "queue.created"; qitemId: string; sourceSession: string; destinationSession: string; priority: string; tier: string | null }
  | { type: "queue.handed_off"; qitemId: string; fromSession: string; toSession: string; closureReason: "handed_off_to" }
  | { type: "queue.claimed"; qitemId: string; destinationSession: string; claimedAt: string; closureRequiredAt: string | null }
  | { type: "queue.unclaimed"; qitemId: string; destinationSession: string; reason: string }
  | { type: "qitem.fallback_routed"; qitemId: string; originalDestination: string; rerouteDestination: string; reason: string }
  | { type: "qitem.closure_overdue"; qitemId: string; destinationSession: string; closureRequiredAt: string; overdueSince: string }
  | { type: "inbox.absorbed"; inboxId: string; destinationSession: string; senderSession: string; promotedQitemId: string }
  | { type: "inbox.denied"; inboxId: string; destinationSession: string; senderSession: string; reason: string }
  // PL-004 Phase B R2: queue.updated emitted from QueueRepository.update()
  // for general state mutations (pending → blocked, in-progress → done,
  // closure transitions, etc.). Lets the view-event-bridge wake SSE
  // consumers on /api/views/:name/sse when ANY queue state mutation
  // changes a view result-set, not just create/handoff/claim/unclaim.
  | { type: "queue.updated"; qitemId: string; fromState: string; toState: string; closureReason: string | null; closureTarget: string | null; actorSession: string }
  // Coordination primitive (PL-004 Phase B) — project (classifier) / view.
  // project.classified: emitted when a stream item is successfully projected.
  // classifier.lease_*: lifecycle of the daemon-enforced single-writer lease.
  // classifier.dead: heartbeat absence past TTL detected (deadness inference).
  // classifier.reclaimed: operator-verb reclaim took the lease.
  // view.changed: a view's projection result-set changed (SSE consumers see deltas).
  | { type: "project.classified"; projectId: string; streamItemId: string; classifierSession: string; classificationType: string | null; classificationDestination: string | null }
  | { type: "classifier.lease_acquired"; leaseId: string; classifierSession: string; acquiredAt: string; expiresAt: string }
  | { type: "classifier.lease_expired"; leaseId: string; classifierSession: string; expiredAt: string }
  | { type: "classifier.dead"; leaseId: string; classifierSession: string; lastHeartbeat: string; detectedAt: string }
  | { type: "classifier.reclaimed"; leaseId: string; previousClassifierSession: string; reclaimedBySession: string; reason: string; reclaimedAt: string }
  | { type: "view.changed"; viewName: string; cause: string }
  // PL-004 Phase C: daemon-native Watchdog supervision tree events.
  // Three policies in scope (periodic-reminder, artifact-pool-ready,
  // edge-artifact-required); workflow-keepalive deferred to Phase D.
  // Pure `not_due` polls are NOT recorded in history and NOT emitted
  // as events; only meaningful evaluations + lifecycle transitions are.
  | { type: "watchdog.evaluation_fired"; jobId: string; policy: string; targetSession: string; deliveryStatus: string }
  | { type: "watchdog.evaluation_skipped"; jobId: string; policy: string; skipReason: string }
  | { type: "watchdog.evaluation_terminal"; jobId: string; policy: string; terminalReason: string }
  | { type: "watchdog.job_registered"; jobId: string; policy: string; targetSession: string; registeredBy: string }
  | { type: "watchdog.job_stopped"; jobId: string; reason: string }
  // PL-004 Phase D: daemon-native Workflow Runtime events. Step closure
  // and next-qitem projection are emitted within the SAME daemon
  // transaction (transactional-scribe contract). Subscribers see the
  // pair atomically.
  | { type: "workflow.instantiated"; instanceId: string; workflowName: string; workflowVersion: string; createdBy: string }
  | { type: "workflow.step_closed"; instanceId: string; stepId: string; closureReason: string; actorSession: string; priorQitemId: string }
  | { type: "workflow.next_qitem_projected"; instanceId: string; nextQitemId: string; nextOwner: string; nextStepId: string }
  | { type: "workflow.completed"; instanceId: string; workflowName: string }
  | { type: "workflow.failed"; instanceId: string; workflowName: string; reason: string }
  | { type: "workflow.routing_table_changed"; rigName: string; cause: string }
  // PL-005 Phase A: Mission Control / Queue Observability events.
  // Action audit + cross-CLI-version drift detection. view_refreshed
  // is emitted when a Mission Control view is recomputed (SSE
  // consumers can choose whether to re-fetch).
  | { type: "mission_control.action_executed"; actionId: string; actionVerb: string; qitemId: string | null; actorSession: string }
  | { type: "mission_control.cli_drift_detected"; rigName: string; missingField: string; observedAt: string }
  | { type: "mission_control.view_refreshed"; viewName: string; cause: string }
  // PL-005 Phase B: notification dispatch events. Best-effort delivery;
  // failure does NOT interrupt the underlying action being notified about.
  | { type: "mission_control.notification_sent"; mechanism: string; target: string; qitemId: string | null; sentAt: string }
  | { type: "mission_control.notification_failed"; mechanism: string; target: string; qitemId: string | null; error: string; failedAt: string };

export type PersistedEvent = RigEvent & {
  seq: number;
  createdAt: string;
};

// -- Composite types --

export interface NodeWithBinding extends Node {
  binding: Binding | null;
}

export interface RigWithRelations {
  rig: Rig;
  nodes: NodeWithBinding[];
  edges: Edge[];
}

export interface PersistedProjectionEntry {
  category: string;
  effectiveId: string;
  sourceSpec: string;
  sourcePath: string;
  resourcePath: string;
  absolutePath: string;
  resourceType?: string;
  mergeStrategy?: string;
  target?: string;
}

export interface NodeStartupSnapshot {
  projectionEntries: PersistedProjectionEntry[];
  resolvedStartupFiles: import("./runtime-adapter.js").ResolvedStartupFile[];
  startupActions: StartupAction[];
  runtime: string;
}

export interface SnapshotData {
  rig: Rig;
  nodes: NodeWithBinding[];
  edges: Edge[];
  sessions: Session[];
  checkpoints: Record<string, Checkpoint | null>;
  pods?: Pod[];
  continuityStates?: ContinuityState[];
  nodeStartupContext?: Record<string, NodeStartupSnapshot | null>;
  envReceipt?: EnvReceipt | null;
}

export interface Snapshot {
  id: string;
  rigId: string;
  kind: string;
  status: string;
  data: SnapshotData;
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  nodeId: string;
  summary: string;
  currentTask: string | null;
  nextStep: string | null;
  blockedOn: string | null;
  keyArtifacts: string[];
  confidence: string | null;
  podId: string | null;
  continuitySource: string | null;
  continuityArtifactsJson: string | null;
  createdAt: string;
}

export interface RestoreResult {
  snapshotId: string;
  preRestoreSnapshotId: string | null;
  rigResult: RestoreRigResult;
  nodes: RestoreNodeResult[];
  warnings: string[];
  blockers?: RestoreValidationBlocker[];
}

export type RestoreRigResult = "fully_restored" | "partially_restored" | "failed" | "not_attempted";

export interface RestoreValidationBlocker {
  code: string;
  severity: "critical";
  nodeId?: string;
  logicalId?: string;
  target?: string;
  path?: string;
  message: string;
  remediation: string;
}

export interface RestoreNodeResult {
  nodeId: string;
  logicalId: string;
  // L3: `attention_required` is set when the post-launch probe detects a
  // Claude resume-selection prompt. `operator_recovered` is the terminal
  // outcome after `restore.outcome_reconciled`; never produced directly by
  // the orchestrator's restore pipeline (only by reconcileNodeRuntimeTruth).
  status: "resumed" | "rebuilt" | "fresh" | "failed" | "attention_required" | "operator_recovered";
  error?: string;
  /** Pane evidence captured when status is `attention_required` (L3, optional). */
  attentionEvidence?: string | null;
}

export type RestoreOutcome =
  | { ok: true; result: RestoreResult }
  | { ok: false; code: "snapshot_not_found"; message: string }
  | { ok: false; code: "rig_not_found"; message: string }
  | { ok: false; code: "rig_not_stopped"; message: string }
  | { ok: false; code: "restore_error"; message: string }
  | { ok: false; code: "restore_in_progress"; message: string }
  | { ok: false; code: "service_boot_failed"; message: string }
  | { ok: false; code: "pre_restore_validation_failed"; message: string; result: RestoreResult };

// -- Node inventory projection (NS-T02) --

// L3 extends with `attention_required` (Claude resume-selection prompt proxy)
// and `operator_recovered` (terminal post-reconciliation outcome — never produced
// directly by restore, only emitted via `restore.outcome_reconciled`).
export type NodeRestoreOutcome = "resumed" | "rebuilt" | "fresh" | "failed" | "attention_required" | "operator_recovered" | "n-a";
export type OccupantLifecycle = "active" | "retiring" | "retired" | "context_walled" | "compacted" | "crashed" | "unknown";
export type ContinuityOutcome = "resumed" | "rebuilt" | "forked" | "fresh" | "failed";
export type HandoverResult = "complete" | "unchanged" | "partial" | "failed" | null;
export type AgentActivityState = "running" | "needs_input" | "idle" | "unknown";
export type AgentActivityEvidenceSource =
  | "runtime_hook"
  | "pane_heuristic"
  | "tmux_session"
  | "external_cli"
  | "session_registry";

export interface AgentActivity {
  state: AgentActivityState;
  reason: string;
  evidenceSource: AgentActivityEvidenceSource;
  sampledAt: string;
  evidence: string | null;
  eventAt?: string | null;
  rawEvent?: string | null;
  rawSubtype?: string | null;
  runtime?: string | null;
  fallback?: boolean;
  stale?: boolean;
}

export interface NodeRecoveryGuidance {
  summary: string;
  commands: string[];
  notes: string[];
}

// Per-node lifecycle projection derived from session/restore state plus snapshot resume metadata.
// L2 cold-start truth model: distinguishes a recoverable detached node from a node that would
// fresh-launch, and surfaces "attention required" for the post-L3 Claude resume-prompt proxy.
export type NodeLifecycleState = "running" | "detached" | "recoverable" | "attention_required";

// Per-rig lifecycle aggregate folded from per-node states.
//   running           — every node is running.
//   recoverable       — every node is non-running and at least one node has a usable snapshot token.
//   stopped           — every node is non-running and no node has a usable snapshot token.
//   degraded          — mixed running + non-running on the same rig.
//   attention_required — any node is attention_required (priority over above).
export type RigLifecycleState = "running" | "recoverable" | "stopped" | "degraded" | "attention_required";

export interface NodeInventoryEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  canonicalSessionName: string | null;
  attachmentType?: "tmux" | "external_cli" | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  restoreOutcome: NodeRestoreOutcome;
  lifecycleState: NodeLifecycleState;
  occupantLifecycle: OccupantLifecycle;
  continuityOutcome: ContinuityOutcome | null;
  handoverResult: HandoverResult;
  previousOccupant: string | null;
  handoverAt: string | null;
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  recoveryGuidance: NodeRecoveryGuidance | null;
  latestError: string | null;
  // Extended fields
  model: string | null;
  agentRef: string | null;
  profile: string | null;
  codexConfigProfile?: string | null;
  resolvedSpecName: string | null;
  resolvedSpecVersion: string | null;
  resolvedSpecHash: string | null;
  cwd: string | null;
  restorePolicy: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  startupCompletedAt: string | null;
  agentActivity?: AgentActivity;
  contextUsage?: ContextUsage;
  /** PL-007: per-node workspace block when the rig declares a workspace.
   *  workspaceRoot mirrors RigSpec.workspace.workspaceRoot. activeRepo is
   *  the repo whose path contains the node's cwd, or RigSpec.workspace.
   *  defaultRepo when no containing repo is found. kind is the kind of
   *  the active repo, or `knowledge` when cwd is under knowledgeRoot.
   *  null when the rig does not declare a workspace. */
  workspace?: NodeWorkspaceInfo | null;
}

export interface NodeWorkspaceInfo {
  workspaceRoot: string;
  activeRepo: string | null;
  kind: WorkspaceKind | null;
}

export interface NodeDetailPeer {
  logicalId: string;
  canonicalSessionName: string | null;
  attachmentType?: "tmux" | "external_cli" | null;
  runtime: string | null;
}

export interface NodeDetailEdge {
  kind: string;
  to?: { logicalId: string; sessionName: string | null };
  from?: { logicalId: string; sessionName: string | null };
}

export interface NodeDetailTranscript {
  enabled: boolean;
  path: string | null;
  tailCommand: string | null;
}

export interface NodeDetailCompactSpec {
  name: string | null;
  version: string | null;
  profile: string | null;
  skillCount: number;
  guidanceCount: number;
}

export interface NodeDetailEntry extends NodeInventoryEntry {
  binding: Binding | null;
  startupFiles: Array<{ path: string; deliveryHint: string; required: boolean }>;
  startupActions: Array<{ type: string; value: string }>;
  installedResources: Array<{ id: string; category: string; targetPath: string }>;
  recentEvents: Array<{ type: string; createdAt: string; payload: Record<string, unknown> }>;
  infrastructureStartupCommand: string | null;
  peers: NodeDetailPeer[];
  edges: { outgoing: NodeDetailEdge[]; incoming: NodeDetailEdge[] };
  transcript: NodeDetailTranscript;
  compactSpec: NodeDetailCompactSpec;
}

// -- AgentSpec types (AgentSpec reboot) --

export interface ImportSpec {
  ref: string;
  version?: string;
}

export interface StartupFile {
  /** PL-014 Item 6: kind defaults to "file" for back-compat. When
   *  "context_pack", contextPackName is required and the resolver
   *  expands the entry into the pack's assembled bundle written to a
   *  synthesized path under <rigRoot>/.openrig/resolved-context-packs/. */
  kind?: "file" | "context_pack";
  path: string;
  /** PL-014 Item 6: pack name when kind === "context_pack". */
  contextPackName?: string;
  /** PL-014 Item 6: pack version when kind === "context_pack"; defaults to "1". */
  contextPackVersion?: string;
  deliveryHint: "auto" | "guidance_merge" | "skill_install" | "send_text";
  required: boolean;
  appliesOn: ("fresh_start" | "restore")[];
}

export interface StartupAction {
  type: "slash_command" | "send_text";
  value: string;
  phase: "after_files" | "after_ready";
  appliesOn: ("fresh_start" | "restore")[];
  idempotent: boolean;
  builtin?: "session_identity";
}

export interface StartupBlock {
  files: StartupFile[];
  actions: StartupAction[];
}

export interface LifecycleDefaults {
  executionMode: "interactive_resident";
  compactionStrategy: "harness_native" | "pod_continuity";
  restorePolicy: "resume_if_possible" | "relaunch_fresh" | "checkpoint_only";
}

export interface SkillResource { id: string; path: string; }
export interface GuidanceResource { id: string; path: string; target: string; merge: "managed_block" | "append"; }
export interface SubagentResource { id: string; path: string; }
export interface HookResource { id: string; path: string; runtimes?: string[]; }
export interface RuntimeResource { id: string; path: string; runtime: string; type: string; }

export interface AgentResources {
  skills: SkillResource[];
  guidance: GuidanceResource[];
  subagents: SubagentResource[];
  hooks: HookResource[];
  runtimeResources: RuntimeResource[];
}

export interface ProfileSpec {
  summary?: string;
  preferences?: { runtime?: string; model?: string };
  startup?: StartupBlock;
  lifecycle?: LifecycleDefaults;
  uses: {
    skills: string[];
    guidance: string[];
    subagents: string[];
    hooks: string[];
    runtimeResources: string[];
  };
}

export interface AgentSpec {
  version: string;
  name: string;
  summary?: string;
  imports: ImportSpec[];
  defaults?: {
    runtime?: string;
    model?: string;
    lifecycle?: LifecycleDefaults;
  };
  startup: StartupBlock;
  resources: AgentResources;
  profiles: Record<string, ProfileSpec>;
}

// -- Legacy RigSpec types (Phase 3, pre-reboot flat contract) --
// TODO: Remove when AS-T08b/AS-T12 migrate all consumers to pod-aware RigSpec

export interface LegacyRigSpec {
  schemaVersion: number;
  name: string;
  version: string;
  nodes: LegacyRigSpecNode[];
  edges: LegacyRigSpecEdge[];
}

export interface LegacyRigSpecNode {
  id: string;
  runtime: string;
  role?: string;
  model?: string;
  cwd?: string;
  surfaceHint?: string;
  workspace?: string;
  restorePolicy?: string;
  packageRefs?: string[];
}

export interface LegacyRigSpecEdge {
  from: string;
  to: string;
  kind: string;
}

// -- RigSpec types (pod-aware, AgentSpec reboot) --

export interface ContinuityPolicySpec {
  enabled: boolean;
  syncTriggers?: string[];
  artifacts?: { sessionLog?: boolean; restoreBrief?: boolean; quiz?: boolean };
  restoreProtocol?: { peerDriven?: boolean; verifyViaQuiz?: boolean };
}

/**
 * Member-level launch input for declaring how a new managed seat should
 * derive its starting context. Discriminated union over `mode`:
 *
 * - `fork` — start from a prior native runtime conversation source
 *   (Claude `--fork-session` / Codex `fork`); persists a NEW post-fork
 *   token; identity-honest (parent token is NEVER persisted onto the
 *   new seat). v1 supports `ref.kind: "native_id"` only.
 *
 * - `rebuild` — fresh-launch a new seat seeded with operator-declared
 *   artifacts (CULTURE, role doc, handover packet, queue files, session
 *   logs). NO native-runtime resume or fork; NO `resumeToken` on the
 *   resulting seat; `continuityOutcome` is `"rebuilt"` (NEVER `"fresh"`,
 *   `"resumed"`, or `"forked"`). v1 supports `ref.kind: "artifact_set"`
 *   only, with `ref.value` as a non-empty array of file paths in
 *   operator-declared trust-precedence order.
 */
export type SessionSourceSpec =
  | SessionSourceForkSpec
  | SessionSourceRebuildSpec
  | SessionSourceAgentImageSpec;

export interface SessionSourceForkSpec {
  mode: "fork";
  ref: {
    kind: "native_id" | "artifact_path" | "name" | "last";
    value?: string;
  };
}

export interface SessionSourceRebuildSpec {
  mode: "rebuild";
  ref: {
    kind: "artifact_set";
    value: string[];
  };
}

/**
 * PL-016 Item 4 — agent_image session source.
 * The instantiator looks up the named image in the
 * AgentImageLibraryService, captures the runtime resume token from the
 * manifest, and dispatches the launch through the existing fork code
 * path (forkSource: { kind: "native_id", value: <resumeToken> }) so
 * `nativeResumeProbe` semantics are preserved.
 *
 * v0 supports `ref.kind: "image_name"` only; `image_id` and
 * `image_hash` are NAMED v1+ triggers per PRD § v0 Out.
 */
export interface SessionSourceAgentImageSpec {
  mode: "agent_image";
  ref: {
    kind: "image_name";
    value: string;
    /** Optional version selector; defaults to "1" at consumption
     *  time (matches the manifest convention). */
    version?: string;
  };
}

/**
 * Reference to a named agent-starter registry entry. Artifact-seeded
 * fresh-launch context: the starter's curated artifacts are added to the
 * member's startup-file chain at launch time. Composes additively with
 * `sessionSource` (independent semantics: starter_ref seeds context;
 * session_source declares the runtime-source mode). v0 schema constraint:
 * `starter_ref` MAY combine with `session_source.mode: "rebuild"` (both
 * apply on `fresh_start`) but MAY NOT combine with `session_source.mode:
 * "fork"` (the v1+ "Real native-fork-from-registered-thread-id starter
 * proof" trigger covers that composition).
 */
export interface StarterRefSpec {
  /** Registry key. Matches an entry at `<registryRoot>/<name>.yaml`. */
  name: string;
}

export interface RigSpecPodMember {
  id: string;
  label?: string;
  agentRef: string;
  profile: string;
  runtime: string;
  codexConfigProfile?: string;
  model?: string;
  cwd: string;
  restorePolicy?: string;
  startup?: StartupBlock;
  /**
   * Optional fork source declaration. v1 MVP: mode="fork" with
   * ref.kind="native_id". Validated by `rigspec-schema.ts` and translated
   * to the runtime adapter's `forkSource` opt at launch time.
   */
  sessionSource?: SessionSourceSpec;
  /**
   * Optional reference to a named starter registry entry.
   * See {@link StarterRefSpec}. Resolved by `AgentStarterResolver` at
   * launch time; resolved artifacts seed the STARTER layer of the
   * member's startup-file chain. Mutually exclusive with
   * `sessionSource.mode: "fork"` per v0 schema (validateStarterRef).
   */
  starterRef?: StarterRefSpec;
}

export interface RigSpecPodEdge {
  kind: string;
  from: string;
  to: string;
}

export interface RigSpecCrossPodEdge {
  kind: string;
  from: string;
  to: string;
}

export interface RigSpecPod {
  id: string;
  label: string;
  summary?: string;
  continuityPolicy?: ContinuityPolicySpec;
  startup?: StartupBlock;
  members: RigSpecPodMember[];
  edges: RigSpecPodEdge[];
}

export interface RigSpecDoc {
  path: string;
}

/**
 * PL-007 Workspace Primitive — typed workspace kinds enum. Reserved set
 * at v0; adding a sixth kind is a v1+ amendment per the PL-007 product
 * spec. Each kind has folder shape + frontmatter contract + ownership
 * rules (see `frontmatter-validator.ts` for the per-kind required-field
 * map).
 */
export const WORKSPACE_KINDS = ["user", "project", "knowledge", "lab", "delivery"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/** PL-007 — RigSpec.workspace.repos[] entry (typed). */
export interface WorkspaceRepoSpec {
  name: string;
  /** Absolute path after normalization. Authors may declare a path relative to
   *  `workspaceRoot` in YAML; the codec resolves to absolute at parse time. */
  path: string;
  kind: WorkspaceKind;
}

/** PL-007 — Optional RigSpec.workspace block. Rigs without it stay valid;
 *  whoami / node-inventory return a null workspace block in that case. */
export interface WorkspaceSpec {
  workspaceRoot: string;
  repos: WorkspaceRepoSpec[];
  defaultRepo?: string;
  /** Optional knowledge-canon root (e.g., substrate/shared-docs/openrig-work).
   *  Treated as kind=knowledge when surfaced through whoami / UI. */
  knowledgeRoot?: string;
}

export interface RigSpec {
  version: string;
  name: string;
  summary?: string;
  cultureFile?: string;
  docs?: RigSpecDoc[];
  startup?: StartupBlock;
  services?: RigServicesSpec;
  /** PL-007 Workspace Primitive — optional typed workspace declaration. */
  workspace?: WorkspaceSpec;
  pods: RigSpecPod[];
  edges: RigSpecCrossPodEdge[];
}

export interface RigServicesWaitTarget {
  service?: string;
  condition?: "healthy";
  url?: string;
  tcp?: string;
}

export interface RigServicesSurfaceUrl {
  name: string;
  url: string;
}

export interface RigServicesSurfaceCommand {
  name: string;
  command: string;
}

export interface RigServicesSurface {
  urls?: RigServicesSurfaceUrl[];
  commands?: RigServicesSurfaceCommand[];
}

export interface RigServicesCheckpointHook {
  id: string;
  exportCommand: string;
  importCommand?: string;
}

export interface RigServicesSpec {
  kind: "compose";
  composeFile: string;
  projectName?: string;
  profiles?: string[];
  downPolicy?: "leave_running" | "down" | "down_and_volumes";
  waitFor?: RigServicesWaitTarget[];
  surfaces?: RigServicesSurface;
  checkpoints?: RigServicesCheckpointHook[];
}

export interface EnvReceipt {
  kind: "compose";
  composeFile: string;
  projectName: string;
  services: Array<{ name: string; status: string; health?: string | null }>;
  waitFor: Array<{ target: RigServicesWaitTarget; status: "healthy" | "unhealthy" | "pending"; detail?: string | null }>;
  capturedAt: string;
}

export interface EnvCheckpoint {
  kind: "compose";
  capturedAt: string;
  artifactsJson: string;
}

export interface RigServicesRecordInput {
  kind: "compose";
  specJson: string;
  rigRoot: string;
  composeFile: string;
  projectName?: string;
  latestReceiptJson?: string | null;
}

export interface RigServicesRecord {
  rigId: string;
  kind: "compose";
  specJson: string;
  rigRoot: string;
  composeFile: string;
  projectName: string;
  latestReceiptJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface PreflightResult {
  ready: boolean;
  warnings: string[];
  errors: string[];
}

export type InstantiateOutcome =
  | { ok: true; result: InstantiateResult }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "preflight_failed"; errors: string[]; warnings: string[] }
  | { ok: false; code: "instantiate_error"; message: string }
  | { ok: false; code: "cycle_error"; message: string }
  | { ok: false; code: "service_boot_failed"; message: string };

export interface InstantiateResult {
  rigId: string;
  specName: string;
  specVersion: string;
  nodes: { logicalId: string; status: "launched" | "failed"; error?: string }[];
  warnings?: string[];
}

// -- Expansion types --

export interface ExpansionPodFragment {
  id: string;
  label: string;
  summary?: string;
  members: Array<{
    id: string;
    runtime: string;
    agentRef?: string;
    profile?: string;
    cwd?: string;
    model?: string;
    codexConfigProfile?: string;
    restorePolicy?: string;
    label?: string;
    /** Optional session source declaration; threaded through to launch. */
    sessionSource?: SessionSourceSpec;
    /**
     * Optional reference to a named starter registry entry; threaded
     * through expansion → buildSyntheticSpec → daemon instantiation,
     * matching the pass-through shape of `sessionSource`.
     */
    starterRef?: StarterRefSpec;
  }>;
  edges: Array<{ from: string; to: string; kind: string }>;
}

export interface ExpansionRequest {
  rigId: string;
  pod: ExpansionPodFragment;
  crossPodEdges?: Array<{ from: string; to: string; kind: string }>;
  rigRoot?: string;
}

export interface ExpansionNodeOutcome {
  logicalId: string;
  nodeId: string;
  status: "launched" | "failed";
  error?: string;
  sessionName?: string;
}

export type ExpansionResult =
  | { ok: true; status: "ok" | "partial" | "failed"; podId: string; podNamespace: string; nodes: ExpansionNodeOutcome[]; warnings: string[]; retryTargets: string[] }
  | { ok: false; code: string; error: string };

// -- Context usage types --

export type ContextAvailability = "known" | "unknown";

export type ContextUnknownReason =
  | "unsupported_runtime"
  | "not_managed"
  | "missing_sidecar"
  | "parse_error"
  | "stale"
  | "session_mismatch"
  | "no_data";

export interface ContextUsage {
  availability: ContextAvailability;
  reason: ContextUnknownReason | null;
  source: "claude_statusline_json" | "codex_token_count_jsonl" | null;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  contextWindowSize: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  currentUsage: string | null;
  transcriptPath: string | null;
  sessionId: string | null;
  sessionName: string | null;
  sampledAt: string | null;
  fresh: boolean;
}
