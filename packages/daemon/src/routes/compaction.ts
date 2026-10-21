import { physicalSessionName } from "../domain/session-registry.js";
import { Hono } from "hono";
import { shellQuote } from "../adapters/shell-quote.js";
import type Database from "better-sqlite3";
import type { ClaudeCompactionEnforcer, ManualCompactionOutcome } from "../domain/claude-compaction-enforcer.js";
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

    const body = await c.req.json<{ session?: string; skipMap?: boolean }>().catch(() => ({} as { session?: string; skipMap?: boolean }));
    if (!body.session) {
      return c.json({ ok: false, error: "Missing required field: session" }, 400);
    }
    if (body.skipMap !== undefined && typeof body.skipMap !== "boolean") return c.json({ ok: false, error: "skipMap must be boolean" }, 400);
    const sessionName = physicalSessionName(db, body.session);

    // Ambiguity / existence check — mirror /send (409 ambiguous, 404 not found).
    const resolved = await transport.resolveSessions({ session: sessionName });
    if (!resolved.ok) {
      const status = resolved.code === "ambiguous" ? 409 : 404;
      return c.json({ ok: false, error: resolved.error }, status);
    }

    // Resolve the DB node id + runtime for the latest session row.
    const row = db.prepare(`
      SELECT n.id AS node_id, n.runtime AS runtime, n.cwd AS cwd
      FROM sessions s
      JOIN nodes n ON s.node_id = n.id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(sessionName) as { node_id: string; runtime: string | null; cwd: string | null } | undefined;
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
        cwd: row.cwd,
        usedPercentage: usage.availability === "known" ? usage.usedPercentage : null,
        transcriptPath: usage.transcriptPath,
        sessionId: usage.sessionId,
      },
      // This is the OPERATOR's manual-trigger verb (bearer-auth'd); the resulting sequence is
      // drain-exempt while auto-compaction is disabled. GHOST-STAGE fix (a) actor-gate: automation
      // paths that do NOT set this are NOT exempt, so they cannot launder a drain past the gate.
      { operatorInitiated: true, skipMap: body.skipMap === true },
    );

    if (outcome.triggered) {
      return c.json({ ok: true, session: sessionName, stage: outcome.stage, compact: compactResultText("submitted_unconfirmed") });
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
      ...(outcome.preparation ? { preparation: outcome.preparation, compact: compactResultText(outcome.preparation.compact) } : {}),
      error: manualOutcomeMessage(sessionName, outcome),
    }, status);
  });

  router.post("/cancel", async (c) => {
    const enforcer = c.get("compactionEnforcer" as never) as ClaudeCompactionEnforcer | undefined;
    const transport = c.get("sessionTransport" as never) as SessionTransport | undefined;
    if (!enforcer || !transport) return c.json({ ok: false, reason: "compaction_unavailable" }, 503);
    const body = await c.req.json<{ session?: string }>().catch(() => ({} as { session?: string }));
    if (!body.session) return c.json({ ok: false, error: "Missing required field: session" }, 400);
    const resolved = await transport.resolveSessions({ session: body.session });
    if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.code === "ambiguous" ? 409 : 404);
    const preparation = enforcer.cancelPreparation(body.session);
    return c.json({ ok: true, session: body.session, preparation,
      ...(preparation ? { compact: compactResultText(preparation.compact) } : {}),
      guidance: "Managed preparation and pending restore/audit are disarmed. Cancellation sent no input. It cannot undo a submitted /compact or confirm whether it ran. No restore request follows cancellation: check the pane before retrying. If it compacted or you cannot tell, send a normal restore request naming preparation.mapPath from --state, asking it to skip reading if it did not compact; a retry would compact it again. An explicit retry still requires the live pane to be idle.",
    });
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
    const preparation = enforcer.getPreparationState(session);
    return c.json({ ok: true, session, state: enforcer.getManualCompactionState(session), preparation,
      ...(preparation ? { compact: compactResultText(preparation.compact) } : {}),
      ...(preparation?.reason === "occupant_generation_unavailable"
        ? { guidance: manualReasonMessage(session, preparation.reason) } : {}),
    });
  });

  return router;
}

function manualOutcomeMessage(sessionName: string, outcome: Extract<ManualCompactionOutcome, { triggered: false }>): string {
  const prep = outcome.preparation;
  if (!prep || prep.delivery === "not_sent") return manualReasonMessage(sessionName, outcome.reason);
  const effect = prep.delivery === "delivered" ? "Preparation was sent" : "Preparation may have reached the seat (delivery is unconfirmed)";
  const detail = outcome.reason === "preparation_incomplete"
    ? manualReasonMessage(sessionName, outcome.reason)
    : `/compact was not confirmed (${outcome.reason}). This attempt is disarmed.`;
  return `${effect} for '${sessionName}' (attempt ${prep.attemptId}). ${detail} Its map remains at ${prep.mapPath} if written. Inspect rig compact ${shellQuote(sessionName)} --state before an explicit retry.`;
}

/** The /compact command's result in words. `preparation.delivery` is the preparation prompt's delivery;
 *  this is the command's, and it never claims that compaction ran. */
export function compactResultText(compact: "not_sent" | "submitted_unconfirmed" | "uncertain"): string {
  switch (compact) {
    case "submitted_unconfirmed": return "submitted, unconfirmed: OpenRig sent /compact and Enter to the seat; it does not check whether Claude Code then started compacting.";
    case "uncertain": return "uncertain: /compact may have reached the seat, possibly as text left in its input box without Enter; it was not retried.";
    default: return "not sent: OpenRig has not sent /compact for this attempt.";
  }
}

function manualReasonMessage(sessionName: string, reason: string): string {
  switch (reason) {
    case "occupant_generation_unavailable":
      return `The occupant generation could not be resolved for '${sessionName}'; no preparation or compact was sent. For the confirmed live seat, run rig reconcile-session ${shellQuote(sessionName)} --no-launch, then explicitly retry rig compact ${shellQuote(sessionName)}. Reconciliation does not restart this attempt.`;
    case "preparation_incomplete":
      return `Preparation (restore map and idle wait) did not finish in time for '${sessionName}'; managed compaction is disarmed. Inspect rig compact ${sessionName} --state, retry explicitly, or use --skip-map once.`;
    case "pane_unknown_protected":
      return `Refused: '${sessionName}' uses draft-aware input protection, and its tmux pane is not recorded. Input to a protected seat needs a known pane, so no preparation or /compact was sent. Both fixes refuse while protection is on, so with the person's agreement turn it off first (rig seat set-typing-guard ${shellQuote(sessionName)} --mode off --reason "<why>") and back on afterwards (--mode draft-aware). To keep the session and resume token, run rig reconcile-session ${shellQuote(sessionName)} --repair-missing-pane --no-launch. Otherwise rig reconcile-session ${shellQuote(sessionName)} --no-launch adopts: a new session row (any running row for the seat is superseded); it re-captures the resume token if it can, and conversation continuity stays unverified. Then explicitly retry rig compact ${shellQuote(sessionName)}; reconciliation does not restart this attempt. If the intended pane cannot be resolved, use rig context get help for operator recovery.`;
    case "preparation_cancelled":
      return `Preparation for '${sessionName}' was cancelled; no further compact is armed.`;
    case "disabled":
      return `Preparation for '${sessionName}' ended when the policy was disabled; enabling it does not revive that attempt.`;
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
