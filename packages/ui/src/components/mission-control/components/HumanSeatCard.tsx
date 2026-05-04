// PL-005 Phase A: first-class human-seat rendering.
//
// Per founder Q3 (2026-05-03): human queues are first-class product
// concepts, NOT invisible config-layer convention. Mission Control
// renders the operator's human seat (default `human-wrandom@kernel`)
// with its own card showing identity + load + capabilities.

import type { CompactStatusRow } from "../hooks/useMissionControlView.js";

export interface HumanSeatCardProps {
  /** Canonical session label, e.g., `human-wrandom@kernel`. */
  session: string;
  /** Pending human-gate items (for load indication). */
  rows: CompactStatusRow[];
  /** Optional capabilities label (which verbs this seat can fire). */
  capabilities?: string[];
}

export function HumanSeatCard({
  session,
  rows,
  capabilities = ["approve", "deny", "route", "annotate", "hold", "drop", "handoff"],
}: HumanSeatCardProps) {
  const pendingCount = rows.filter(
    (r) => r.state === "idle" || r.state === "attention" || r.state === "blocked",
  ).length;
  const blockedCount = rows.filter((r) => r.state === "blocked").length;
  return (
    <div
      data-testid="mc-human-seat-card"
      data-session={session}
      className="border border-stone-300 bg-stone-50 p-3"
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-stone-500">
            human seat
          </div>
          <div data-testid="mc-human-seat-session" className="font-mono text-sm text-stone-900">
            {session}
          </div>
        </div>
        <div className="text-right">
          <div data-testid="mc-human-seat-pending" className="font-mono text-2xl text-stone-900">
            {pendingCount}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
            pending
          </div>
        </div>
      </div>
      {blockedCount > 0 ? (
        <div data-testid="mc-human-seat-blocked" className="mt-2 font-mono text-[10px] text-red-800">
          {blockedCount} blocked
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {capabilities.map((cap) => (
          <span
            key={cap}
            className="border border-stone-300 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-stone-600"
          >
            {cap}
          </span>
        ))}
      </div>
    </div>
  );
}
