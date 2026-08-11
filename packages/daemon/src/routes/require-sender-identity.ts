import type { Context } from "hono";

/**
 * P21 sender-provenance chokepoint — the ONE shared route helper that generalizes P18's inline
 * `/inbox/drop` form (b2437104) across every caller-identity site. The acting seat's identity is
 * DERIVED from the authenticated transport header the CLI's DaemonClient stamps once from the seat
 * env (X-OpenRig-Session), and the row records WHICH ERA that derivation came from.
 *
 * P18 DELIVER-AND-LABEL (founder ruling, over-engineering audit — the refusals are deleted). The two
 * refusals this helper used to raise both asserted "this sender is ILLEGITIMATE" when the only thing
 * actually known was "I cannot verify this sender at this boundary". Those are different claims and
 * the system was making the confident one:
 *   - 401 `unattributable_sender` (header absent) — DELETED. A missing header means an unmanaged
 *     terminal, not an attacker; this trust domain's only caller is the operator's own client.
 *     The honest response is to DELIVER and record the weaker era-stamp `claimed:v1`.
 *   - 409 `identity_mismatch` (body claim ≠ transport identity) — DELETED (PM, 2026-08-11, ruling (A):
 *     both refusals die, folded into this ONE sweep — the earlier one-atom-each split was retired as
 *     unnecessary ceremony). The fact that this sender IS certified is exactly why refusing them was
 *     wrong: the wire decides the actor and the body never does, so a disagreeing body claim is NOISE TO
 *     BE SUPERSEDED, not an attack to be refused. Deliver under the wire identity, labelled transport:v1;
 *     the discrepancy is NOT persisted (no new field/schema). The incident transport matrix showed this
 *     409 firing on honest-but-skewed clients (stale env / legacy --actor / relay skew), never adversaries.
 *     The byte-identical 409 in resolveActorWithDeferral (below) is retired the same way so the two
 *     sibling helpers agree on the supersede rule.
 *
 * What remains beyond that is NOT an adversary boundary: with neither a transport header nor a body
 * actor there is no actor to put on the ledger row at all, so the caller is asked for the missing
 * parameter (400 `actor_required`) — the same shape PM ruled a deliberate keep at queue.ts:215.
 * Requiring a parameter is honest help; refusing a named actor because it cannot be cryptographically
 * vouched for is not.
 *
 * The label half is NOT new machinery: `resolveRecordedProvenance` below already degrades down as its
 * default branch, and `resolveActorWithDeferral` already did deliver-and-label on founder-visible
 * surfaces. This extends that existing, correctly-degrading pattern to the sites that used to refuse.
 */
export const SENDER_IDENTITY_HEADER = "x-openrig-session";

export type SenderIdentity =
  // `provenance` is the NON-RELAY subset — this helper only ever derives locally: transport:v1 when the
  // header proved it here, claimed:v1 when it did not. relay:v1 belongs to the cross-host forward and is
  // decided by resolveRecordedProvenance, never here.
  | { ok: true; session: string; provenance: Exclude<IdentityProvenance, "relay:v1"> }
  | { ok: false; response: Response };

export function requireSenderIdentity(
  c: Context,
  opts?: { verb?: string; bodyClaim?: string | null },
): SenderIdentity {
  const verb = opts?.verb ?? "this action";
  const session = c.req.header(SENDER_IDENTITY_HEADER)?.trim();
  const claim = opts?.bodyClaim?.trim();
  if (session) {
    // Transport path — the header PROVED the actor at this hop. P18 SWEEP: the wire SUPERSEDES any body
    // claim (the 409 identity_mismatch refusal is retired). A disagreeing body actor is noise to be
    // superseded, not an attack to refuse — the wire decides the actor, the body never does. Deliver
    // under the certified transport identity, labelled transport:v1 as shipped; the discrepancy is not
    // persisted (ruling (A) — no new field/schema). `claim` is intentionally ignored on this path.
    return { ok: true, session, provenance: "transport:v1" };
  }
  // No transport identity: deliver under the body-declared actor, labelled honestly as claimed-era.
  if (claim) return { ok: true, session: claim, provenance: "claimed:v1" };
  // Neither a derived identity nor a declared one — nothing to attribute the row to. Parameter
  // completeness, not distrust.
  return {
    ok: false,
    response: c.json({
      error: "actor_required",
      message:
        `Cannot record ${verb}: no authenticated transport identity (X-OpenRig-Session absent) and no ` +
        "actor named in the request body. The channel of record needs an actor to attribute the row to — " +
        "name one, or run from a managed seat so the identity is derived for you.",
    }, 400),
  };
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
    // Transport path (CLI/DaemonClient stamped the header). P18 SWEEP: the wire SUPERSEDES any body
    // claim — the 409 identity_mismatch is retired here too, so the two sibling helpers agree that a
    // disagreeing body actor is noise to be superseded, never an attack to refuse. Deliver under the
    // certified transport identity, labelled transport:v1 as shipped; the discrepancy is not persisted.
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

/**
 * The wire header a FORWARDING daemon stamps to carry the provenance it resolved for the actor it is
 * re-stamping, so the origin hop records the TRUTH about that actor's verification instead of inferring
 * it from the mere presence of a re-stamped X-OpenRig-Session. SAME token alphabet as the store
 * (IdentityProvenance) — never an ad-hoc string. Its absence is meaningful (see resolveRecordedProvenance).
 */
export const IDENTITY_PROVENANCE_HEADER = "x-openrig-provenance";
/** Set by a forwarding daemon to mark "this arrived via a relay hop" (the actor was derived elsewhere). */
export const RELAY_HEADER = "x-openrig-relay";

/**
 * P21 §4 — the SOLE decider of the provenance RECORDED on a row (rail 2: exactly one place can ever say
 * `transport:v1`, and only when the transport actually proved it at THIS hop). `identity` is the local
 * derivation from resolveActorWithDeferral (transport:v1 = header present; claimed:v1 = the deferral).
 *
 * Direct request (no relay hop): record exactly what this hop proved — identity.provenance verbatim.
 *
 * Relayed request (a forwarding daemon re-stamped the header): NEVER `transport:v1` — the actor was, at
 * best, verified ONE HOP AWAY, so the strongest honest claim is `relay:v1`, and ONLY when the forwarder
 * explicitly carried a `transport:v1` marker. Rail 1 — DEGRADE DOWN AS THE DEFAULT BRANCH: any other
 * carried value, AND a MISSING marker (an old forwarder that predates this plumbing), records `claimed:v1`.
 * NB the honesty nuance: a missing marker and a forwarder-declared `claimed:v1` are INDISTINGUISHABLE here
 * and that is correct — both are "not verified at this boundary". `claimed:v1` on a relayed row therefore
 * means "unverified", NEVER proof the origin action was a UI tap. Uncertainty weakens the claim; it can
 * never strengthen it — a claimed-era actor can never be laundered into a verified one across a hop.
 */
export function resolveRecordedProvenance(
  c: Context,
  identity: { provenance: Exclude<IdentityProvenance, "relay:v1"> },
): IdentityProvenance {
  const relayed = !!c.req.header(RELAY_HEADER)?.trim();
  if (!relayed) return identity.provenance; // transport:v1 (proven here) | claimed:v1 (the deferral)
  const carried = c.req.header(IDENTITY_PROVENANCE_HEADER)?.trim();
  return carried === "transport:v1" ? "relay:v1" : "claimed:v1";
}
