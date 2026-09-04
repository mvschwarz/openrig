// OPR.0.3.4.10 — seat attention reconciler: evidence-gated clear of stuck
// startup_status=attention_required. Managed writer + append-only audit.

import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { AgentActivity, SeatIdentityVerdict } from "./types.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { classifyPaneRuntimeMatch } from "./seat-identity-reconciler.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { defaultListProcesses } from "./resume-metadata-refresher.js";
import { findExactNativeResumeProcess } from "./native-process-lineage.js";

type PaneIdentityTmux = Pick<TmuxAdapter, "listPanes" | "getPanePid" | "getPaneCommand">;
type ProcessRow = { pid: number; ppid: number; command: string };

export type PaneIdentityReconcileResult =
  | { ok: true; pane: string; pid: number; command: string | null }
  | { ok: false; detail: string };

/** Rebind one managed seat to the sole pane currently in its named tmux
 * session and positively identify its declared agent runtime. */
export async function rebindAndVerifyPaneIdentity(input: {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  tmux: PaneIdentityTmux;
  nodeId: string;
  sessionName: string;
  runtime: string | null;
  expectedResumeToken?: string | null;
  requireExactResumeLineage?: boolean;
  listProcesses?: () => Promise<ProcessRow[]>;
  now?: () => Date;
}): Promise<PaneIdentityReconcileResult> {
  const observedAt = (input.now ?? (() => new Date()))().toISOString();
  const identityStore = new SeatIdentityStore(input.db);
  let panes: Awaited<ReturnType<PaneIdentityTmux["listPanes"]>>;
  try {
    panes = await input.tmux.listPanes(input.sessionName);
  } catch (error) {
    return { ok: false, detail: `tmux pane lookup failed: ${(error as Error).message}` };
  }
  if (panes.length !== 1) {
    const registeredPane = input.sessionRegistry.getBindingForNode(input.nodeId)?.tmuxPane ?? null;
    identityStore.upsert({
      nodeId: input.nodeId,
      verdict: panes.length === 0 ? "pane_missing" : "mismatch",
      evidenceSource: "tmux_session",
      reason: panes.length === 0 ? "session_missing" : "pane_ambiguous",
      evidence: { registeredPane, observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: input.sessionName,
      observedAt,
    });
    return {
      ok: false,
      detail: panes.length === 0
        ? `tmux session '${input.sessionName}' has no attachable pane`
        : `tmux session '${input.sessionName}' has ${panes.length} panes; exact seat pane is ambiguous`,
    };
  }

  const pane = panes[0]!;
  let pid: number | null;
  let command: string | null;
  try {
    pid = await input.tmux.getPanePid(pane.id);
    command = await input.tmux.getPaneCommand(pane.id);
  } catch (error) {
    return { ok: false, detail: `tmux pane identity lookup failed: ${(error as Error).message}` };
  }
  const runtimeMatch = classifyPaneRuntimeMatch(command, input.runtime);
  const normalizedCommand = command?.trim().toLowerCase() ?? "";
  let lineageMatch: ProcessRow | null = null;
  const expectedResumeToken = input.expectedResumeToken ?? null;
  const strictNativeLineage = input.requireExactResumeLineage === true
    && expectedResumeToken !== null
    && (input.runtime === "claude-code" || input.runtime === "codex");
  if (pid !== null && runtimeMatch === "match" && strictNativeLineage) {
    try {
      lineageMatch = findExactNativeResumeProcess(
        await (input.listProcesses ?? defaultListProcesses)(),
        pid,
        input.runtime,
        expectedResumeToken!,
      );
    } catch {
      // Missing process evidence is ambiguity, never positive identity.
    }
  }
  const runtimeAmbiguous = runtimeMatch === "match" && (strictNativeLineage
    ? lineageMatch === null
    : (input.runtime === "claude-code" && !normalizedCommand.includes("claude"))
      || (input.runtime === "codex" && !normalizedCommand.includes("codex")));
  const verdict: SeatIdentityVerdict = {
    nodeId: input.nodeId,
    verdict: pid === null
      ? "pane_missing"
      : runtimeMatch === "mismatch" || runtimeAmbiguous
        ? "mismatch"
        : "verified",
    evidenceSource: "pane_process",
    reason: pid === null
      ? "pane_pid_gone"
      : runtimeMatch === "mismatch"
        ? "process_identity_mismatch"
        : runtimeAmbiguous
          ? "process_identity_ambiguous"
        : null,
    evidence: {
      registeredPane: pane.id,
      observedPid: lineageMatch?.pid ?? pid,
      observedCommand: lineageMatch?.command ?? command,
      matchedLayer: pid === null || runtimeAmbiguous ? null : 1,
    },
    sessionName: input.sessionName,
    observedAt,
  };

  // Persist the replacement pane before the verdict so both records describe
  // the same current binding. A non-green verdict remains applicable and
  // therefore keeps the public topology in attention_required.
  input.sessionRegistry.updateBinding(input.nodeId, {
    tmuxSession: input.sessionName,
    tmuxPane: pane.id,
  });
  identityStore.upsert(verdict);

  if (verdict.verdict === "pane_missing") {
    return { ok: false, detail: `tmux pane '${pane.id}' has no live process` };
  }
  if (verdict.verdict === "mismatch") {
    if (runtimeAmbiguous) {
      return {
        ok: false,
        detail: `tmux pane '${pane.id}' foreground command '${command ?? "unknown"}' does not positively identify runtime '${input.runtime}'`,
      };
    }
    return {
      ok: false,
      detail: `tmux pane '${pane.id}' foreground command '${command ?? "unknown"}' contradicts runtime '${input.runtime ?? "unknown"}'`,
    };
  }
  return { ok: true, pane: pane.id, pid: pid!, command };
}

export interface ClearAttentionResult {
  ok: boolean;
  code?: "not_in_attention" | "not_demonstrably_responsive" | "cleared";
  from?: string;
  to?: string;
  clearedBy?: "evidence" | "operator_attestation";
  evidence?: { kind: string; state?: string; reason?: string };
  reason?: string;
  detail?: string;
  previousError?: string | null;
  clearedClasses?: ("startup_status" | "restore_outcome" | "pane_identity")[];
  derivedEvidence?: {
    source: string;
    kind?: string;
    state?: string;
    reason?: string;
    runtimeCwdVerified?: boolean;
    attemptId?: number;
    tmux?: boolean;
    fgProcess?: string;
    resumeTokenUsed?: boolean;
    paneState?: "usable";
  };
}

export interface SendVerifyFn {
  (sessionName: string, text: string, opts?: { verify?: boolean }): Promise<{ ok: boolean; outcome?: string; verified?: boolean }>;
}

export interface CaptureFn {
  (sessionName: string, opts?: { lines?: number }): Promise<{ ok: boolean; sessionName: string; content?: string; error?: string }>;
}

interface ClearAttentionDeps {
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  agentActivityStore: AgentActivityStore;
  sendVerify?: SendVerifyFn;
  capture?: CaptureFn;
  db?: Database.Database;
  tmux?: PaneIdentityTmux;
  reconcileRestoreOutcome?: (rigId: string, nodeId: string) => Promise<
    | {
        ok: true;
        attemptId: number;
        from: "failed" | "attention_required";
        to: "operator_recovered";
        evidence: { tmux: boolean; fgProcess: string; resumeTokenUsed: boolean; paneState: "usable" };
      }
    | { ok: false; code: string; detail: string }
  >;
}

const POSITIVE_STATES = new Set(["running", "idle"]);
type DerivedAttentionOutcome = {
  status: "failed" | "attention_required";
  source: "restore.completed" | "restore.subset_completed";
};

export class SeatAttentionReconciler {
  private deps: ClearAttentionDeps;

  constructor(deps: ClearAttentionDeps) {
    this.deps = deps;
  }

  async clearAttention(
    sessionName: string,
    opts?: { reason?: string },
  ): Promise<ClearAttentionResult> {
    const { sessionRegistry, eventBus, agentActivityStore } = this.deps;

    // Resolve session -> node + current startup_status.
    const session = this.findLatestSessionByName(sessionName);
    if (!session) {
      return { ok: false, code: "not_in_attention", detail: `Session '${sessionName}' not found` };
    }

    const startupClassActive = session.startupStatus === "attention_required" || session.startupStatus === "failed";
    const derivedOutcome = this.getDerivedAttentionOutcome(session);
    const identityClassActive = this.getActiveIdentityVerdict(session, sessionName);

    if (!startupClassActive && !derivedOutcome && !identityClassActive) {
      return { ok: false, code: "not_in_attention", detail: `Session startup_status is '${session.startupStatus}', restoreOutcome is not attention/failed, and pane identity is not mismatched/missing — not in attention` };
    }

    const previousError = session.latestError ?? null;

    // Full-restore outcomes belong to one immutable attempt. Generic activity,
    // send verification, and operator attestation cannot prove that lineage;
    // delegate to the restore owner that checks the exact native resume token
    // and appends the attempt-scoped reconciliation event. Subset restores do
    // not have a restore.started receipt and retain their established path.
    if (derivedOutcome?.source === "restore.completed") {
      const reconcile = this.deps.reconcileRestoreOutcome;
      if (!reconcile) {
        return {
          ok: false,
          code: "not_demonstrably_responsive",
          detail: "Uncleared attention class restore_outcome: strict restore reconciler is unavailable",
        };
      }
      const restored = await reconcile(session.rigId, session.nodeId);
      if (!restored.ok) {
        return {
          ok: false,
          code: "not_demonstrably_responsive",
          detail: `Uncleared attention class restore_outcome: ${restored.code}: ${restored.detail}`,
        };
      }

      const evidence = { kind: "strict_restore_runtime_truth", state: "operator_recovered" };
      const clearedClasses: ("startup_status" | "restore_outcome" | "pane_identity")[] = ["restore_outcome"];
      if (identityClassActive) clearedClasses.push("pane_identity");
      if (startupClassActive) {
        sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
        eventBus.emit({
          type: "seat.attention_cleared",
          rigId: session.rigId,
          nodeId: session.nodeId,
          sessionName,
          from: session.startupStatus,
          to: "ready",
          clearedBy: "evidence",
          evidence,
          previousError,
        });
        clearedClasses.push("startup_status");
      }
      return {
        ok: true,
        code: "cleared",
        from: session.startupStatus,
        to: "ready",
        clearedBy: "evidence",
        evidence,
        previousError,
        clearedClasses,
        derivedEvidence: {
          source: "restore_runtime_truth",
          attemptId: restored.attemptId,
          ...restored.evidence,
        },
      };
    }

    // A pane-identity class can be cleared only by re-resolving the current
    // session to one concrete live pane. The same proof is strong enough to
    // clear any coexisting historical startup/restore attention class.
    if (identityClassActive) {
      if (!this.deps.db || !this.deps.tmux) {
        return {
          ok: false,
          code: "not_demonstrably_responsive",
          detail: "Uncleared attention class pane_identity: tmux identity verifier is unavailable",
        };
      }
      const identity = await rebindAndVerifyPaneIdentity({
        db: this.deps.db,
        sessionRegistry,
        tmux: this.deps.tmux,
        nodeId: session.nodeId,
        sessionName,
        runtime: session.runtime,
      });
      if (!identity.ok) {
        return {
          ok: false,
          code: "not_demonstrably_responsive",
          detail: `Uncleared attention class pane_identity: ${identity.detail}`,
        };
      }
      return this.performEvidenceClear(
        session,
        sessionName,
        startupClassActive,
        derivedOutcome?.source === "restore.subset_completed" ? derivedOutcome.status : null,
        { kind: "pane_identity_reverified", state: identity.pane },
        previousError,
        true,
      );
    }

    // Operator attestation override (--reason).
    if (opts?.reason) {
      const clearedClasses: ("startup_status" | "restore_outcome" | "pane_identity")[] = [];
      if (startupClassActive) {
        sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
        eventBus.emit({
          type: "seat.attention_cleared",
          rigId: session.rigId,
          nodeId: session.nodeId,
          sessionName,
          from: session.startupStatus,
          to: "ready",
          clearedBy: "operator_attestation",
          reason: opts.reason,
          previousError,
        });
        clearedClasses.push("startup_status");
      }
      if (derivedOutcome?.source === "restore.subset_completed") {
        eventBus.emit({
          type: "restore.outcome_reconciled",
          rigId: session.rigId,
          nodeId: session.nodeId,
          attemptId: 0,
          from: derivedOutcome.status,
          to: "operator_recovered",
          evidence: { source: "operator_attestation", reason: opts.reason, runtimeCwdVerified: false },
        });
        clearedClasses.push("restore_outcome");
      }
      return {
        ok: true,
        code: "cleared",
        from: session.startupStatus,
        to: "ready",
        clearedBy: "operator_attestation",
        reason: opts.reason,
        previousError,
        clearedClasses,
        derivedEvidence: derivedOutcome?.source === "restore.subset_completed"
          ? { source: "operator_attestation", reason: opts.reason, runtimeCwdVerified: false }
          : undefined,
      };
    }

    // Evidence-gated clear.
    const activity = agentActivityStore.getLatestForNode({
      nodeId: session.nodeId,
      sessionName,
    });

    if (activity && activity.stale !== true && POSITIVE_STATES.has(activity.state)) {
      const evidence = { kind: "fresh_activity", state: activity.state, reason: activity.reason };
      return this.performEvidenceClear(
        session,
        sessionName,
        startupClassActive,
        derivedOutcome?.source === "restore.subset_completed" ? derivedOutcome.status : null,
        evidence,
        previousError,
      );
    }

    // Second evidence path: active send-verify round-trip.
    if (this.deps.sendVerify) {
      try {
        const probeText = `# OpenRig attention-clear liveness probe ${Date.now()}`;
        const sendResult = await this.deps.sendVerify(sessionName, probeText, { verify: true });
        if (sendResult.ok && (sendResult.outcome === "delivered" || sendResult.verified === true)) {
          const evidence = { kind: "send_verify_roundtrip", state: sendResult.outcome ?? "delivered" };
          return this.performEvidenceClear(
            session,
            sessionName,
            startupClassActive,
            derivedOutcome?.source === "restore.subset_completed" ? derivedOutcome.status : null,
            evidence,
            previousError,
          );
        }

        if (sendResult.ok && sendResult.outcome === "rendered-unconfirmed" && this.deps.capture) {
          try {
            const captureResult = await this.deps.capture(sessionName, { lines: 50 });
            if (captureResult.ok && captureResult.content && captureResult.content.includes(probeText)) {
              const evidence = { kind: "send_verify_capture_confirmed", state: "rendered-unconfirmed" };
              return this.performEvidenceClear(
                session,
                sessionName,
                startupClassActive,
                derivedOutcome?.source === "restore.subset_completed" ? derivedOutcome.status : null,
                evidence,
                previousError,
              );
            }
          } catch { /* Capture failed */ }
        }
      } catch { /* Send failed */ }
    }

    return {
      ok: false,
      code: "not_demonstrably_responsive",
      detail: activity
        ? `Latest activity: state='${activity.state}', stale=${activity.stale ?? false}, reason='${activity.reason}' -- not positive evidence; send-verify also not confirmed`
        : "No recent agent activity found; send-verify also not confirmed",
    };
  }

  private performEvidenceClear(
    session: { id: string; nodeId: string; rigId: string; startupStatus: string },
    sessionName: string,
    startupClassActive: boolean,
    subsetOutcome: "failed" | "attention_required" | null,
    evidence: { kind: string; state?: string; reason?: string },
    previousError: string | null,
    identityClassCleared = false,
  ): ClearAttentionResult {
    const { sessionRegistry, eventBus } = this.deps;
    const clearedClasses: ("startup_status" | "restore_outcome" | "pane_identity")[] = [];

    if (identityClassCleared) clearedClasses.push("pane_identity");

    if (startupClassActive) {
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
      eventBus.emit({
        type: "seat.attention_cleared",
        rigId: session.rigId,
        nodeId: session.nodeId,
        sessionName,
        from: session.startupStatus,
        to: "ready",
        clearedBy: "evidence",
        evidence,
        previousError,
      });
      clearedClasses.push("startup_status");
    }

    if (subsetOutcome) {
      eventBus.emit({
        type: "restore.outcome_reconciled",
        rigId: session.rigId,
        nodeId: session.nodeId,
        attemptId: 0,
        from: subsetOutcome,
        to: "operator_recovered",
        evidence: { source: "clear_attention_evidence", kind: evidence.kind, state: evidence.state, runtimeCwdVerified: false },
      });
      clearedClasses.push("restore_outcome");
    }

    return {
      ok: true,
      code: "cleared",
      from: session.startupStatus,
      to: "ready",
      clearedBy: "evidence",
      evidence,
      previousError,
      clearedClasses,
      derivedEvidence: subsetOutcome
        ? { source: "clear_attention_evidence", kind: evidence.kind, state: evidence.state, runtimeCwdVerified: false }
        : undefined,
    };
  }

  private findLatestSessionByName(sessionName: string): {
    id: string;
    nodeId: string;
    rigId: string;
    startupStatus: string;
    sessionStatus: string;
    runtime: string | null;
    bindingPane: string | null;
    latestError: string | null;
  } | null {
    const row = this.deps.sessionRegistry.db.prepare(
      `SELECT s.id, s.node_id, n.rig_id, n.runtime, b.tmux_pane, s.startup_status, s.status,
              (SELECT e.payload FROM events e WHERE e.node_id = s.node_id AND e.type IN ('node.startup_attention_required','node.startup_failed') ORDER BY e.seq DESC LIMIT 1) as latest_error_payload
       FROM sessions s
       JOIN nodes n ON n.id = s.node_id
       LEFT JOIN bindings b ON b.node_id = s.node_id
       WHERE s.session_name = ?
       ORDER BY s.created_at DESC, s.id DESC LIMIT 1`
    ).get(sessionName) as {
      id: string;
      node_id: string;
      rig_id: string;
      startup_status: string;
      status: string;
      runtime: string | null;
      tmux_pane: string | null;
      latest_error_payload: string | null;
    } | undefined;

    if (!row) return null;

    let latestError: string | null = null;
    if (row.latest_error_payload) {
      try {
        const parsed = JSON.parse(row.latest_error_payload);
        latestError = parsed.error ?? parsed.message ?? row.latest_error_payload;
      } catch {
        latestError = row.latest_error_payload;
      }
    }

    return {
      id: row.id,
      nodeId: row.node_id,
      rigId: row.rig_id,
      startupStatus: row.startup_status ?? "pending",
      sessionStatus: row.status ?? "unknown",
      runtime: row.runtime,
      bindingPane: row.tmux_pane,
      latestError,
    };
  }

  private getActiveIdentityVerdict(session: {
    nodeId: string;
    sessionStatus: string;
    bindingPane: string | null;
  }, sessionName: string): SeatIdentityVerdict | null {
    if (!this.deps.db || session.sessionStatus !== "running") return null;
    const verdict = new SeatIdentityStore(this.deps.db).getForNode(session.nodeId);
    if (!verdict) return null;
    if (verdict.sessionName !== sessionName) return null;
    if (verdict.evidence.registeredPane !== session.bindingPane) return null;
    return verdict.verdict === "mismatch" || verdict.verdict === "pane_missing" ? verdict : null;
  }

  private getDerivedAttentionOutcome(session: { nodeId: string; rigId: string; sessionStatus: string }): DerivedAttentionOutcome | null {
    if (!this.deps.db) return null;

    const rows = this.deps.db.prepare(
      "SELECT type, payload FROM events WHERE rig_id = ? AND type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled') ORDER BY seq DESC"
    ).all(session.rigId) as { type: string; payload: string }[];

    for (const row of rows) {
      try {
        if (row.type === "restore.outcome_reconciled") {
          const ev = JSON.parse(row.payload) as { nodeId: string; to: "operator_recovered" };
          if (ev.nodeId !== session.nodeId) continue;
          return null;
        }
        const ev = JSON.parse(row.payload) as { result: { nodes: Array<{ nodeId: string; status: string }> } };
        const n = ev.result.nodes.find((nd) => nd.nodeId === session.nodeId);
        if (!n) continue;
        // Mirror deriveNodeLifecycleState: attention_required regardless of
        // sessionStatus; failed only when sessionStatus=running.
        const source = row.type as DerivedAttentionOutcome["source"];
        if (n.status === "attention_required") return { status: "attention_required", source };
        if (n.status === "failed" && session.sessionStatus === "running") return { status: "failed", source };
        return null;
      } catch { continue; }
    }
    return null;
  }
}
