// Operator Surface Reconciliation v0 — Lane Rails panel.
//
// Item 1D: per-lane (delivery-ready/mode-{0..3}) top-N items + lane-
// health badges (active/blocked/done) + next-pull marker per the
// Priority Rail Rule semantics computed daemon-side.

import type { LaneRailItem, LaneRailPayload } from "../../hooks/useSteering.js";

export function LaneRailsPanel({ laneRails }: { laneRails: LaneRailPayload[] }) {
  if (laneRails.length === 0) {
    return (
      <section
        data-testid="steering-lane-rails-empty"
        className="border border-stone-200 bg-stone-50 p-3 font-mono text-[10px] text-stone-500"
      >
        Delivery-ready lane rails source unavailable. Configure OPENRIG_DELIVERY_READY_DIR or place delivery-ready/mode-N/PROGRESS.md under the steering workspace.
      </section>
    );
  }
  return (
    <section data-testid="steering-lane-rails" className="border border-stone-300 bg-white">
      <header className="border-b border-stone-200 bg-stone-50 px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-700">
          Delivery-ready lane rails
        </div>
      </header>
      <div className="divide-y divide-stone-200">
        {laneRails.map((lane) => (
          <LaneRailSection key={lane.laneId} lane={lane} />
        ))}
      </div>
    </section>
  );
}

function LaneRailSection({ lane }: { lane: LaneRailPayload }) {
  return (
    <div
      data-testid={`steering-lane-${lane.laneId}`}
      className="px-3 py-2"
    >
      <div className="flex items-baseline gap-2">
        <div className="font-mono text-[10px] font-bold text-stone-900">{lane.laneId}</div>
        <div className="ml-auto flex items-baseline gap-2">
          <HealthBadge label="active" count={lane.healthBadges.active} variant="active" />
          <HealthBadge label="blocked" count={lane.healthBadges.blocked} variant="blocked" />
          <HealthBadge label="done" count={lane.healthBadges.done} variant="done" />
        </div>
      </div>
      {lane.topItems.length === 0 ? (
        <div className="mt-1 font-mono text-[9px] text-stone-400">No checkbox rows.</div>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {lane.topItems.map((item) => (
            <LaneRailRow key={item.line} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LaneRailRow({ item }: { item: LaneRailItem }) {
  const { icon, color } = statusGlyph(item.status);
  return (
    <li
      data-testid={`steering-lane-row-${item.line}`}
      data-status={item.status}
      data-is-next-pull={item.isNextPull}
      className={`flex items-baseline gap-2 px-1 py-0.5 ${item.isNextPull ? "bg-emerald-50" : ""}`}
    >
      <span className={`shrink-0 font-mono text-[10px] ${color}`} aria-label={item.status}>{icon}</span>
      <span className="flex-1 font-mono text-[10px] text-stone-800 truncate">{item.text}</span>
      {item.isNextPull && (
        <span
          data-testid={`steering-lane-row-${item.line}-next-pull`}
          className="shrink-0 border border-emerald-400 bg-emerald-100 px-1 font-mono text-[8px] uppercase tracking-[0.10em] text-emerald-900"
        >
          next pull
        </span>
      )}
      <span className="shrink-0 font-mono text-[8px] text-stone-400">L{item.line}</span>
    </li>
  );
}

function HealthBadge({ label, count, variant }: { label: string; count: number; variant: "active" | "blocked" | "done" }) {
  const cls =
    variant === "active" ? "border-stone-300 bg-stone-50 text-stone-700"
    : variant === "blocked" ? "border-amber-300 bg-amber-50 text-amber-900"
    : "border-emerald-300 bg-emerald-50 text-emerald-900";
  return (
    <span
      data-testid={`steering-lane-badge-${variant}`}
      className={`inline-flex items-baseline gap-0.5 border px-1 font-mono text-[8px] uppercase tracking-[0.10em] ${cls}`}
    >
      <span>{label}</span>
      <span className="font-bold">{count}</span>
    </span>
  );
}

function statusGlyph(status: LaneRailItem["status"]): { icon: string; color: string } {
  switch (status) {
    case "done":    return { icon: "✓", color: "text-emerald-700" };
    case "blocked": return { icon: "⚠", color: "text-amber-700" };
    case "active":  return { icon: "◯", color: "text-stone-500" };
    default:        return { icon: "·", color: "text-stone-400" };
  }
}
