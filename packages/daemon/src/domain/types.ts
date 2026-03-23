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
  lastSeenAt: string | null;
  createdAt: string;
}

export interface NodeWithBinding extends Node {
  binding: Binding | null;
}

export interface RigWithRelations {
  rig: Rig;
  nodes: NodeWithBinding[];
  edges: Edge[];
}
