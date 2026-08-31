import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { QueueRepository } from "./queue-repository.js";

type ClaimedSessionRow = {
  session_id: string;
  session_name: string;
  node_id: string;
  rig_id: string;
  logical_id: string;
  tmux_session: string | null;
};

type NodeLifecycleRow = {
  node_id: string;
  rig_id: string;
  logical_id: string;
  pod_id: string | null;
  tmux_session: string | null;
  latest_session_id: string | null;
  latest_session_name: string | null;
  latest_session_status: string | null;
  latest_session_origin: string | null;
};

type RigReleaseRow = {
  node_id: string;
  logical_id: string;
  session_id: string | null;
  session_name: string | null;
  session_origin: string | null;
};

type FallbackValidationFailure = {
  ok: false;
  code: "fallback_not_running" | "fallback_in_target";
  error: string;
};

export type UnclaimSessionResult =
  | {
      ok: true;
      rigId: string;
      nodeId: string;
      logicalId: string;
      sessionId: string;
      sessionName: string;
    }
  | {
      ok: false;
      code: "session_not_found" | "session_ambiguous";
      error: string;
    };

export type RemoveNodeResult =
  | {
      ok: true;
      rigId: string;
      nodeId: string;
      logicalId: string;
      sessionsKilled: number;
      fallbackDestination?: string;
      reroutedQitemIds: string[];
    }
  | {
      ok: false;
      code: "rig_not_found" | "node_not_found" | "active_qitems" | "fallback_not_running" | "fallback_in_target" | "kill_failed";
      error: string;
      activeQitemIds?: string[];
      fallbackDestination?: string;
      reroutedQitemIds?: string[];
    };

export type ReleaseRigResult =
  | {
      ok: true;
      status: "ok" | "partial";
      rigId: string;
      deleted: boolean;
      released: Array<{
        nodeId: string;
        logicalId: string;
        sessionId: string;
        sessionName: string;
      }>;
      failed: Array<{
        nodeId: string;
        logicalId: string;
        sessionId: string | null;
        sessionName: string | null;
        error: string;
      }>;
    }
  | {
      ok: false;
      code: "rig_not_found" | "contains_launched_nodes";
      error: string;
      launchedLogicalIds?: string[];
    };

export type ShrinkPodResult =
  | {
      ok: true;
      status: "ok" | "partial";
      rigId: string;
      podId: string;
      namespace: string;
      removedLogicalIds: string[];
      sessionsKilled: number;
      fallbackDestination?: string;
      reroutedQitemIds: string[];
      nodes: Array<{
        nodeId: string;
        logicalId: string;
        status: "removed" | "failed";
        sessionsKilled: number;
        error?: string;
      }>;
    }
  | {
      ok: false;
      code: "rig_not_found" | "pod_not_found" | "active_qitems" | "fallback_not_running" | "fallback_in_target" | "kill_failed";
      error: string;
      activeQitemIds?: string[];
      fallbackDestination?: string;
      reroutedQitemIds?: string[];
    };

interface RigLifecycleDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  discoveryRepo: DiscoveryRepository;
  eventBus: EventBus;
  queueRepo: QueueRepository;
  tmuxAdapter?: TmuxAdapter;
}

export class RigLifecycleService {
  readonly db: Database.Database;
  private readonly rigRepo: RigRepository;
  private readonly sessionRegistry: SessionRegistry;
  private readonly discoveryRepo: DiscoveryRepository;
  private readonly eventBus: EventBus;
  private readonly queueRepo: QueueRepository;
  private readonly tmuxAdapter: TmuxAdapter | null;

  constructor(deps: RigLifecycleDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("RigLifecycleService: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("RigLifecycleService: sessionRegistry must share the same db handle");
    if (deps.db !== deps.discoveryRepo.db) throw new Error("RigLifecycleService: discoveryRepo must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("RigLifecycleService: eventBus must share the same db handle");
    if (deps.db !== deps.queueRepo.db) throw new Error("RigLifecycleService: queueRepo must share the same db handle");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.discoveryRepo = deps.discoveryRepo;
    this.eventBus = deps.eventBus;
    this.queueRepo = deps.queueRepo;
    this.tmuxAdapter = deps.tmuxAdapter ?? null;
  }

  async unclaimSession(sessionRef: string): Promise<UnclaimSessionResult> {
    const exactId = this.db.prepare(`
      SELECT s.id AS session_id, s.session_name, n.id AS node_id, n.rig_id, n.logical_id, b.tmux_session
      FROM sessions s
      JOIN nodes n ON n.id = s.node_id
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.id = ?
        AND s.origin = 'claimed'
      LIMIT 1
    `).get(sessionRef) as ClaimedSessionRow | undefined;

    const matches = exactId
      ? [exactId]
      : this.db.prepare(`
          SELECT s.id AS session_id, s.session_name, n.id AS node_id, n.rig_id, n.logical_id, b.tmux_session
          FROM sessions s
          JOIN nodes n ON n.id = s.node_id
          LEFT JOIN bindings b ON b.node_id = n.id
          WHERE s.session_name = ?
            AND s.origin = 'claimed'
          ORDER BY s.created_at DESC, s.id DESC
        `).all(sessionRef) as ClaimedSessionRow[];

    if (matches.length === 0) {
      return { ok: false, code: "session_not_found", error: `Claimed session '${sessionRef}' not found.` };
    }
    if (!exactId && matches.length > 1) {
      return {
        ok: false,
        code: "session_ambiguous",
        error: `Session '${sessionRef}' is ambiguous. Use the session ID instead.`,
      };
    }

    const session = matches[0]!;

    // Best-effort: clear OpenRig-owned tmux metadata from the adopted session.
    if (this.tmuxAdapter && session.tmux_session) {
      const keys = [
        "@rigged_node_id",
        "@rigged_session_name",
        "@rigged_rig_id",
        "@rigged_rig_name",
        "@rigged_logical_id",
      ];
      for (const key of keys) {
        try {
          await this.tmuxAdapter.setSessionOption(session.tmux_session, key, "");
        } catch {
          // best-effort only
        }
      }
    }

    let persistedSeq = 0;
    let persistedAt = "";
    const tx = this.db.transaction(() => {
      this.sessionRegistry.markDetached(session.session_id);
      this.sessionRegistry.clearBinding(session.node_id);
      this.discoveryRepo.releaseClaimByNodeId(session.node_id);
      const event = this.eventBus.persistWithinTransaction({
        type: "session.detached",
        rigId: session.rig_id,
        nodeId: session.node_id,
        sessionName: session.session_name,
      });
      persistedSeq = event.seq;
      persistedAt = event.createdAt;
    });
    tx();

    this.eventBus.notifySubscribers({
      type: "session.detached",
      rigId: session.rig_id,
      nodeId: session.node_id,
      sessionName: session.session_name,
      seq: persistedSeq,
      createdAt: persistedAt,
    });

    return {
      ok: true,
      rigId: session.rig_id,
      nodeId: session.node_id,
      logicalId: session.logical_id,
      sessionId: session.session_id,
      sessionName: session.session_name,
    };
  }

  async releaseRig(rigId: string, opts?: { delete?: boolean }): Promise<ReleaseRigResult> {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", error: `Rig '${rigId}' not found.` };
    }

    const rows = this.db.prepare(`
      SELECT
        n.id AS node_id,
        n.logical_id,
        s.id AS session_id,
        s.session_name,
        s.origin AS session_origin
      FROM nodes n
      LEFT JOIN sessions s ON s.id = (
        SELECT s2.id
        FROM sessions s2
        WHERE s2.node_id = n.id
        ORDER BY s2.created_at DESC, s2.id DESC
        LIMIT 1
      )
      WHERE n.rig_id = ?
      ORDER BY n.logical_id
    `).all(rigId) as RigReleaseRow[];

    const launchedLogicalIds = rows
      .filter((row) => row.session_id && row.session_origin === "launched")
      .map((row) => row.logical_id);
    if (launchedLogicalIds.length > 0) {
      return {
        ok: false,
        code: "contains_launched_nodes",
        error: "Rig contains launched nodes and cannot be released safely. Use rig down for OpenRig-launched rigs.",
        launchedLogicalIds,
      };
    }

    const released: Array<{
      nodeId: string;
      logicalId: string;
      sessionId: string;
      sessionName: string;
    }> = [];
    const failed: Array<{
      nodeId: string;
      logicalId: string;
      sessionId: string | null;
      sessionName: string | null;
      error: string;
    }> = [];

    for (const row of rows) {
      if (!row.session_id || row.session_origin !== "claimed") continue;
      const result = await this.unclaimSession(row.session_id);
      if (result.ok) {
        released.push({
          nodeId: result.nodeId,
          logicalId: result.logicalId,
          sessionId: result.sessionId,
          sessionName: result.sessionName,
        });
      } else {
        failed.push({
          nodeId: row.node_id,
          logicalId: row.logical_id,
          sessionId: row.session_id,
          sessionName: row.session_name,
          error: result.error,
        });
      }
    }

    let deleted = false;
    if (failed.length === 0 && opts?.delete) {
      let persistedSeq = 0;
      let persistedAt = "";
      const tx = this.db.transaction(() => {
        const event = this.eventBus.persistWithinTransaction({
          type: "rig.deleted",
          rigId,
        });
        persistedSeq = event.seq;
        persistedAt = event.createdAt;
        this.rigRepo.deleteRig(rigId);
      });
      tx();

      this.eventBus.notifySubscribers({
        type: "rig.deleted",
        rigId,
        seq: persistedSeq,
        createdAt: persistedAt,
      });
      deleted = true;
    }

    return {
      ok: true,
      status: failed.length > 0 ? "partial" : "ok",
      rigId,
      deleted,
      released,
      failed,
    };
  }

  async removeNode(
    rigId: string,
    nodeRef: string,
    opts?: { fallbackDestination?: string },
  ): Promise<RemoveNodeResult> {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", error: `Rig '${rigId}' not found.` };
    }

    const node = this.resolveNodeRef(rigId, nodeRef);
    if (!node) {
      return { ok: false, code: "node_not_found", error: `Node '${nodeRef}' not found in rig '${rigId}'.` };
    }

    const fallbackDestination = opts?.fallbackDestination;
    if (fallbackDestination !== undefined) {
      const invalidFallback = await this.validateFallbackDestination(fallbackDestination, new Set([node.node_id]));
      if (invalidFallback) return invalidFallback;
    }

    const activeQitemIds = this.activeQitemIdsForSessionNames(
      node.latest_session_name ? [node.latest_session_name] : [],
    );
    if (activeQitemIds.length > 0 && fallbackDestination === undefined) {
      return {
        ok: false,
        code: "active_qitems",
        activeQitemIds,
        error: this.activeQitemsError(
          `Node '${node.logical_id}' still has active queue work addressed to '${node.latest_session_name}'.`,
          activeQitemIds,
          "removing the node",
        ),
      };
    }

    if (fallbackDestination !== undefined) {
      for (const qitemId of activeQitemIds) {
        this.queueRepo.routeToFallback(qitemId, fallbackDestination, `explicit fallback while removing node ${node.logical_id}`);
      }
    }

    const preserveDetachedClaimedSession = node.latest_session_origin === "claimed" && node.latest_session_status === "detached";

    let sessionsKilled = 0;
    if (node.latest_session_name && !preserveDetachedClaimedSession) {
      const kill = await this.tmuxAdapter?.killSession(node.latest_session_name);
      if (kill && !kill.ok && kill.code !== "session_not_found") {
        return {
          ok: false,
          code: "kill_failed",
          error: `Failed to kill session '${node.latest_session_name}': ${kill.message}`,
          fallbackDestination,
          reroutedQitemIds: activeQitemIds,
        };
      }
      sessionsKilled = !kill || kill.ok ? 1 : 0;
    }

    const persisted: Array<{ type: "session.detached" | "node.removed"; seq: number; createdAt: string }> = [];
    const tx = this.db.transaction(() => {
      if (node.latest_session_name && !preserveDetachedClaimedSession) {
        const detached = this.eventBus.persistWithinTransaction({
          type: "session.detached",
          rigId,
          nodeId: node.node_id,
          sessionName: node.latest_session_name,
        });
        persisted.push({ type: "session.detached", seq: detached.seq, createdAt: detached.createdAt });
      }
      const removed = this.eventBus.persistWithinTransaction({
        type: "node.removed",
        rigId,
        nodeId: node.node_id,
      });
      persisted.push({ type: "node.removed", seq: removed.seq, createdAt: removed.createdAt });
      this.rigRepo.deleteNode(node.node_id);
    });
    tx();

    for (const event of persisted) {
      if (event.type === "session.detached" && node.latest_session_name) {
        this.eventBus.notifySubscribers({
          type: "session.detached",
          rigId,
          nodeId: node.node_id,
          sessionName: node.latest_session_name,
          seq: event.seq,
          createdAt: event.createdAt,
        });
      }
      if (event.type === "node.removed") {
        this.eventBus.notifySubscribers({
          type: "node.removed",
          rigId,
          nodeId: node.node_id,
          seq: event.seq,
          createdAt: event.createdAt,
        });
      }
    }

    return {
      ok: true,
      rigId,
      nodeId: node.node_id,
      logicalId: node.logical_id,
      sessionsKilled,
      ...(fallbackDestination !== undefined ? { fallbackDestination } : {}),
      reroutedQitemIds: activeQitemIds,
    };
  }

  async shrinkPod(
    rigId: string,
    podRef: string,
    opts?: { fallbackDestination?: string },
  ): Promise<ShrinkPodResult> {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", error: `Rig '${rigId}' not found.` };
    }

    const pod = this.resolvePodRef(rigId, podRef);
    if (!pod) {
      return { ok: false, code: "pod_not_found", error: `Pod '${podRef}' not found in rig '${rigId}'.` };
    }

    const nodes = this.db.prepare(`
      SELECT n.id, n.logical_id,
        (SELECT s.session_name FROM sessions s WHERE s.node_id = n.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS latest_session_name
      FROM nodes n
      WHERE n.rig_id = ? AND n.pod_id = ?
      ORDER BY n.logical_id
    `).all(rigId, pod.id) as Array<{ id: string; logical_id: string; latest_session_name: string | null }>;

    const fallbackDestination = opts?.fallbackDestination;
    if (fallbackDestination !== undefined) {
      const invalidFallback = await this.validateFallbackDestination(
        fallbackDestination,
        new Set(nodes.map((node) => node.id)),
      );
      if (invalidFallback) return invalidFallback;
    }

    const activeQitemIds = this.activeQitemIdsForSessionNames(
      nodes.flatMap((node) => node.latest_session_name ? [node.latest_session_name] : []),
    );
    if (activeQitemIds.length > 0 && fallbackDestination === undefined) {
      return {
        ok: false,
        code: "active_qitems",
        activeQitemIds,
        error: this.activeQitemsError(
          `Pod '${pod.namespace}' still has active queue work addressed to members being removed.`,
          activeQitemIds,
        ),
      };
    }

    if (fallbackDestination !== undefined) {
      for (const qitemId of activeQitemIds) {
        this.queueRepo.routeToFallback(qitemId, fallbackDestination, `explicit fallback while shrinking pod ${pod.namespace}`);
      }
    }

    let sessionsKilled = 0;
    const removedLogicalIds: string[] = [];
    const nodeOutcomes: Array<{
      nodeId: string;
      logicalId: string;
      status: "removed" | "failed";
      sessionsKilled: number;
      error?: string;
    }> = [];
    for (const node of nodes) {
      const removed = await this.removeNode(rigId, node.id);
      if (!removed.ok) {
        const error = removed.code === "node_not_found"
          ? `Node '${node.logical_id}' disappeared while shrinking pod '${pod.namespace}'.`
          : removed.error;

        if (removedLogicalIds.length > 0) {
          nodeOutcomes.push({
            nodeId: node.id,
            logicalId: node.logical_id,
            status: "failed",
            sessionsKilled: 0,
            error,
          });
          return {
            ok: true,
            status: "partial",
            rigId,
            podId: pod.id,
            namespace: pod.namespace,
            removedLogicalIds,
            sessionsKilled,
            fallbackDestination,
            reroutedQitemIds: activeQitemIds,
            nodes: nodeOutcomes,
          };
        }

        if (removed.code === "rig_not_found") {
          return {
            ok: false,
            code: "rig_not_found",
            error: removed.error,
            fallbackDestination,
            reroutedQitemIds: activeQitemIds,
          };
        }
        if (removed.code === "node_not_found") {
          return {
            ok: false,
            code: "kill_failed",
            error,
            fallbackDestination,
            reroutedQitemIds: activeQitemIds,
          };
        }
        return {
          ok: false,
          code: "kill_failed",
          error,
          fallbackDestination,
          reroutedQitemIds: activeQitemIds,
        };
      }
      sessionsKilled += removed.sessionsKilled;
      removedLogicalIds.push(removed.logicalId);
      nodeOutcomes.push({
        nodeId: removed.nodeId,
        logicalId: removed.logicalId,
        status: "removed",
        sessionsKilled: removed.sessionsKilled,
      });
    }

    let persistedSeq = 0;
    let persistedAt = "";
    const tx = this.db.transaction(() => {
      const event = this.eventBus.persistWithinTransaction({
        type: "pod.deleted",
        rigId,
        podId: pod.id,
      });
      persistedSeq = event.seq;
      persistedAt = event.createdAt;
      this.db.prepare("DELETE FROM pods WHERE id = ?").run(pod.id);
    });
    tx();

    this.eventBus.notifySubscribers({
      type: "pod.deleted",
      rigId,
      podId: pod.id,
      seq: persistedSeq,
      createdAt: persistedAt,
    });

    return {
      ok: true,
      status: "ok",
      rigId,
      podId: pod.id,
      namespace: pod.namespace,
      removedLogicalIds,
      sessionsKilled,
      ...(fallbackDestination !== undefined ? { fallbackDestination } : {}),
      reroutedQitemIds: activeQitemIds,
      nodes: nodeOutcomes,
    };
  }

  private activeQitemIdsForSessionNames(sessionNames: string[]): string[] {
    const uniqueSessionNames = [...new Set(sessionNames)];
    if (uniqueSessionNames.length === 0) return [];
    const placeholders = uniqueSessionNames.map(() => "?").join(", ");
    return (this.db.prepare(`
      SELECT qitem_id
      FROM queue_items
      WHERE destination_session IN (${placeholders})
        AND state IN ('pending', 'in-progress', 'blocked')
      ORDER BY qitem_id
    `).all(...uniqueSessionNames) as Array<{ qitem_id: string }>).map((row) => row.qitem_id);
  }

  private activeQitemsError(subject: string, activeQitemIds: string[], before = "removal"): string {
    const fallbackCommands = activeQitemIds
      .map((qitemId) => `rig queue fallback ${qitemId} --destination <live-seat>`)
      .join("\n");
    return `${subject} Reroute each qitem before ${before}:\n${fallbackCommands}`;
  }

  private async validateFallbackDestination(
    fallbackDestination: string,
    targetNodeIds: Set<string>,
  ): Promise<FallbackValidationFailure | null> {
    const row = this.db.prepare(`
      SELECT s.node_id, n.logical_id, s.status
      FROM sessions s
      JOIN nodes n ON n.id = s.node_id
      WHERE s.session_name = ?
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    `).get(fallbackDestination) as { node_id: string; logical_id: string; status: string } | undefined;

    if (!row || row.status !== "running") {
      return {
        ok: false,
        code: "fallback_not_running",
        error: `Fallback destination '${fallbackDestination}' is not a currently running seat. No queue or topology changes were made.`,
      };
    }
    if (targetNodeIds.has(row.node_id)) {
      return {
        ok: false,
        code: "fallback_in_target",
        error: `Fallback destination '${fallbackDestination}' belongs to '${row.logical_id}', which is part of the removal target. No queue or topology changes were made.`,
      };
    }
    if (!this.tmuxAdapter || !(await this.tmuxAdapter.hasSession(fallbackDestination))) {
      return {
        ok: false,
        code: "fallback_not_running",
        error: `Fallback destination '${fallbackDestination}' is not a currently running seat. No queue or topology changes were made.`,
      };
    }
    return null;
  }

  private resolveNodeRef(rigId: string, nodeRef: string): NodeLifecycleRow | null {
    const exactId = this.db.prepare(`
      SELECT n.id AS node_id, n.rig_id, n.logical_id, n.pod_id, b.tmux_session,
        s.id AS latest_session_id,
        s.session_name AS latest_session_name,
        s.status AS latest_session_status,
        s.origin AS latest_session_origin
      FROM nodes n
      LEFT JOIN bindings b ON b.node_id = n.id
      LEFT JOIN sessions s ON s.id = (
        SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1
      )
      WHERE n.rig_id = ? AND n.id = ?
      LIMIT 1
    `).get(rigId, nodeRef) as NodeLifecycleRow | undefined;
    if (exactId) return exactId;

    const byLogicalId = this.db.prepare(`
      SELECT n.id AS node_id, n.rig_id, n.logical_id, n.pod_id, b.tmux_session,
        s.id AS latest_session_id,
        s.session_name AS latest_session_name,
        s.status AS latest_session_status,
        s.origin AS latest_session_origin
      FROM nodes n
      LEFT JOIN bindings b ON b.node_id = n.id
      LEFT JOIN sessions s ON s.id = (
        SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1
      )
      WHERE n.rig_id = ? AND n.logical_id = ?
      LIMIT 1
    `).get(rigId, nodeRef) as NodeLifecycleRow | undefined;
    return byLogicalId ?? null;
  }

  private resolvePodRef(rigId: string, podRef: string): { id: string; namespace: string } | null {
    const exactId = this.db.prepare(`
      SELECT id, namespace
      FROM pods
      WHERE rig_id = ? AND id = ?
      LIMIT 1
    `).get(rigId, podRef) as { id: string; namespace: string } | undefined;
    if (exactId) return exactId;

    const byNamespace = this.db.prepare(`
      SELECT id, namespace
      FROM pods
      WHERE rig_id = ? AND namespace = ?
      LIMIT 1
    `).get(rigId, podRef) as { id: string; namespace: string } | undefined;
    return byNamespace ?? null;
  }
}
