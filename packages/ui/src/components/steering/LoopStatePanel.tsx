// Operator Surface Reconciliation v0 — Loop State panel.
//
// Item 1E: cross-rig roll-up of recent qitems via PL-005's
// `recently-active` view (same source as InMotionPanel; here we
// surface the most-recent qitem per actor seat without the
// product-specs filter, so the operator sees who's busy on what).

import { useQuery } from "@tanstack/react-query";

interface MissionControlRow {
  qitemId: string;
  sourceSession?: string;
  destinationSession?: string;
  body?: string;
  state?: string;
  tsUpdated?: string;
}

interface MissionControlViewResponse {
  viewName: string;
  rows: MissionControlRow[];
}

async function fetchRecentlyActive(): Promise<MissionControlViewResponse> {
  const res = await fetch("/api/mission-control/views/recently-active");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MissionControlViewResponse;
}

export function LoopStatePanel() {
  const view = useQuery({
    queryKey: ["mission-control", "views", "recently-active"],
    queryFn: fetchRecentlyActive,
    staleTime: 30_000,
  });
  return (
    <section data-testid="steering-loop-state" className="border border-stone-300 bg-white">
      <header className="flex items-baseline justify-between border-b border-stone-200 bg-stone-50 px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-700">
          Loop state
        </div>
        <div className="font-mono text-[9px] text-stone-500">
          most-recent qitem per seat (cross-rig roll-up)
        </div>
      </header>
      {view.isLoading && <div className="p-3 font-mono text-[10px] text-stone-400">Loading…</div>}
      {view.isError && (
        <div data-testid="steering-loop-state-error" className="p-3 font-mono text-[10px] text-red-600">
          Mission Control view unavailable.
        </div>
      )}
      {view.data && (() => {
        const bySeat = new Map<string, MissionControlRow>();
        for (const row of view.data.rows) {
          const seat = row.destinationSession ?? row.sourceSession ?? "unknown";
          const existing = bySeat.get(seat);
          if (!existing || (row.tsUpdated ?? "") > (existing.tsUpdated ?? "")) bySeat.set(seat, row);
        }
        const seats = Array.from(bySeat.entries()).sort((a, b) => (b[1].tsUpdated ?? "").localeCompare(a[1].tsUpdated ?? ""));
        if (seats.length === 0) {
          return <div data-testid="steering-loop-state-empty" className="p-3 font-mono text-[10px] text-stone-400">No recent qitems.</div>;
        }
        return (
          <ul className="divide-y divide-stone-100">
            {seats.slice(0, 10).map(([seat, row]) => (
              <li
                key={seat}
                data-testid={`steering-loop-row-${seat}`}
                className="flex items-baseline gap-2 px-3 py-1"
              >
                <span className="font-mono text-[9px] text-stone-500 shrink-0">{(row.tsUpdated ?? "").slice(11, 19)}</span>
                <span className="font-mono text-[10px] font-semibold text-stone-900 shrink-0 truncate max-w-[14rem]">{seat}</span>
                <span className="flex-1 font-mono text-[10px] text-stone-700 truncate">{row.body ?? row.qitemId}</span>
              </li>
            ))}
          </ul>
        );
      })()}
    </section>
  );
}
