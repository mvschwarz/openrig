// Slice-04 (OPR.0.5.0.4) seam C1 (resume) — the getReadModel COLLECTION seam. A pure function
// over injected inputs (the codex-auth metadata reader + a cross-rig seat lister + a clock), so the
// production read-model path is directly testable without a live daemon/db. It maps codex-auth
// profiles → accounts[] (authState="unknown" per BR-3 validate-at-use — NEVER assert active/
// needs_reauth from static disk), joins the seat universe to the codex seat-registry into
// rawBindings[] (unregistered/claude seats → unbound: no registry placement, which isn't an anomaly),
// carries signals through (empty until the live signal-collection lane), and delegates all anomaly
// computation to assembleFourBlock.

import type { CodexAuthMetadata } from "./codex-auth-reader.js";
import { rollupHostUsage } from "./host-usage-rollup.js";
import { assembleFourBlock, type RawSeatBinding } from "./provider-read-model.js";
import { claudeStatuslineSignals } from "./provider-signals.js";
import type { FourBlockReadModel, ProviderAccount, ProviderSignal, SeatAccountConfiguration, UnknownSeatObservation } from "./provider-types.js";
import type { NodeLifecycleState } from "../types.js";
import type { SeatRuntimeHome } from "../seat-runtime-home.js";

/** One seat in the fleet (the universe to bind), sourced from node-inventory across rigs. */
export interface ProviderSeat {
  seatSession: string;
  rigName: string;
  runtime: string;
  lifecycleState: NodeLifecycleState;
  /** The seat's own runtime home from its stored `env:`, when it declares one (seat-runtime-home.ts). */
  runtimeHome?: SeatRuntimeHome;
  /** A Claude seat's own token reference, which its next launch reads: the label is the operator's name for it. */
  claudeToken?: { label: string; kind?: "api-key" };
}

export interface ProviderCollectDeps {
  /** Reads codex-auth on-disk METADATA (profile names + seat registry) — never token content. */
  readCodexAuth: () => CodexAuthMetadata;
  /** The current seat universe (node-inventory across all rigs). */
  listSeats: () => ProviderSeat[];
  /** signals[] — empty until the live Codex/Claude/reactive collection lane is wired. */
  collectSignals?: () => ProviderSignal[];
  /** Each seat's configured account, one per seat in the order given (configuredSeatAccounts). */
  configuredAccounts?: (seats: ProviderSeat[]) => SeatAccountConfiguration[];
  /** A real caller-provided clock; the read model's asOf (anomalies borrow it, never invented). */
  now: () => string;
}

export function collectFourBlockReadModel(deps: ProviderCollectDeps): FourBlockReadModel {
  const asOf = deps.now();
  const { profiles, seats } = deps.readCodexAuth();
  const seatUniverse = deps.listSeats();

  // accounts[] — one row per known codex profile. BR-3: authState is "unknown" (validate-at-use);
  // static disk presence proves the profile exists, NOT that its auth is currently valid.
  const accounts: ProviderAccount[] = profiles.map((name) => ({
    accountId: name,
    label: name,
    provider: "codex",
    authState: "unknown",
    profileRef: name,
    asOf,
  }));

  // seat session → codex-auth registry row (the only binding source in this seam).
  const registryBySeat = new Map(seats.map((s) => [s.seat, s]));

  const rawBindings: RawSeatBinding[] = seatUniverse.map((seat) => {
    const reg = registryBySeat.get(seat.seatSession);
    // Runtime-identity gate: bind ONLY when the LIVE inventory seat is actually a Codex seat. The
    // codex auth-seat-registry is keyed by session name, so a STALE row whose session name was
    // reused by a Claude seat must NOT bind that Claude seat to a Codex account — a Claude seat
    // stays unbound regardless of any same-session registry row. The registry lives in
    // the daemon's CODEX_HOME, so it binds nothing for a seat that launches with its own.
    if (reg && seat.runtime === "codex" && !seat.runtimeHome?.home) {
      return {
        accountId: reg.authProfile,
        seatSession: seat.seatSession,
        rigName: seat.rigName,
        boundAt: reg.updatedTs,
        bindingSource: "codex_auth_seat_registry",
      };
    }
    // Unregistered/non-codex (claude seats, codex seats with no registry row) → unbound: no applicable
    // registry placement, never a missing account. We never fabricate a sentinel account.
    return {
      accountId: null,
      seatSession: seat.seatSession,
      rigName: seat.rigName,
      boundAt: null,
      bindingSource: null,
    };
  });

  const liveClaudeSeats = new Set(
    seatUniverse
      .filter((seat) => seat.runtime === "claude-code" && seat.lifecycleState === "running")
      .map((seat) => seat.seatSession),
  );
  const signals = (deps.collectSignals ? [...deps.collectSignals()] : []).filter((signal) =>
    signal.provider !== "claude" || !signal.seatSession || liveClaudeSeats.has(signal.seatSession),
  );
  const signaledClaudeSeats = new Set(
    signals.filter((signal) => signal.provider === "claude" && signal.seatSession).map((signal) => signal.seatSession!),
  );
  // Cache discovery is never the seat-discovery authority. Every live Claude seat must have a
  // row even before its first statusline payload (or when its cache is malformed/absent).
  for (const seatSession of liveClaudeSeats) {
    if (signaledClaudeSeats.has(seatSession)) continue;
    signals.push(...claudeStatuslineSignals({ seatSession, cachePresent: false, asOf }));
  }
  const model = assembleFourBlock({ accounts, rawBindings, signals, asOf });
  // Beside each seat's registry placement, what the seat uses: the configuration its next launch reads, and its
  // launch and provider observations, which nothing records yet. The assembler keeps order, so bindings[i] is seat i.
  const configured = deps.configuredAccounts?.(seatUniverse);
  const bindings = model.bindings.map((binding, i) => ({
    ...binding,
    runtime: seatUniverse[i]!.runtime,
    ...(configured?.[i] ? { configured: configured[i] } : {}),
    launched: LAUNCH_NOT_RECORDED,
    verified: IDENTITY_NOT_OBSERVED,
  }));
  // Slice-04 S-A: the host-level rollup aggregates the SAME signals this collection produced.
  // Codex deployment presence = auth profiles on disk (a host with codex accounts but no meter
  // must surface an explicit unknown, never an omitted row).
  return {
    ...model,
    bindings,
    hostUsage: rollupHostUsage({ signals, codexProfilesPresent: profiles.length > 0, now: asOf }),
  };
}

const LAUNCH_NOT_RECORDED: UnknownSeatObservation = {
  state: "unknown",
  reason: "OpenRig doesn't record which credential a seat's launch applied",
};
const IDENTITY_NOT_OBSERVED: UnknownSeatObservation = {
  state: "unknown",
  reason: "no provider-observed identity is tied to this seat's launch; a stored reading names an operator's label or the login a home holds, not this seat's",
};
