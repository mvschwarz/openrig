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
