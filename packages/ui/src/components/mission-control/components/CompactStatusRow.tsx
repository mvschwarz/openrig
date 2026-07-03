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

import { useState, type MouseEvent } from "react";
import type { CompactStatusRow as CompactStatusRowData } from "../hooks/useMissionControlView.js";

export interface CompactStatusRowProps {
  row: CompactStatusRowData;
  density?: "compact" | "expanded";
  onAction?: () => void;
  highlighted?: boolean;
}

const STATE_BADGES: Record<CompactStatusRowData["state"], { label: string; cls: string }> = {
  active: { label: "ACTIVE", cls: "bg-emerald-100 text-emerald-800" },
  idle: { label: "IDLE", cls: "bg-surface-low text-on-surface" },
  attention: { label: "ATTN", cls: "bg-amber-100 text-amber-800" },
  blocked: { label: "BLOCKED", cls: "bg-red-100 text-red-800" },
  degraded: { label: "DEGRADED", cls: "bg-orange-100 text-orange-800" },
};

export function CompactStatusRow({
  row,
  density = "expanded",
  onAction,
  highlighted = false,
}: CompactStatusRowProps) {
  const badge = STATE_BADGES[row.state];
  const summary = row.qitemSummary ?? summarizeQitemBody(row.qitemBody);
  const fullBody = row.qitemBody?.trim() ?? "";
  const hasDetails = Boolean(fullBody || row.qitemId || row.rawSourceRef);
  const [isExpanded, setIsExpanded] = useState(highlighted);

  const toggleDetails = () => {
    if (hasDetails) setIsExpanded((current) => !current);
  };

  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("a,button,input,select,textarea")) return;
    toggleDetails();
  };

  return (
    <div
      data-testid="mc-status-row"
      data-state={row.state}
      data-qitem-id={row.qitemId ?? ""}
      data-highlighted={highlighted ? "true" : "false"}
      data-expanded={isExpanded ? "true" : "false"}
      id={row.qitemId ? `mc-qitem-${row.qitemId}` : undefined}
      onClick={onRowClick}
      className={`border p-3 hover:bg-background ${
        hasDetails ? "cursor-pointer" : ""
      } ${
        highlighted
          ? "border-amber-400 bg-amber-50 ring-2 ring-amber-300"
          : "border-outline-variant bg-surface-lowest"
      }`}
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
            className="font-mono text-xs text-on-surface truncate"
            title={row.rigOrMissionName}
          >
            {row.rigOrMissionName}
          </span>
          {row.currentPhase ? (
            <span
              data-testid="mc-current-phase"
              className="font-mono text-[10px] text-on-surface-variant"
            >
              · {row.currentPhase}
            </span>
          ) : null}
        </div>
        {hasDetails ? (
          <button
            type="button"
            onClick={() => toggleDetails()}
            data-testid="mc-row-details-toggle"
            className="border border-outline-variant px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface hover:bg-surface-low"
            aria-expanded={isExpanded}
          >
            {isExpanded ? "Hide" : "Details"}
          </button>
        ) : null}
        {onAction ? (
          <button
            type="button"
            onClick={onAction}
            data-testid="mc-row-action"
            className="border border-outline-variant px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface hover:bg-surface-low"
          >
            ACT
          </button>
        ) : null}
      </div>
      {summary ? (
        <p
          data-testid="mc-qitem-summary"
          className="mt-2 break-words text-sm leading-snug text-on-surface"
        >
          {summary}
        </p>
      ) : null}
      {density === "expanded" && (
        <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-on-surface sm:grid-cols-2">
          {row.nextAction ? (
            <div data-testid="mc-next-action">
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-on-surface-variant">next</span>{" "}
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
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-on-surface-variant">read</span>{" "}
              {row.readCost}
            </div>
          ) : null}
          {row.confidenceFreshness ? (
            <div data-testid="mc-confidence-freshness">
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-on-surface-variant">conf</span>{" "}
              {row.confidenceFreshness}
            </div>
          ) : null}
          <div data-testid="mc-last-update" className="text-on-surface-variant font-mono text-[10px]">
            {row.lastUpdate}
          </div>
          {row.evidenceLink ? (
            <a
              data-testid="mc-evidence-link"
              href={row.evidenceLink}
              className="text-on-surface-variant underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              evidence
            </a>
          ) : null}
        </div>
      )}
      {isExpanded && hasDetails ? (
        <div
          data-testid="mc-qitem-details"
          className="mt-3 space-y-2 border-t border-outline-variant pt-2 text-[11px] text-on-surface"
        >
          {fullBody ? (
            <div data-testid="mc-qitem-body" className="whitespace-pre-wrap break-words text-xs text-on-surface">
              {fullBody}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-1 font-mono text-[10px] text-on-surface-variant sm:grid-cols-2">
            {row.qitemId ? (
              <div>
                qitem <span data-testid="mc-qitem-id">{row.qitemId}</span>
              </div>
            ) : null}
            {row.rawSourceRef ? (
              <div>
                source <span data-testid="mc-qitem-source">{row.rawSourceRef}</span>
              </div>
            ) : null}
          </div>
          {row.qitemId ? (
            <a
              data-testid="mc-qitem-audit-link"
              href={`/mission-control?view=audit-history&qitem_id=${encodeURIComponent(row.qitemId)}`}
              className="inline-flex border border-outline-variant px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface hover:bg-surface-low"
            >
              Audit
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function summarizeQitemBody(body: string | null | undefined): string | null {
  const compact = body?.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 117).trimEnd()}...`;
}
