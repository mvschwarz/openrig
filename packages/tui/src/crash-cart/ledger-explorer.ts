// Crash-cart shell-placement rework (ruling 3c6c2be0) — the LEDGER-FED explorer model. Daemon-down the
// explorer sidebar stays present but is fed from the SAME one-JSON crash-cart discovery (rigs+seats —
// never a second read path) and HONESTLY MARKED as ledger-sourced. The in-pane split's left column
// renders these rows + the honest note; on restore the shell swaps this source for the live navigator.
export interface LedgerExplorerRow {
  label: string;
  rigName: string;
  seatCount: number;
}

export interface LedgerExplorer {
  /** Always true here — this sidebar is fed from the ledger (the crash-cart one-JSON), not the daemon. */
  ledgerSourced: true;
  /** The honest marker shown on the sidebar (the founder's ledger-sourced honesty requirement). */
  note: string;
  rows: LedgerExplorerRow[];
}

/** The per-rig shape the ledger explorer reads — the crash-cart MODEL's foundOnHost (built from the
 *  SAME one-JSON discovery, so this is not a second read). */
export interface LedgerRigInput {
  name: string;
  seatCount: number;
}

/** Build the ledger-fed explorer from the model's rigs (the SAME one-JSON — no second read). */
export function buildLedgerExplorer(foundOnHost: LedgerRigInput[]): LedgerExplorer {
  return {
    ledgerSourced: true,
    note: "ledger-sourced · daemon down",
    rows: foundOnHost.map((r) => ({ label: `▦ ${r.name}`, rigName: r.name, seatCount: r.seatCount })),
  };
}
