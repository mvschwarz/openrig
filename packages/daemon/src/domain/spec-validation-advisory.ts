// OPR.0.5.3.3 — spec-validation advisory: alias-form model pins.
//
// CANONICAL_MODEL_PINS below is the SINGLE alias mapping home (f7dfca0c): this advisory nudges
// spec authors toward canonical ids at `rig spec validate` time, and the model-divergence
// detector canonicalizes the PINNED string through the same map before comparing (modelsMatch),
// so a known alias pin running exactly its canonical model no longer proclaims a false
// divergence. Do not grow a second mapping anywhere else.
//
// It is an ADVISORY, never an error (FAIL-OPEN): an alias pin a human already wrote still
// validates, and the nudge stands — canonical pins keep specs exact at the source. (The
// migration-bridge deletion contract this module's filename once triggered is completed: the
// bridge is deleted from model-divergence-monitor.ts.)

/** Measured alias -> canonical model-id map (keys lower-cased, values canonical ids). The ONE
 *  mapping home for both spec validation and the runtime detector; extend only as further alias
 *  forms are measured.
 *
 *  NULL-PROTOTYPE on purpose (r2 BLOCKING-1, f7dfca0c round 2): pins are arbitrary user strings,
 *  and on an ordinary object a lookup like map["constructor"] or map["__proto__"] returns an
 *  INHERITED Object.prototype member instead of undefined — the detector then threw mid-pass and
 *  the advisory fabricated a canonical id. With no prototype, every non-measured key reads
 *  undefined and both consumers' `?? `/null fallbacks behave. Keep this representation when
 *  extending the map; the suites pin the prototype and the behavior. */
export const CANONICAL_MODEL_PINS: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  { fable: "claude-fable-5" },
);

/**
 * If `pin` is a known alias form, return a named advisory stating the canonical id; else null.
 * `where` locates the pin in the spec (e.g. "pods.dev.members.driver").
 */
export function aliasModelPinAdvisory(pin: unknown, where: string): string | null {
  if (typeof pin !== "string" || pin.trim() === "") return null;
  const canonical = CANONICAL_MODEL_PINS[pin.trim().toLowerCase()];
  if (!canonical) return null;
  return `${where}: model pin "${pin}" is an alias form — pin the canonical id "${canonical}" ` +
    `(5.3 prefers canonical pins at the source; the runtime detector canonicalizes known aliases ` +
    `through this same map, but an unmeasured alias still proclaims divergence).`;
}
