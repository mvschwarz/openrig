// OPR.0.3.4.10 — seat attention reconciler: evidence-gated clear of stuck
// startup_status=attention_required. Managed writer + append-only audit.

import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { AgentActivity } from "./types.js";

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
}

export interface SendVerifyFn {
  (sessionName: string, text: string, opts?: { verify?: boolean }): Promise<{ ok: boolean; outcome?: string; verified?: boolean }>;
}

interface ClearAttentionDeps {
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  agentActivityStore: AgentActivityStore;
  sendVerify?: SendVerifyFn;
}

const POSITIVE_STATES = new Set(["running", "idle"]);

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

    if (session.startupStatus !== "attention_required" && session.startupStatus !== "failed") {
      return { ok: false, code: "not_in_attention", detail: `Session startup_status is '${session.startupStatus}', not attention_required/failed` };
    }

    const previousError = session.latestError ?? null;

    // Operator attestation override (--reason).
    if (opts?.reason) {
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
      return {
        ok: true,
        code: "cleared",
        from: session.startupStatus,
        to: "ready",
        clearedBy: "operator_attestation",
        reason: opts.reason,
        previousError,
      };
    }

    // Evidence-gated clear.
    const activity = agentActivityStore.getLatestForNode({
      nodeId: session.nodeId,
      sessionName,
    });

    if (activity && activity.stale !== true && POSITIVE_STATES.has(activity.state)) {
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
      eventBus.emit({
        type: "seat.attention_cleared",
        rigId: session.rigId,
        nodeId: session.nodeId,
        sessionName,
        from: session.startupStatus,
        to: "ready",
        clearedBy: "evidence",
        evidence: { kind: "fresh_activity", state: activity.state, reason: activity.reason },
        previousError,
      });
      return {
        ok: true,
        code: "cleared",
        from: session.startupStatus,
        to: "ready",
        clearedBy: "evidence",
        evidence: { kind: "fresh_activity", state: activity.state, reason: activity.reason },
        previousError,
      };
    }

    // Second evidence path: active send-verify round-trip.
    if (this.deps.sendVerify) {
      try {
        const probeText = `# OpenRig attention-clear liveness probe ${Date.now()}`;
        const sendResult = await this.deps.sendVerify(sessionName, probeText, { verify: true });
        if (sendResult.ok && (sendResult.outcome === "delivered" || sendResult.verified === true)) {
          sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
          eventBus.emit({
            type: "seat.attention_cleared",
            rigId: session.rigId,
            nodeId: session.nodeId,
            sessionName,
            from: session.startupStatus,
            to: "ready",
            clearedBy: "evidence",
            evidence: { kind: "send_verify_roundtrip", state: sendResult.outcome ?? "delivered" },
            previousError,
          });
          return {
            ok: true,
            code: "cleared",
            from: session.startupStatus,
            to: "ready",
            clearedBy: "evidence",
            evidence: { kind: "send_verify_roundtrip", state: sendResult.outcome ?? "delivered" },
            previousError,
          };
        }
        // rendered-unconfirmed without capture confirmation: could-not-confirm, NOT dead.
        // failed: transport did not land. Neither clears.
      } catch {
        // Send failed — transport error. Do not clear.
      }
    }

    return {
      ok: false,
      code: "not_demonstrably_responsive",
      detail: activity
        ? `Latest activity: state='${activity.state}', stale=${activity.stale ?? false}, reason='${activity.reason}' -- not positive evidence; send-verify also not confirmed`
        : "No recent agent activity found; send-verify also not confirmed",
    };
  }

  private findLatestSessionByName(sessionName: string): {
    id: string;
    nodeId: string;
    rigId: string;
    startupStatus: string;
    latestError: string | null;
  } | null {
    const row = this.deps.sessionRegistry.db.prepare(
      `SELECT s.id, s.node_id, n.rig_id, s.startup_status,
              (SELECT e.payload FROM events e WHERE e.node_id = s.node_id AND e.type IN ('node.startup_attention_required','node.startup_failed') ORDER BY e.seq DESC LIMIT 1) as latest_error_payload
       FROM sessions s
       JOIN nodes n ON n.id = s.node_id
       WHERE s.session_name = ?
       ORDER BY s.created_at DESC, s.id DESC LIMIT 1`
    ).get(sessionName) as {
      id: string;
      node_id: string;
      rig_id: string;
      startup_status: string;
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
      latestError,
    };
  }
}
