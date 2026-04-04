import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";

export type ClaimResult =
  | { ok: true; nodeId: string; sessionId: string }
  | { ok: false; code: string; error: string };

interface ClaimServiceDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  discoveryRepo: DiscoveryRepository;
  eventBus: EventBus;
  tmuxAdapter?: TmuxAdapter;
}

interface ClaimOptions {
  discoveredId: string;
  rigId: string;
  logicalId?: string;
}

interface BindOptions {
  discoveredId: string;
  rigId: string;
  logicalId: string;
}

interface CreateAndBindToPodOptions {
  discoveredId: string;
  rigId: string;
  podId: string;
  podNamespace: string;
  memberName: string;
}

/**
 * Adopts a discovered session into a managed rig.
 * Creates node + binding + session record atomically.
 * No package install, no guidance merge, no hooks.
 */
export class ClaimService {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private discoveryRepo: DiscoveryRepository;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter | null;

  constructor(deps: ClaimServiceDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("ClaimService: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("ClaimService: sessionRegistry must share the same db handle");
    if (deps.db !== deps.discoveryRepo.db) throw new Error("ClaimService: discoveryRepo must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("ClaimService: eventBus must share the same db handle");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.discoveryRepo = deps.discoveryRepo;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter ?? null;
  }

  /** Best-effort: set Rigged-owned tmux metadata on an adopted session. */
  private async setRiggedMetadata(tmuxSession: string, meta: {
    nodeId: string; sessionName: string; rigId: string; rigName: string; logicalId: string;
  }): Promise<void> {
    if (!this.tmuxAdapter) return;
    const entries: [string, string][] = [
      ["@rigged_node_id", meta.nodeId],
      ["@rigged_session_name", meta.sessionName],
      ["@rigged_rig_id", meta.rigId],
      ["@rigged_rig_name", meta.rigName],
      ["@rigged_logical_id", meta.logicalId],
    ];
    for (const [key, value] of entries) {
      await this.tmuxAdapter.setSessionOption(tmuxSession, key, value);
    }
  }

  async claim(opts: ClaimOptions): Promise<ClaimResult> {
    // Validate discovery record
    const discovered = this.discoveryRepo.getDiscoveredSession(opts.discoveredId);
    if (!discovered) {
      return { ok: false, code: "not_found", error: "Discovery record not found" };
    }
    if (discovered.status !== "active") {
      return { ok: false, code: "not_active", error: `Discovery record is ${discovered.status}, not active` };
    }

    // Validate rig exists
    const rig = this.rigRepo.getRig(opts.rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", error: "Target rig not found" };
    }

    // Derive logical ID
    const logicalId = opts.logicalId ?? discovered.tmuxSession;

    // Check for duplicate logical_id in the rig
    if (rig.nodes.some((n) => n.logicalId === logicalId)) {
      return { ok: false, code: "duplicate_logical_id", error: `Logical ID '${logicalId}' already exists in rig` };
    }

    // Atomic transaction: node + binding + session + discovery claim + event
    const claimTx = this.db.transaction(() => {
      // Create node with runtime from discovery hint
      const runtime = discovered.runtimeHint === "unknown" || discovered.runtimeHint === "terminal"
        ? undefined
        : discovered.runtimeHint;
      const node = this.rigRepo.addNode(opts.rigId, logicalId, {
        runtime,
        cwd: discovered.cwd ?? undefined,
      });

      // Create binding pointing to existing tmux session/pane
      this.sessionRegistry.updateBinding(node.id, {
        tmuxSession: discovered.tmuxSession,
        tmuxWindow: discovered.tmuxWindow ?? undefined,
        tmuxPane: discovered.tmuxPane ?? undefined,
      });

      // Create session with origin='claimed'
      const session = this.sessionRegistry.registerClaimedSession(node.id, discovered.tmuxSession);

      // Mark discovery record as claimed
      this.discoveryRepo.markClaimed(discovered.id, node.id);

      // Emit event (persisted within same transaction context)
      this.eventBus.persistWithinTransaction({
        type: "node.claimed",
        rigId: opts.rigId,
        nodeId: node.id,
        logicalId,
        discoveredId: discovered.id,
      });

      return { nodeId: node.id, sessionId: session.id };
    });

    try {
      const { nodeId, sessionId } = claimTx();
      // Notify in-memory subscribers after transaction commits
      const event = this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT 1").get() as { seq: number; type: string; rig_id: string; node_id: string; payload: string; created_at: string };
      if (event) {
        this.eventBus.notifySubscribers({
          type: "node.claimed",
          rigId: opts.rigId,
          nodeId,
          logicalId,
          discoveredId: discovered.id,
          seq: event.seq,
          createdAt: event.created_at,
        });
      }
      // Best-effort: set Rigged-owned tmux metadata on the adopted session
      try {
        await this.setRiggedMetadata(discovered.tmuxSession, {
          nodeId, sessionName: discovered.tmuxSession,
          rigId: opts.rigId, rigName: rig!.rig.name, logicalId,
        });
      } catch { /* best-effort */ }

      return { ok: true, nodeId, sessionId };
    } catch (err) {
      return { ok: false, code: "claim_error", error: (err as Error).message };
    }
  }

  async bind(opts: BindOptions): Promise<ClaimResult> {
    const discovered = this.discoveryRepo.getDiscoveredSession(opts.discoveredId);
    if (!discovered) {
      return { ok: false, code: "not_found", error: "Discovery record not found" };
    }
    if (discovered.status !== "active") {
      return { ok: false, code: "not_active", error: `Discovery record is ${discovered.status}, not active` };
    }

    const rig = this.rigRepo.getRig(opts.rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", error: "Target rig not found" };
    }

    const node = rig.nodes.find((candidate) => candidate.logicalId === opts.logicalId);
    if (!node) {
      return { ok: false, code: "node_not_found", error: `Logical ID '${opts.logicalId}' does not exist in rig` };
    }

    const existingBinding = this.sessionRegistry.getBindingForNode(node.id);
    if (existingBinding?.tmuxSession) {
      return { ok: false, code: "already_bound", error: `Logical ID '${opts.logicalId}' is already bound` };
    }

    const discoveredRuntime = discovered.runtimeHint === "unknown" || discovered.runtimeHint === "terminal"
      ? null
      : discovered.runtimeHint;
    if (node.runtime && discoveredRuntime && node.runtime !== discoveredRuntime) {
      return {
        ok: false,
        code: "runtime_mismatch",
        error: `Logical ID '${opts.logicalId}' expects runtime '${node.runtime}', but discovery resolved '${discoveredRuntime}'`,
      };
    }

    const bindTx = this.db.transaction(() => {
      this.sessionRegistry.updateBinding(node.id, {
        tmuxSession: discovered.tmuxSession,
        tmuxWindow: discovered.tmuxWindow ?? undefined,
        tmuxPane: discovered.tmuxPane ?? undefined,
      });

      const session = this.sessionRegistry.registerClaimedSession(node.id, discovered.tmuxSession);
      this.discoveryRepo.markClaimed(discovered.id, node.id);
      this.eventBus.persistWithinTransaction({
        type: "node.claimed",
        rigId: opts.rigId,
        nodeId: node.id,
        logicalId: opts.logicalId,
        discoveredId: discovered.id,
      });

      return { nodeId: node.id, sessionId: session.id };
    });

    try {
      const { nodeId, sessionId } = bindTx();
      const event = this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT 1").get() as { seq: number; type: string; rig_id: string; node_id: string; payload: string; created_at: string };
      if (event) {
        this.eventBus.notifySubscribers({
          type: "node.claimed",
          rigId: opts.rigId,
          nodeId,
          logicalId: opts.logicalId,
          discoveredId: discovered.id,
          seq: event.seq,
          createdAt: event.created_at,
        });
      }
      // Best-effort: set Rigged-owned tmux metadata
      try {
        await this.setRiggedMetadata(discovered.tmuxSession, {
          nodeId, sessionName: discovered.tmuxSession,
          rigId: opts.rigId, rigName: rig!.rig.name, logicalId: opts.logicalId,
        });
      } catch { /* best-effort */ }

      return { ok: true, nodeId, sessionId };
    } catch (err) {
      return { ok: false, code: "claim_error", error: (err as Error).message };
    }
  }

  async createAndBindToPod(opts: CreateAndBindToPodOptions): Promise<ClaimResult> {
    const discovered = this.discoveryRepo.getDiscoveredSession(opts.discoveredId);
    if (!discovered) {
      return { ok: false, code: "not_found", error: "Discovery record not found" };
    }
    if (discovered.status !== "active") {
      return { ok: false, code: "not_active", error: `Discovery record is ${discovered.status}, not active` };
    }

    const rig = this.rigRepo.getRig(opts.rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", error: "Target rig not found" };
    }

    const podRow = this.db
      .prepare("SELECT rig_id, namespace FROM pods WHERE id = ?")
      .get(opts.podId) as { rig_id: string; namespace: string } | undefined;
    if (!podRow || podRow.rig_id !== opts.rigId) {
      return { ok: false, code: "pod_not_found", error: "Target pod not found in rig" };
    }

    const memberName = opts.memberName.trim();
    const podNamespace = opts.podNamespace.trim();
    if (!memberName) {
      return { ok: false, code: "invalid_member_name", error: "memberName is required" };
    }
    if (!podNamespace) {
      return { ok: false, code: "invalid_pod_namespace", error: "podNamespace is required" };
    }
    if (podRow.namespace !== podNamespace) {
      return { ok: false, code: "invalid_pod_namespace", error: "podNamespace does not match target pod" };
    }

    const logicalId = `${podNamespace}.${memberName}`;
    if (rig.nodes.some((n) => n.logicalId === logicalId)) {
      return { ok: false, code: "duplicate_logical_id", error: `Logical ID '${logicalId}' already exists in rig` };
    }

    const claimTx = this.db.transaction(() => {
      const runtime = discovered.runtimeHint === "unknown" || discovered.runtimeHint === "terminal"
        ? undefined
        : discovered.runtimeHint;
      const node = this.rigRepo.addNode(opts.rigId, logicalId, {
        runtime,
        cwd: discovered.cwd ?? undefined,
        podId: opts.podId,
      });

      this.sessionRegistry.updateBinding(node.id, {
        tmuxSession: discovered.tmuxSession,
        tmuxWindow: discovered.tmuxWindow ?? undefined,
        tmuxPane: discovered.tmuxPane ?? undefined,
      });

      const session = this.sessionRegistry.registerClaimedSession(node.id, discovered.tmuxSession);
      this.discoveryRepo.markClaimed(discovered.id, node.id);
      this.eventBus.persistWithinTransaction({
        type: "node.claimed",
        rigId: opts.rigId,
        nodeId: node.id,
        logicalId,
        discoveredId: discovered.id,
      });

      return { nodeId: node.id, sessionId: session.id };
    });

    try {
      const { nodeId, sessionId } = claimTx();
      const event = this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT 1").get() as { seq: number; type: string; rig_id: string; node_id: string; payload: string; created_at: string };
      if (event) {
        this.eventBus.notifySubscribers({
          type: "node.claimed",
          rigId: opts.rigId,
          nodeId,
          logicalId,
          discoveredId: discovered.id,
          seq: event.seq,
          createdAt: event.created_at,
        });
      }
      // Best-effort: set Rigged-owned tmux metadata
      try {
        await this.setRiggedMetadata(discovered.tmuxSession, {
          nodeId, sessionName: discovered.tmuxSession,
          rigId: opts.rigId, rigName: rig!.rig.name, logicalId,
        });
      } catch { /* best-effort */ }

      return { ok: true, nodeId, sessionId };
    } catch (err) {
      return { ok: false, code: "claim_error", error: (err as Error).message };
    }
  }
}
