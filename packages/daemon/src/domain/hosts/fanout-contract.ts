// OPR.0.4.4.15 — THE shared intra-P4 fan-out payload contract.
//
// ONE contract for the whole P4 packet (arch adjudication 2026-07-05,
// cross-PRD interface cell): slice 15's aggregated For-You attention feed
// AND slice 21's `rig ps --all-hosts` rollup both speak AggregatedPayload —
// items plus a per-host structured status array. Slice 15 defines this
// module (first lander, per the whichever-builds-first rule named in both
// PRDs); slice 21 IMPORTS it. Any change here is a CROSS-PRD contract
// change requiring re-review of BOTH slices — never driver discretion.

/** The local host's id literal in every P3/P4 payload (arch pin: defined
 *  ONCE here, imported everywhere, never retyped). Matches slice 11's
 *  topology aggregate literal. */
export const LOCAL_HOST_ID = "local";

// 51-09 increment 2 — the daemon's durable self-host id (increment 1's
// self_host_identity), published beside the LOCAL_HOST_ID sentinel and
// populated ONCE at boot (startup calls setSelfHostId after
// reconcileSelfHostIdentity). This is ADDITIVE — it does NOT touch the
// AggregatedPayload / PerHostStatus cross-PRD contract below; it only exposes
// the origin's OWN stable, operator-meaningful identity, DISTINCT from the
// "local" positional sentinel ("whoever is local"): both route home, but they
// are different tokens and the self-id never BECOMES 'local'. Null until boot
// resolves it. A module accessor (this single shared host-contract module) so
// the read-through AND the queue-destination validator (increment 4) resolve
// the self-id from ONE source without a server.ts/context plumb.
let selfHostId: string | null = null;

/** Publish the boot-resolved self-host id (startup, once). null resets (tests). */
export function setSelfHostId(id: string | null): void {
  selfHostId = id;
}

/** The boot-resolved self-host id, or null before boot has reconciled it. */
export function getSelfHostId(): string | null {
  return selfHostId;
}

// Slice 14 §2c — the id's PROVENANCE, resolved once at boot beside the id itself.
//
// Deliberately NOT derived per request: it needs the operator's configured `host.name`, and reading
// settings inside the /healthz handler put file I/O on the hottest path in the daemon and blew the
// ps+summary burst latency budget (caught by ps-summary-stall-red). Same lifecycle as the id: set
// once at boot, read for free thereafter.
let selfHostIdSource: string | null = null;

/** Publish the boot-derived self-host id source (startup, once). null resets (tests). */
export function setSelfHostIdSource(source: string | null): void {
  selfHostIdSource = source;
}

/** The boot-derived self-host id source, or null before boot has reconciled it. */
export function getSelfHostIdSource(): string | null {
  return selfHostIdSource;
}

/**
 * The shared self-resolution convention: does a host token route to THIS host?
 * True for an absent/empty token, the `LOCAL_HOST_ID` positional sentinel, and
 * the daemon's own resolved self-id. The self-id comparison is CASE-SENSITIVE —
 * the same convention as increment 1's candidate-vs-stored check, so the two
 * identity layers agree on case (a case-only divergence is a distinct token).
 * `selfId` is passed explicitly (defaults to the boot-resolved id) so the
 * predicate is pure + unit-testable.
 */
export function resolvesToLocalHost(
  hostToken: string | undefined | null,
  selfId: string | null = selfHostId,
): boolean {
  if (hostToken === undefined || hostToken === null || hostToken === "") return true;
  if (hostToken === LOCAL_HOST_ID) return true;
  return selfId !== null && hostToken === selfId;
}

/** CLOSED enum (arch pin A). `unsupported-transport` is R15-2's explicit
 *  class (an SSH-declared host is never a silently thinner payload);
 *  `auth-failed` is distinct from `unreachable` because the operator fix
 *  differs (rotate/set the bearer vs check the host). Extending this set =
 *  a cross-PRD contract change (slices 15 AND 21 re-review). */
export type PerHostStatusKind = "ok" | "unreachable" | "unsupported-transport" | "auth-failed";

export interface PerHostStatus {
  hostId: string;
  status: PerHostStatusKind;
  /** Honest failure detail, rendered muted next to the host chip/row. */
  error?: string;
  /** ADDITIVE OPTIONAL detail (arch adjudication): the shipped CLI
   *  FailedStep vocabulary when a transport-level step classified the
   *  failure. Never load-bearing — `status` is the contract. */
  failedStep?: string;
}

/** items + per-host status: EVERY subscribed host appears in `hosts` on
 *  EVERY payload — ok, unreachable, auth-failed, or unsupported-transport.
 *  Absence is a contract violation (omission-proof; never all-or-nothing,
 *  never silent thinning). */
export interface AggregatedPayload<T> {
  items: T[];
  hosts: PerHostStatus[];
}

/** Contract-level completeness predicate (arch pin B: asserted as near to
 *  the contract as tests allow): true iff every expected host id appears
 *  exactly once in the payload's hosts array. */
export function hostsCovered(payload: AggregatedPayload<unknown>, expectedHostIds: string[]): boolean {
  const seen = new Map<string, number>();
  for (const h of payload.hosts) seen.set(h.hostId, (seen.get(h.hostId) ?? 0) + 1);
  return expectedHostIds.every((id) => seen.get(id) === 1) && payload.hosts.length === expectedHostIds.length;
}
