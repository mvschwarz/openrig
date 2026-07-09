import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type {
  QueueRepository,
  QueuePriority,
  QueueState,
} from "../domain/queue-repository.js";
import { QueueRepositoryError, newQitemId, deriveCrossHostSuccessorId } from "../domain/queue-repository.js";
import type { QueueItem } from "../domain/queue-repository.js";
import { isHumanSeatSession } from "../domain/human-route-enforcer.js";
import { parseSessionName } from "../domain/session-name.js";
import { hostname as osHostname } from "node:os";
import type { InboxHandler } from "../domain/inbox-handler.js";
import { InboxHandlerError } from "../domain/inbox-handler.js";
import type { OutboxHandler } from "../domain/outbox-handler.js";
import { aggregateAttention } from "../domain/feed/attention-aggregator.js";
import type { AttentionItem } from "../domain/feed/attention-aggregator.js";
import { loadHostRegistry, resolveHost } from "../domain/hosts/hosts-registry-reader.js";
import { LOCAL_HOST_ID } from "../domain/hosts/fanout-contract.js";
import { remoteJsonRequest } from "../domain/hosts/remote-daemon-http.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";

/**
 * Coordination L3 — Queue HTTP routes (PL-004 Phase A).
 *
 * Host-scoped. Backs `rig queue create|claim|update|handoff|show|list|inbox-*`.
 * Hot-potato strict-rejection happens in the domain layer; routes surface
 * structured errors with the validReasons enum so CLIs can render help.
 */

// OPR.0.4.6.MH3 D-5: the cross-host FORWARD write-class deadline, named at
// the call site (the S15 rule). The 5s READ budget is not the write budget;
// a forwarded coordination WRITE gets its own generous-but-bounded window
// (same class as mission-control's REMOTE_ACTION_TIMEOUT_MS). remoteJsonRequest
// never hangs — a timeout surfaces as a structured host-named failure.
const QUEUE_FORWARD_TIMEOUT_MS = 10_000;

// OPR.0.4.6.MH3 D-4 (FR-2/R2a): the cross-host provenance shape appended to a
// FORWARDED body's tags — a marker (`cross-host`) + the forwarding daemon's
// self-declared name (`from-host:<name>`). Honest best-effort provenance, not
// authenticated identity (host ids are per-registry local aliases). Without it
// the successor's source_session (recorded as given) is indistinguishable from
// a local one. The self-declared name is the daemon's own OS hostname — the
// shipped registry has no canonical own-alias reader, and D-4 frames this name
// as free-text best-effort by design.
export const CROSS_HOST_TAG = "cross-host";
export function crossHostProvenanceTags(existing: string[] | undefined): string[] {
  const base = existing ?? [];
  const fromHost = `from-host:${osHostname()}`;
  const additions = [CROSS_HOST_TAG, fromHost].filter((t) => !base.includes(t));
  return [...base, ...additions];
}

/**
 * OPR.0.3.2.20 — attention-class predicate for the `/list?attention=1`
 * filter. Mirrors the mission-control read layer's semantics so the
 * For You Action-required + Approval lenses agree with the
 * single-pane view:
 *
 *   - approval class  → tier === "human-gate"
 *   - action-required → destinationSession is a human seat
 *   - parked-on-human → state === "blocked" AND blockedOn is a human
 *                       seat (OPR.0.4.4.19 FR-6, C5 leg 1 — the owner
 *                       keeps the potato; the human owes the decision)
 *
 * Human-seat matching delegates to the single-source
 * human-route-enforcer predicate (no drift with the SQL function).
 * Exported so the predicate is a discrete, testable surface. The route
 * layer composes this with the open-state default so only unresolved
 * items appear — closed/done attention items are not surfaced.
 */
export function isAttentionItem(q: { tier: string | null; destinationSession: string; state?: string; blockedOn?: string | null }): boolean {
  if (q.tier === "human-gate") return true;
  if (isHumanSeatSession(q.destinationSession)) return true;
  return q.state === "blocked" && isHumanSeatSession(q.blockedOn ?? null);
}


export function queueRoutes(): Hono {
  const app = new Hono();

  function getRepo(c: { get: (key: string) => unknown }): QueueRepository {
    return c.get("queueRepo" as never) as QueueRepository;
  }
  function getInbox(c: { get: (key: string) => unknown }): InboxHandler {
    return c.get("inboxHandler" as never) as InboxHandler;
  }
  function getOutbox(c: { get: (key: string) => unknown }): OutboxHandler {
    return c.get("outboxHandler" as never) as OutboxHandler;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  /** PL-007: validate `target_repo` against the source rig's typed
   *  workspace block. Returns 3-part structured error when the repo name
   *  does not match the source rig's RigSpec.workspace.repos[]. Sessions
   *  not associated with a workspace-bearing rig pass-through (target_repo
   *  is honored as a free-form tag for back-compat). */
  function validateTargetRepo(
    c: { get: (key: string) => unknown },
    sourceSession: string,
    targetRepo: string,
  ): { ok: true } | { ok: false; error: string; message: string; meta?: Record<string, unknown> } {
    const rigRepo = c.get("rigRepo" as never) as import("../domain/rig-repository.js").RigRepository | undefined;
    if (!rigRepo) return { ok: true };
    // OPR.0.4.6.MH1 FR-8: the shared parse contract (this regex WAS the
    // contract's canonical shape — behavior-identical for every input).
    const parsedSource = parseSessionName(sourceSession);
    if (parsedSource.kind !== "canonical") return { ok: true };
    const rigName = parsedSource.rig;
    const rigs = rigRepo.findRigsByName(rigName);
    if (rigs.length === 0) return { ok: true };
    const rigId = rigs[0]!.id;
    const ws = rigRepo.getRigWorkspace(rigId);
    if (!ws) return { ok: true };
    const known = ws.repos.map((r) => r.name);
    if (!known.includes(targetRepo)) {
      return {
        ok: false,
        error: "unknown_target_repo",
        message: `target_repo "${targetRepo}" does not match any repo in rig ${rigName}'s workspace; check rig whoami --json | jq .workspace.repos to see declared repos`,
        meta: { rigName, knownRepos: known },
      };
    }
    return { ok: true };
  }

  function errorResponse(c: { json: (body: unknown, status?: number) => Response }, err: unknown): Response {
    if (err instanceof QueueRepositoryError) {
      const status = err.code === "qitem_not_found" ? 404
        : err.code === "missing_closure_reason" ? 400
        : err.code === "invalid_closure_reason" ? 400
        : err.code === "missing_closure_target" ? 400
        : err.code === "invalid_state" ? 400
        : err.code === "claim_destination_mismatch" ? 403
        : err.code === "qitem_not_claimable" ? 409
        : err.code === "qitem_not_in_progress" ? 409
        : err.code === "qitem_already_terminal" ? 409
        // OPR.0.4.6.MH3 Q-a: same minted id, different destination/source =
        // caller id-reuse (a bug, not an idempotent retry) — surface as a
        // conflict, never overwrite.
        : err.code === "qitem_id_reuse" ? 409
        // OPR.0.4.6.MH3 FR-4 (C2): a cross-host source-close re-drive naming a
        // DIFFERENT closure_target than the recorded one — someone else closed
        // the source meanwhile; surfaced, never overwritten.
        : err.code === "cross_host_close_conflict" ? 409
        : err.code === "unknown_destination_rig" ? 400
        : err.code === "human_route_fields_required" ? 400
        // OPR.0.4.6.WF3 FR-6: the frontier close-path guard — operator
        // misuse of a queue verb on a live workflow packet; structured
        // 400 with the what/why/fix message, never a 500.
        : err.code === "workflow_frontier_packet" ? 400
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    if (err instanceof InboxHandlerError) {
      const status = err.code === "inbox_not_found" ? 404
        : err.code === "auth_failed" ? 401
        : err.code === "absorb_destination_mismatch" ? 403
        : err.code === "deny_destination_mismatch" ? 403
        : err.code === "inbox_already_denied" ? 409
        : err.code === "inbox_not_pending" ? 409
        : 500;
      return c.json({ error: err.code, message: err.message }, status as 200);
    }
    const message = err instanceof Error ? err.message : "internal error";
    return c.json({ error: "internal_error", message }, 500);
  }

  // OPR.0.4.6.MH3 (FR-2, C1; return shape generalized in C2): the ONE shared
  // forward-then-strip helper for the queue's cross-host coordination WRITES
  // (create + handoff both route through it — one mechanism, not two).
  // Generalizes the shipped mission-control write template
  // (routes/mission-control.ts:340-388): resolve the registry daemon-side,
  // reject ssh/unsupported-transport, forward the WHOLE body (already minted +
  // provenance-tagged + hostId-stripped by the caller) to the origin daemon
  // over the bearer, and map transport failures to the structured host-named
  // taxonomy. Bearers resolve server-side and never reach the caller (the
  // shipped posture).
  //
  // Returns a discriminated union rather than a Response so the HANDOFF
  // choreography (C2) can compose: on success it needs the origin's verbatim
  // payload to pair with the local source-close result; /create just unwraps.
  // Either way the origin's row is THE record — no local write in here, ever.
  async function forwardQueueWrite(
    c: {
      get: (key: string) => unknown;
      json: (body: unknown, status?: number) => Response;
    },
    hostId: string,
    path: string,
    forwardBody: Record<string, unknown>,
  ): Promise<
    | { ok: true; payload: unknown; status: number }
    | { ok: false; response: Response }
  > {
    const registryLoader =
      (c.get("hostRegistryLoader" as never) as (() => ReturnType<typeof loadHostRegistry>) | undefined) ??
      loadHostRegistry;
    const fetchImpl = c.get("remoteFetchImpl" as never) as typeof fetch | undefined;
    const fail = (detail: string, failureClass: string, remoteStatus?: number): { ok: false; response: Response } => ({
      ok: false,
      response: c.json(
        { error: "remote_queue_write_failed", hostId, failureClass, ...(remoteStatus !== undefined ? { remoteStatus } : {}), detail },
        502,
      ),
    });
    const reg = registryLoader();
    if (!reg.ok) return fail(reg.error, "registry");
    const resolved = resolveHost(reg.registry, hostId);
    if (!resolved.ok) return fail(resolved.error, "unknown-host");
    if (resolved.host.transport !== "http") {
      return fail(
        `host '${hostId}' is SSH-declared; cross-host queue writes require an http-transport registry entry (url + bearer)`,
        "unsupported-transport",
      );
    }
    const res = await remoteJsonRequest(resolved.host, path, {
      method: "POST",
      body: forwardBody,
      timeoutMs: QUEUE_FORWARD_TIMEOUT_MS,
      fetchImpl,
    });
    if (res.ok) {
      // The origin daemon's structured response, verbatim — its row is the
      // record; no optimistic local re-shaping, no local write.
      return { ok: true, payload: res.payload, status: res.status ?? 200 };
    }
    switch (res.kind) {
      case "bearer":
        return fail(res.detail, "auth-failed");
      case "timeout":
        return fail(
          res.phase === "body"
            ? `remote queue write timed out: response headers arrived (HTTP ${res.status}) but the body never completed`
            : `remote queue write timed out after ${QUEUE_FORWARD_TIMEOUT_MS}ms`,
          "unreachable",
          res.status,
        );
      case "network":
        return fail(res.detail, "unreachable");
      case "http":
        // The origin refused (its own validation/auth/conflict) — its
        // structured error rides through; NO fake success.
        return fail(
          res.detail || `HTTP ${res.status}`,
          res.status === 401 || res.status === 403 ? "auth-failed" : "remote-error",
          res.status,
        );
    }
  }

  /**
   * OPR.0.4.6.MH3 FR-4 (C2): the cross-host HANDOFF choreography — shared by
   * /handoff (source closes `handed-off`) and /handoff-and-complete (source
   * closes `done`); the ONLY difference is the terminal state.
   *
   * The local atomic close+create cannot span two DBs, so the boundary is
   * bridged by message-passing in the arch-ruled Q-c order:
   *
   *   (1) read the LOCAL source row + pre-flight the re-drive state — a
   *       source already closed toward a DIFFERENT closure_target conflicts
   *       BEFORE any forward (never manufacture an orphan on the target host
   *       for a re-drive that cannot complete);
   *   (2) derive the successor id (D-1 — same source+destination+host →
   *       same id, stateless) and build the successor-create body: the
   *       local handoff's inheritance rules (body/priority/tier/tags from
   *       input ?? source), `chainOfRecord = [...source.chain, source.id]`
   *       (opaque lineage ids on the target — arch R2b), D-4 provenance
   *       tags, the forwarded `nudge` flag;
   *   (3) forward the successor-create FIRST via the ONE forwardQueueWrite
   *       helper — a failed forward returns the structured host-named error
   *       with the source UNTOUCHED (never-drop: the potato stays live);
   *       a re-driven forward absorbs on the target's PK (Q-a + D-1);
   *   (4) close the LOCAL source SECOND via the bounded repo method —
   *       `closure_target` = the opaque 3-part `<member@rig>@<host>` (R1),
   *       `handed_off_to` = the 2-part session (BR-1); an already-closed
   *       source with the MATCHING target absorbs idempotently.
   *
   * NOTE (disclosed): the target-side successor carries lineage via
   * `chain_of_record` + the provenance tags; the local-only
   * `handed_off_from` column is not part of the create body and stays NULL
   * on the target — R2b's opaque-lineage contract, not a gap.
   */
  async function crossHostHandoff(
    c: {
      get: (key: string) => unknown;
      json: (body: unknown, status?: number) => Response;
    },
    qitemId: string,
    hostId: string,
    terminalState: "handed-off" | "done",
    body: {
      fromSession: string;
      toSession: string;
      body?: string;
      transitionNote?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
      targetRepo?: string;
      summary?: string | null;
      evidenceRef?: string | null;
      nudge?: boolean;
    },
  ): Promise<Response> {
    const repo = getRepo(c);
    const source = repo.getById(qitemId);
    if (!source) return c.json({ error: "qitem_not_found", message: `qitem ${qitemId} not found` }, 404);

    // The opaque 3-part closure target (R1 — display/audit metadata, never
    // parsed). Session-string carriers keep the 2-part form (BR-1).
    const closureTarget = `${body.toSession}@${hostId}`;

    // (1) Pre-flight the re-drive state BEFORE any forward.
    const sourceTerminal = source.state === "done" || source.state === "handed-off";
    if (sourceTerminal && source.closureTarget !== closureTarget) {
      return c.json(
        {
          error: "cross_host_close_conflict",
          message: `qitem ${qitemId} is already closed toward ${source.closureTarget ?? "<no closure_target>"} — this re-drive names ${closureTarget}; surfacing the conflict, never overwriting`,
          existingClosureTarget: source.closureTarget,
          attemptedClosureTarget: closureTarget,
        },
        409,
      );
    }

    // (2) The deterministic successor identity + forwarded body.
    const successorId = deriveCrossHostSuccessorId(source.qitemId, body.toSession, hostId);
    const effectiveTags = body.tags ?? source.tags ?? undefined;
    const forwardBody: Record<string, unknown> = {
      qitemId: successorId,
      sourceSession: body.fromSession,
      destinationSession: body.toSession,
      body: body.body ?? source.body,
      priority: body.priority ?? source.priority,
      ...(body.tier ?? source.tier ? { tier: body.tier ?? source.tier } : {}),
      tags: crossHostProvenanceTags(effectiveTags),
      chainOfRecord: [...(source.chainOfRecord ?? []), source.qitemId],
      ...(body.targetRepo !== undefined
        ? { targetRepo: body.targetRepo }
        : source.targetRepo
          ? { targetRepo: source.targetRepo }
          : {}),
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.evidenceRef !== undefined ? { evidenceRef: body.evidenceRef } : {}),
      ...(body.nudge !== undefined ? { nudge: body.nudge } : {}),
    };

    // (3) Successor-create FIRST — origin-owns-the-record; failure leaves the
    // source untouched (never-drop).
    const fwd = await forwardQueueWrite(c, hostId, "/api/queue/create", forwardBody);
    if (!fwd.ok) return fwd.response;

    // (4) Source-close SECOND (idempotent absorb / structured conflict).
    let closed: { item: QueueItem; absorbed: boolean };
    try {
      closed = repo.closeCrossHostHandoffSource({
        qitemId: source.qitemId,
        fromSession: body.fromSession,
        toSession: body.toSession,
        closureTarget,
        terminalState,
        transitionNote: body.transitionNote,
      });
    } catch (err) {
      return errorResponse(c, err);
    }

    // Same {closed, created} shape as the local transactional handoff;
    // `created` is the origin daemon's row, verbatim.
    return c.json({ closed: closed.item, created: fwd.payload }, 201);
  }

  // POST /create
  app.post("/create", async (c) => {
    const body = await c.req.json<{
      qitemId?: string;
      sourceSession?: string;
      destinationSession?: string;
      body?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
      expiresAt?: string;
      chainOfRecord?: string[];
      targetRepo?: string;
      summary?: string | null;
      evidenceRef?: string | null;
      nudge?: boolean;
      // OPR.0.4.6.MH3 FR-1: the out-of-band host envelope (BR-1 — the
      // session string stays member@rig; the host is NEVER in-string).
      // Absent / "" / "local" = today's local path, byte-identical.
      hostId?: string;
    }>().catch(() => ({} as never));

    if (!body.sourceSession) return c.json({ error: "sourceSession is required" }, 400);
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    if (!body.body) return c.json({ error: "body is required" }, 400);

    // OPR.0.4.6.MH3 FR-2 (C1): cross-host CREATE. A registered remote host id
    // forwards the write to that host's daemon; the qitem lives in the origin
    // host's DB (origin-owns-the-record) and its OWN maybeNudge fires on its
    // local tmux (FR-3 — forward the WHOLE body incl. nudge). Delivery is
    // at-least-once + idempotent: the FORWARDING daemon MINTS the qitemId
    // before the first forward (Q-a) so every retry carries the same id. No
    // local row is ever written on the cross-host path.
    // PL-007: validate target_repo against source rig's workspace.repos[].
    // GUARD FIXBACK (OPR.0.4.6.MH3 review of 86ba8b42, Finding 1): this runs
    // BEFORE the cross-host branch — the validation authority is the SOURCE
    // rig's typed workspace, which lives on THIS host; the target daemon
    // passes-through when it doesn't know the source rig, so a post-forward
    // check cannot recover it. Local ordering is unchanged (the cross-host
    // branch is a no-op without hostId).
    if (body.targetRepo) {
      const validation = validateTargetRepo(c, body.sourceSession, body.targetRepo);
      if (!validation.ok) return c.json({ error: validation.error, message: validation.message, ...(validation.meta ?? {}) }, 400);
    }

    if (typeof body.hostId === "string" && body.hostId !== "" && body.hostId !== LOCAL_HOST_ID) {
      const mintedId = body.qitemId ?? newQitemId();
      const { hostId: _dropped, ...rest } = body;
      const forwardBody: Record<string, unknown> = {
        ...rest,
        qitemId: mintedId,
        tags: crossHostProvenanceTags(body.tags),
      };
      const fwd = await forwardQueueWrite(c, body.hostId, "/api/queue/create", forwardBody);
      return fwd.ok ? c.json(fwd.payload as Record<string, unknown>, fwd.status as 200) : fwd.response;
    }

    try {
      const item = await getRepo(c).create({
        qitemId: body.qitemId,
        sourceSession: body.sourceSession,
        destinationSession: body.destinationSession,
        body: body.body,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        expiresAt: body.expiresAt,
        chainOfRecord: body.chainOfRecord,
        targetRepo: body.targetRepo,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        nudge: (body as { nudge?: boolean }).nudge,
      });
      return c.json(item, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/claim
  app.post("/:qitemId/claim", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{ destinationSession?: string }>().catch(() => ({} as never));
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    try {
      const item = getRepo(c).claim({ qitemId, destinationSession: body.destinationSession });
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/unclaim
  app.post("/:qitemId/unclaim", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{ destinationSession?: string; reason?: string }>().catch(() => ({} as never));
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    try {
      const item = getRepo(c).unclaim(qitemId, body.destinationSession, body.reason ?? "manual");
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/update — general state mutator (incl. done).
  //
  // OPR.0.3.2.21.FR-4(d-docs) — closure ≠ acceptance.
  //
  // `state=done` with `closure_reason=handed_off_to` records that the
  // source seat has DELIVERED the work to the next stage. It does NOT
  // record that the next stage has ACCEPTED the work — that's the next
  // stage's verdict on its own qitem (typically a separate close with
  // its own closure_reason).
  //
  // Closure vocabulary:
  //   - handed_off_to    delivered to next stage; acceptance pending
  //                      that stage's verdict on its own qitem
  //   - blocked_on       waiting on a named blocker (closureTarget)
  //   - denied           the source seat refuses the work
  //   - canceled         work no longer needed (no follow-on)
  //   - no-follow-on     completed in place; no further routing
  //   - escalation       routed to a higher-authority seat
  //
  // The "accepted" state IS NOT a queue state in v0.3.x — the qitem
  // model captures delivery + the receiving stage owns acceptance as
  // a separate transaction. (FR-4d-state schema change adding a
  // distinct "accepted" state is deferred to release-0.3.3.)
  app.post("/:qitemId/update", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{
      actorSession?: string;
      state?: QueueState;
      transitionNote?: string;
      closureReason?: string;
      closureTarget?: string;
      blockedOn?: string;
      summary?: string | null;
      evidenceRef?: string | null;
    }>().catch(() => ({} as never));
    if (!body.actorSession) return c.json({ error: "actorSession is required" }, 400);
    if (!body.state) return c.json({ error: "state is required" }, 400);

    try {
      const item = getRepo(c).update({
        qitemId,
        actorSession: body.actorSession,
        state: body.state,
        transitionNote: body.transitionNote,
        closureReason: body.closureReason,
        closureTarget: body.closureTarget,
        // OPR.0.4.4.19 FR-6 — the leg-1 park surface: blockedOn plus the
        // park-time summary/evidence_ref persist inputs.
        blockedOn: body.blockedOn,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
      });
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/handoff — transactional close+create (local); cross-host
  // message-passing choreography when a registered hostId is enveloped
  // (OPR.0.4.6.MH3 FR-4, C2).
  app.post("/:qitemId/handoff", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{
      fromSession?: string;
      toSession?: string;
      body?: string;
      transitionNote?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
      targetRepo?: string;
      summary?: string | null;
      evidenceRef?: string | null;
      nudge?: boolean;
      // OPR.0.4.6.MH3 FR-1: the out-of-band host envelope (BR-1). Absent /
      // "" / "local" = today's local transactional path, byte-identical.
      hostId?: string;
    }>().catch(() => ({} as never));
    if (!body.fromSession) return c.json({ error: "fromSession is required" }, 400);
    if (!body.toSession) return c.json({ error: "toSession is required" }, 400);

    // PL-007 — GUARD FIXBACK (Finding 1): an EXPLICIT targetRepo validates
    // against the SOURCE host's authority BEFORE the cross-host branch (see
    // the create-route note). An inherited source.targetRepo (no override)
    // is NOT re-validated — it was already accepted on the source row.
    if (body.targetRepo) {
      const validation = validateTargetRepo(c, body.fromSession, body.targetRepo);
      if (!validation.ok) return c.json({ error: validation.error, message: validation.message, ...(validation.meta ?? {}) }, 400);
    }

    if (typeof body.hostId === "string" && body.hostId !== "" && body.hostId !== LOCAL_HOST_ID) {
      return crossHostHandoff(c, qitemId, body.hostId, "handed-off", {
        fromSession: body.fromSession,
        toSession: body.toSession,
        body: body.body,
        transitionNote: body.transitionNote,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        targetRepo: body.targetRepo,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        nudge: body.nudge,
      });
    }

    try {
      const result = await getRepo(c).handoff({
        qitemId,
        fromSession: body.fromSession,
        toSession: body.toSession,
        body: body.body,
        transitionNote: body.transitionNote,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        targetRepo: body.targetRepo,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        nudge: (body as { nudge?: boolean }).nudge,
      });
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/handoff-and-complete — variant of handoff that closes
  // source as `done` (terminal) instead of `handed-off` (intermediate).
  // Same atomic close+create + chain_of_record + default-nudge contract.
  // Cross-host: same C2 choreography with the `done` terminal state.
  app.post("/:qitemId/handoff-and-complete", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{
      fromSession?: string;
      toSession?: string;
      body?: string;
      transitionNote?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
      nudge?: boolean;
      targetRepo?: string;
      summary?: string | null;
      evidenceRef?: string | null;
      // OPR.0.4.6.MH3 FR-1: the out-of-band host envelope (BR-1).
      hostId?: string;
    }>().catch(() => ({} as never));
    if (!body.fromSession) return c.json({ error: "fromSession is required" }, 400);
    if (!body.toSession) return c.json({ error: "toSession is required" }, 400);

    // PL-007 — GUARD FIXBACK (Finding 1): same source-host-authority ordering
    // as handoff — explicit targetRepo validates BEFORE the cross-host branch.
    if (body.targetRepo) {
      const validation = validateTargetRepo(c, body.fromSession, body.targetRepo);
      if (!validation.ok) return c.json({ error: validation.error, message: validation.message, ...(validation.meta ?? {}) }, 400);
    }

    if (typeof body.hostId === "string" && body.hostId !== "" && body.hostId !== LOCAL_HOST_ID) {
      return crossHostHandoff(c, qitemId, body.hostId, "done", {
        fromSession: body.fromSession,
        toSession: body.toSession,
        body: body.body,
        transitionNote: body.transitionNote,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        targetRepo: body.targetRepo,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        nudge: body.nudge,
      });
    }

    try {
      const result = await getRepo(c).handoffAndComplete({
        qitemId,
        fromSession: body.fromSession,
        toSession: body.toSession,
        body: body.body,
        transitionNote: body.transitionNote,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        targetRepo: body.targetRepo,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        nudge: body.nudge,
      });
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/fallback
  app.post("/:qitemId/fallback", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{ fallbackDestination?: string; reason?: string }>().catch(() => ({} as never));
    if (!body.fallbackDestination) return c.json({ error: "fallbackDestination is required" }, 400);
    try {
      const item = getRepo(c).routeToFallback(qitemId, body.fallbackDestination, body.reason ?? "manual");
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /whoami — caller's queue position from the daemon's perspective.
  // MUST precede /:qitemId so the literal path wins.
  app.get("/whoami", (c) => {
    const session = c.req.query("session");
    if (!session) return c.json({ error: "session is required" }, 400);
    const recentLimit = c.req.query("recentLimit")
      ? Number.parseInt(c.req.query("recentLimit")!, 10)
      : undefined;
    return c.json(getRepo(c).whoami(session, { recentLimit }));
  });

  // GET /list — list with filters. MUST precede /:qitemId so the literal path wins.
  //
  // OPR.0.3.2.20 — `?attention=1` filter for the For You priority
  // windowing slice. Returns OPEN attention-class qitems (the durable
  // source of truth for the UI Action-required + Approval lenses) so
  // those surfaces don't depend on the lossy ephemeral client event
  // FIFO. Class membership matches the mission-control read layer
  // semantics: tier='human-gate' OR destination matches
  // /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/. Open state defaults
  // to pending|in-progress|blocked (callers can still override via
  // `state=...`). Composable with destinationSession/sourceSession/
  // targetRepo/limit.
  // OPR.0.4.4.15 FR-1 — the aggregated attention read: ONE payload in the
  // shared P4 fanout contract ({items, hosts}), local always included,
  // subscribed remote hosts fanned out DAEMON-SIDE (bearer never in the
  // browser). A NEW sibling endpoint by arch ruling 3 — the existing
  // /list?attention=1 wire below stays byte-preserved (the strongest form
  // of the zero-config negative AC).
  app.get("/attention-aggregate", async (c) => {
    const repo = getRepo(c);
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    // Same DI style as every other context dep — tests/QA inject a loader;
    // production falls back to the shared S11 reader over the operator's
    // real hosts.yaml.
    const registryLoader = (c.get("hostRegistryLoader" as never) as (() => ReturnType<typeof loadHostRegistry>) | undefined) ?? loadHostRegistry;
    const payload = await aggregateAttention({
      // The SAME repo query the /list attention path runs, same open-state
      // default — invoked, not duplicated.
      listLocalAttention: () => repo.listAttention({ state: ["pending", "in-progress", "blocked"] }) as unknown as AttentionItem[],
      listSubscriptions: () => (store ? store.listFeedHostSubscriptions() : []),
      loadRegistry: registryLoader,
    });
    return c.json(payload);
  });

  app.get("/list", (c) => {
    const destinationSession = c.req.query("destinationSession") || undefined;
    const sourceSession = c.req.query("sourceSession") || undefined;
    const stateRaw = c.req.query("state") || undefined;
    const targetRepo = c.req.query("targetRepo") || undefined;
    const userLimit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    const asSession = c.req.query("as") || undefined;
    const compact = c.req.query("compact") === "1";
    const rig = c.req.query("rig") || undefined;
    const activeOnly = c.req.query("activeOnly") === "1";
    const attention = c.req.query("attention") === "1";

    const state: QueueState[] | undefined = stateRaw
      ? (stateRaw.split(",") as QueueState[])
      : attention
        ? ["pending", "in-progress", "blocked"]
        : undefined;

    if (!attention) {
      const items = getRepo(c).list({
        destinationSession,
        sourceSession,
        state,
        targetRepo,
        limit: userLimit,
        asSession,
        compact,
        rig,
        activeOnly,
      });
      return c.json(items);
    }

    // OPR.0.3.2.20 — attention path goes through
    // QueueRepository.listAttention, which pushes the attention
    // predicate INTO the SQL WHERE clause so the LIMIT applies AFTER
    // attention filtering. Window-independent by construction: an
    // old human-gate item is never evicted by routine open qitems,
    // however many of them land after it (guard re-verify
    // qitem-20260518190827 BLOCKER 1). The earlier fetch-then-filter
    // shape (ATTENTION_FETCH_BOUND) is gone — the LIMIT bound is the
    // user-facing one only, applied at the SQL layer post-predicate.
    //
    // destinationSession/sourceSession/targetRepo are composable with
    // the attention predicate at the SQL layer (guard re-verify
    // qitem-20260518192210 BLOCKER 1 — the previous forward-fix
    // dropped composition). Scoped attention queries (e.g.,
    // attention=1&destinationSession=...) return ONLY the matching
    // attention items.
    const items = getRepo(c).listAttention({
      limit: userLimit,
      state,
      destinationSession,
      sourceSession,
      targetRepo,
    });
    // Defense-in-depth: refine with the JS predicate so the SQL
    // LIKE superset cannot leak a malformed destination through.
    const filtered = items.filter(isAttentionItem);
    return c.json(filtered);
  });

  // GET /overdue — surfaces in-progress qitems past closure_required_at.
  // MUST precede /:qitemId.
  app.get("/overdue", (c) => {
    const items = getRepo(c).findOverdue();
    return c.json(items);
  });

  // ---- SSE watch over coordination events ----
  // MUST precede /:qitemId so the literal `watch` and `sse` paths win
  // over the bare-param route (otherwise GET /api/queue/sse resolves as
  // /:qitemId with qitemId="sse" and returns 404 qitem_not_found).
  // Mounted at both /watch (legacy alias) and /sse (Phase A contract per IMPL).
  // Same handler; either path emits the identical event stream.
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "queue.created" &&
          event.type !== "queue.handed_off" &&
          event.type !== "queue.claimed" &&
          event.type !== "queue.unclaimed" &&
          event.type !== "qitem.fallback_routed" &&
          event.type !== "qitem.closure_overdue" &&
          event.type !== "inbox.absorbed" &&
          event.type !== "inbox.denied"
        ) return;
        const sse = { id: String(event.seq), data: JSON.stringify(event) };
        stream.writeSSE(sse).catch(() => {});
      });

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        unsubscribe();
      }
    });
  };

  app.get("/watch", sseHandler);
  app.get("/sse", sseHandler);

  // GET /:qitemId/transitions — registered before /:qitemId so the literal
  // suffix wins over the bare param route.
  app.get("/:qitemId/transitions", (c) => {
    const qitemId = c.req.param("qitemId");
    const repo = getRepo(c);
    if (!repo.getById(qitemId)) return c.json({ error: "qitem_not_found" }, 404);
    return c.json(repo.transitionLog.listForQitem(qitemId));
  });

  // GET /:qitemId — show one
  app.get("/:qitemId", (c) => {
    const qitemId = c.req.param("qitemId");
    const item = getRepo(c).getById(qitemId);
    if (!item) return c.json({ error: "qitem_not_found" }, 404);
    return c.json(item);
  });

  // ---- Inbox routes (mailbox) ----

  app.post("/inbox/drop", async (c) => {
    const body = await c.req.json<{
      inboxId?: string;
      destinationSession?: string;
      senderSession?: string;
      body?: string;
      tags?: string[];
      urgency?: string;
      auditPointer?: string;
      authenticatedSender?: string;
    }>().catch(() => ({} as never));
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    if (!body.senderSession) return c.json({ error: "senderSession is required" }, 400);
    if (!body.body) return c.json({ error: "body is required" }, 400);

    try {
      const entry = getInbox(c).drop(
        {
          inboxId: body.inboxId,
          destinationSession: body.destinationSession,
          senderSession: body.senderSession,
          body: body.body,
          tags: body.tags,
          urgency: body.urgency,
          auditPointer: body.auditPointer,
        },
        body.authenticatedSender
      );
      return c.json(entry, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/inbox/:inboxId/absorb", async (c) => {
    const inboxId = c.req.param("inboxId");
    const body = await c.req.json<{ receiverSession?: string }>().catch(() => ({} as never));
    if (!body.receiverSession) return c.json({ error: "receiverSession is required" }, 400);
    try {
      const result = await getInbox(c).absorb(inboxId, body.receiverSession);
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/inbox/:inboxId/deny", async (c) => {
    const inboxId = c.req.param("inboxId");
    const body = await c.req.json<{ receiverSession?: string; reason?: string }>().catch(() => ({} as never));
    if (!body.receiverSession) return c.json({ error: "receiverSession is required" }, 400);
    if (!body.reason) return c.json({ error: "reason is required" }, 400);
    try {
      const entry = getInbox(c).deny(inboxId, body.receiverSession, body.reason);
      return c.json(entry);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/inbox/pending", (c) => {
    const destinationSession = c.req.query("destinationSession");
    if (!destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    return c.json(getInbox(c).listPending(destinationSession));
  });

  app.get("/inbox/list", (c) => {
    const destinationSession = c.req.query("destinationSession");
    if (!destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    return c.json(getInbox(c).listForDestination(destinationSession, limit));
  });

  // ---- Outbox routes ----

  app.post("/outbox/record", async (c) => {
    const body = await c.req.json<{
      outboxId?: string;
      senderSession?: string;
      destinationSession?: string;
      body?: string;
      tags?: string[];
      urgency?: string;
      auditPointer?: string;
    }>().catch(() => ({} as never));
    if (!body.senderSession) return c.json({ error: "senderSession is required" }, 400);
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    if (!body.body) return c.json({ error: "body is required" }, 400);

    const entry = getOutbox(c).record({
      outboxId: body.outboxId,
      senderSession: body.senderSession,
      destinationSession: body.destinationSession,
      body: body.body,
      tags: body.tags,
      urgency: body.urgency,
      auditPointer: body.auditPointer,
    });
    return c.json(entry, 201);
  });

  app.get("/outbox/list", (c) => {
    const senderSession = c.req.query("senderSession");
    if (!senderSession) return c.json({ error: "senderSession is required" }, 400);
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    return c.json(getOutbox(c).listForSender(senderSession, limit));
  });

  return app;
}
