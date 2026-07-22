// Living Notes Packet 2 — the surface's action layer (OPR.0.4.4.20).
//
// BR-9: every surface action invokes the SAME verb/write-path Packet 1 lands —
// never a parallel writer, never a synthetic qitem. The founder-facing
// affordances are exactly TWO (APPROVE + CHAT, SS14); route-back and
// not-faithful outcomes ride CHAT-then-agent-records through the same
// Packet-1 mechanisms.
//
// Until Packet 1's producers land, these calls surface HONEST structured
// errors (the endpoints are named by contract; fixtures stand in for reads).
// Actor provenance: the REAL resolving session; human/on-behalf-of is
// delegation metadata recorded daemon-side, never the actor (#6).

import { CHAT_PREAMBLE_SUFFIX } from "./chat.js";

export interface ActionOutcome {
  ok: boolean;
  /** Honest failure surface — rendered verbatim next to the affordance. */
  message: string;
}

async function post(url: string, body: unknown): Promise<ActionOutcome> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, message: "recorded" };
    let detail = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { error?: string; message?: string; hint?: string };
      detail = json.message ?? json.error ?? detail;
      if (json.hint) detail += ` — ${json.hint}`;
    } catch {
      /* body not json */
    }
    return { ok: false, message: detail };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * APPROVE (slice-terminal): the Packet-1 FR-9 approve verb — frontmatter
 * sole-writer + audit row; the delivery stamp fires the compose-and-freeze.
 * Body shape matches the SHIPPED Packet-1 route contract
 * (routes/scope-approve.ts: scopeTier / scopePath / actorSession /
 * approvalScope — rev1-r2 fixback at d6135921; the earlier guessed field
 * names failed the real route's scope_tier_invalid validation).
 */
export function approveSlice(scopePath: string, actor: string, scope: "spec" | "delivery" = "delivery"): Promise<ActionOutcome> {
  return post("/api/scope/approve", {
    scopeTier: "slice",
    scopePath,
    actorSession: actor,
    approvalScope: scope,
  });
}

/**
 * slice-04 REV6 — the ONE derivation of the scope-approve caller value, shared by
 * EVERY nested approve control (mission board + slice NEEDS YOU) so they cannot
 * drift. The daemon contract (routes/scope-approve.ts) is a missions-root-RELATIVE
 * path `<mission>/slices/<slice>`; a bare slice name is the legacy root-slice
 * fallback (missionId null/absent). This is a pure API value — NEVER an absolute
 * filesystem path (e.g. SliceDetail.slicePath): the route (path.resolve +
 * containment) would accept and canonicalize a contained absolute path, so this is
 * not about a 404 — it is that an absolute path couples the API value to host-local
 * filesystem identity and violates the missions-root-relative scopePath contract.
 */
export function sliceScopePath(missionId: string | null | undefined, slice: string): string {
  return missionId ? `${missionId}/slices/${slice}` : slice;
}

/**
 * RESOLVE (leg-1 park): the Packet-1 FR-7 mission-control verb — ONE write
 * path, decision text lands in queue_transitions.transition_note, unpark +
 * nudge in the same transaction. `resolve` is additive to the shipped verb
 * enum; pre-P1 the route rejects it with a structured error (honest).
 */
export function resolveQitem(qitemId: string, decision: string, actorSession: string): Promise<ActionOutcome> {
  return post("/api/mission-control/action", {
    verb: "resolve",
    qitemId,
    decision,
    actorSession,
  });
}

/** The freeze re-invoke (idempotent; FR-6) — exposed for the LOCKED receipt. */
export function refreeze(slice: string, actor: string): Promise<ActionOutcome> {
  return post("/api/review/freeze", { scope: "slice", name: slice, actor });
}

export { CHAT_PREAMBLE_SUFFIX };
