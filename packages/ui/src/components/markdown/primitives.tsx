// 0.3.1 slice 06 — spatial primitives used by kind layouts + fenced
// block renderers. Honors OpenRig vellum tokens (no Thariq palette
// literals); square corners except the 12px status dots; tactical
// drafting aesthetic per project_v1_professional_grade_ship_gate.

import type {
  TimelineEntry,
  TimelineStatus,
  StatsEntry,
  RiskTableEntry,
  RiskLevel,
  CompareRow,
} from "./storytelling-primitives.js";

// -----------------------------------------------------------------------------
// Status → token mapping (shared across primitives)
// -----------------------------------------------------------------------------

const STATUS_TOKENS: Record<TimelineStatus, { dot: string; ink: string; label: string }> = {
  success: { dot: "bg-emerald-600", ink: "text-emerald-800", label: "SUCCESS" },
  warning: { dot: "bg-amber-500", ink: "text-amber-800", label: "WARNING" },
  danger:  { dot: "bg-red-600",    ink: "text-red-800",    label: "DANGER" },
  info:    { dot: "bg-sky-600",    ink: "text-sky-800",    label: "INFO" },
  muted:   { dot: "bg-stone-500",  ink: "text-stone-700",  label: "MUTED" },
};

const RISK_TOKENS: Record<RiskLevel, { ink: string; label: string }> = {
  low:  { ink: "text-emerald-800", label: "LOW" },
  med:  { ink: "text-amber-800",   label: "MED" },
  high: { ink: "text-red-800",     label: "HIGH" },
};

// -----------------------------------------------------------------------------
// TLDRSlate — dark vellum slab; sits at top of a kind layout
// -----------------------------------------------------------------------------

export function TLDRSlate({ children, testId = "primitive-tldr-slate" }: { children: React.ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="my-4 border border-stone-900 bg-stone-900 px-4 py-3 text-[12px] leading-relaxed text-stone-50 hard-shadow"
    >
      <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.18em] text-stone-400">TL;DR</div>
      <div>{children}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// DotTimeline — vertical dot+line track for ordered events
// -----------------------------------------------------------------------------

export function DotTimeline({ entries, testId = "primitive-dot-timeline" }: { entries: TimelineEntry[]; testId?: string }) {
  if (entries.length === 0) return null;
  return (
    <ol data-testid={testId} className="my-4 list-none space-y-0 border-l border-outline-variant pl-0">
      {entries.map((e, i) => {
        const tokens = STATUS_TOKENS[e.status];
        const isLast = i === entries.length - 1;
        return (
          <li key={i} className="relative pl-9 pb-4" data-testid={`primitive-dot-timeline-entry-${i}`}>
            {!isLast && (
              <div className="absolute left-[13px] top-6 bottom-0 w-px bg-outline-variant" aria-hidden="true" />
            )}
            <div
              className={`absolute left-[7px] top-2 h-3 w-3 rounded-full border border-outline-variant ${tokens.dot}`}
              data-status={e.status}
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
              <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">{e.time}</span>
              <span className={`font-mono text-[8px] uppercase tracking-[0.12em] ${tokens.ink}`}>{tokens.label}</span>
            </div>
            <div className="mt-1 text-[12px] font-semibold text-stone-900">{e.title}</div>
            {e.body && <div className="mt-1 text-[11px] leading-relaxed text-stone-700">{e.body}</div>}
          </li>
        );
      })}
    </ol>
  );
}

// -----------------------------------------------------------------------------
// StatCardBand — horizontal row of label/value/trend cards
// -----------------------------------------------------------------------------

const TREND_GLYPH = { up: "↑", flat: "—", down: "↓" } as const;
const TREND_INK = { up: "text-emerald-700", flat: "text-stone-500", down: "text-red-700" } as const;

export function StatCardBand({ entries, testId = "primitive-stat-card-band" }: { entries: StatsEntry[]; testId?: string }) {
  if (entries.length === 0) return null;
  return (
    <div data-testid={testId} className="my-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {entries.map((e, i) => (
        <div
          key={i}
          data-testid={`primitive-stat-card-${i}`}
          className="border border-outline-variant bg-white/45 px-3 py-2 hard-shadow"
        >
          <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-stone-500">{e.label}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-[18px] font-bold text-stone-900">{e.value}</span>
            {e.trend && (
              <span className={`font-mono text-[10px] ${TREND_INK[e.trend]}`} data-trend={e.trend}>
                {TREND_GLYPH[e.trend]}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// RiskTableGrid — risk × probability × impact × mitigation grid
// -----------------------------------------------------------------------------

export function RiskTableGrid({ entries, testId = "primitive-risk-table-grid" }: { entries: RiskTableEntry[]; testId?: string }) {
  if (entries.length === 0) return null;
  return (
    <div data-testid={testId} className="my-4 overflow-x-auto">
      <table className="w-full border-collapse border border-outline-variant text-[11px]">
        <thead>
          <tr className="bg-stone-50">
            <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-stone-600">Risk</th>
            <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-stone-600">Prob</th>
            <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-stone-600">Impact</th>
            <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-stone-600">Mitigation</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => {
            const prob = RISK_TOKENS[e.probability];
            const imp = RISK_TOKENS[e.impact];
            return (
              <tr key={i} data-testid={`primitive-risk-row-${i}`}>
                <td className="border border-outline-variant px-2 py-1 text-stone-900">{e.risk}</td>
                <td className={`border border-outline-variant px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] ${prob.ink}`}>{prob.label}</td>
                <td className={`border border-outline-variant px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] ${imp.ink}`}>{imp.label}</td>
                <td className="border border-outline-variant px-2 py-1 text-stone-700">{e.mitigation}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// -----------------------------------------------------------------------------
// CompareTable — n-column comparison table
// -----------------------------------------------------------------------------

export function CompareTable({ columns, rows, testId = "primitive-compare-table" }: { columns: string[]; rows: CompareRow[]; testId?: string }) {
  if (columns.length === 0) return null;
  return (
    <div data-testid={testId} className="my-4 overflow-x-auto">
      <table className="w-full border-collapse border border-outline-variant text-[11px]">
        <thead>
          <tr className="bg-stone-50">
            <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-stone-600"></th>
            {columns.map((c, i) => (
              <th key={i} className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-stone-600">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} data-testid={`primitive-compare-row-${i}`}>
              <td className="border border-outline-variant px-2 py-1 font-mono text-[10px] font-semibold text-stone-700">{row.label}</td>
              {columns.map((_c, j) => (
                <td key={j} className="border border-outline-variant px-2 py-1 text-stone-800">{row.values[j] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// -----------------------------------------------------------------------------
// ActionChecklist — list of [done?] tasks
// -----------------------------------------------------------------------------

export function ActionChecklist({ items, testId = "primitive-action-checklist" }: { items: Array<{ done: boolean; text: string }>; testId?: string }) {
  if (items.length === 0) return null;
  return (
    <ul data-testid={testId} className="my-4 list-none space-y-1 pl-0">
      {items.map((item, i) => (
        <li
          key={i}
          data-testid={`primitive-action-checklist-item-${i}`}
          className="flex items-baseline gap-2 text-[12px]"
        >
          <span
            data-done={item.done}
            className={`mt-0.5 inline-block h-3 w-3 shrink-0 border ${item.done ? "border-emerald-700 bg-emerald-600" : "border-outline-variant bg-white"}`}
            aria-hidden="true"
          />
          <span className={item.done ? "text-stone-500 line-through" : "text-stone-900"}>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

// -----------------------------------------------------------------------------
// SummaryStrip — single-line summary row at top of a feature-shipped layout
// -----------------------------------------------------------------------------

export function SummaryStrip({
  label,
  body,
  testId = "primitive-summary-strip",
}: { label: string; body: string; testId?: string }) {
  return (
    <div data-testid={testId} className="my-3 border-l-4 border-emerald-600 bg-emerald-50/60 px-3 py-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-emerald-800">{label}</div>
      <div className="mt-1 text-[12px] text-stone-900">{body}</div>
    </div>
  );
}
