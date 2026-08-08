import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { ClaudeCompactionEnforcer } from "../domain/claude-compaction-enforcer.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import type { SessionTransport } from "../domain/session-transport.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import {
  AUTHORIZABLE_COMPACTION_REASONS,
  CLAUDE_COMPACTION_ENFORCER_KIND,
  type EnforcerDecisionStore,
} from "../domain/enforcer-decision-store.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { requireSenderIdentity } from "./require-sender-identity.js";

/**
 * OPR.0.4.3.14 — manual configurable compaction trigger route.
 *
 * POST /api/compaction/trigger { session } drives the SAME guided compaction
 * lifecycle the auto-policy runs, on demand, for one Claude seat. Mirrors the
 * /api/transport/send auth + resolveSessions ambiguity/404/409 pattern.
 *
 * The route resolves the target to a node + runtime and reads the EXISTING
 * context-usage projection BEFORE triggering — it never invents usage values.
 * The enforcer owns the reject reasons (non-Claude / no-usage) so there is one
 * source of truth for the guided-sequence contract.
 */
export function compactionRoutes(opts?: { bearerToken?: string | null }): Hono {
  const router = new Hono();
  router.use("*", authBearerTokenMiddleware({ expectedToken: opts?.bearerToken ?? null }));

  router.post("/control", async (c) => {
    const identity = requireSenderIdentity(c, { verb: "compaction control create" });
    if (!identity.ok) return identity.response;
    const store = c.get("enforcerDecisionStore" as never) as EnforcerDecisionStore | undefined;
    const sessionRegistry = c.get("sessionRegistry" as never) as SessionRegistry | undefined;
    if (!store || !sessionRegistry) {
      return c.json({ ok: false, error: "compaction_control_unavailable" }, 503);
    }

    type ControlBody = {
      session?: string;
      direction?: string;
      automaticReason?: string;
      reason?: string;
    };
    const body = await c.req.json<ControlBody>().catch((): ControlBody => ({}));
    const sessionName = body.session?.trim();
    if (!sessionName) return c.json({ ok: false, error: "session_required" }, 400);
    const reason = body.reason?.trim();
    if (!reason) return c.json({ ok: false, error: "reason_required" }, 400);
    if (body.direction !== "hold" && body.direction !== "authorize") {
      return c.json({ ok: false, error: "direction_invalid" }, 400);
    }

    let automaticReason: string | null = null;
    if (body.direction === "authorize") {
      automaticReason = body.automaticReason?.trim() ?? "";
      if (!automaticReason) {
        return c.json({ ok: false, error: "automatic_reason_required" }, 400);
      }
      if (!(AUTHORIZABLE_COMPACTION_REASONS as readonly string[]).includes(automaticReason)) {
        return c.json({ ok: false, error: "automatic_reason_not_authorizable" }, 400);
      }
    }

    const currentSession = sessionRegistry.db.prepare(`
      WITH target AS (
        SELECT node_id
        FROM sessions
        WHERE session_name = ?
        ORDER BY id DESC
        LIMIT 1
      )
      SELECT session_name
      FROM sessions
      WHERE node_id = (SELECT node_id FROM target)
      ORDER BY id DESC
      LIMIT 1
    `).get(sessionName) as { session_name: string } | undefined;
    if (currentSession && currentSession.session_name !== sessionName) {
      return c.json({
        ok: false,
        error: "session_not_current",
        currentSession: currentSession.session_name,
      }, 409);
    }

    const generationUuid = sessionRegistry.currentOccupantGenerationForSession(sessionName);
    if (!generationUuid) {
      return c.json({ ok: false, error: "generation_unavailable" }, 409);
    }

    try {
      const decision = store.create({
        enforcerKind: CLAUDE_COMPACTION_ENFORCER_KIND,
        sessionName,
        generationUuid,
        direction: body.direction,
        automaticReason,
        reason,
        actorSession: identity.session,
        identityProvenance: "transport:v1",
      });
      return c.json({ ok: true, decision }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /active hold|already exists/i.test(message) ? 409 : 400;
      return c.json({ ok: false, error: "decision_rejected", message }, status as 400 | 409);
    }
  });

  router.get("/control", (c) => {
    const store = c.get("enforcerDecisionStore" as never) as EnforcerDecisionStore | undefined;
    if (!store) return c.json({ ok: false, error: "compaction_control_unavailable" }, 503);
    const sessionName = c.req.query("session")?.trim();
    return c.json({
      ok: true,
      decisions: store.list(sessionName ? { sessionName } : {}),
    });
  });

  router.post("/control/:decisionId/clear", async (c) => {
    const identity = requireSenderIdentity(c, { verb: "compaction control clear" });
    if (!identity.ok) return identity.response;
    const store = c.get("enforcerDecisionStore" as never) as EnforcerDecisionStore | undefined;
    if (!store) return c.json({ ok: false, error: "compaction_control_unavailable" }, 503);
    type ClearBody = { reason?: string };
    const body = await c.req.json<ClearBody>().catch((): ClearBody => ({}));
    const reason = body.reason?.trim();
    if (!reason) return c.json({ ok: false, error: "reason_required" }, 400);
    try {
      const decision = store.clear({
        decisionId: c.req.param("decisionId"),
        actorSession: identity.session,
        identityProvenance: "transport:v1",
        reason,
      });
      return c.json({ ok: true, decision });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: "decision_not_active", message }, 404);
    }
  });

  router.post("/trigger", async (c) => {
    const enforcer = c.get("compactionEnforcer" as never) as ClaudeCompactionEnforcer | undefined;
    const transport = c.get("sessionTransport" as never) as SessionTransport | undefined;
    const usageStore = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
    const db = c.get("db" as never) as Database.Database | undefined;

    if (!enforcer || !transport || !usageStore || !db) {
      return c.json({
        ok: false,
        reason: "compaction_unavailable",
        error: "Manual compaction is not available on this daemon (enforcer/transport/context-usage not wired).",
      }, 503);
    }

    const body = await c.req.json<{ session?: string }>().catch(() => ({} as { session?: string }));
    if (!body.session) {
      return c.json({ ok: false, error: "Missing required field: session" }, 400);
    }
    const sessionName = body.session;

    // Ambiguity / existence check — mirror /send (409 ambiguous, 404 not found).
    const resolved = await transport.resolveSessions({ session: sessionName });
    if (!resolved.ok) {
      const status = resolved.code === "ambiguous" ? 409 : 404;
      return c.json({ ok: false, error: resolved.error }, status);
    }

    // Resolve the DB node id + runtime for the latest session row.
    const row = db.prepare(`
      SELECT n.id AS node_id, n.runtime AS runtime
      FROM sessions s
      JOIN nodes n ON s.node_id = n.id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(sessionName) as { node_id: string; runtime: string | null } | undefined;
    if (!row) {
      return c.json({
        ok: false,
        reason: "session_missing",
        error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      }, 404);
    }

    // Read the KNOWN context-usage projection BEFORE triggering. When usage is
    // absent / stale / unknown we pass null (never invent a value); the enforcer
    // returns an honest `no_usage_data` reason for a Claude seat.
    const usage = usageStore.getForNode(row.node_id, sessionName);
    const outcome = await enforcer.triggerManualCompact(
      {
        sessionName,
        runtime: row.runtime,
        usedPercentage: usage.availability === "known" ? usage.usedPercentage : null,
        transcriptPath: usage.transcriptPath,
        sessionId: usage.sessionId,
      },
      // This is the OPERATOR's manual-trigger verb (bearer-auth'd); the resulting sequence is
      // drain-exempt while auto-compaction is disabled. GHOST-STAGE fix (a) actor-gate: automation
      // paths that do NOT set this are NOT exempt, so they cannot launder a drain past the gate.
      { operatorInitiated: true },
    );

    if (outcome.triggered) {
      return c.json({ ok: true, session: sessionName, stage: outcome.stage });
    }

    const statusMap: Record<string, number> = {
      runtime_filter: 422,
      no_usage_data: 409,
      mid_work: 409,
      target_needs_input: 409,
      target_activity_unknown: 409,
      wait_for_idle_timeout: 409,
      transport_unavailable: 409,
      invalid_wait_for_idle: 400,
      session_missing: 404,
      tmux_unavailable: 503,
      send_failed: 502,
      submit_failed: 502,
      human_hold: 409,
    };
    const status = (statusMap[outcome.reason] ?? 409) as 400 | 404 | 409 | 422 | 502 | 503;
    return c.json({
      ok: false,
      session: sessionName,
      stage: outcome.stage,
      reason: outcome.reason,
      ...(outcome.decisionId ? { decisionId: outcome.decisionId } : {}),
      error: manualReasonMessage(sessionName, outcome.reason),
    }, status);
  });

  router.get("/state", (c) => {
    const enforcer = c.get("compactionEnforcer" as never) as ClaudeCompactionEnforcer | undefined;
    if (!enforcer) {
      return c.json({ ok: false, reason: "compaction_unavailable" }, 503);
    }
    const session = c.req.query("session");
    if (!session) {
      return c.json({ ok: false, error: "Missing required query param: session" }, 400);
    }
    return c.json({ ok: true, session, state: enforcer.getManualCompactionState(session) });
  });

  return router;
}

function manualReasonMessage(sessionName: string, reason: string): string {
  switch (reason) {
    case "runtime_filter":
      return `Refused: '${sessionName}' is not a Claude (claude-code) seat. Manual compaction runs the Claude guided lifecycle only.`;
    case "no_usage_data":
      return `Refused: no known context-usage sample for '${sessionName}' yet; not triggering blind. Retry once telemetry is fresh.`;
    case "mid_work":
      return `Refused: '${sessionName}' appears mid-task; the pre-compact prep could not be sent. Wait for it to settle and retry.`;
    case "target_needs_input":
      return `Refused: '${sessionName}' is at an interactive prompt; the pre-compact prep could not be sent safely.`;
    case "target_activity_unknown":
      return `Refused: '${sessionName}' activity could not be determined; failing closed so /compact cannot land on a prompt.`;
    case "wait_for_idle_timeout":
      return `Prep was sent to '${sessionName}' but it did not go idle in time, so /compact was NOT sent. Retry once the prep turn completes.`;
    case "human_hold":
      return `Refused: '${sessionName}' has an active human compaction hold.`;
    default:
      return `Manual compaction for '${sessionName}' did not complete (${reason}).`;
  }
}
