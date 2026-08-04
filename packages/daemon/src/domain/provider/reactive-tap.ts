import type { AgentActivity } from "../types.js";
import type { CodexAuthMetadata } from "./codex-auth-reader.js";
import { reactiveEventSignal, type ReactiveEventKind } from "./provider-signals.js";
import type { ProviderSignal } from "./provider-types.js";

interface ReactiveSeat {
  seatSession: string;
  runtime: string;
}

interface ReactiveActivityReader {
  getLatestForNode(input: { sessionName: string; now: Date }): AgentActivity | null;
}

export interface ReactiveTapDeps {
  seats: readonly ReactiveSeat[];
  auth: CodexAuthMetadata;
  activity: ReactiveActivityReader;
  now: string;
  freshnessMs: number;
}

const EVENT_KINDS: Readonly<Record<string, ReactiveEventKind>> = {
  at_limit: "at_limit",
  rate_limit: "at_limit",
  rate_limited: "at_limit",
  stream_failure: "stream_failure",
  stream_fail: "stream_failure",
  stop_error: "stop_error",
};

/**
 * Map the current structured activity for each honestly identified Codex seat into reactive
 * provider rows. Generic needs-input activity is deliberately insufficient: permission prompts
 * are blocked seats too, but are not provider interruptions. Only the exact typed vocabulary above
 * is accepted, with raw subtype taking precedence over raw event and normalized reason.
 */
export function collectReactiveEventSignals(deps: ReactiveTapDeps): ProviderSignal[] {
  const nowMs = Date.parse(deps.now);
  if (!Number.isFinite(nowMs) || !Number.isFinite(deps.freshnessMs) || deps.freshnessMs <= 0) return [];

  // Honest reactive eligibility, centralized. The account ref must name a KNOWN auth
  // profile (a file in auth-profiles/), not merely a nonempty registry token: a registry
  // row that points at an absent profile has no account identity and must produce NO
  // actionable row (explicit-unknown honesty, never a fabricated account).
  const knownProfiles = new Set(deps.auth.profiles);
  const accountBySeat = new Map(
    deps.auth.seats
      .filter((seat) => seat.runtime === "codex" && knownProfiles.has(seat.authProfile.trim()))
      .map((seat) => [seat.seat, seat.authProfile] as const),
  );
  const signals: ProviderSignal[] = [];

  for (const seat of deps.seats) {
    if (seat.runtime !== "codex") continue;
    const accountRef = accountBySeat.get(seat.seatSession);
    if (!accountRef) continue;

    const event = deps.activity.getLatestForNode({
      sessionName: seat.seatSession,
      now: new Date(nowMs),
    });
    if (!event || event.stale) continue;
    // The PERSISTED activity runtime must itself be Codex. A claude-code activity attached
    // to a Codex inventory/registry seat is NOT Codex provider evidence and must never be
    // relabeled as one — eligibility follows the event, not just the seat.
    if (event.runtime !== "codex") continue;

    const kind = eventKind(event);
    const eventAt = event.eventAt;
    if (!kind || typeof eventAt !== "string") continue;
    const eventAtMs = Date.parse(eventAt);
    if (!Number.isFinite(eventAtMs)) continue;
    const staleAfterMs = eventAtMs + deps.freshnessMs;
    // BR-2 expiry is inclusive: at the bound, the event is already stale.
    if (nowMs >= staleAfterMs) continue;

    signals.push(reactiveEventSignal({
      provider: "codex",
      accountRef,
      kind,
      asOf: eventAt,
      staleAfter: new Date(staleAfterMs).toISOString(),
    }));
  }

  return signals;
}

// Classification binds to the structured provider-interruption PRODUCER CLASS — the
// event class itself (`rawEvent`), matched exactly against the declared interruption
// vocabulary. The managed hook relay maps a tool_name into `rawSubtype`, so a generic
// lifecycle event (e.g. a `PermissionRequest` with a `rate_limit` tool-name subtype) is a
// permission block, never exhaustion; and a normalized `reason` is a derived field, not a
// producer. Only an event whose class is an explicit interruption producer is actionable —
// an unproven producer yields no row (fail-visible, never fabricated).
function eventKind(activity: AgentActivity): ReactiveEventKind | null {
  const eventClass = activity.rawEvent;
  if (typeof eventClass !== "string") return null;
  return EVENT_KINDS[eventClass] ?? null;
}
