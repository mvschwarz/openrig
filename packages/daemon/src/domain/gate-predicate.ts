// OPR.0.4.3.16 — centralized queue gate-predicate.
//
// Convention: conventions/queue-gate-predicate/README.md (frozen by
// pm-lead 2026-07-03). This is the ONE config point that decides whether a
// queue qitem is "gate work" — a review/approval step a specific role must
// act on to clear, and which can STALL. Consumers (the idle-gate watchdog
// policy) read the predicate from HERE; they never scatter tag-checks or
// body-parse the qitem (slice-16 PRD Business Rule 4).
//
// Predicate = a qitem carrying ANY `gate:<role>` tag. SECONDARY fallback:
// tier === "human-gate" maps to the `gate:human` role (subsumes the legacy
// human-gate tier for the predicate; it is NOT sufficient on its own to
// catch the guard / spec-review targets).

/** Tag namespace that marks gate work. */
export const GATE_TAG_PREFIX = "gate:";

/**
 * Known gate roles. Guidance / documentation only — the predicate accepts
 * ANY `gate:<role>` so new gate-holder roles need no code change.
 */
export const GATE_ROLES = [
  "guard",
  "spec-review",
  "pm-lead",
  "review-r1",
  "review-r2",
  "qa",
  "human",
] as const;
export type GateRole = (typeof GATE_ROLES)[number];

/** The human-approval tier that maps to the `gate:human` role (fallback). */
export const HUMAN_GATE_TIER = "human-gate";

/** True if `tag` is a well-formed `gate:<role>` tag. */
export function isGateTag(tag: string): boolean {
  return tag.startsWith(GATE_TAG_PREFIX) && tag.length > GATE_TAG_PREFIX.length;
}

/** Gate roles declared by a qitem's tags (order-preserving, de-duplicated). */
export function gateRolesOf(tags: readonly string[] | null | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const t of tags) {
    if (isGateTag(t)) {
      const role = t.slice(GATE_TAG_PREFIX.length);
      if (!seen.has(role)) {
        seen.add(role);
        roles.push(role);
      }
    }
  }
  return roles;
}

export interface GatePredicateInput {
  tags: readonly string[] | null | undefined;
  tier?: string | null;
}

/**
 * THE predicate: is this qitem gate work?
 * Primary: any `gate:<role>` tag. Secondary fallback: tier === "human-gate".
 */
export function qitemIsGated(input: GatePredicateInput): boolean {
  if (gateRolesOf(input.tags).length > 0) return true;
  if (input.tier === HUMAN_GATE_TIER) return true; // → gate:human
  return false;
}

/**
 * Effective gate roles for a qitem, including the human-gate tier fallback
 * surfaced as the `human` role. Empty iff the qitem is not gate work.
 */
export function effectiveGateRoles(input: GatePredicateInput): string[] {
  const roles = gateRolesOf(input.tags);
  if (input.tier === HUMAN_GATE_TIER && !roles.includes("human")) roles.push("human");
  return roles;
}
