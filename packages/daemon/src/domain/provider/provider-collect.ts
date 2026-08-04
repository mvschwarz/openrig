// Slice-04 (OPR.0.5.0.4) seam C1 (resume) — the getReadModel COLLECTION seam. A pure function
// over injected inputs (the codex-auth metadata reader + a cross-rig seat lister + a clock), so the
// production read-model path is directly testable without a live daemon/db. It maps codex-auth
// profiles → accounts[] (authState="unknown" per BR-3 validate-at-use — NEVER assert active/
// needs_reauth from static disk), joins the seat universe to the codex seat-registry into
// rawBindings[] (unregistered/claude seats → unbound, so the assembler emits seat_with_no_account),
// carries signals through (empty until the live signal-collection lane), and delegates all anomaly
// computation to assembleFourBlock.

import type { CodexAuthMetadata } from "./codex-auth-reader.js";
import { assembleFourBlock, type RawSeatBinding } from "./provider-read-model.js";
import { claudeStatuslineSignals } from "./provider-signals.js";
import type { FourBlockReadModel, ProviderAccount, ProviderSignal } from "./provider-types.js";
import type { NodeLifecycleState } from "../types.js";

/** One seat in the fleet (the universe to bind), sourced from node-inventory across rigs. */
export interface ProviderSeat {
  seatSession: string;
  rigName: string;
  runtime: string;
  lifecycleState: NodeLifecycleState;
}

export interface ProviderCollectDeps {
  /** Reads codex-auth on-disk METADATA (profile names + seat registry) — never token content. */
  readCodexAuth: () => CodexAuthMetadata;
  /** The current seat universe (node-inventory across all rigs). */
  listSeats: () => ProviderSeat[];
  /** signals[] — empty until the live Codex/Claude/reactive collection lane is wired. */
  collectSignals?: () => ProviderSignal[];
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
    // stays unbound (seat_with_no_account) regardless of any same-session registry row.
    if (reg && seat.runtime === "codex") {
      return {
        accountId: reg.authProfile,
        seatSession: seat.seatSession,
        rigName: seat.rigName,
        boundAt: reg.updatedTs,
        bindingSource: "codex_auth_seat_registry",
      };
    }
    // Unregistered/non-codex (claude seats, codex seats with no registry row) → unbound. The assembler
    // attaches the required seat_with_no_account anomaly; we never fabricate a sentinel account.
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
  return assembleFourBlock({ accounts, rawBindings, signals, asOf });
}
