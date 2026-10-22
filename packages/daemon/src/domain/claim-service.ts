import { shellQuote } from "../adapters/shell-quote.js";
import { resumeTypeForRuntime, validateResumeToken } from "./resume-token-validation.js";
import { OutboxHandler } from "./outbox-handler.js";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import { SessionAddressConflict, type SessionRegistry } from "./session-registry.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import { startTmuxTranscriptCapture } from "./transcript-capture.js";
import { deriveResumeToken, type ResumeTokenCaptureDeps } from "./resume-token-capture.js";
import { verifyClaudePaneRuntime, verifyCodexPaneProcess, witnessedClaudeVersionLabel, type NativeProcessLister } from "./native-process-lineage.js";
import {
  observeSolePane,
  paneObservationVerdict,
  type PaneBindingObservation,
} from "./pane-binding-observation.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { DeliveryGuardError } from "./seat-delivery-guard.js";

export type ClaimResult =
  | { ok: true; nodeId: string; sessionId: string }
  | { ok: false; code: string; error: string };

export interface AdoptionCaptureOutcome {
  outcome: "captured" | "preserved" | "skipped" | "exempt" | "noop" | "error";
  reason?: string;
}

export interface ReconcileResumeMetadata {
  capture: AdoptionCaptureOutcome;
  /** Recorded metadata is not proof of conversation continuity or resumability. */
  status: "recorded" | "missing" | "unknown" | "not_applicable";
  guidance?: string;
}

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
  /** Absent for the binding-only missing-pane repair, which does not capture. */
  resumeMetadata?: ReconcileResumeMetadata;
}

export interface MissingPaneRepairResult extends ReconcileSessionResult {
  mode: "repair-missing-pane";
  pane: string;
}

export type ReconcileSessionOutcome =
  | { ok: true; result: ReconcileSessionResult | MissingPaneRepairResult }
  | { ok: false; code: string; message: string };

export interface ReconcileSessionOptions {
  sessionName: string;
  /** Optional explicit disambiguation; when given they are authoritative and
   *  cross-checked against the session-name mapping. */
  rigId?: string;
  logicalId?: string;
  /** Explicit binding-only recovery; never enters adoption or capture housekeeping. */
  repairMissingPane?: boolean;
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
  // OPR.0.4.3.20 FR-3 — adoption-boundary resume-token capture. Both optional
  // and structurally typed (avoid a domain import cycle; older wirings / tests
  // that omit them make capture a silent no-op). contextUsageStore reads the
  // Claude status-line sidecar; resumeTokenCapturer derives the Codex thread id.
  contextUsageStore?: {
    readSidecar(sessionName: string): { ok: true; data: { session_id?: string; sampled_at?: string } } | { ok: false; reason: string };
  };
  /** #421 — start time of the pane's current Claude process; a sidecar sampled earlier is skipped. */
  claudeProcessStartedAt?: ResumeTokenCaptureDeps["claudeProcessStartedAt"];
  /** Process census for the runtime proof in `reconcileSession` and #86's native version-label witness; defaults to the live process table. */
  listProcesses?: NativeProcessLister;
  resumeTokenCapturer?: {
    captureCodexThreadId(sessionName: string): Promise<string | undefined>;
  };
  /** OPR.0.4.6.PI1 FR-6 — pi-runner sidecar reader for Pi resume-token capture. */
  piRunnerStateStore?: {
    readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string };
  };
  ompRunnerStateStore?: ResumeTokenCaptureDeps["ompRunnerStateStore"];
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
  private contextUsageStore: ClaimServiceDeps["contextUsageStore"] | null;
  private claudeProcessStartedAt: ClaimServiceDeps["claudeProcessStartedAt"] | null;
  private listProcesses: NativeProcessLister | undefined;
  private resumeTokenCapturer: ClaimServiceDeps["resumeTokenCapturer"] | null;
  private piRunnerStateStore: ClaimServiceDeps["piRunnerStateStore"] | null;
  private ompRunnerStateStore: ClaimServiceDeps["ompRunnerStateStore"] | null;

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
    this.contextUsageStore = deps.contextUsageStore ?? null;
    this.claudeProcessStartedAt = deps.claudeProcessStartedAt ?? null;
    this.listProcesses = deps.listProcesses;
    this.resumeTokenCapturer = deps.resumeTokenCapturer ?? null;
    this.piRunnerStateStore = deps.piRunnerStateStore ?? null;
    this.ompRunnerStateStore = deps.ompRunnerStateStore ?? null;
  }

  private async observeBindingPane(
    sessionName: string,
    knownPane?: string | null,
  ): Promise<PaneBindingObservation> {
    if (knownPane) return { ok: true, pane: knownPane };
    if (!this.tmuxAdapter) {
      return { ok: false, code: "tmux_unavailable", detail: "tmux adapter unavailable" };
    }
    return observeSolePane(this.tmuxAdapter, sessionName);
  }

  private persistPaneBinding(
    nodeId: string,
    sessionName: string,
    observation: PaneBindingObservation,
    sessionId: string,
    tmuxWindow?: string | null,
  ): void {
    this.sessionRegistry.updateBinding(nodeId, {
      tmuxSession: sessionName,
      ...(tmuxWindow ? { tmuxWindow } : {}),
      ...(observation.ok ? { tmuxPane: observation.pane } : {}),
    });
    if (!observation.ok) {
      new SeatIdentityStore(this.db).upsert(paneObservationVerdict({
        nodeId,
        sessionId,
        sessionName,
        observation,
      }));
    }
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
    const write = async () => {
      const sent = await this.tmuxAdapter!.sendText(tmuxSession, hint);
      if (sent.ok) await this.tmuxAdapter!.sendKeys(tmuxSession, ["Enter"]);
    };
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard) await guard.operation(tmuxSession, write, async target => {
      new OutboxHandler(this.db).retain({ outboxId: `guard-claim-${target.nodeId}-${target.occupant ?? "unknown"}`,
        senderSession: "claim@system", destinationSession: tmuxSession, body: hint }, target);
    });
    else await write();
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

  /**
   * OPR.0.4.3.20 FR-3 — best-effort capture of a seat's resume token at the
   * adoption boundary (reconcile / adopt / bind). Called post-tx, pre-return
   * from all three ClaimService adoption paths, precisely where an operator has
   * just re-established a live session they expect to survive the next crash.
   *
   * Derivation is REUSE-ONLY and PURE READ — no pane writes, no launch — so it
   * is consistent with reconcile's no-launch/no-input safety contract:
   *   claude-code → the status-line sidecar's session_id (a file read)
   *   codex       → the thread id derived from live pid-keyed logs
   * Persist via updateResumeToken with provenance "adoption"; the rank guard
   * governs clobber (operator/hook are never downgraded; the validity guard
   * blocks an empty write). Honest failure = persist nothing (null token = the
   * honest missing/unverified state) + a redacted skip event with a stated
   * reason. Terminal/unknown runtime is exempt (no capture, no event, not a
   * failure). ANY throw is swallowed — capture NEVER fails or blocks the
   * adoption (PRD Rule 7).
   */
  private async captureResumeTokenOnAdoption(input: {
    rigId: string; nodeId: string; sessionId: string; sessionName: string; runtime: string | null;
  }): Promise<AdoptionCaptureOutcome> {
    try {
      // Derivation is the shared PURE helper (OPR.0.4.3.04 B2 — reused by the
      // seat-handover discovered-mode capture); persistence + events stay here so
      // FR-3's adoption provenance/audit semantics are unchanged.
      const derived = await deriveResumeToken(
        { runtime: input.runtime, sessionName: input.sessionName },
        { contextUsageStore: this.contextUsageStore, claudeProcessStartedAt: this.claudeProcessStartedAt, resumeTokenCapturer: this.resumeTokenCapturer, piRunnerStateStore: this.piRunnerStateStore, ompRunnerStateStore: this.ompRunnerStateStore },
      );
      if (derived.outcome === "exempt" || derived.outcome === "noop") return { outcome: derived.outcome };
      const runtime = input.runtime as string; // non-null past exempt
      if (derived.outcome === "skipped") {
        this.emitCaptureSkip(input, runtime, derived.reason);
        // The legacy capture reason also covers an absent result before a deadline.
        return { outcome: "skipped", reason: derived.reason === "probe_timeout" ? "not_obtained" : derived.reason };
      }
      const validation = { resumeType: derived.resumeType, token: derived.token };

      // Emit "captured" ONLY when the write actually happened. If the provenance
      // guard refused it (a higher-rank hook/operator token already present —
      // e.g. a hook fired during the async probe window), the ledger is
      // correctly preserved and the event must say so, not falsely claim a
      // captured adoption write at the exact boundary FR-3 makes authoritative.
      const wrote = this.sessionRegistry.updateResumeToken(input.sessionId, validation.resumeType, validation.token, "adoption");
      try {
        this.eventBus.emit(wrote
          ? {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "captured", resumeType: validation.resumeType, provenance: "adoption", redacted: true,
            }
          : {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "preserved", resumeType: validation.resumeType, reason: "higher_rank_present", redacted: true,
            });
      } catch { /* best-effort */ }
      return { outcome: wrote ? "captured" : "preserved" };
    } catch {
      // No exception text or native token crosses the result boundary.
      return { outcome: "error", reason: "capture_failed" };
    }
  }

  private emitCaptureSkip(
    input: { rigId: string; nodeId: string; sessionId: string; sessionName: string },
    runtime: string,
    reason: "missing_sidecar" | "parse_error" | "probe_timeout" | "process_unreadable" | "invalid_token" | "stale_sidecar",
  ): void {
    try {
      this.eventBus.emit({
        type: "session.resume_token_captured",
        rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
        runtime, outcome: "skipped", reason, redacted: true,
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

    const guard = this.tmuxAdapter?.deliveryGuard;
    if (guard && !guard.ownsLifecycle(node.id)) return guard.lifecycle([node.id], () => this.bind(opts));
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

    const paneObservation = await this.observeBindingPane(
      discovered.tmuxSession,
      discovered.tmuxPane,
    );

    const bindTx = this.db.transaction(() => {
      const session = this.sessionRegistry.registerClaimedSession(node.id, discovered.tmuxSession);
      this.persistPaneBinding(
        node.id,
        discovered.tmuxSession,
        paneObservation,
        session.id,
        discovered.tmuxWindow,
      );
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
      this.tmuxAdapter?.deliveryGuard?.rebindLifecycle(nodeId);
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
      // OPR.0.4.3.20 FR-3 — capture the resume token at the adoption boundary.
      await this.captureResumeTokenOnAdoption({
        rigId: opts.rigId, nodeId, sessionId, sessionName: discovered.tmuxSession,
        runtime: node.runtime ?? discoveredRuntime ?? null,
      });

      return { ok: true, nodeId, sessionId };
    } catch (err) {
      if (err instanceof SessionAddressConflict) return { ok: false, code: "address_conflict", error: err.message };
      return { ok: false, code: "claim_error", error: (err as Error).message };
    }
  }

  /** Whether the pane's own process tree shows the node's runtime, whatever `pane_current_command` says. */
  private async runtimeProvenInPane(runtime: string, target: string): Promise<boolean> {
    if (!this.tmuxAdapter) return false;
    const input = { target, tmux: this.tmuxAdapter, listProcesses: this.listProcesses };
    try {
      if (runtime === "claude-code") return !!await verifyClaudePaneRuntime(input);
      if (runtime === "codex") return !!await verifyCodexPaneProcess(input);
    } catch { /* unproven */ }
    return false;
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
    if (opts.repairMissingPane) return this.repairMissingPane({ ...opts, sessionName });

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
    const guard = this.tmuxAdapter.deliveryGuard;
    const observedTarget = guard?.target(nodeRow.id);
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
    const paneObservation = await this.observeBindingPane(sessionName);
    if (!paneObservation.ok) projectionDrift.push(paneObservation.detail);
    const paneTarget = paneObservation.ok ? paneObservation.pane : sessionName;
    let paneCommand: string | null = null;
    try {
      paneCommand = await this.tmuxAdapter.getPaneCommand(paneTarget);
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
      } else if (expected && expected.length > 0 && !expected.includes(paneCommand)
        // #86: a native install's version label confirms claude-code only with its OS executable witness.
        && !(nodeRow.runtime === "claude-code" && await witnessedClaudeVersionLabel(paneCommand,
          { target: paneTarget, tmux: this.tmuxAdapter, listProcesses: this.listProcesses }))
        && !await this.runtimeProvenInPane(nodeRow.runtime, paneTarget)) {
        // A script-launched runtime reads as its launcher (`sh`); only a pane whose process tree shows no such runtime is drift.
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
        const session = this.sessionRegistry.registerClaimedSession(nodeRow!.id, sessionName);
        this.persistPaneBinding(nodeRow!.id, sessionName, paneObservation, session.id);
        sessionId = session.id;
        persistedEvent = this.eventBus.persistWithinTransaction({
          type: "node.reconciled",
          rigId: nodeRow!.rig_id,
          nodeId: nodeRow!.id,
          logicalId: nodeRow!.logical_id,
          sessionName,
        });
      });
      if (guard && observedTarget) guard.reconcileBinding(observedTarget, tx);
      else tx();
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
      // OPR.0.4.3.20 FR-3 — capture the resume token at the adoption boundary.
      // Pure reads only (sidecar file / pid-keyed log) — consistent with the
      // no-launch/no-input contract above; does NOT touch `continuity`
      // (FR-3 captures a token, it does not assert conversation continuity).
      const capture = await this.captureResumeTokenOnAdoption({
        rigId: nodeRow.rig_id, nodeId: nodeRow.id, sessionId, sessionName,
        runtime: nodeRow.runtime,
      });
      const expectedType = resumeTypeForRuntime(nodeRow.runtime);
      let status: ReconcileResumeMetadata["status"] = expectedType ? "unknown" : "not_applicable";
      if (expectedType) {
        try {
          const row = this.db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id=?").get(sessionId) as
            { resume_type: string | null; resume_token: string | null } | undefined;
          status = row?.resume_type === expectedType && validateResumeToken(nodeRow.runtime, row.resume_token).ok ? "recorded" : "missing";
        } catch { /* Reporting cannot turn an already committed binding into failure. */ }
      }
      const resumeMetadata: ReconcileResumeMetadata = { capture, status };
      if (status === "missing" || status === "unknown") {
        resumeMetadata.guidance = `The seat is bound, but future resume metadata is ${status === "missing" ? "missing" : "unconfirmed"}. ` +
          `After confirming the live conversation identity, pipe its verified token to rig seat set-resume-token ${shellQuote(sessionName)} --token-stdin --reason "verified live conversation". ` +
          "The token must come from stdin, never a command argument. No prior token was copied.";
      }

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
          resumeMetadata,
        },
      };
    } catch (err) {
      if (err instanceof SessionAddressConflict) return { ok: false, code: "address_conflict", message: err.message };
      return { ok: false, code: "reconcile_error", message: (err as Error).message };
    }
  }

  private async repairMissingPane(opts: ReconcileSessionOptions): Promise<ReconcileSessionOutcome> {
    const { sessionName } = opts;
    const tmux = this.tmuxAdapter, guard = tmux?.deliveryGuard;
    if (!tmux || !guard) return { ok: false, code: "reconcile_error", message: "Missing-pane repair requires the managed tmux delivery guard." };
    const deadline = performance.now() + 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refuse = (code: string, message: string): never => { throw new DeliveryGuardError(code, message); };
    try {
      const expected = guard.target(sessionName);
      const owner = this.db.prepare("SELECT rig_id FROM nodes WHERE id=?").get(expected.nodeId) as { rig_id: string } | undefined;
      const rig = owner && this.rigRepo.getRig(owner.rig_id);
      const node = rig?.nodes.find(n => n.id === expected.nodeId);
      if (!rig || !node) return refuse("node_not_found", "The current managed node no longer exists.");
      if ((opts.rigId && opts.rigId !== rig.rig.id) || (opts.logicalId && opts.logicalId !== node.logicalId)) {
        return refuse("node_mismatch", "The supplied rig/node does not match the current managed session.");
      }
      const current = () => this.db.prepare(`SELECT b.id AS bindingId, b.tmux_session AS sessionName,
        b.tmux_pane AS pane, b.attachment_type AS attachment, s.id AS sessionId,
        s.session_name AS registeredName, s.status, s.origin, n.rig_id AS rigId, n.logical_id AS logicalId
        FROM bindings b JOIN sessions s ON s.node_id=b.node_id JOIN nodes n ON n.id=b.node_id
        WHERE b.node_id=? ORDER BY s.id DESC LIMIT 1`).get(expected.nodeId) as {
          bindingId: string; sessionName: string; pane: string | null; attachment: string;
          sessionId: string; registeredName: string; status: string; origin: string;
          rigId: string; logicalId: string;
        } | undefined;
      const before = current();
      if (!before || before.attachment !== "tmux" || before.sessionName !== sessionName || before.registeredName !== sessionName
        || before.pane !== null || expected.pane !== null || expected.session !== sessionName
        || before.status !== "running" || before.origin !== "launched") {
        return refuse("repair_not_applicable", "Repair requires a current running launched session with its own NULL tmux pane binding; nothing was adopted or overwritten.");
      }
      const observe = async () => {
        const presence = await tmux.probeSession(sessionName);
        if (presence.state !== "present") return refuse(presence.state === "absent" ? "session_not_found" : "tmux_unavailable", "The managed tmux session could not be positively observed.");
        const sessions = (await tmux.listSessions()).filter(s => s.name === sessionName);
        if (sessions.length !== 1 || sessions[0]!.windows !== 1 || !sessions[0]!.created) {
          return refuse("pane_ambiguous", "Repair requires exactly one positively observed session with one window.");
        }
        const pane = await observeSolePane(tmux, sessionName);
        if (!pane.ok) return refuse(pane.code, pane.detail);
        const pid = await tmux.getPanePid(pane.pane);
        if (!Number.isInteger(pid) || pid! <= 0) return refuse("pane_missing", "The sole pane has no observable process PID.");
        return { created: sessions[0]!.created, pane: pane.pane, pid };
      };
      // ponytail: one command-local wait/commit fence. Late read-only tmux calls may finish,
      // but cannot reach the commit below; do not cancel the shared tmux control client.
      const observation = await Promise.race([
        (async () => {
          const first = await observe(), second = await observe();
          if (JSON.stringify(first) !== JSON.stringify(second)) return refuse("guard_target_changed", "The session, pane or PID changed during observation; nothing was repaired.");
          return second;
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeliveryGuardError("repair_timed_out", "Pane observation exceeded five seconds; no repair will commit.")), 5000); }),
      ]);
      this.db.transaction(() => guard.reconcileBinding(expected, () => {
        if (performance.now() >= deadline) return refuse("repair_timed_out", "The repair deadline expired before commit; nothing was repaired.");
        if (JSON.stringify(guard.maybeTarget(sessionName)) !== JSON.stringify(expected)
          || JSON.stringify(current()) !== JSON.stringify(before)) return refuse("guard_target_changed", "The current name, binding or session changed during observation; nothing was repaired.");
        const changed = this.db.prepare(`UPDATE bindings SET tmux_pane=?, updated_at=datetime('now')
          WHERE id=? AND node_id=? AND tmux_session=? AND attachment_type='tmux' AND tmux_pane IS NULL`)
          .run(observation.pane, before.bindingId, expected.nodeId, sessionName).changes;
        if (changed !== 1) return refuse("guard_target_changed", "The NULL binding changed before commit; nothing was repaired.");
      })).immediate();
      return { ok: true, result: { mode: "repair-missing-pane", pane: observation.pane,
        rigId: rig.rig.id, rigName: rig.rig.name, nodeId: node.id, logicalId: node.logicalId,
        sessionName, sessionId: before.sessionId, projectionDrift: [], continuity: "unverified" } };
    } catch (error) {
      return { ok: false, code: error instanceof DeliveryGuardError ? error.code : "reconcile_error", message: (error as Error).message };
    } finally { if (timer) clearTimeout(timer); }
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

    const paneObservation = await this.observeBindingPane(
      discovered.tmuxSession,
      discovered.tmuxPane,
    );

    const claimTx = this.db.transaction(() => {
      const node = this.rigRepo.addNode(opts.rigId, logicalId, {
        runtime: discoveredRuntime,
        cwd: discovered.cwd ?? undefined,
        podId: opts.podId,
      });

      const session = this.sessionRegistry.registerClaimedSession(node.id, discovered.tmuxSession);
      this.persistPaneBinding(
        node.id,
        discovered.tmuxSession,
        paneObservation,
        session.id,
        discovered.tmuxWindow,
      );
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
      // OPR.0.4.3.20 FR-3 — capture the resume token at the adoption boundary.
      await this.captureResumeTokenOnAdoption({
        rigId: opts.rigId, nodeId, sessionId, sessionName: discovered.tmuxSession,
        runtime: discoveredRuntime ?? null,
      });

      return { ok: true, nodeId, sessionId };
    } catch (err) {
      if (err instanceof SessionAddressConflict) return { ok: false, code: "address_conflict", error: err.message };
      return { ok: false, code: "claim_error", error: (err as Error).message };
    }
  }
}
