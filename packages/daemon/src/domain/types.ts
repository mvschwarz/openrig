export interface Rig {
  id: string;
  name: string;
  createdAt: string;
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
  | { type: "node.launched"; rigId: string; nodeId: string; sessionName: string }
  | { type: "snapshot.created"; rigId: string; snapshotId: string; kind: string }
  | { type: "restore.started"; rigId: string; snapshotId: string }
  | { type: "restore.completed"; rigId: string; snapshotId: string; result: RestoreResult };

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
