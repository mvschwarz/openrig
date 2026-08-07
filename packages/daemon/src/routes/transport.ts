import { Hono } from "hono";
import type { SessionTransport, TargetSpec } from "../domain/session-transport.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { requireSenderIdentity } from "./require-sender-identity.js";

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
    }>();

    if (!body.session || !body.text) {
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

    // P21 I4: the actor (the --dangerously-interact override AUDIT actor) is DERIVED from the transport
    // header, never body.actorSession. A body claim that DIFFERS from the header refuses-loud; a
    // drive-the-prompt override MUST be attributable, so an absent header refuses-loud (the override
    // writes an audit row that names who drove the prompt — it cannot be a forgeable claim).
    const derivedActor = c.req.header("x-openrig-session")?.trim() || null;
    if (body.actorSession && derivedActor && body.actorSession.trim() !== derivedActor) {
      return c.json({
        ok: false, error: "identity_mismatch",
        message: `The request body claims actor "${body.actorSession}" but the authenticated transport identity is "${derivedActor}". Remove the body actor (the transport header is authoritative).`,
      }, 409);
    }
    if (body.dangerouslyInteract && !derivedActor) {
      return c.json({
        ok: false, error: "unattributable_sender",
        message: "Refusing --dangerously-interact: no authenticated sender identity (X-OpenRig-Session header absent). The override audit records only a transport-derived actor, never a request-body claim.",
      }, 401);
    }

    // Check for ambiguity first
    const resolved = await transport.resolveSessions({ session: body.session });
    if (!resolved.ok) {
      const status = resolved.code === "ambiguous" ? 409 : 404;
      return c.json({ ok: false, error: resolved.error }, status);
    }

    const result = await transport.send(body.session, body.text, {
      verify: body.verify,
      force: body.force,
      waitForIdleMs: body.waitForIdleMs,
      dangerouslyInteract: body.dangerouslyInteract,
      reason: body.reason,
      actorSession: derivedActor, // transport-derived, never the body claim
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
      };
      const status = (statusMap[result.reason ?? ""] ?? 500) as 400 | 404 | 409 | 500 | 502 | 503;
      return c.json(result, status);
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

    // P21 I4: the --dangerously-interact override AUDIT actor is DERIVED from the transport header (see
    // /send). The envelopeSender (the From: rendered into every recipient's terminal) derives too — orch
    // ruled (a): the header re-stamp is authoritative and the body value is ignored (see below).
    const derivedActor = c.req.header("x-openrig-session")?.trim() || null;
    if (body.actorSession && derivedActor && body.actorSession.trim() !== derivedActor) {
      return c.json({
        error: "identity_mismatch",
        message: `The request body claims actor "${body.actorSession}" but the authenticated transport identity is "${derivedActor}". Remove the body actor (the transport header is authoritative).`,
      }, 409);
    }
    if (body.dangerouslyInteract && !derivedActor) {
      return c.json({
        error: "unattributable_sender",
        message: "Refusing --dangerously-interact: no authenticated sender identity (X-OpenRig-Session header absent). The override audit records only a transport-derived actor.",
      }, 401);
    }

    // P21 I4 (orch ruling from specimen 5 — the false "From: pm-lead" the incident acted upon): the
    // From: line rendered into every recipient's terminal MUST DERIVE from the transport identity, never
    // the body value. A present body.envelopeSender signals the ENVELOPED fan-out (rig send); its value
    // is IGNORED and the From: is the derived actor. A cross-host relay re-stamps X-OpenRig-Session from
    // ITS authenticated context (not a caller --from string). Unattributable enveloped send ⇒ refuse-loud
    // — never render an unverified name (no silent fallback to the body). Raw `rig broadcast` = no envelope.
    let envelopeSender: string | undefined = undefined;
    if (body.envelopeSender !== undefined && body.envelopeSender !== null) {
      if (!derivedActor) {
        return c.json({
          error: "unattributable_sender",
          message: "Refusing an enveloped send: no authenticated sender identity (X-OpenRig-Session header absent). The rendered From: derives from the transport, never a request-body claim.",
        }, 401);
      }
      envelopeSender = derivedActor;
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

    return c.json(result);
  });

  return router;
}
