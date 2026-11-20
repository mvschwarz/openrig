// Slice-04 (OPR.0.5.0.4) — the four-block ASSEMBLY (packet 3ffa3c22 §1, proof item 4).
// A PURE assembler over already-collected inputs (no CLI/auth I/O — collection is a separate
// seam). It emits real bound rows + explicit unbound rows (no registry placement, no anomaly),
// computes same_account_on_n_seats ONLY from repeated real account IDs, attaches anomalies
// deterministically, preserves signals unchanged, and invents no IDs/boundAt/asOf.

import type {
  BindingAnomaly,
  FourBlockReadModel,
  ProviderAccount,
  ProviderBinding,
  ProviderSignal,
  SameAccountOnNSeatsAnomaly,
} from "./provider-types.js";

/**
 * A collected seat↔account fact — a discriminated bound/unbound union over the honest field
 * set (no anomalies; the assembler computes those). Mirrors ProviderBinding so the collector
 * never has to fabricate account/binding data for an unbound seat.
 */
export type RawSeatBinding =
  | { accountId: string; seatSession: string; rigName: string; boundAt: string; bindingSource: string }
  | { accountId: null; seatSession: string; rigName: string; boundAt: null; bindingSource: null };

export interface AssembleInput {
  accounts: ProviderAccount[];
  rawBindings: RawSeatBinding[];
  signals: ProviderSignal[];
  /** The read model's asOf — a real caller-provided timestamp; anomalies borrow it (not invented). */
  asOf: string;
}

export function assembleFourBlock(input: AssembleInput): FourBlockReadModel {
  const { accounts, rawBindings, signals, asOf } = input;

  // Group DISTINCT seat sessions by REAL account id (unbound/null-account seats never
  // contribute). A Set so duplicate raw rows for the same account+seat cannot inflate the count.
  const seatsByAccount = new Map<string, Set<string>>();
  for (const rb of rawBindings) {
    if (rb.accountId === null) continue;
    const set = seatsByAccount.get(rb.accountId) ?? new Set<string>();
    set.add(rb.seatSession);
    seatsByAccount.set(rb.accountId, set);
  }

  // A same_account_on_n_seats anomaly per account genuinely shared across >= 2 DISTINCT seats.
  const sharedAnomalyByAccount = new Map<string, SameAccountOnNSeatsAnomaly>();
  for (const [accountId, seats] of seatsByAccount) {
    if (seats.size < 2) continue;
    const sortedSeats = [...seats].sort(); // deterministic
    sharedAnomalyByAccount.set(accountId, {
      kind: "same_account_on_n_seats",
      count: sortedSeats.length,
      seats: sortedSeats,
      evidence: `account ${accountId} bound on ${sortedSeats.length} seats: ${sortedSeats.join(", ")}`,
      asOf,
    });
  }

  const bindings: ProviderBinding[] = rawBindings.map((rb) => {
    if (rb.accountId === null) {
      // No applicable registry placement says nothing about the account the seat uses, so it isn't an anomaly:
      // the null placement fields already state the measured fact.
      return {
        accountId: null,
        seatSession: rb.seatSession,
        rigName: rb.rigName,
        boundAt: null,
        bindingSource: null,
        anomalies: [],
      };
    }
    const shared = sharedAnomalyByAccount.get(rb.accountId);
    const anomalies: BindingAnomaly[] = shared ? [shared] : [];
    return {
      accountId: rb.accountId,
      seatSession: rb.seatSession,
      rigName: rb.rigName,
      boundAt: rb.boundAt,
      bindingSource: rb.bindingSource,
      anomalies,
    };
  });

  return {
    accounts,
    bindings,
    signals, // preserved unchanged
    asOf,
  };
}
