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
  // Chat events
  | { type: "chat.message"; rigId: string; messageId: string; sender: string; kind: string; body: string; topic?: string }
  // Expansion events
  | { type: "rig.expanded"; rigId: string; podId: string; podNamespace: string; nodes: Array<{ logicalId: string; status: string }>; status: string };

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
  preRestoreSnapshotId: string;
  nodes: RestoreNodeResult[];
  warnings: string[];
}

export interface RestoreNodeResult {
  nodeId: string;
  logicalId: string;
  status: "resumed" | "rebuilt" | "fresh" | "failed";
  error?: string;
}

export type RestoreOutcome =
  | { ok: true; result: RestoreResult }
  | { ok: false; code: "snapshot_not_found"; message: string }
  | { ok: false; code: "rig_not_found"; message: string }
  | { ok: false; code: "rig_not_stopped"; message: string }
  | { ok: false; code: "restore_error"; message: string }
  | { ok: false; code: "restore_in_progress"; message: string }
  | { ok: false; code: "service_boot_failed"; message: string };

// -- Node inventory projection (NS-T02) --

export type NodeRestoreOutcome = "resumed" | "rebuilt" | "fresh" | "failed" | "n-a";

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
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  latestError: string | null;
  // Extended fields
  model: string | null;
  agentRef: string | null;
  profile: string | null;
  resolvedSpecName: string | null;
  resolvedSpecVersion: string | null;
  resolvedSpecHash: string | null;
  cwd: string | null;
  restorePolicy: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  startupCompletedAt: string | null;
  contextUsage?: ContextUsage;
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
  path: string;
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

export interface RigSpecPodMember {
  id: string;
  label?: string;
  agentRef: string;
  profile: string;
  runtime: string;
  model?: string;
  cwd: string;
  restorePolicy?: string;
  startup?: StartupBlock;
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

export interface RigSpec {
  version: string;
  name: string;
  summary?: string;
  cultureFile?: string;
  docs?: RigSpecDoc[];
  startup?: StartupBlock;
  services?: RigServicesSpec;
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
    restorePolicy?: string;
    label?: string;
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
  source: "claude_statusline_json" | null;
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
