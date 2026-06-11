import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import { startTmuxTranscriptCapture } from "./transcript-capture.js";

export type ClaimResult =
  | { ok: true; nodeId: string; sessionId: string }
  | { ok: false; code: string; error: string };

/**
 * OPR.0.3.4.3 — outcome of the no-launch reconcile (adopt a hand-resumed
 * canonical session back into its persisted node). Honest split: `projectionDrift`
 * lists topology metadata the reconcile could NOT prove about the live pane;
 * `continuity` is ALWAYS "unverified" — reconnecting the projection never claims
 * the provider conversation is continuous.
 */
export interface ReconcileSessionResult {
  rigId: string;
  rigName: string;
  nodeId: string;
  logicalId: string;
  sessionName: string;
  sessionId: string;
  /** Topology metadata the reconcile could not prove on the live pane (e.g.
   *  "runtime unverified: pane command 'node' does not confirm runtime 'codex'"). */
  projectionDrift: string[];
  /** Provider-session conversation continuity is never verified by reconcile. */
  continuity: "unverified";
}

export type ReconcileSessionOutcome =
  | { ok: true; result: ReconcileSessionResult }
  | { ok: false; code: "session_not_found"; message: string }
  | { ok: false; code: "node_not_found"; message: string }
  | { ok: false; code: "rig_not_found"; message: string }
  | { ok: false; code: "node_mismatch"; message: string }
  | { ok: false; code: "reconcile_error"; message: string };

export interface ReconcileSessionOptions {
  sessionName: string;
  /** Optional explicit disambiguation; when given they are authoritative and
   *  cross-checked against the session-name mapping. */
  rigId?: string;
  logicalId?: string;
}

interface ClaimServiceDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  discoveryRepo: DiscoveryRepository;
  eventBus: EventBus;
  tmuxAdapter?: TmuxAdapter;
  transcriptStore?: TranscriptStore;
  claudeContextProvisioner?: {
    ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void;
  };
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
  private transcriptStore: TranscriptStore | null;
  private claudeContextProvisioner: ClaimServiceDeps["claudeContextProvisioner"] | null;

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
    this.transcriptStore = deps.transcriptStore ?? null;
    this.claudeContextProvisioner = deps.claudeContextProvisioner ?? null;
  }

  /** Best-effort: set OpenRig-owned tmux metadata on an adopted session. */
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

  /** Best-effort: send a short identity hint into the adopted session after claim. */
  private async deliverClaimHint(tmuxSession: string, meta: {
    rigName: string; logicalId: string;
  }): Promise<void> {
    if (!this.tmuxAdapter) return;
    const hint = `--- OpenRig: You have been adopted into rig "${meta.rigName}" as ${meta.logicalId}. Run: rig whoami --json ---`;
    await this.tmuxAdapter.sendText(tmuxSession, hint);
    await this.tmuxAdapter.sendKeys(tmuxSession, ["C-m"]);
  }

  private maybeProvisionContextCollector(runtime: string | null | undefined, cwd: string | null | undefined, tmuxSession: string): void {
    if (runtime !== "claude-code") return;
    try {
      this.claudeContextProvisioner?.ensureContextCollector({
        cwd: cwd ?? undefined,
        tmuxSession,
      });
    } catch { /* best-effort */ }
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
      // Best-effort: set OpenRig-owned tmux metadata
      try {
        await this.setRiggedMetadata(discovered.tmuxSession, {
          nodeId, sessionName: discovered.tmuxSession,
          rigId: opts.rigId, rigName: rig!.rig.name, logicalId: opts.logicalId,
        });
      } catch { /* best-effort */ }
      this.maybeProvisionContextCollector(node.runtime ?? discoveredRuntime, node.cwd ?? discovered.cwd, discovered.tmuxSession);
      try {
        await startTmuxTranscriptCapture(this.tmuxAdapter, this.transcriptStore, rig!.rig.name, discovered.tmuxSession);
      } catch { /* best-effort */ }
      // Best-effort: send post-claim identity hint
      try {
        await this.deliverClaimHint(discovered.tmuxSession, { rigName: rig!.rig.name, logicalId: opts.logicalId });
      } catch { /* best-effort */ }

      return { ok: true, nodeId, sessionId };
    } catch (err) {
      return { ok: false, code: "claim_error", error: (err as Error).message };
    }
  }

  /**
   * OPR.0.3.4.3 — no-launch reconcile: adopt a LIVE, hand-resumed canonical
   * session back into its persisted node. The safest outage repair (manual
   * `claude --resume` / `codex resume` into the canonical tmux name) leaves the
   * daemon projection showing the seat down; this binds the live process to its
   * OWN node and flips the projection, and does NOTHING else.
   *
   * THE SAFETY LINE (guard rev1): reuses ONLY the DB binding / projection /
   * metadata portions of bind — NEVER the post-claim input path. It does not
   * call launchNode / createSession / killSession / sendText / sendKeys /
   * deliverClaimHint / startup-or-resume delivery / compact-menu automation.
   * Allowed target ops: hasSession check, pane metadata/PID reads,
   * binding/session/projection upserts, non-input tmux metadata
   * (setSessionOption), event emission, transcript bookkeeping.
   *
   * Identity boundary: binds to the EXISTING node — same node id, no re-key,
   * no migration. Honest split: projectionDrift (unproven topology metadata)
   * is reported separately; continuity is always "unverified".
   */
  async reconcileSession(opts: ReconcileSessionOptions): Promise<ReconcileSessionOutcome> {
    const sessionName = opts.sessionName.trim();
    if (!sessionName) {
      return { ok: false, code: "session_not_found", message: "sessionName is required." };
    }

    // 1. Resolve the persisted node for this canonical session name. The
    // session-name mapping is the daemon's own history (bindings + session
    // rows); explicit --rig/--node are authoritative and cross-checked.
    let nodeRow: { id: string; rig_id: string; logical_id: string; runtime: string | null; cwd: string | null } | undefined;
    if (opts.rigId && opts.logicalId) {
      const rig = this.rigRepo.getRig(opts.rigId);
      if (!rig) {
        return { ok: false, code: "rig_not_found", message: `Rig "${opts.rigId}" not found.` };
      }
      const node = rig.nodes.find((candidate) => candidate.logicalId === opts.logicalId);
      if (!node) {
        return { ok: false, code: "node_not_found", message: `Logical ID "${opts.logicalId}" does not exist in rig "${rig.rig.name}".` };
      }
      nodeRow = { id: node.id, rig_id: opts.rigId, logical_id: node.logicalId, runtime: node.runtime ?? null, cwd: node.cwd ?? null };
      // Cross-check: if the daemon's history maps this session name to a
      // DIFFERENT node, refuse honestly rather than silently re-pointing.
      const mapped = this.resolveNodeIdForSessionName(sessionName);
      if (mapped && mapped !== node.id) {
        return {
          ok: false,
          code: "node_mismatch",
          message: `Session "${sessionName}" maps to a different persisted node than ${opts.logicalId}. Re-check --rig/--node, or omit them to use the daemon's mapping.`,
        };
      }
      // IDENTITY BOUNDARY (guard re-review): with NO daemon-history mapping,
      // explicit --rig/--node may only adopt the node's OWN canonical/managed
      // session name. Binding an arbitrary never-managed name to a node would
      // be an adopt/re-key path, not a reconcile — those go through
      // rig discover + rig bind.
      if (!mapped) {
        const expected = await this.expectedManagedSessionName(node.logicalId, node.podId ?? null, rig.rig.name);
        if (sessionName !== expected) {
          return {
            ok: false,
            code: "node_mismatch",
            message: `Session "${sessionName}" is not ${opts.logicalId}'s managed session name (expected "${expected}") and the daemon has no history mapping it to this node. Reconcile only re-adopts a node's own canonical session; to manage a new/unmanaged session, use rig discover + rig bind.`,
          };
        }
      }
    } else {
      const mappedNodeId = this.resolveNodeIdForSessionName(sessionName);
      if (!mappedNodeId) {
        return {
          ok: false,
          code: "node_not_found",
          message: `No persisted node maps to session "${sessionName}". If this seat was never managed, use rig discover + rig bind; reconcile only re-adopts a previously managed seat. You can disambiguate with --rig <rig> --node <logicalId>.`,
        };
      }
      const row = this.db
        .prepare("SELECT id, rig_id, logical_id, runtime, cwd FROM nodes WHERE id = ?")
        .get(mappedNodeId) as { id: string; rig_id: string; logical_id: string; runtime: string | null; cwd: string | null } | undefined;
      if (!row) {
        return { ok: false, code: "node_not_found", message: `Persisted node for session "${sessionName}" no longer exists.` };
      }
      nodeRow = row;
    }

    const rig = this.rigRepo.getRig(nodeRow.rig_id);
    if (!rig) {
      return { ok: false, code: "rig_not_found", message: `Rig for node "${nodeRow.logical_id}" no longer exists.` };
    }

    // 2. Verify a LIVE tmux session with the canonical name exists (read-only).
    if (!this.tmuxAdapter) {
      return { ok: false, code: "reconcile_error", message: "tmux adapter unavailable; cannot verify the live session." };
    }
    const alive = await this.tmuxAdapter.hasSession(sessionName);
    if (!alive) {
      return {
        ok: false,
        code: "session_not_found",
        message: `No live tmux session named "${sessionName}". Reconcile adopts a RUNNING session; to start the seat, use the launch path instead.`,
      };
    }

    // 3. Read-only pane facts for the honest drift report. Reading never
    // injects input; failures degrade to drift entries, not errors.
    const projectionDrift: string[] = [];
    let paneCommand: string | null = null;
    try {
      paneCommand = await this.tmuxAdapter.getPaneCommand(sessionName);
    } catch { paneCommand = null; }
    if (nodeRow.runtime) {
      const expectation: Record<string, string[]> = {
        "claude-code": ["claude", "node"],
        codex: ["codex", "node"],
        terminal: [],
      };
      const expected = expectation[nodeRow.runtime];
      if (!paneCommand) {
        projectionDrift.push(`runtime unverified: pane command unreadable; node declares runtime "${nodeRow.runtime}"`);
      } else if (expected && expected.length > 0 && !expected.includes(paneCommand)) {
        projectionDrift.push(`runtime unverified: pane command "${paneCommand}" does not confirm runtime "${nodeRow.runtime}"`);
      }
    }
    if (nodeRow.cwd) {
      projectionDrift.push(`cwd unverified: node declares "${nodeRow.cwd}"; the live pane's cwd is not provable without injecting input`);
    }

    // 4. The DB portion of bind, reconcile-shaped: supersede stale session
    // rows for THIS node, upsert the binding to the live session, register a
    // fresh claimed-session row (status running), emit node.reconciled — one tx.
    try {
      let sessionId = "";
      let persistedEvent: ReturnType<EventBus["persistWithinTransaction"]> | undefined;
      const tx = this.db.transaction(() => {
        const stale = this.db
          .prepare("SELECT id FROM sessions WHERE node_id = ? AND status = 'running'")
          .all(nodeRow!.id) as Array<{ id: string }>;
        for (const row of stale) {
          this.sessionRegistry.markSuperseded(row.id);
        }
        this.sessionRegistry.updateBinding(nodeRow!.id, { tmuxSession: sessionName });
        const session = this.sessionRegistry.registerClaimedSession(nodeRow!.id, sessionName);
        sessionId = session.id;
        persistedEvent = this.eventBus.persistWithinTransaction({
          type: "node.reconciled",
          rigId: nodeRow!.rig_id,
          nodeId: nodeRow!.id,
          logicalId: nodeRow!.logical_id,
          sessionName,
        });
      });
      tx();
      if (persistedEvent) this.eventBus.notifySubscribers(persistedEvent);

      // 5. Best-effort NON-INPUT housekeeping: OpenRig-owned tmux metadata
      // (setSessionOption only) + transcript capture (pipe-pane bookkeeping).
      // Deliberately NO deliverClaimHint and NO context-collector provisioning
      // — nothing that writes into the live pane or the seat's workspace.
      try {
        await this.setRiggedMetadata(sessionName, {
          nodeId: nodeRow.id,
          sessionName,
          rigId: nodeRow.rig_id,
          rigName: rig.rig.name,
          logicalId: nodeRow.logical_id,
        });
      } catch { /* best-effort */ }
      try {
        await startTmuxTranscriptCapture(this.tmuxAdapter, this.transcriptStore, rig.rig.name, sessionName);
      } catch { /* best-effort */ }

      return {
        ok: true,
        result: {
          rigId: nodeRow.rig_id,
          rigName: rig.rig.name,
          nodeId: nodeRow.id,
          logicalId: nodeRow.logical_id,
          sessionName,
          sessionId,
          projectionDrift,
          continuity: "unverified",
        },
      };
    } catch (err) {
      return { ok: false, code: "reconcile_error", message: (err as Error).message };
    }
  }

  /** The session name a managed node is EXPECTED to live at — pod-aware nodes
   *  derive `{pod}-{member}@{rigName}`; legacy flat nodes use the legacy
   *  derivation. Used to fence the explicit --rig/--node reconcile branch when
   *  the daemon has no history mapping for the supplied name. */
  private async expectedManagedSessionName(logicalId: string, podId: string | null, rigName: string): Promise<string> {
    const { deriveCanonicalSessionName, deriveSessionName } = await import("./session-name.js");
    if (podId) {
      const parts = logicalId.split(".");
      if (parts.length >= 2) {
        return deriveCanonicalSessionName(parts[0]!, parts.slice(1).join("."), rigName);
      }
    }
    return deriveSessionName(rigName, logicalId);
  }

  /** Map a canonical session name to its persisted node via the daemon's own
   *  history: the current binding first, then the most recent session row. */
  private resolveNodeIdForSessionName(sessionName: string): string | null {
    const bound = this.db
      .prepare("SELECT node_id FROM bindings WHERE tmux_session = ?")
      .get(sessionName) as { node_id: string } | undefined;
    if (bound) return bound.node_id;
    const recent = this.db
      .prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(sessionName) as { node_id: string } | undefined;
    return recent?.node_id ?? null;
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

    const discoveredRuntime = discovered.runtimeHint === "unknown" || discovered.runtimeHint === "terminal"
      ? undefined
      : discovered.runtimeHint;

    const claimTx = this.db.transaction(() => {
      const node = this.rigRepo.addNode(opts.rigId, logicalId, {
        runtime: discoveredRuntime,
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
      // Best-effort: set OpenRig-owned tmux metadata
      try {
        await this.setRiggedMetadata(discovered.tmuxSession, {
          nodeId, sessionName: discovered.tmuxSession,
          rigId: opts.rigId, rigName: rig!.rig.name, logicalId,
        });
      } catch { /* best-effort */ }
      this.maybeProvisionContextCollector(discoveredRuntime, discovered.cwd, discovered.tmuxSession);
      try {
        await startTmuxTranscriptCapture(this.tmuxAdapter, this.transcriptStore, rig!.rig.name, discovered.tmuxSession);
      } catch { /* best-effort */ }
      // Best-effort: send post-claim identity hint
      try {
        await this.deliverClaimHint(discovered.tmuxSession, { rigName: rig!.rig.name, logicalId });
      } catch { /* best-effort */ }

      return { ok: true, nodeId, sessionId };
    } catch (err) {
      return { ok: false, code: "claim_error", error: (err as Error).message };
    }
  }
}
