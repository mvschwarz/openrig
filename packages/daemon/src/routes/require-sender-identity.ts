import type { Context } from "hono";

/**
 * P21 sender-provenance chokepoint — the ONE shared route helper that generalizes P18's inline
 * `/inbox/drop` form (b2437104) across every caller-identity site. The acting seat's identity is
 * DERIVED from the authenticated transport header the CLI's DaemonClient stamps once from the seat
 * env (X-OpenRig-Session); the channel of record records only that derived identity, never a
 * request-body claim (a body-supplied actor is forgeable false history — the ranked buggy/stale-caller
 * class). Absent header ⇒ refuse-unattributable LOUD (401), naming the verb.
 *
 * Adopt-and-drop transitional window (per the P21 plan): while a surface still carries its legacy body
 * identity field + CLI flag, a body claim is tolerated ONLY when it EQUALS the transport identity;
 * a DIFFERENT claim refuses-loud `identity_mismatch` (409) naming BOTH values — never silently prefer
 * either. The field + flag drop at the surface's completion fold, after which no bodyClaim is passed.
 */
export const SENDER_IDENTITY_HEADER = "x-openrig-session";

export type SenderIdentity =
  | { ok: true; session: string }
  | { ok: false; response: Response };

export function requireSenderIdentity(
  c: Context,
  opts?: { verb?: string; bodyClaim?: string | null },
): SenderIdentity {
  const verb = opts?.verb ?? "this action";
  const session = c.req.header(SENDER_IDENTITY_HEADER)?.trim();
  if (!session) {
    return {
      ok: false,
      response: c.json({
        error: "unattributable_sender",
        message:
          `Refusing ${verb}: no authenticated sender identity (X-OpenRig-Session header absent). ` +
          "The channel of record records only a transport-derived actor, never a request-body claim.",
      }, 401),
    };
  }
  const claim = opts?.bodyClaim?.trim();
  if (claim && claim !== session) {
    return {
      ok: false,
      response: c.json({
        error: "identity_mismatch",
        message:
          `Refusing ${verb}: the request body claims actor "${claim}" but the authenticated transport ` +
          `identity is "${session}". The body-supplied actor is not accepted — remove it (the transport ` +
          "header is authoritative).",
      }, 409),
    };
  }
  return { ok: true, session };
}

/**
 * P21 — the CLOSED era-provenance union stamped on identity-carrying rows (PM-ratified pin). A shared
 * type so every producer (this helper, the forwarding re-stamp, the recorded-provenance decider) speaks
 * the same closed alphabet:
 *   - `transport:v1` — derived from the transport chokepoint (X-OpenRig-Session on a local request).
 *   - `relay:v1`     — a forwarding daemon re-stamped from its OWN authenticated context (cross-host).
 *   - `claimed:v1`   — a founder-visible-surface UI/MCP tap under a not-yet-plumbed principal (the named
 *                      deferral); honest "pre-verification" of a TODAY actor.
 * NULL / absent is deliberately NOT a member — it is reserved for pre-sweep-legacy / unstamped rows, so a
 * legacy row stays distinguishable from a `claimed:v1` tap today (the era boundary). A forward must
 * PRESERVE `claimed:v1` (never upgrade it to transport:v1/relay:v1 — that would launder unverified→verified).
 */
export type IdentityProvenance = "transport:v1" | "relay:v1" | "claimed:v1";

export type ActorWithDeferral =
  // provenance is the NON-RELAY subset: this helper only ever produces transport:v1 (header present) or
  // claimed:v1 (the deferral); relay:v1 belongs to the cross-host forward, not a local route derivation.
  | { ok: true; session: string; provenance: Exclude<IdentityProvenance, "relay:v1"> }
  | { ok: false; response: Response };

/**
 * P21 §2 + rail-addendum d00c468d — the FOUNDER-VISIBLE-surface variant of requireSenderIdentity.
 * Header PRESENT ⇒ identical transport derivation (derive + 409-on-mismatch + `transport:v1`).
 * Header ABSENT ⇒ a NAMED PER-SURFACE DEFERRAL instead of refuse-loud: refusing would break a shipped
 * founder-visible flow (the browser UI review-actions + useFiles sites the CLI chokepoint can't reach),
 * so the body-supplied actor is recorded as the DECLARED claimed-era variant `claimed:v1` (a TODAY tap
 * under a not-yet-plumbed principal — honest "pre-verification", distinct from a legacy null row).
 * This is NEVER silent-accept — the claimed:v1 era-stamp IS the visible gap — and NEVER silent-break. A
 * body actor is still required (some actor must be on the record); its verification is the named gap
 * whose owner + plumbing-path are documented per increment. Use ONLY on surfaces PM-ruled founder-
 * visible-flow-breaking (d00c468d: ui review approve/resolve/refreeze + useFiles write); everything else
 * uses requireSenderIdentity (refuse-loud default).
 */
export function resolveActorWithDeferral(
  c: Context,
  opts?: { verb?: string; bodyClaim?: string | null },
): ActorWithDeferral {
  const verb = opts?.verb ?? "this action";
  const session = c.req.header(SENDER_IDENTITY_HEADER)?.trim();
  const claim = opts?.bodyClaim?.trim();
  if (session) {
    // Transport path (CLI/DaemonClient stamped the header): derive + 409 on a differing body claim.
    if (claim && claim !== session) {
      return {
        ok: false,
        response: c.json({
          error: "identity_mismatch",
          message:
            `Refusing ${verb}: the request body claims actor "${claim}" but the authenticated transport ` +
            `identity is "${session}". The body-supplied actor is not accepted — remove it (the transport ` +
            "header is authoritative).",
        }, 409),
      };
    }
    return { ok: true, session, provenance: "transport:v1" };
  }
  // Header absent = the browser UI / MCP path → NAMED DEFERRAL (never-break): record the body actor as
  // the DECLARED claimed-era variant `claimed:v1` (not null). A claimed-era actor is still required.
  if (!claim) {
    return {
      ok: false,
      response: c.json({
        error: "actor_required",
        message:
          `Refusing ${verb}: no authenticated transport identity (X-OpenRig-Session absent) and no body ` +
          "actor to record. The channel of record needs at least a claimed-era actor.",
      }, 400),
    };
  }
  return { ok: true, session: claim, provenance: "claimed:v1" };
}
