/** One observed native server slot. Unknown transport/identity is not absence. */
export type NativeExchangeSlot =
  | { state: "absent" }
  | { state: "present"; generation: string }
  | { state: "unknown" };

export interface NativeExchangeIdentity {
  canonical: string;
  staging: string;
  parking: string;
  predecessorGeneration: string;
  successorGeneration: string;
}

export type NativeExchangeStep =
  | { state: "complete" }
  | { state: "rename"; from: string; to: string }
  | { state: "blocked"; reason: string };

/** Plan exactly one rename from fresh observations. The caller must persist
 * custody before the first write and reobserve after every attempted rename,
 * including timeouts. Never infer success/failure from a client exit alone.
 *
 * psmux keeps each ConPTY in its own server. Three name changes exchange their
 * addresses without exporting the PTYs or making one server depend on another.
 * This planner deliberately does not retire either server or redirect clients.
 */
export function nextNativeRuntimeExchangeStep(
  identity: NativeExchangeIdentity,
  slots: { canonical: NativeExchangeSlot; staging: NativeExchangeSlot; parking: NativeExchangeSlot },
  direction: "forward" | "rollback",
): NativeExchangeStep {
  const { canonical, staging, parking, predecessorGeneration: predecessor, successorGeneration: successor } = identity;
  const blocked = (reason: string): NativeExchangeStep => ({ state: "blocked", reason });
  if ([canonical, staging, parking].some(name => !name || /[\x00-\x1f<>:"/\\|?*]/.test(name) || /[. ]$/.test(name))
    || new Set([canonical, staging, parking]).size !== 3
    || !/^[A-Za-z0-9_-]{1,128}$/.test(predecessor) || !/^[A-Za-z0-9_-]{1,128}$/.test(successor)
    || predecessor === successor) return blocked("Native exchange identities are missing or ambiguous");
  const role = (slot: NativeExchangeSlot): string => slot.state === "absent" ? "-"
    : slot.state === "unknown" ? "?" : slot.generation === predecessor ? "p" : slot.generation === successor ? "s" : "?";
  const observed = [slots.canonical, slots.staging, slots.parking].map(role).join("");
  const rename = (from: string, to: string): NativeExchangeStep => ({ state: "rename", from, to });
  switch (observed) {
    case "ps-": return direction === "forward" ? rename(canonical, parking) : { state: "complete" };
    case "-sp": return direction === "forward" ? rename(staging, canonical) : rename(parking, canonical);
    case "s-p": return direction === "forward" ? rename(parking, staging) : rename(canonical, staging);
    case "sp-": return direction === "forward" ? { state: "complete" } : rename(staging, parking);
    default: return blocked("Native exchange slots do not establish both expected occupants; no rename is safe");
  }
}
