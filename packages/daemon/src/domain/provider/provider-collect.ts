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
import type { FourBlockReadModel, ProviderAccount, ProviderSignal } from "./provider-types.js";

/** One seat in the fleet (the universe to bind), sourced from node-inventory across rigs. */
export interface ProviderSeat {
  seatSession: string;
  rigName: string;
  runtime: string;
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

  const rawBindings: RawSeatBinding[] = deps.listSeats().map((seat) => {
    const reg = registryBySeat.get(seat.seatSession);
    if (reg) {
      return {
        accountId: reg.authProfile,
        seatSession: seat.seatSession,
        rigName: seat.rigName,
        boundAt: reg.updatedTs,
        bindingSource: "codex_auth_seat_registry",
      };
    }
    // Unregistered (claude seats, and codex seats with no registry row) → unbound. The assembler
    // attaches the required seat_with_no_account anomaly; we never fabricate a sentinel account.
    return {
      accountId: null,
      seatSession: seat.seatSession,
      rigName: seat.rigName,
      boundAt: null,
      bindingSource: null,
    };
  });

  const signals = deps.collectSignals ? deps.collectSignals() : [];
  return assembleFourBlock({ accounts, rawBindings, signals, asOf });
}
