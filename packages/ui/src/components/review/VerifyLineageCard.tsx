// Living Notes Packet 2 — the verify-lineage CARD (OPR.0.4.4.20 FR-2 / SS14).
//
// Promoted from an inline strip to its own bounded card. N1 rule: the three
// view-time facts (proven-at SHA · merged-at-or-UNMERGED · current tip) always
// render; the fresh/stale label is a DERIVATION of the shown facts and never
// appears alone. G1 rule: each gate chip renders the RECORDED token verbatim
// (a CONCERNING never renders as FAIL) with a separately derived tone.

import type { VerifyLineage } from "../../hooks/useReview.js";
import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";

const TONE_CLASS: Record<string, string> = {
  pass: "bg-emerald-100 text-emerald-900 border-emerald-300",
  fail: "bg-red-100 text-red-900 border-red-300",
  unknown: "bg-surface-variant text-on-surface-variant border-outline-variant",
};

// CORRECTIVE §11 — the separate green readout is REMOVED; recorded-verdict
// rigor now feeds per-deliverable `verified` in DELIVERED.
export function VerifyLineageCard({ lineage }: { lineage: VerifyLineage }) {
  return (
    <section data-testid="verify-lineage-card" className={cn(VELLUM_CARD, "p-3 space-y-2")}>
      <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">Verify lineage</h3>
      <p className="font-mono text-[11px] break-all">
        proven-at <code>{lineage.candidateSha ?? "unknown"}</code>
        {" · "}merged-at <code>{lineage.mergeSha ?? "UNMERGED"}</code>
        {" · "}main tip <code>{lineage.mainTip}</code>
        {" · "}
        <span data-testid="lineage-freshness">
          freshness {lineage.freshness}
          {lineage.staleBehind !== null ? ` (${lineage.staleBehind} behind)` : ""}
        </span>
      </p>
      <div className="flex flex-wrap gap-1" data-testid="lineage-gate-cells">
        {lineage.gateCells.map((cell) => (
          <span
            key={cell.role}
            data-testid={`gate-cell-${cell.role}`}
            title={cell.source ?? "no artifact"}
            className={`border px-1.5 py-0.5 font-mono text-[10px] ${TONE_CLASS[cell.tone]}`}
          >
            {cell.role}: {cell.recordedToken ?? "missing"}
          </span>
        ))}
      </div>
    </section>
  );
}
