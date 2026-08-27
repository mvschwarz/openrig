import { Hono } from "hono";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { EventBus } from "../domain/event-bus.js";
import { verifyStartupProof } from "../domain/startup-proof.js";
import type { ActivityEvidence } from "../domain/activity-taxonomy.js";
import type { AgentActivity } from "../domain/types.js";
import * as parkedQuery from "../domain/parked-query.js";
import { runtimeRungInventory } from "../domain/activity-taxonomy.js";

// ── S19 A4 — the ingest half of the adapter seam: hook events reach the ONE oracle ──
// (SeatActivityService) through this translation, so AgentActivityStore is reduced to a
// raw-event consumer/recorder and arbitration happens in exactly one place. The store's
// ALREADY-NORMALIZED state is the input (one event-name parser, no twin).

/** Translate a recorded hook activity into oracle evidence. Returns null for states the
 *  oracle should not consume (unknown = noise, never evidence). needs_input becomes
 *  COUNT+reason on the hooks rung — never an activity value (the taxonomy's binding
 *  exclusion); the turn's working/idle stays whatever other evidence says. */
export function evidenceFromHookActivity(input: {
  seatNodeId: string;
  sessionName: string;
  runtime: string | null;
  activity: AgentActivity;
  seq: number;
}): ActivityEvidence | null {
  const base = {
    seatNodeId: input.seatNodeId,
    sessionName: input.sessionName,
    rung: "lifecycle-hooks" as const,
    sourceId: `${input.runtime ?? "unknown-runtime"}:hooks`,
    seq: input.seq,
    observedAt: input.activity.eventAt ?? input.activity.sampledAt,
  };
  switch (input.activity.state) {
    case "running":
      return { ...base, activity: "working", needsInput: { count: 0, reason: null } };
    case "idle":
      return { ...base, activity: "idle-at-prompt", needsInput: { count: 0, reason: null } };
    case "needs_input":
      return { ...base, needsInput: { count: 1, reason: input.activity.reason || "needs input" } };
    default:
      return null; // unknown = noise, never evidence
  }
}

// Per-source monotonic seq for ingested hook evidence (the relay does not mint one).
const hookEvidenceSeq = new Map<string, number>();
function nextHookSeq(key: string): number {
  const next = (hookEvidenceSeq.get(key) ?? 0) + 1;
  hookEvidenceSeq.set(key, next);
  return next;
}

export const activityRoutes = new Hono();

activityRoutes.post("/hooks", async (c) => {
  const store = c.get("agentActivityStore" as never) as AgentActivityStore | undefined;
  const expectedToken = c.get("activityHookToken" as never) as string | undefined;

  if (!store || !expectedToken) {
    return c.json({
      ok: false,
      code: "activity_hook_unconfigured",
      error: "Agent activity hook ingestion is not configured for this daemon.",
    }, 503);
  }

  const authHeader = c.req.header("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;
  const headerToken = c.req.header("x-openrig-activity-token") ?? null;
  if (bearerToken !== expectedToken && headerToken !== expectedToken) {
    return c.json({
      ok: false,
      code: "activity_hook_unauthorized",
      error: "Agent activity hook ingestion requires the configured local hook token.",
    }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, code: "invalid_json", error: "Request body must be JSON." }, 400);
  }

  if (body.eventFamily === "session_identity") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
    const sessionName = stringOrNull(body.sessionName);
    const runtime = stringOrNull(body.runtime);
    if (!sessionId || !sessionName) {
      return c.json({ ok: false, code: "missing_session_identity", error: "session_identity requires sessionId and sessionName" }, 400);
    }

    const sessionRegistry = c.get("sessionRegistry" as never) as SessionRegistry | undefined;
    const eventBus = c.get("eventBus" as never) as EventBus | undefined;
    if (!sessionRegistry || !eventBus) {
      return c.json({ ok: false, code: "identity_hook_unconfigured", error: "Session registry not available" }, 503);
    }

    const nodeId = stringOrNull(body.nodeId);
    const resolved = store.resolveSession({ sessionName, nodeId, runtime });
    if (!resolved) {
      return c.json({ ok: false, code: "session_not_found", error: `No session found for ${sessionName}` }, 404);
    }

    // OPR.0.4.6.PI1 FR-5 — Pi session identity arrives from the pi-runner's
    // RPC get_state (provenance "rpc" on the bus, never scrape). The resume
    // TOKEN for Pi is the session FILE (body.sessionFile), not the session id;
    // it is format-validated before the persist and never echoed on failure.
    if (runtime === "pi") {
      const { validateResumeToken } = await import("../domain/resume-token-validation.js");
      const sessionFile = stringOrNull(body.sessionFile);
      const validation = validateResumeToken("pi", sessionFile);
      if (validation.ok) {
        sessionRegistry.updateResumeToken(resolved.sessionId, "pi_session_file", validation.token, "hook");
      }
      eventBus.emit({
        type: "agent.session_identity",
        rigId: resolved.rigId,
        nodeId: resolved.nodeId,
        sessionName: resolved.sessionName,
        runtime: "pi",
        sessionId,
        provenance: "rpc",
      });
      return c.json({ ok: true, sessionId, provenance: "rpc", tokenPersisted: validation.ok });
    }

    // The resume-type label derives from the RUNTIME, never a fixed default: this line used to stamp
    // "codex_id" for every non-pi runtime, so claude-code seats carried a codex-typed label over a
    // correct token value — and a restore path selecting its resume MECHANISM by label would pick the
    // wrong one while looking healthy. The relay only posts session_identity with a runtime present;
    // an unmapped runtime skips the persist (tokenPersisted: false) rather than guessing a label.
    const { validateResumeToken } = await import("../domain/resume-token-validation.js");
    const validation = validateResumeToken(runtime, sessionId);
    if (validation.ok) {
      sessionRegistry.updateResumeToken(resolved.sessionId, validation.resumeType, validation.token, "hook");
    }
    eventBus.emit({
      type: "agent.session_identity",
      rigId: resolved.rigId,
      nodeId: resolved.nodeId,
      sessionName: resolved.sessionName,
      runtime: runtime ?? "codex",
      sessionId,
      provenance: "hook",
    });

    return c.json({ ok: true, sessionId, provenance: "hook", tokenPersisted: validation.ok });
  }

  // OPR.0.4.3.06 — startup proof ingestion. Mirrors session_identity: reuses
  // the Bearer auth + relay transport above. Identity-bound + anti-replay +
  // contract-verified; only a verified proof projects `oriented` (never
  // `ready`). A bare ACK / wrong / replayed / identity-mismatched proof is an
  // append-only rejection.
  if (body.eventFamily === "startup_proof") {
    const eventBus = c.get("eventBus" as never) as EventBus | undefined;
    if (!eventBus) {
      return c.json({ ok: false, code: "startup_proof_unconfigured", error: "Event bus not available" }, 503);
    }
    const result = verifyStartupProof({ store, eventBus }, {
      sessionName: stringOrNull(body.sessionName),
      nodeId: stringOrNull(body.nodeId),
      runtime: stringOrNull(body.runtime),
      challengeId: stringOrNull(body.challengeId),
      answer: typeof body.answer === "string" ? body.answer : null,
    });
    if (!result.ok) {
      // Identity failures (unknown identity, or a nodeId/sessionName that
      // resolve to different seats) → 404; verification failures → 422.
      const status = result.code === "identity_unbound" || result.code === "identity_mismatch" ? 404 : 422;
      return c.json({ ok: false, code: result.code, error: result.error }, status);
    }
    return c.json({ ok: true, oriented: "verified", nodeId: result.nodeId, challengeId: result.challengeId });
  }

  const result = store.recordHookEvent({
    runtime: stringOrNull(body.runtime),
    sessionName: stringOrNull(body.sessionName),
    nodeId: stringOrNull(body.nodeId),
    hookEvent: typeof body.hookEvent === "string" ? body.hookEvent : "",
    subtype: stringOrNull(body.subtype),
    occurredAt: stringOrNull(body.occurredAt),
    // W2a-1 — source-bound emitting generation, carried by managed launch/fresh-handover producers.
    // Legacy, excluded, or no-tenure emitting paths may omit it ⇒ stamped null ⇒ unresolved at read
    // (sound per-path absence; never false-fresh).
    generation: stringOrNull(body.generation),
  });

  if (!result.ok) {
    const status = result.code === "missing_session_identity" ? 400 : 404;
    return c.json({ ok: false, code: result.code, error: result.error }, status);
  }

  // S19 A4 — feed the ONE oracle through the adapter seam: the recorded (store-
  // normalized) event becomes ladder evidence on the lifecycle-hooks rung. The store
  // remains the raw-event recorder (startup-proof, delivery verification); arbitration
  // happens only in SeatActivityService.
  const oracle = c.get("seatActivityService" as never) as
    | import("../domain/seat-activity-service.js").SeatActivityService
    | undefined;
  const emitted = result.event as { nodeId?: string; sessionName?: string; runtime?: string } | undefined;
  if (oracle && emitted?.nodeId && emitted.sessionName) {
    const runtime = emitted.runtime ?? stringOrNull(body.runtime);
    // Auto-declare on first hook evidence (and after a swap cleared the inventory):
    // the runtime's inventory sets each rung's INITIAL trust (claude standing, codex
    // hooks-at-trial per AM-2) — a successor's rungs always start unpromoted.
    if (!oracle.hasRungInventory(emitted.nodeId)) {
      oracle.declareRungInventory(
        { seatNodeId: emitted.nodeId, sessionName: emitted.sessionName },
        runtimeRungInventory(runtime),
      );
    }
    const evidence = evidenceFromHookActivity({
      seatNodeId: emitted.nodeId,
      sessionName: emitted.sessionName,
      runtime,
      activity: result.activity,
      seq: nextHookSeq(`${emitted.nodeId}:${runtime ?? "unknown-runtime"}:hooks`),
    });
    if (evidence) oracle.reportEvidence(evidence);
  }

  return c.json({ ok: true, activity: result.activity });
});

// ── S19 A7 — the parked query surface: GET /api/activity/parked[?seat=] ──
// Mounted under the existing activity route group (no new top-level mount): the parked
// diagnosis is activity-domain — the JOIN of the oracle with the queue's obligation
// face, derived at read time, never stored. Read-only: this route performs NO queue
// writes and the oracle keeps its non-inference contract.
activityRoutes.get("/parked", (c) => {
  const oracle = c.get("seatActivityService" as never) as
    | import("../domain/seat-activity-service.js").SeatActivityService
    | undefined;
  const queueRepo = c.get("queueRepo" as never) as
    | { list: (opts: { destinationSession?: string; state?: string[]; limit?: number }) => Array<{ qitemId: string; state: string; summary?: string | null }> }
    | undefined;
  const rigRepo = c.get("rigRepo" as never) as { db: import("better-sqlite3").Database } | undefined;
  if (!oracle || !queueRepo || !rigRepo) {
    return c.json({
      ok: false,
      code: "parked_query_unconfigured",
      error: "The parked query needs the activity oracle, queue repository and rig repository — one is not configured on this daemon.",
    }, 503);
  }

  const { diagnoseSeatParked, diagnoseRigParked, PARKED_OBLIGATION_LIMIT } = parkedQuery;
  const deps = {
    getSeatState: (id: string) => oracle.getSeatState(id),
    listOpenObligations: (destination: string, limit: number) => ({
      rows: queueRepo
        .list({ destinationSession: destination, state: ["pending", "in-progress", "blocked"], limit })
        .map((r) => ({ qitemId: r.qitemId, state: r.state as "pending" | "in-progress" | "blocked", summary: r.summary ?? null })),
      limit,
    }),
  };

  const seats = rigRepo.db.prepare(`
    SELECT n.id AS node_id, s.session_name AS session_name
    FROM nodes n
    JOIN sessions s ON s.node_id = n.id
      AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
    WHERE s.status = 'running' AND s.session_name IS NOT NULL
  `).all() as Array<{ node_id: string; session_name: string }>;

  const seatParam = c.req.query("seat") || undefined;
  if (seatParam) {
    const match = seats.find((s) => s.node_id === seatParam || s.session_name === seatParam);
    if (!match) {
      return c.json({
        ok: false,
        code: "seat_not_found",
        error: `No running seat matches "${seatParam}" — pass a node id or canonical session name (known: ${seats.map((s) => s.session_name).join(", ") || "(none running)"}).`,
      }, 404);
    }
    return c.json({ ok: true, seat: diagnoseSeatParked(deps, { seatNodeId: match.node_id, sessionName: match.session_name }), limit: PARKED_OBLIGATION_LIMIT });
  }
  return c.json({ ok: true, rig: diagnoseRigParked(deps, seats.map((s) => ({ seatNodeId: s.node_id, sessionName: s.session_name }))) });
});

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
