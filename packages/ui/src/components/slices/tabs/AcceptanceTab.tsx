// Slice Story View v0 + v1 + UI Enhancement Pack v0 — Acceptance tab.
//
// v0 (Slice Story View): header progress bar + checkbox list pulled
// from the slice's README / IMPLEMENTATION-PRD / PROGRESS.md.
//
// v1 dimension #3: when a workflow_instance is bound to the slice,
// renders a Current Step panel above the checkbox list — active step,
// objective, allowed exits, and spec-declared next-step destinations.
//
// UI Enhancement Pack v0 (item 1A) extends the checkbox list with:
//   - Checkbox pills (rounded with status icon: ◯ active / ✓ done /
//     ⚠ blocked) instead of raw `[ ]` / `[x]` syntax.
//   - Status filter chips (All / Active / Done / Blocked; default All).
//   - Click-to-expand row detail panel showing source file:line
//     citation prominently.
//
// All three layers compose; PROGRESS.md parsing remains unchanged.
// (Hierarchy from `## Heading` sections + `  -` indent is a
// straightforward extension once the daemon-side acceptance parser
// returns parent_section_heading per row.)

import { useMemo, useState } from "react";
import type { AcceptanceItem, CurrentStepPayload, SliceDetail } from "../../../hooks/useSlices.js";
import { ToolMark } from "../../graphics/RuntimeMark.js";

type StatusFilter = "all" | "active" | "done" | "blocked";

const FILTERS: StatusFilter[] = ["all", "active", "done", "blocked"];

export function AcceptanceTab({ acceptance }: { acceptance: SliceDetail["acceptance"] }) {
  const { totalItems, doneItems, percentage, items, closureCallout, currentStep } = acceptance;
  const [filter, setFilter] = useState<StatusFilter>("all");
  const filtered = useMemo(() => filterItems(items, filter), [items, filter]);


  return (
    <div data-testid="acceptance-tab" className="p-4">
      {currentStep && <CurrentStepPanel currentStep={currentStep} />}
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
        {items.length > 0 && (
          <div className="mt-3 flex gap-1" data-testid="acceptance-filter-row">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                data-testid={`acceptance-filter-${f}`}
                data-active={filter === f}
                onClick={() => setFilter(f)}
                className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.10em] ${
                  filter === f
                    ? "border-stone-700 bg-stone-700 text-white"
                    : "border-stone-300 text-stone-700 hover:bg-stone-100"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </header>
      {items.length === 0 ? (
        <div className="font-mono text-[10px] text-stone-400" data-testid="acceptance-empty">
          No acceptance items found in slice docs (looks for `[ ]` / `[x]` checkbox lines in README / IMPLEMENTATION-PRD / PROGRESS / IMPLEMENTATION).
        </div>
      ) : filtered.length === 0 ? (
        <div className="font-mono text-[10px] text-stone-400" data-testid="acceptance-filter-empty">
          No items match filter '{filter}'.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="acceptance-list">
          {filtered.map((item, idx) => (
            <AcceptanceRow key={`${item.source.file}:${item.source.line}`} item={item} idx={idx} />
          ))}
        </ul>
      )}
    </div>
  );
}

// v1 dimension #3: Current Step panel.
function CurrentStepPanel({ currentStep }: { currentStep: CurrentStepPayload }) {
  return (
    <section
      data-testid="acceptance-current-step"
      data-step-id={currentStep.stepId}
      className="mb-6 border border-stone-300 bg-stone-50 p-3"
    >
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-stone-700">
          Current step
        </div>
        <div className="font-mono text-[9px] text-stone-500">
          hop {currentStep.hopCount} · {currentStep.instanceStatus}
        </div>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span
          data-testid="acceptance-current-step-id"
          className="font-mono text-[12px] font-bold text-stone-900"
        >
          {currentStep.stepId}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">
          role: {currentStep.role}
        </span>
      </div>
      {currentStep.objective && (
        <div
          data-testid="acceptance-current-step-objective"
          className="mt-2 whitespace-pre-line font-mono text-[10px] text-stone-700"
        >
          {currentStep.objective}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div data-testid="acceptance-current-step-allowed-exits">
          <div className="font-mono text-[8px] uppercase tracking-[0.10em] text-stone-500">
            Allowed exits
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {currentStep.allowedExits.length === 0 ? (
              <span className="font-mono text-[9px] text-stone-400">(none)</span>
            ) : (
              currentStep.allowedExits.map((exit) => (
                <span
                  key={exit}
                  className="border border-stone-300 bg-white px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] text-stone-700"
                >
                  {exit}
                </span>
              ))
            )}
          </div>
        </div>
        <div data-testid="acceptance-current-step-allowed-next-steps">
          <div className="font-mono text-[8px] uppercase tracking-[0.10em] text-stone-500">
            Allowed next steps
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {currentStep.allowedNextSteps.length === 0 ? (
              <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">
                <ToolMark tool="terminal" size="xs" />
                terminal
              </span>
            ) : (
              currentStep.allowedNextSteps.map((next) => (
                <span
                  key={next.stepId}
                  data-testid={`acceptance-next-step-${next.stepId}`}
                  className="border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] text-emerald-900"
                  title={`role: ${next.role}`}
                >
                  {next.stepId}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// UI Enhancement Pack v0 (item 1A): checkbox-pill row with click-to-expand detail.
function AcceptanceRow({ item, idx }: { item: AcceptanceItem; idx: number }) {
  const [expanded, setExpanded] = useState(false);
  const { pillClass, pillIcon, pillLabel } = pillStyle(item.done);
  return (
    <li
      data-testid={`acceptance-item-${idx}`}
      data-done={item.done}
      className="border-b border-stone-100"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`acceptance-item-${idx}-toggle`}
        className="flex w-full items-start gap-2 py-1.5 text-left hover:bg-stone-50"
      >
        <span
          data-testid={`acceptance-pill-${idx}`}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${pillClass}`}
          aria-label={pillLabel}
        >
          <span aria-hidden="true">{pillIcon}</span>
          <span>{pillLabel}</span>
        </span>
        <span className="flex-1 font-mono text-[10px] text-stone-800">{item.text}</span>
        <span className="font-mono text-[8px] text-stone-400" title={`${item.source.file}:${item.source.line}`}>
          {item.source.file}:{item.source.line}
        </span>
      </button>
      {expanded && (
        <div
          data-testid={`acceptance-item-${idx}-detail`}
          className="ml-2 mt-1 border-l-2 border-stone-300 bg-stone-50 px-3 py-2 font-mono text-[9px] text-stone-700"
        >
          <div>
            <span className="font-bold">Source:</span>{" "}
            <span data-testid={`acceptance-item-${idx}-citation`}>{item.source.file}:{item.source.line}</span>
          </div>
          <div className="mt-1">
            <span className="font-bold">Status:</span> {pillLabel}
          </div>
          <div className="mt-2 whitespace-pre-line text-stone-800">{item.text}</div>
        </div>
      )}
    </li>
  );
}

function filterItems(items: AcceptanceItem[], filter: StatusFilter): AcceptanceItem[] {
  if (filter === "all") return items;
  if (filter === "done") return items.filter((i) => i.done);
  if (filter === "active") return items.filter((i) => !i.done);
  if (filter === "blocked") {
    // v0's parser doesn't expose a "blocked" state separately; the
    // blocked filter shows items whose text contains a "blocked" /
    // "park" hint as a heuristic. When the parser graduates to
    // `[~]` recognition the heuristic will degrade gracefully (the
    // filter still works on text patterns).
    return items.filter((i) => /\b(blocked|blocker|parked|park)\b/i.test(i.text));
  }
  return items;
}

function pillStyle(done: boolean): { pillClass: string; pillIcon: string; pillLabel: string } {
  if (done) {
    return {
      pillClass: "border-emerald-400 bg-emerald-50 text-emerald-900",
      pillIcon: "✓",
      pillLabel: "done",
    };
  }
  return {
    pillClass: "border-stone-400 bg-stone-50 text-stone-700",
    pillIcon: "◯",
    pillLabel: "active",
  };
}
