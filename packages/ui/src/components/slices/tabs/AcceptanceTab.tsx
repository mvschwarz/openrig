// Slice Story View v0 + v1 — Acceptance tab.
//
// v0: header progress bar + checkbox list pulled from the slice's
// README / IMPLEMENTATION-PRD / PROGRESS.md `[ ]` / `[x]` items.
//
// v1 dimension #3: when a workflow_instance is bound to the slice,
// renders a Current Step panel above the v0 checkbox list — showing
// the active step, its objective, allowed exits, and the spec-declared
// next-step destinations. The two views compose; PROGRESS.md parsing
// remains unchanged.

import type { CurrentStepPayload, SliceDetail } from "../../../hooks/useSlices.js";

export function AcceptanceTab({ acceptance }: { acceptance: SliceDetail["acceptance"] }) {
  const { totalItems, doneItems, percentage, items, closureCallout, currentStep } = acceptance;
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
              <span className="font-mono text-[9px] text-stone-400">(terminal)</span>
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
