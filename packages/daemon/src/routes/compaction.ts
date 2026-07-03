import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { ClaudeCompactionEnforcer } from "../domain/claude-compaction-enforcer.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import type { SessionTransport } from "../domain/session-transport.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";

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
    const outcome = await enforcer.triggerManualCompact({
      sessionName,
      runtime: row.runtime,
      usedPercentage: usage.availability === "known" ? usage.usedPercentage : null,
      transcriptPath: usage.transcriptPath,
      sessionId: usage.sessionId,
    });

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
    };
    const status = (statusMap[outcome.reason] ?? 409) as 400 | 404 | 409 | 422 | 502 | 503;
    return c.json({
      ok: false,
      session: sessionName,
      stage: outcome.stage,
      reason: outcome.reason,
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
    default:
      return `Manual compaction for '${sessionName}' did not complete (${reason}).`;
  }
}
