// PL-005 Phase A: 9-field phone-friendly content-model atom.
//
// Per PRD § Acceptance Criteria item 1, NON-NEGOTIABLE: this row carries
// all 9 fields verbatim. UI may display compact (only top 3-4 fields
// visible on mobile width) but the JSON payload preserves all 9.
//
// 9 fields verbatim from PRD:
//   1. rig/mission name
//   2. current phase
//   3. active/idle/attention/blocked/degraded
//   4. next-action
//   5. pending-human-decision
//   6. read-cost (full / skim/approve / summary-only)
//   7. last-update timestamp
//   8. confidence/freshness
//   9. evidence link

import type { CompactStatusRow as CompactStatusRowData } from "../hooks/useMissionControlView.js";

export interface CompactStatusRowProps {
  row: CompactStatusRowData;
  density?: "compact" | "expanded";
  onAction?: () => void;
}

const STATE_BADGES: Record<CompactStatusRowData["state"], { label: string; cls: string }> = {
  active: { label: "ACTIVE", cls: "bg-emerald-100 text-emerald-800" },
  idle: { label: "IDLE", cls: "bg-stone-100 text-stone-700" },
  attention: { label: "ATTN", cls: "bg-amber-100 text-amber-800" },
  blocked: { label: "BLOCKED", cls: "bg-red-100 text-red-800" },
  degraded: { label: "DEGRADED", cls: "bg-orange-100 text-orange-800" },
};

export function CompactStatusRow({
  row,
  density = "expanded",
  onAction,
}: CompactStatusRowProps) {
  const badge = STATE_BADGES[row.state];
  return (
    <div
      data-testid="mc-status-row"
      data-state={row.state}
      data-qitem-id={row.qitemId ?? ""}
      className="border border-stone-200 bg-white p-3 hover:bg-stone-50"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            data-testid="mc-state-badge"
            className={`inline-flex items-center px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${badge.cls}`}
          >
            {badge.label}
          </span>
          <span
            data-testid="mc-rig-name"
            className="font-mono text-xs text-stone-900 truncate"
            title={row.rigOrMissionName}
          >
            {row.rigOrMissionName}
          </span>
          {row.currentPhase ? (
            <span
              data-testid="mc-current-phase"
              className="font-mono text-[10px] text-stone-500"
            >
              · {row.currentPhase}
            </span>
          ) : null}
        </div>
        {onAction ? (
          <button
            type="button"
            onClick={onAction}
            data-testid="mc-row-action"
            className="border border-stone-300 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-700 hover:bg-stone-100"
          >
            ACT
          </button>
        ) : null}
      </div>
      {density === "expanded" && (
        <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-stone-700 sm:grid-cols-2">
          {row.nextAction ? (
            <div data-testid="mc-next-action">
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-stone-500">next</span>{" "}
              {row.nextAction}
            </div>
          ) : null}
          {row.pendingHumanDecision ? (
            <div data-testid="mc-pending-human-decision" className="text-amber-800">
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-amber-700">human</span>{" "}
              {row.pendingHumanDecision}
            </div>
          ) : null}
          {row.readCost ? (
            <div data-testid="mc-read-cost">
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-stone-500">read</span>{" "}
              {row.readCost}
            </div>
          ) : null}
          {row.confidenceFreshness ? (
            <div data-testid="mc-confidence-freshness">
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-stone-500">conf</span>{" "}
              {row.confidenceFreshness}
            </div>
          ) : null}
          <div data-testid="mc-last-update" className="text-stone-500 font-mono text-[10px]">
            {row.lastUpdate}
          </div>
          {row.evidenceLink ? (
            <a
              data-testid="mc-evidence-link"
              href={row.evidenceLink}
              className="text-stone-600 underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              evidence
            </a>
          ) : null}
        </div>
      )}
    </div>
  );
}
