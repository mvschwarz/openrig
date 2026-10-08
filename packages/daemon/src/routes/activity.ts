import { existsSync } from "node:fs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { EventBus } from "../domain/event-bus.js";
import { verifyStartupProof } from "../domain/startup-proof.js";
import type { ActivityEvidence } from "../domain/activity-taxonomy.js";
import type { AgentActivity } from "../domain/types.js";
import * as parkedQuery from "../domain/parked-query.js";
import { runtimeRungInventory } from "../domain/activity-taxonomy.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { transportSenderSession } from "./require-sender-identity.js";

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
  if (input.activity.reason === "permission_request_pending") {
    return { ...base, permissionRequest: { id: input.activity.turnId ?? "uncorrelated" } };
  }
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
    // OMP session identity (hook or seat) is strict: the exact seat name, the
    // seat's own runtime, the current occupant generation, and a materialized
    // session file that matches the seat's runner sidecar. Every refusal
    // reports tokenPersisted: false so the OMP runner keeps re-announcing.
    // Pi, Claude, Codex and terminal seats keep the paths below unchanged.
    if (runtime === "omp" || resolved.runtime === "omp") {
      if (sessionName !== resolved.sessionName) {
        return c.json({ ok: false, code: "session_not_found", tokenPersisted: false, error: "Session identity does not match the managed seat." }, 404);
      }
      if (runtime !== resolved.runtime) {
        return c.json({ ok: false, code: "runtime_mismatch", tokenPersisted: false, error: "Session identity runtime does not match the managed seat." }, 409);
      }
      // Same occupant-generation gate as Pi below, before any file eligibility.
      const generation = stringOrNull(body.generation);
      let reason: string | null = null;
      try {
        const current = sessionRegistry.currentOccupantTenure(resolved.nodeId);
        if (!generation) reason = "generation_unverifiable";
        else if (!current || !sessionRegistry.isOccupantGenerationRegistered(resolved.nodeId, generation)) {
          reason = "generation_unresolvable";
        } else if (current.generationUuid !== generation) reason = "generation_mismatch";
      } catch {
        return c.json({
          ok: false, code: "generation_resolver_error", tokenPersisted: false,
          error: "OMP session identity ignored: occupant generation is unavailable.",
        }, 503);
      }
      if (reason) {
        return c.json({
          ok: false, code: reason, tokenPersisted: false,
          error: "OMP session identity ignored: emitter is not the registered current occupant.",
        }, 409);
      }
      const validation = validateResumeToken("omp", stringOrNull(body.sessionFile));
      // OMP reports a path before its first turn is written. Persist only
      // materialized history; the runner can re-announce identity later.
      const adapters = c.get("runtimeAdapters" as never) as Record<string, unknown> | undefined;
      const omp = adapters?.["omp"] as { readSessionFile?: (sessionName: string) => { ok: true; sessionFile: string } | { ok: false; reason: string } } | undefined;
      const ownFile = typeof omp?.readSessionFile === "function" ? omp.readSessionFile(resolved.sessionName) : null;
      const tokenPersisted = validation.ok && ownFile?.ok === true && ownFile.sessionFile === validation.token && existsSync(validation.token)
        ? sessionRegistry.updateResumeToken(resolved.sessionId, validation.resumeType, validation.token, "hook")
          || sessionRegistry.resumeTokenMatches(resolved.sessionId, validation.resumeType, validation.token)
        : false;
      eventBus.emit({
        type: "agent.session_identity",
        rigId: resolved.rigId,
        nodeId: resolved.nodeId,
        sessionName: resolved.sessionName,
        runtime: "omp",
        sessionId,
        provenance: "rpc",
      });
      return c.json({ ok: true, sessionId, provenance: "rpc", tokenPersisted });
    }

    // OPR.0.4.6.PI1 FR-5 — Pi session identity arrives from the pi-runner's
    // RPC get_state (provenance "rpc" on the bus, never scrape). The resume
    // TOKEN for Pi is the session FILE (body.sessionFile), not the session id;
    // it is format-validated before the persist and never echoed on failure.
    if (runtime === "pi") {
      // A delayed get_state from a retired runner must not replace the successor's
      // resume token or publish a current identity. Keep resolution, this check
      // and both effects synchronous so renewal cannot interleave at an await.
      const generation = stringOrNull(body.generation);
      let reason: string | null = null;
      try {
        const current = sessionRegistry.currentOccupantTenure(resolved.nodeId);
        if (!generation) reason = "generation_unverifiable";
        else if (!current || !sessionRegistry.isOccupantGenerationRegistered(resolved.nodeId, generation)) {
          reason = "generation_unresolvable";
        } else if (current.generationUuid !== generation) reason = "generation_mismatch";
      } catch {
        return c.json({
          ok: false, code: "generation_resolver_error", tokenPersisted: false,
          error: "Pi session identity ignored: occupant generation is unavailable.",
        }, 503);
      }
      if (reason) {
        return c.json({
          ok: false, code: reason, tokenPersisted: false,
          error: "Pi session identity ignored: emitter is not the registered current occupant.",
        }, 409);
      }
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
    // tokenPersisted reports the stored state, not format validity: a higher-provenance token
    // (operator) refuses the hook write, which only counts as persisted when it already matches.
    const validation = validateResumeToken(runtime, sessionId);
    const tokenPersisted = validation.ok
      && (sessionRegistry.updateResumeToken(resolved.sessionId, validation.resumeType, validation.token, "hook")
        || sessionRegistry.resumeTokenMatches(resolved.sessionId, validation.resumeType, validation.token));
    eventBus.emit({
      type: "agent.session_identity",
      rigId: resolved.rigId,
      nodeId: resolved.nodeId,
      sessionName: resolved.sessionName,
      runtime: runtime ?? "codex",
      sessionId,
      provenance: "hook",
    });

    return c.json({ ok: true, sessionId, provenance: "hook", tokenPersisted });
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
    turnId: stringOrNull(body.turnId),
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
  // Recording a historical hook is valid, but its raw activity cannot staff the
  // current oracle. The store may resolve nodeId to a newer session even when
  // the emitter supplied an old sessionName, so check both identities before
  // declaring an inventory (which would reactivate a retired seat).
  const currentSession = oracle && emitted?.nodeId
    ? store.db.prepare("SELECT session_name, status FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
      .get(emitted.nodeId) as { session_name: string; status: string } | undefined
    : undefined;
  const suppliedSessionName = stringOrNull(body.sessionName);
  if (oracle && emitted?.nodeId && emitted.sessionName
      && currentSession?.status === "running" && currentSession.session_name === emitted.sessionName
      && (!suppliedSessionName || suppliedSessionName === emitted.sessionName)) {
    // A same-name relaunch can have a different registered occupant generation.
    // Honor the store's positive mismatch verdict, while preserving legacy hooks
    // with unresolved provenance and the archival response below.
    if (result.activity.generation != null
        && store.getLatestForNode({ nodeId: emitted.nodeId, sessionName: emitted.sessionName })?.reason === "generation_mismatch") {
      return c.json({ ok: true, activity: result.activity });
    }
    const runtime = emitted.runtime ?? stringOrNull(body.runtime);
    // Auto-declare on first hook evidence (and after a swap cleared the inventory):
    // the runtime's inventory sets each rung's INITIAL trust (claude standing, codex
    // hooks-at-trial per AM-2) — a successor's rungs always start unpromoted.
    if (!oracle.hasRungInventory(emitted.nodeId, emitted.sessionName)) {
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

// ── S19 AM-R18 — the push substrate: GET /api/activity/events (SSE) ──
// Desk-accepted shape (ruling row qitem-20260827001530): CHANGE NOTIFICATIONS ONLY —
// seat.activity_changed (identity + seq) and seat.rung_health stream to the open view;
// the view REHYDRATES from /api/ps. The push never carries derived vocabulary, so "no
// second activity mechanism" holds by construction. No timers: pure bus relay;
// disconnect unsubscribes.
activityRoutes.get("/events", (c) => {
  const eventBus = c.get("eventBus" as never) as
    | { subscribe: (cb: (event: unknown) => void) => () => void }
    | undefined;
  if (!eventBus?.subscribe) {
    return c.json({
      ok: false,
      code: "activity_events_unconfigured",
      error: "The activity event stream needs the event bus — not configured on this daemon.",
    }, 503);
  }
  return streamSSE(c, async (stream) => {
    const unsubscribe = eventBus.subscribe((event) => {
      const type = (event as { type?: string }).type;
      if (type !== "seat.activity_changed" && type !== "seat.rung_health" && type !== "proof.judged" && type !== "proof.sources_changed") return;
      void stream.writeSSE({ event: type, data: JSON.stringify(event) });
    });
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        unsubscribe();
        resolve();
      });
    });
  });
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
    | {
        list: (opts: { destinationSession?: string; state?: string[]; limit?: number }) => Array<{ qitemId: string; state: string; summary?: string | null }>;
        getParkWakeStatus: (qitemId: string) => import("../domain/queue-wake-repository.js").ParkWakeStatus | null;
      }
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
    getParkWake: (qitemId: string) => queueRepo.getParkWakeStatus(qitemId),
  };

  // WAVE-O B2 (R2 508e383d): the diagnosis is RIG-SCOPED, never fleet-wide. Resolve ONE
  // declared scope — an explicit seat coordinate carrying its @rig, the explicit ?rig=
  // parameter, or the caller's own session identity — and NAME it in the response
  // (AM-3: the scope that ran is part of the answer). No resolvable scope is an honest
  // refusal, never a silent fold of every rig on the daemon.
  const seatParam = c.req.query("seat") || undefined;
  const rigParam = c.req.query("rig") || undefined;
  const callerSession = transportSenderSession(c);
  let scope: { rig: string; resolvedFrom: "seat-coordinate" | "query-param" | "caller-session" } | null = null;
  if (seatParam?.includes("@")) {
    scope = { rig: seatParam.split("@")[1]!, resolvedFrom: "seat-coordinate" };
  } else if (rigParam) {
    scope = { rig: rigParam, resolvedFrom: "query-param" };
  } else if (callerSession?.includes("@")) {
    // Canonical local form name@rig; a cross-host stamp name@rig@host parses the same.
    scope = { rig: callerSession.split("@")[1]!, resolvedFrom: "caller-session" };
  }
  if (!scope) {
    return c.json({
      ok: false,
      code: "rig_scope_unresolvable",
      error: "The parked diagnosis is rig-scoped and no rig coordinate could be resolved — pass ?rig=<name> (CLI: --rig), target a seat by its canonical session name (?seat=name@rig), or call from a seat shell so the session identity carries the rig.",
    }, 400);
  }
  const rigRow = rigRepo.db.prepare("SELECT id, name FROM rigs WHERE name = ?").get(scope.rig) as { id: string; name: string } | undefined;
  if (!rigRow) {
    const known = (rigRepo.db.prepare("SELECT name FROM rigs ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    return c.json({
      ok: false,
      code: "rig_not_found",
      error: `No rig named "${scope.rig}" on this daemon — known rigs: ${known.join(", ") || "(none)"}.`,
    }, 404);
  }

  const seats = rigRepo.db.prepare(`
    SELECT n.id AS node_id, s.session_name AS session_name
    FROM nodes n
    JOIN rigs r ON r.id = n.rig_id
    JOIN sessions s ON s.node_id = n.id
      AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
    WHERE s.status = 'running' AND s.session_name IS NOT NULL AND r.name = ?
  `).all(scope.rig) as Array<{ node_id: string; session_name: string }>;

  if (seatParam) {
    const match = seats.find((s) => s.node_id === seatParam || s.session_name === seatParam);
    if (!match) {
      return c.json({
        ok: false,
        code: "seat_not_found",
        error: `No running seat in rig "${scope.rig}" matches "${seatParam}" — pass a node id or canonical session name (known in scope: ${seats.map((s) => s.session_name).join(", ") || "(none running)"}).`,
      }, 404);
    }
    return c.json({
      ok: true,
      seat: diagnoseSeatParked(deps, { seatNodeId: match.node_id, sessionName: match.session_name }),
      scope,
      limit: PARKED_OBLIGATION_LIMIT,
    });
  }
  return c.json({
    ok: true,
    rig: {
      ...diagnoseRigParked(deps, seats.map((s) => ({ seatNodeId: s.node_id, sessionName: s.session_name }))),
      scope,
    },
  });
});

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
