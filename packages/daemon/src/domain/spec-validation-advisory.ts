// OPR.0.5.3.3 — spec-validation advisory: alias-form model pins.
//
// The model-divergence detector requires exact/canonical model pins (the alias-tolerance bridge
// expired at 5.3 — see SPEC_VALIDATION_CAPABILITIES in rigspec-schema + modelsMatch). This advisory
// warns, at `rig spec validate` time, when a spec pins an ALIAS form and names the canonical id.
//
// It is an ADVISORY, never an error (FAIL-OPEN): an alias pin a human already wrote still validates,
// but the operator is nudged toward the canonical id before the detector proclaims a false
// divergence at runtime. This module's FILENAME is also the behavioral marker the migration-bridge
// deletion contract keys on (model-divergence-monitor.test.ts): once it exists, the bridge is empty.

/** Measured alias -> canonical model-id map (keys lower-cased). Mirrors the now-expired migration
 *  bridge's one measured pair; extend as further alias forms are measured. */
export const CANONICAL_MODEL_PINS: Record<string, string> = {
  fable: "claude-fable-5",
};

/**
 * If `pin` is a known alias form, return a named advisory stating the canonical id; else null.
 * `where` locates the pin in the spec (e.g. "pods.dev.members.driver").
 */
export function aliasModelPinAdvisory(pin: unknown, where: string): string | null {
  if (typeof pin !== "string" || pin.trim() === "") return null;
  const canonical = CANONICAL_MODEL_PINS[pin.trim().toLowerCase()];
  if (!canonical) return null;
  return `${where}: model pin "${pin}" is an alias form — pin the canonical id "${canonical}" ` +
    `(5.3 requires exact/canonical pins; the model-divergence detector no longer tolerates aliases).`;
}
