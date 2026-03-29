export interface Rig {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pod {
  id: string;
  rigId: string;
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
  tmuxSession: string | null;
  tmuxWindow: string | null;
  tmuxPane: string | null;
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
  startupStatus: "pending" | "ready" | "failed";
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
  | { type: "pod.created"; rigId: string; podId: string; label: string }
  | { type: "pod.deleted"; rigId: string; podId: string }
  | { type: "node.startup_pending"; rigId: string; nodeId: string }
  | { type: "node.startup_ready"; rigId: string; nodeId: string }
  | { type: "node.startup_failed"; rigId: string; nodeId: string; error: string }
  | { type: "continuity.sync"; rigId: string; podId: string; nodeId: string }
  | { type: "continuity.degraded"; rigId: string; podId: string; nodeId: string; reason: string };

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

export interface SnapshotData {
  rig: Rig;
  nodes: NodeWithBinding[];
  edges: Edge[];
  sessions: Session[];
  checkpoints: Record<string, Checkpoint | null>;
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
}

export interface RestoreNodeResult {
  nodeId: string;
  logicalId: string;
  status: "resumed" | "checkpoint_written" | "fresh_no_checkpoint" | "failed";
  error?: string;
}

export type RestoreOutcome =
  | { ok: true; result: RestoreResult }
  | { ok: false; code: "snapshot_not_found"; message: string }
  | { ok: false; code: "rig_not_found"; message: string }
  | { ok: false; code: "rig_not_stopped"; message: string }
  | { ok: false; code: "restore_error"; message: string }
  | { ok: false; code: "restore_in_progress"; message: string };

// -- RigSpec types (Phase 3) --

export interface RigSpec {
  schemaVersion: number;
  name: string;
  version: string;
  nodes: RigSpecNode[];
  edges: RigSpecEdge[];
}

export interface RigSpecNode {
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

export interface RigSpecEdge {
  from: string;
  to: string;
  kind: string;
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
  | { ok: false; code: "instantiate_error"; message: string };

export interface InstantiateResult {
  rigId: string;
  specName: string;
  specVersion: string;
  nodes: { logicalId: string; status: "launched" | "failed"; error?: string }[];
}
