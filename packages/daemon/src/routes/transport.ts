import { Hono } from "hono";
import type { SessionTransport, TargetSpec } from "../domain/session-transport.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { requireSenderIdentity } from "./require-sender-identity.js";
import type { OutboxHandler } from "../domain/outbox-handler.js";
import { wrapPaneEnvelope } from "../lib/pane-envelope.js";

// S2 (OPR.0.5.4.3) — the sender-side half of two-ended honesty: appended to any
// unattributed delivery's success payload and surfaced by the CLI renderers.
// Held to the S1 truthfulness bar for a success payload: what happened, what the
// recipient cannot know, and the concrete fix (sign).
const UNKNOWN_SENDER_NOTICE =
  "Delivered without sender identity: this request carried no X-OpenRig-Session header, so your recipient has no way of knowing who sent it. Follow up and sign it — send from a seat shell (the header stamps automatically) or state your identity in the message body.";

// The unknown-sender From: marker, DERIVED from the canonical envelope wrapper
// (pane-envelope.ts SENDER_FALLBACK is unexported and its literal is
// canonicity-guarded to exactly two twin sites) — deriving at module load keeps
// one source of truth with no third definition. wrapPaneEnvelope with an absent
// sender renders "From: <marker>" as its first line.
const UNKNOWN_SENDER_MARKER = wrapPaneEnvelope(undefined, "", "").split("\n")[0]!.replace(/^From: /, "");

export function transportRoutes(opts?: { bearerToken?: string | null }): Hono {
  const router = new Hono();

  const terminalToken = opts?.bearerToken ?? null;
  router.use("*", authBearerTokenMiddleware({ expectedToken: terminalToken }));

  router.post("/send", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      session?: string;
      text: string;
      verify?: boolean;
      force?: boolean;
      waitForIdleMs?: number;
      dangerouslyInteract?: boolean;
      reason?: string;
      actorSession?: string | null;
      submitOnly?: boolean;
      expectedStagedText?: string;
      expectedStagedLineCount?: number;
    }>();

    // submitOnly (mechanics-gate fix d9b3989a) sends NO text — the Enter-only retry for staged
    // content; every other send still requires text.
    if (!body.session || (!body.text && !body.submitOnly)) {
      return c.json({ error: "Missing required fields: session, text" }, 400);
    }
    // OPR.0.4.1.10 — the danger override and wait mode are contradictory; reject before transport.
    if (body.dangerouslyInteract && body.waitForIdleMs !== undefined) {
      return c.json({
        ok: false,
        reason: "invalid_dangerously_interact",
        error: "--dangerously-interact cannot be combined with --wait-for-idle. No text was sent.",
      }, 400);
    }
    // The override must carry a reason for the audit record.
    if (body.dangerouslyInteract && (!body.reason || body.reason.trim().length === 0)) {
      return c.json({
        ok: false,
        reason: "dangerously_interact_requires_reason",
        error: "--dangerously-interact requires --reason explaining why the prompt is being driven. No text was sent.",
      }, 400);
    }
    if (body.waitForIdleMs !== undefined) {
      if (body.force) {
        return c.json({
          ok: false,
          reason: "invalid_wait_for_idle",
          error: "--wait-for-idle cannot be combined with force. No text was sent.",
        }, 400);
      }
      if (typeof body.waitForIdleMs !== "number" || !Number.isFinite(body.waitForIdleMs) || body.waitForIdleMs <= 0) {
        return c.json({
          ok: false,
          reason: "invalid_wait_for_idle",
          error: "waitForIdleMs must be a positive number. No text was sent.",
        }, 400);
      }
    }

    // P21 I4 + S2 (OPR.0.5.4.3): the actor (the --dangerously-interact override AUDIT actor) is
    // DERIVED from the transport header, never body.actorSession. A body claim that DIFFERS is
    // simply SUPERSEDED, never a refusal: the wire decides the actor and the body never does
    // (PM ruling (A), 2026-08-11 — see require-sender-identity.ts:16-22). An ABSENT header no
    // longer refuses (founder descope, S2): a spoofer defeats a refusal by adding a header, so
    // the 401 only ever stopped honest uncounted callers. Instead the send DELIVERS, the
    // already-nullable audit actor records null (projected "unknown"), and the response carries
    // the sign-it notice below.
    const derivedActor = c.req.header("x-openrig-session")?.trim() || null;

    // Check for ambiguity first
    const resolved = await transport.resolveSessions({ session: body.session });
    if (!resolved.ok) {
      const status = resolved.code === "ambiguous" ? 409 : 404;
      return c.json({ ok: false, error: resolved.error }, status);
    }

    const result = await transport.send(body.session, body.text ?? "", {
      verify: body.verify,
      force: body.force,
      waitForIdleMs: body.waitForIdleMs,
      dangerouslyInteract: body.dangerouslyInteract,
      reason: body.reason,
      actorSession: derivedActor, // transport-derived, never the body claim
      // Mechanics-gate fix (d9b3989a): the walk retry's bare-Enter mode, guarded in the
      // transport by the expected-staged-text precheck.
      submitOnly: body.submitOnly,
      expectedStagedText: body.expectedStagedText,
      expectedStagedLineCount: body.expectedStagedLineCount,
    });

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        session_missing: 404,
        tmux_unavailable: 503,
        transport_unavailable: 409,
        mid_work: 409,
        invalid_wait_for_idle: 400,
        invalid_dangerously_interact: 400,
        dangerously_interact_requires_reason: 400,
        wait_for_idle_timeout: 409,
        target_needs_input: 409,
        target_activity_unknown: 409,
        prompt_override_audit_unavailable: 500,
        submit_failed: 502,
        send_failed: 502,
        invalid_submit_only: 400,
        staged_mismatch: 409,
      };
      const status = (statusMap[result.reason ?? ""] ?? 500) as 400 | 404 | 409 | 500 | 502 | 503;
      return c.json(result, status);
    }

    // A3 (P22): auto-record the DISPATCHED send into the sender-side outbox, so a derived send cannot
    // accept-and-drop at the audit layer (the specimen-5 window: no outbox row, attribution survived only
    // via provider JSONL). STRICTLY DOWNSTREAM of the certified header-derivation (line 65): it consumes
    // the already-derived `derivedActor`, never re-derives or alters it. Records only a DERIVED send —
    // `derivedActor` present — with the era-stamp `transport:v1` (the sole mode this header-derived route
    // produces; a cross-host relay's header IS the origin triple, so the recorded sender is the ORIGIN,
    // never the relay). A null-actor send has no derived sender to attribute (no fabricated row). The
    // send is already committed, so a rare audit-write failure is LOGGED, never a false-negative on a
    // delivered send.
    if (derivedActor && !body.submitOnly) { // submitOnly types no text — nothing to outbox-record
      const outbox = c.get("outboxHandler" as never) as OutboxHandler | undefined;
      if (outbox) {
        try {
          outbox.record({
            senderSession: derivedActor,
            destinationSession: body.session,
            body: body.text,
            identityProvenance: "transport:v1",
          });
        } catch (err) {
          console.warn(`[transport/send] outbox auto-record failed (send already delivered): ${(err as Error).message}`);
        }
      }
    }

    // S2 (OPR.0.5.4.3) sender-side honesty: an unattributed delivery tells the sender, on the
    // success payload the CLI renderers surface, that the recipient cannot know who sent it.
    // Composes with any existing transport warning; attributed sends see no change and no nag.
    if (!derivedActor) {
      result.warning = result.warning ? `${result.warning} ${UNKNOWN_SENDER_NOTICE}` : UNKNOWN_SENDER_NOTICE;
    }

    return c.json(result);
  });

  router.post("/capture", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      session?: string;
      rig?: string;
      pod?: string;
      lines?: number;
    }>();

    // Multi-target: rig or pod
    if (body.rig || body.pod) {
      const target: TargetSpec = body.pod
        ? { pod: body.pod, rig: body.rig }
        : { rig: body.rig! };

      const resolved = await transport.resolveSessions(target);
      if (!resolved.ok) {
        return c.json({ ok: false, error: resolved.error }, 404);
      }

      const results = [];
      for (const session of resolved.sessions) {
        const result = await transport.capture(session.sessionName, { lines: body.lines });
        results.push(result);
      }
      return c.json({ results });
    }

    // Single target: session
    if (!body.session) {
      return c.json({ error: "Provide session, rig, or pod to capture" }, 400);
    }

    const result = await transport.capture(body.session, { lines: body.lines });
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        session_missing: 404,
        tmux_unavailable: 503,
        transport_unavailable: 409,
        capture_failed: 502,
      };
      const status = (statusMap[result.reason ?? ""] ?? 404) as 404 | 409 | 502 | 503;
      return c.json(result, status);
    }
    return c.json(result);
  });

  router.post("/broadcast", async (c) => {
    const transport = c.get("sessionTransport" as never) as SessionTransport;
    const body = await c.req.json<{
      rig?: string;
      pod?: string;
      // OPR.0.4.3.30 — explicit multi-recipient list (`rig send --to a,b`).
      sessions?: string[];
      text: string;
      verify?: boolean;
      force?: boolean;
      // OPR.0.4.3.30 — plumbed through so `rig send` fan-out carries the same guard/wait
      // semantics as a single send. Each is applied PER recipient inside broadcast()'s loop
      // (the danger audit fires once per seat, not once per batch).
      waitForIdleMs?: number;
      dangerouslyInteract?: boolean;
      reason?: string;
      actorSession?: string | null;
      // OPR.0.4.3.30 — when set, the fan-out wraps each recipient in its own From/To envelope.
      // `rig broadcast` never sets it (raw-to-all, unchanged).
      envelopeSender?: string | null;
    }>();

    if (!body.text) {
      return c.json({ error: "Missing required field: text" }, 400);
    }

    // P21 I4 + S2 (OPR.0.5.4.3): the --dangerously-interact override AUDIT actor is DERIVED from the
    // transport header (see /send). An absent header no longer refuses — the send proceeds and the
    // audit's already-nullable actor records null (projected "unknown"); the response carries the
    // sign-it notice below.
    const derivedActor = c.req.header("x-openrig-session")?.trim() || null;

    // P21 I4 (orch ruling from specimen 5 — the false "From: pm-lead" the incident acted upon): the
    // From: line rendered into every recipient's terminal MUST DERIVE from the transport identity, never
    // the body value. A present body.envelopeSender signals the ENVELOPED fan-out (rig send); its value
    // is IGNORED and the From: is the derived actor. A cross-host relay re-stamps X-OpenRig-Session from
    // ITS authenticated context (not a caller --from string). S2 (OPR.0.5.4.3): an unattributable
    // enveloped send now DELIVERS with the explicit unknown-sender marker as its From: — the specimen-5
    // rule is preserved unweakened: the body claim is STILL never rendered; the recipient sees honest
    // "unknown", never an unverified name. Raw `rig broadcast` = no envelope.
    let envelopeSender: string | undefined = undefined;
    if (body.envelopeSender !== undefined && body.envelopeSender !== null) {
      envelopeSender = derivedActor ?? UNKNOWN_SENDER_MARKER;
    }

    const target: TargetSpec =
      body.sessions && body.sessions.length > 0
        ? { sessions: body.sessions }
        : body.pod
          ? { pod: body.pod, rig: body.rig }
          : body.rig
            ? { rig: body.rig }
            : { global: true };

    const result = await transport.broadcast(target, body.text, {
      verify: body.verify,
      force: body.force,
      waitForIdleMs: body.waitForIdleMs,
      dangerouslyInteract: body.dangerouslyInteract,
      reason: body.reason,
      actorSession: derivedActor, // transport-derived, never the body claim
      envelopeSender, // the From: is the DERIVED identity (never the body value) — orch ruling (a)
    });

    // A3b (P22 follow-on, planner-ruled IN scope): auto-record the fan-out — N rows, ONE per RESOLVED
    // recipient. The schema is a per-recipient design (destination_session is typed + indexed; per-row
    // delivery_state), so a partial fan-out records the TRUTH per recipient, never a lossy aggregate.
    // STRICTLY DOWNSTREAM of the certified derivation (derivedActor above): each row's sender is the
    // already-derived actor; destination = the RESOLVED session, NEVER the TargetSpec (which would poison
    // the typed session column). Best-effort per row: the fan-out is already dispatched, so a rare
    // audit-write failure is logged, never a false-negative on delivery.
    if (derivedActor) {
      const outbox = c.get("outboxHandler" as never) as OutboxHandler | undefined;
      if (outbox) {
        for (const r of result.results) {
          if (!r.sessionName) continue;
          try {
            const entry = outbox.record({
              senderSession: derivedActor,
              destinationSession: r.sessionName,
              body: body.text,
              identityProvenance: "transport:v1",
            });
            if (r.ok) outbox.markDelivered(entry.outboxId);
            else outbox.markFailed(entry.outboxId);
          } catch (err) {
            console.warn(`[transport/broadcast] outbox auto-record failed for ${r.sessionName} (fan-out already dispatched): ${(err as Error).message}`);
          }
        }
      }
    }

    // S2 (OPR.0.5.4.3) sender-side honesty: an unattributed fan-out's response carries the
    // sign-it notice for the CLI renderers to surface. Attributed fan-outs are unchanged.
    if (!derivedActor) {
      return c.json({ ...result, warning: UNKNOWN_SENDER_NOTICE });
    }
    return c.json(result);
  });

  return router;
}
