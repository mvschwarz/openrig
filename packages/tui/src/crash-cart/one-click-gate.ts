// Crash-cart C3 — the one-click gate (founder rule, binding on ⏎). ⏎ is ONE keystroke IFF the restore
// plan is ZERO GENERATION (every seat resume-original). Daemon-DOWN, we compute the proxy from the C2
// read: a rig is fully recoverable when resumableCount == seatCount. Any rig with non-resumable seats
// makes ⏎ lead to a confirm screen naming those deltas — never a silent resume→fresh downgrade.

export interface OneClickRigInput {
  rigName: string;
  seatCount: number;
  resumableCount: number;
}

/** A rig that is NOT fully resumable — the seats that would be fresh-primed/awaiting-decision. */
export interface OneClickDelta {
  rigName: string;
  seatCount: number;
  resumableCount: number;
  nonResumable: number;
}

export interface OneClickGate {
  /** True ⇒ ⏎ RESTORE EVERYTHING is a single keystroke (no confirm). */
  zeroGeneration: boolean;
  /** Rigs with non-resumable seats — the confirm screen names exactly these. Empty ⇔ zeroGeneration. */
  deltas: OneClickDelta[];
}

/** Evaluate the one-click gate over the C2 discovery's per-rig resumable/seat counts. */
export function evaluateOneClickGate(discovery: { foundOnHost: OneClickRigInput[] }): OneClickGate {
  const deltas: OneClickDelta[] = discovery.foundOnHost
    .filter((r) => r.resumableCount < r.seatCount)
    .map((r) => ({
      rigName: r.rigName,
      seatCount: r.seatCount,
      resumableCount: r.resumableCount,
      nonResumable: r.seatCount - r.resumableCount,
    }));
  return { zeroGeneration: deltas.length === 0, deltas };
}
