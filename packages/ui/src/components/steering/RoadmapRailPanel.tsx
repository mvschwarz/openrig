// Operator Surface Reconciliation v0 — Roadmap Rail panel.
//
// Item 1B: PL-XXX checklist + next-unchecked marker. Each unchecked
// row links to its corresponding PRD if a product-specs/<slug>/README.md
// exists; v0 simply links via the Files browser path.

import type { RoadmapRailPayload } from "../../hooks/useSteering.js";

export function RoadmapRailPanel({ roadmapRail }: { roadmapRail: RoadmapRailPayload | null }) {
  if (!roadmapRail) {
    return (
      <section
        data-testid="steering-roadmap-rail-empty"
        className="border border-stone-200 bg-stone-50 p-3 font-mono text-[10px] text-stone-500"
      >
        Roadmap rail source unavailable. Configure OPENRIG_ROADMAP_PATH or place roadmap/PROGRESS.md under the steering workspace.
      </section>
    );
  }
  const { items, counts, mtime } = roadmapRail;
  return (
    <section
      data-testid="steering-roadmap-rail"
      className="border border-stone-300 bg-white"
    >
      <header className="flex items-baseline justify-between border-b border-stone-200 bg-stone-50 px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-700">
          Roadmap rail
        </div>
        <div className="font-mono text-[9px] text-stone-500" data-testid="steering-roadmap-rail-counts">
          {counts.done} / {counts.total} done · last modified {mtime}
        </div>
      </header>
      {items.length === 0 ? (
        <div className="p-3 font-mono text-[10px] text-stone-400">No checkbox rows in roadmap PROGRESS.md.</div>
      ) : (
        <ul className="divide-y divide-stone-100">
          {items.map((item) => (
            <li
              key={item.line}
              data-testid={`steering-roadmap-item-${item.line}`}
              data-rail-code={item.railItemCode ?? ""}
              data-is-next-unchecked={item.isNextUnchecked}
              className={`flex items-baseline gap-2 px-3 py-1.5 ${item.isNextUnchecked ? "bg-emerald-50" : ""}`}
            >
              <span
                className={`inline-flex shrink-0 items-center justify-center font-mono text-[10px] ${
                  item.done ? "text-emerald-700" : "text-stone-500"
                }`}
                aria-label={item.done ? "done" : "active"}
              >
                {item.done ? "✓" : "◯"}
              </span>
              {item.railItemCode && (
                <span
                  className="shrink-0 font-mono text-[9px] font-bold uppercase tracking-[0.10em] text-stone-700"
                  data-testid={`steering-roadmap-item-${item.line}-code`}
                >
                  {item.railItemCode}
                </span>
              )}
              <span className="flex-1 font-mono text-[10px] text-stone-800">{item.text}</span>
              {item.isNextUnchecked && (
                <span
                  data-testid={`steering-roadmap-next-marker-${item.line}`}
                  className="shrink-0 border border-emerald-400 bg-emerald-100 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.10em] text-emerald-900"
                >
                  next pull
                </span>
              )}
              <span className="shrink-0 font-mono text-[8px] text-stone-400">L{item.line}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
