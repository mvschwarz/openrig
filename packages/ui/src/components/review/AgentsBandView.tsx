// Living Notes Packet 2 — the AGENTS band (OPR.0.4.4.20 FR-4 SSOT + delta-A).
//
// The SHARED AGENT-ROW ANATOMY both scopes render (this component is the one
// renderer; slice-22's rig altitude consumes the same anatomy + the same
// scope-parameterized contract): name · runtime badge · state glyph
// (honest-unknown when telemetry is down — never guessed) · plain-language
// "doing" line · holds count · last transition age · ▲ mark with inline
// evidence · CHAT affordance (the terminal, BR-12) · read-only terminal
// drill (the same ProgressiveTerminal, static until clicked live).
//
// Drift-killers (verbatim contract): no capability forks between scopes;
// one-count identity; the mission band never embeds slice pages (rows +
// zoom only — the region is anchor-addressable, no standalone slice route);
// no new nav vocabulary — this band is just "AGENTS".

import { useState } from "react";
import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";
import type { AgentsBand } from "../../hooks/useReview.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import { TranscriptDrillPanel } from "./TranscriptDrillPanel.js";
import { buildChatPreamble } from "./chat.js";

const GLYPH: Record<string, { char: string; cls: string; label: string }> = {
  active: { char: "●", cls: "text-emerald-700", label: "active" },
  parked: { char: "◐", cls: "text-amber-700", label: "parked" },
  idle: { char: "○", cls: "text-on-surface-variant", label: "idle" },
  unknown: { char: "◌", cls: "text-on-surface-variant", label: "unknown (telemetry down)" },
};

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
}

function AgentRowItem({
  row,
  rowInstanceKey,
  bandScope,
  itemRef,
}: {
  row: AgentsBand["rows"][number];
  rowInstanceKey: string;
  bandScope: AgentsBand["scope"];
  itemRef: string;
}) {
  const [openChat, setOpenChat] = useState(false);
  const glyph = GLYPH[row.stateGlyph] ?? GLYPH["unknown"]!;

  return (
    <li className="px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <details className="min-w-0 flex-1">
          <summary
            data-testid={`agent-drill-${row.sessionName}`}
            title="Drill into the transcript (read-only, on demand)"
            className="flex min-w-0 cursor-pointer list-none items-center gap-2 text-left marker:hidden"
          >
            <span className={glyph.cls} title={glyph.label} aria-label={glyph.label}>
              {glyph.char}
            </span>
            <span className="text-[12px] font-medium">{row.agentName}</span>
            <span className="border border-outline-variant px-1 font-mono text-[9px] uppercase text-on-surface-variant">
              {row.runtime}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-on-surface-variant">
              {row.doing ?? "—"}
            </span>
            <span className="font-mono text-[10px] text-on-surface-variant">holds {row.holdsCount}</span>
            <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(row.lastTransitionIso)}</span>
          </summary>
          {/* FR-6: the transcript drill — SHIPPED read routes, fetched only
              when opened (zero standing transcript cost). */}
          <TranscriptDrillPanel sessionName={row.sessionName} deferUntilDetailsOpen />
        </details>
        <button
          type="button"
          data-testid={`agent-chat-${row.sessionName}`}
          onClick={() => setOpenChat((cur) => !cur)}
          className="border border-outline px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-variant"
        >
          Chat
        </button>
      </div>
      {row.exception ? (
        <p data-testid={`agent-exception-${row.sessionName}`} className="mt-1 font-mono text-[10px] text-amber-800">
          ▲ {row.exception.evidence} · threshold: {row.exception.threshold}
        </p>
      ) : null}
      {openChat ? (
        <div className="mt-2 border border-outline-variant" data-testid={`agent-chat-terminal-${row.sessionName}`}>
          {/* BR-12: the SAME shipped terminal family, everywhere CHAT appears. */}
          <ProgressiveTerminal
            sessionName={row.sessionName}
            terminalKey={`review-agents:${bandScope}:${rowInstanceKey}`}
            initialText={buildChatPreamble({ sessionName: row.sessionName, itemRef })}
          />
        </div>
      ) : null}
    </li>
  );
}

export function AgentsBandView({
  band,
  itemRef,
  grouping = "agent",
  previewLimit,
}: {
  band: AgentsBand;
  itemRef: string;
  /** OPR.0.4.4.22 FR-1 — page-level arrangement (arch-ruled: extension in
   *  THIS one home, never a forked copy): "agent" = the flat one-row-per-
   *  agent render (existing behavior, default); "slice" = the same rows
   *  grouped under each slice they hold work on — membership stays
   *  work-on-scope, never rig co-residency (the data already guarantees it). */
  grouping?: "agent" | "slice";
  /** Mission altitude keeps ownership visible without letting a large queue
   *  ledger dominate the page. Only the remainder is disclosed. */
  previewLimit?: number;
}) {
  const visibleRows = previewLimit === undefined ? band.rows : band.rows.slice(0, previewLimit);
  const overflowRows = previewLimit === undefined ? [] : band.rows.slice(previewLimit);
  const zoomHref = band.scope.startsWith("slice:")
    ? `/agents?slice=${encodeURIComponent(band.scope.slice("slice:".length))}`
    : band.scope === "rig"
      ? null
      : "/agents";
  const groups: Array<{ label: string | null; rows: typeof band.rows }> =
    grouping === "slice" && visibleRows.length > 0
      ? [...new Set(visibleRows.flatMap((r) => (r.slices.length > 0 ? r.slices : ["(no slice)"])))]
          .sort()
          .map((slice) => ({
            label: slice,
            rows: visibleRows.filter((r) => (r.slices.length > 0 ? r.slices.includes(slice) : slice === "(no slice)")),
          }))
      : [{ label: null, rows: visibleRows }];

  return (
    <section id="agents" data-testid="agents-band" className={cn(VELLUM_CARD, "space-y-1 p-2")}>
      <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">AGENTS</h3>
      {/* FR-4: the one coordination-health line per scope. */}
      {band.coordinationHealth ? (
        <p data-testid="agents-health" className="font-mono text-[10px] text-on-surface-variant">
          {band.coordinationHealth}
        </p>
      ) : null}
      {band.rows.length === 0 ? null : (
        <div data-testid={previewLimit === undefined ? undefined : "agents-visible"}>
          {groups.map((group) => (
            <div key={group.label ?? "__flat"}>
              {group.label ? (
                <p data-testid={`agents-group-${group.label}`} className="mt-1 font-mono text-[10px] uppercase text-on-surface-variant">
                  {group.label}
                </p>
              ) : null}
              <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
                {group.rows.map((row) => {
                  const rowInstanceKey = `${group.label ?? "__flat"}:${row.sessionName}`;
                  return <AgentRowItem key={rowInstanceKey} row={row} rowInstanceKey={rowInstanceKey} bandScope={band.scope} itemRef={itemRef} />;
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {overflowRows.length > 0 ? (
        <details data-testid="agents-overflow" className="border border-outline-variant">
          <summary className="cursor-pointer px-2 py-1.5 font-mono text-[10px] text-on-surface-variant">
            +{overflowRows.length} more queue-scoped agents
          </summary>
          <ul className="divide-y divide-outline-variant/50 border-t border-outline-variant">
            {overflowRows.map((row) => (
              <AgentRowItem
                key={`__overflow:${row.sessionName}`}
                row={row}
                rowInstanceKey={`__overflow:${row.sessionName}`}
                bandScope={band.scope}
                itemRef={itemRef}
              />
            ))}
          </ul>
        </details>
      ) : null}
      <div data-testid="agents-footer" className="flex items-center justify-between gap-3 border-t border-outline-variant/60 pt-1.5">
        <p
          data-testid={band.rows.length === 0 ? "agents-empty" : undefined}
          className="font-mono text-[10px] text-on-surface-variant"
        >
          {band.provenance}
        </p>
        {zoomHref ? (
          <a
            href={zoomHref}
            className="shrink-0 font-mono text-[10px] uppercase text-on-surface-variant underline-offset-2 hover:underline"
          >
            all agents ↗
          </a>
        ) : null}
      </div>
    </section>
  );
}
