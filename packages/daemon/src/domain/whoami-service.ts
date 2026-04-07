import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TranscriptStore } from "./transcript-store.js";

export interface WhoamiResult {
  resolvedBy: "node_id" | "session_name";
  identity: {
    rigId: string;
    rigName: string;
    nodeId: string;
    logicalId: string;
    podId: string | null;
    podLabel: string | null;
    memberId: string;
    memberLabel: string | null;
    sessionName: string;
    runtime: string;
    cwd: string | null;
    agentRef: string | null;
    profile: string | null;
    resolvedSpecName: string | null;
    resolvedSpecVersion: string | null;
  };
  peers: Array<{
    logicalId: string;
    sessionName: string;
    runtime: string;
    podId: string | null;
    memberId: string;
  }>;
  edges: {
    outgoing: Array<{ kind: string; to: { logicalId: string; sessionName: string } }>;
    incoming: Array<{ kind: string; from: { logicalId: string; sessionName: string } }>;
  };
  transcript: {
    enabled: boolean;
    path: string | null;
    tailCommand: string | null;
    grepCommand: string | null;
  };
  commands: {
    sendExamples: string[];
    captureExamples: string[];
  };
}

export class WhoamiAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhoamiAmbiguousError";
  }
}

interface NodeRow {
  id: string;
  rig_id: string;
  logical_id: string;
  role: string | null;
  runtime: string | null;
  cwd: string | null;
  pod_id: string | null;
  agent_ref: string | null;
  profile: string | null;
  label: string | null;
  resolved_spec_name: string | null;
  resolved_spec_version: string | null;
}

interface SessionRow {
  id: string;
  node_id: string;
  session_name: string;
  status: string;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  kind: string;
}

interface PodRow {
  id: string;
  label: string | null;
  namespace: string | null;
}

interface WhoamiDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  transcriptStore: TranscriptStore;
}

export class WhoamiService {
  private db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private transcriptStore: TranscriptStore;

  constructor(deps: WhoamiDeps) {
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.transcriptStore = deps.transcriptStore;
  }

  resolve(query: { nodeId?: string; sessionName?: string }): WhoamiResult | null {
    let nodeRow: NodeRow | undefined;
    let resolvedBy: "node_id" | "session_name";
    let currentSessionName: string;

    if (query.nodeId) {
      nodeRow = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(query.nodeId) as NodeRow | undefined;
      if (!nodeRow) return null;
      resolvedBy = "node_id";
      currentSessionName = this.getCurrentSessionName(nodeRow.id, nodeRow.rig_id);
    } else if (query.sessionName) {
      // Find sessions matching this name — check for ambiguity across rigs
      const sessionRows = this.db
        .prepare("SELECT * FROM sessions WHERE session_name = ? ORDER BY id DESC")
        .all(query.sessionName) as SessionRow[];

      if (sessionRows.length === 0) return null;

      // Check distinct rigs
      const rigIds = new Set<string>();
      for (const sess of sessionRows) {
        const node = this.db.prepare("SELECT rig_id FROM nodes WHERE id = ?").get(sess.node_id) as { rig_id: string } | undefined;
        if (node) rigIds.add(node.rig_id);
      }

      if (rigIds.size > 1) {
        throw new WhoamiAmbiguousError(
          `Session '${query.sessionName}' is ambiguous — found in ${rigIds.size} rigs. Use --node-id instead.`
        );
      }

      const sess = sessionRows[0]!;
      nodeRow = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(sess.node_id) as NodeRow | undefined;
      if (!nodeRow) return null;
      resolvedBy = "session_name";
      currentSessionName = this.getCurrentSessionName(nodeRow.id, nodeRow.rig_id);
    } else {
      return null;
    }

    // Get rig
    const rig = this.rigRepo.getRig(nodeRow.rig_id);
    if (!rig) return null;

    // Derive member identity
    const parts = nodeRow.logical_id.split(".");
    const memberId = parts.length > 1 ? parts.slice(1).join(".") : nodeRow.logical_id;

    // Get pod info
    let podLabel: string | null = null;
    if (nodeRow.pod_id) {
      const pod = this.db.prepare("SELECT * FROM pods WHERE id = ?").get(nodeRow.pod_id) as PodRow | undefined;
      podLabel = pod?.label ?? null;
    }

    // If resolved by nodeId, get current session name
    if (resolvedBy === "node_id") {
      currentSessionName = this.getCurrentSessionName(nodeRow.id, nodeRow.rig_id);
    }

    // Build identity
    const identity: WhoamiResult["identity"] = {
      rigId: nodeRow.rig_id,
      rigName: rig.rig.name,
      nodeId: nodeRow.id,
      logicalId: nodeRow.logical_id,
      podId: nodeRow.pod_id,
      podLabel,
      memberId,
      memberLabel: nodeRow.label,
      sessionName: currentSessionName!,
      runtime: nodeRow.runtime ?? "unknown",
      cwd: nodeRow.cwd,
      agentRef: nodeRow.agent_ref,
      profile: nodeRow.profile,
      resolvedSpecName: nodeRow.resolved_spec_name,
      resolvedSpecVersion: nodeRow.resolved_spec_version,
    };

    // Build peers — other nodes in this rig with their current sessions
    const peers: WhoamiResult["peers"] = [];
    for (const peerNode of rig.nodes) {
      if (peerNode.id === nodeRow.id) continue;
      const peerParts = peerNode.logicalId.split(".");
      const peerMemberId = peerParts.length > 1 ? peerParts.slice(1).join(".") : peerNode.logicalId;
      const peerSessionName = this.getCurrentSessionName(peerNode.id, nodeRow.rig_id);

      peers.push({
        logicalId: peerNode.logicalId,
        sessionName: peerSessionName,
        runtime: peerNode.runtime ?? "unknown",
        podId: peerNode.podId ?? null,
        memberId: peerMemberId,
      });
    }

    // Build edges — classify as outgoing/incoming relative to this node
    const outgoing: WhoamiResult["edges"]["outgoing"] = [];
    const incoming: WhoamiResult["edges"]["incoming"] = [];

    const edgeRows = this.db
      .prepare("SELECT source_id, target_id, kind FROM edges WHERE rig_id = ?")
      .all(nodeRow.rig_id) as EdgeRow[];

    // Build node ID → logicalId + sessionName map
    const nodeMap = new Map<string, { logicalId: string; sessionName: string }>();
    for (const n of rig.nodes) {
      nodeMap.set(n.id, {
        logicalId: n.logicalId,
        sessionName: this.getCurrentSessionName(n.id, nodeRow.rig_id),
      });
    }

    for (const edge of edgeRows) {
      if (edge.source_id === nodeRow.id) {
        const target = nodeMap.get(edge.target_id);
        if (target) {
          outgoing.push({ kind: edge.kind, to: { logicalId: target.logicalId, sessionName: target.sessionName } });
        }
      } else if (edge.target_id === nodeRow.id) {
        const source = nodeMap.get(edge.source_id);
        if (source) {
          incoming.push({ kind: edge.kind, from: { logicalId: source.logicalId, sessionName: source.sessionName } });
        }
      }
    }

    // Build transcript info
    const transcriptEnabled = this.transcriptStore.enabled;
    const transcriptPath = transcriptEnabled
      ? this.transcriptStore.getTranscriptPath(rig.rig.name, currentSessionName!)
      : null;

    const transcript: WhoamiResult["transcript"] = {
      enabled: transcriptEnabled,
      path: transcriptPath,
      tailCommand: transcriptEnabled ? `rig transcript ${currentSessionName!} --tail 100` : null,
      grepCommand: transcriptEnabled ? `rig transcript ${currentSessionName!} --grep <pattern>` : null,
    };

    // Build command examples from peers
    const sendExamples = peers.slice(0, 3).map((p) => `rig send ${p.sessionName} 'message' --verify`);
    const captureExamples = peers.slice(0, 3).map((p) => `rig capture ${p.sessionName}`);

    return {
      resolvedBy,
      identity,
      peers,
      edges: { outgoing, incoming },
      transcript,
      commands: { sendExamples, captureExamples },
    };
  }

  private getCurrentSessionName(nodeId: string, rigId: string): string {
    // Prefer binding's tmux session (most current)
    const binding = this.db.prepare("SELECT tmux_session FROM bindings WHERE node_id = ?").get(nodeId) as { tmux_session: string | null } | undefined;
    if (binding?.tmux_session) return binding.tmux_session;

    // Fall back to newest session by ULID
    const sess = this.db
      .prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
      .get(nodeId) as { session_name: string } | undefined;

    return sess?.session_name ?? `unknown-${nodeId.slice(-6)}`;
  }
}
