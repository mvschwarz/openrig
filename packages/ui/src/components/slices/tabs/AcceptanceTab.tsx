// Slice Story View v0 — Acceptance tab.
//
// Header progress bar + checkbox list pulled from the slice's README /
// IMPLEMENTATION-PRD / PROGRESS.md `[ ]` / `[x]` items. Source citation
// (file + 1-based line) lets the operator jump to the canonical
// statement (Docs tab is the natural follow-on).

import type { SliceDetail } from "../../../hooks/useSlices.js";

export function AcceptanceTab({ acceptance }: { acceptance: SliceDetail["acceptance"] }) {
  const { totalItems, doneItems, percentage, items, closureCallout } = acceptance;
  return (
    <div data-testid="acceptance-tab" className="p-4">
      <header className="mb-4">
        <div className="flex items-baseline justify-between">
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-stone-700">
            Acceptance
          </div>
          <div className="font-mono text-[10px] text-stone-500">
            {doneItems} / {totalItems} ({percentage}%)
          </div>
        </div>
        <div className="mt-2 h-2 w-full bg-stone-100" data-testid="acceptance-progress-bar">
          <div
            className="h-2 bg-emerald-500 transition-all"
            data-testid="acceptance-progress-fill"
            data-percentage={percentage}
            style={{ width: `${percentage}%` }}
          />
        </div>
        {closureCallout && (
          <div
            data-testid="acceptance-closure-callout"
            className="mt-3 border border-emerald-300 bg-emerald-50 px-3 py-2 font-mono text-[10px] text-emerald-900"
          >
            {closureCallout}
          </div>
        )}
      </header>
      {items.length === 0 ? (
        <div className="font-mono text-[10px] text-stone-400" data-testid="acceptance-empty">
          No acceptance items found in slice docs (looks for `[ ]` / `[x]` checkbox lines in README / IMPLEMENTATION-PRD / PROGRESS / IMPLEMENTATION).
        </div>
      ) : (
        <ul className="space-y-1" data-testid="acceptance-list">
          {items.map((item, idx) => (
            <li
              key={`${item.source.file}:${item.source.line}`}
              data-testid={`acceptance-item-${idx}`}
              data-done={item.done}
              className="flex items-start gap-2 border-b border-stone-100 py-1"
            >
              <span className="font-mono text-[10px] text-stone-500" aria-label={item.done ? "done" : "pending"}>
                {item.done ? "[x]" : "[ ]"}
              </span>
              <span className="flex-1 font-mono text-[10px] text-stone-800">{item.text}</span>
              <span className="font-mono text-[8px] text-stone-400" title={`${item.source.file}:${item.source.line}`}>
                {item.source.file}:{item.source.line}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
