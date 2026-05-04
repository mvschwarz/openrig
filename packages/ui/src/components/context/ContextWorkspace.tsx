// Token / Context Usage Surface v0 (PL-012) — /context route workspace.
//
// One-screen portfolio scan of context-usage across all running seats:
// - Header summary: total + tier counts (critical/warning/low/unknown).
// - Filter chips: tier, runtime, rig.
// - Per-seat list sorted by usedPercentage descending.
// - Refresh button (re-fetches /api/ps + per-rig /nodes via the hook).
// - Compact action surfaces a copy-able `rig compact-plan --rig <rig>`.
//
// Auto-compact OUT per founder safety stop directive
// (feedback_safety_stop_no_auto_review_loops). Surface visibility only.

import { useState, useMemo } from "react";
import { useSearch } from "@tanstack/react-router";
import { useContextFleet, type ContextTier, type FleetSeat } from "../../hooks/useContextFleet.js";
import { copyText } from "../../lib/copy-text.js";

const TIER_LABEL: Record<ContextTier, string> = {
  critical: "critical",
  warning: "warning",
  low: "ok",
  unknown: "unknown",
};

const TIER_BADGE: Record<ContextTier, string> = {
  critical: "bg-red-100 text-red-800 border-red-300",
  warning: "bg-amber-100 text-amber-800 border-amber-300",
  low: "bg-emerald-100 text-emerald-800 border-emerald-300",
  unknown: "bg-stone-100 text-stone-600 border-stone-300",
};

interface ContextWorkspaceSearch {
  tier?: ContextTier;
  runtime?: string;
  rigId?: string;
}

export function ContextWorkspace() {
  const search = useSearch({ strict: false }) as ContextWorkspaceSearch;
  const { data, isLoading, isError, error, refetch, isFetching } = useContextFleet();
  const [tierFilter, setTierFilter] = useState<ContextTier | null>(search.tier ?? null);
  const [runtimeFilter, setRuntimeFilter] = useState<string | null>(search.runtime ?? null);
  const [rigFilter, setRigFilter] = useState<string | null>(search.rigId ?? null);
  const [copiedSession, setCopiedSession] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.seats
      .filter((s) => !tierFilter || s.tier === tierFilter)
      .filter((s) => !runtimeFilter || (s.runtime ?? "unknown") === runtimeFilter)
      .filter((s) => !rigFilter || s.rigId === rigFilter)
      .sort(seatComparator);
  }, [data, tierFilter, runtimeFilter, rigFilter]);

  const onCompact = async (seat: FleetSeat) => {
    const cmd = `rig compact-plan --rig ${seat.rigName}`;
    const ok = await copyText(cmd);
    if (ok) {
      setCopiedSession(seat.canonicalSessionName ?? seat.logicalId);
      window.setTimeout(() => setCopiedSession(null), 2000);
    }
  };

  if (isLoading) {
    return (
      <div data-testid="context-workspace-loading" className="p-6 font-mono text-[10px] text-stone-400">
        Loading fleet context state…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div data-testid="context-workspace-error" className="p-6 font-mono text-[10px] text-red-600">
        Could not load fleet context state: {(error as Error)?.message ?? "unknown"}.
        <div className="mt-2 text-stone-500">
          Cross-version fallback: use <code>rig context --json</code> from terminal.
        </div>
      </div>
    );
  }

  const { summary } = data;

  return (
    <div data-testid="context-workspace" className="p-6 space-y-4">
      <header className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-mono text-sm font-bold text-stone-900">Context Usage</h2>
          <button
            type="button"
            data-testid="context-workspace-refresh"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="font-mono text-[9px] uppercase tracking-[0.10em] border border-stone-400 px-2 py-1 hover:bg-stone-200 disabled:opacity-50"
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div className="font-mono text-[10px] text-stone-500">
          fleet-wide context-usage portfolio · auto-refreshes every 15s
        </div>
        <div className="flex flex-wrap items-baseline gap-3 font-mono text-[10px]">
          <Stat label="total" value={summary.total} />
          <Stat label="critical" value={summary.byTier.critical} variant="alert" />
          <Stat label="warning" value={summary.byTier.warning} variant="warn" />
          <Stat label="ok" value={summary.byTier.low} variant="ok" />
          <Stat label="unknown" value={summary.byTier.unknown} variant="dim" />
        </div>
      </header>

      <section data-testid="context-filter-bar" className="space-y-2 border border-stone-300 bg-white px-3 py-2">
        <FilterRow
          label="tier"
          values={(["critical", "warning", "low", "unknown"] as ContextTier[])
            .filter((t) => summary.byTier[t] > 0)
            .map((t) => ({ id: t, label: `${TIER_LABEL[t]} (${summary.byTier[t]})` }))}
          selected={tierFilter}
          onSelect={(v) => setTierFilter(v as ContextTier | null)}
        />
        <FilterRow
          label="runtime"
          values={Object.entries(summary.byRuntime).map(([rt, n]) => ({ id: rt, label: `${rt} (${n})` }))}
          selected={runtimeFilter}
          onSelect={setRuntimeFilter}
        />
        <FilterRow
          label="rig"
          values={summary.byRig.map((r) => ({ id: r.rigId, label: `${r.rigName} (${r.count})` }))}
          selected={rigFilter}
          onSelect={setRigFilter}
        />
      </section>

      {filtered.length === 0 ? (
        <div data-testid="context-seats-empty" className="font-mono text-[10px] text-stone-500 px-3 py-2 border border-stone-200">
          No seats match the current filters.
        </div>
      ) : (
        <ul data-testid="context-seat-list" className="border border-stone-300 bg-white divide-y divide-stone-100">
          {filtered.map((seat) => (
            <li
              key={`${seat.rigId}/${seat.logicalId}`}
              data-testid={`context-seat-${seat.logicalId}`}
              data-rig-id={seat.rigId}
              data-tier={seat.tier}
              className="flex items-baseline gap-3 px-3 py-1.5"
            >
              <span className="font-mono text-[10px] text-stone-500 shrink-0 w-32 truncate">{seat.rigName}</span>
              <span className="font-mono text-[10px] font-semibold text-stone-900 shrink-0 truncate flex-1">
                {seat.canonicalSessionName ?? seat.logicalId}
              </span>
              <span className="font-mono text-[9px] text-stone-500 shrink-0 w-20">{seat.runtime ?? "—"}</span>
              <span className="font-mono text-[10px] shrink-0 w-12 text-right">
                {typeof seat.usedPercentage === "number" ? `${seat.usedPercentage}%` : "—"}
                {seat.fresh === false && typeof seat.usedPercentage === "number" && (
                  <span className="text-stone-400">*</span>
                )}
              </span>
              <span
                data-testid={`context-seat-${seat.logicalId}-tier-badge`}
                className={`font-mono text-[8px] uppercase tracking-[0.10em] border px-1 py-0.5 shrink-0 ${TIER_BADGE[seat.tier]}`}
              >
                {TIER_LABEL[seat.tier]}
              </span>
              <button
                type="button"
                data-testid={`context-seat-${seat.logicalId}-compact`}
                onClick={() => void onCompact(seat)}
                className="font-mono text-[8px] uppercase tracking-[0.10em] border border-stone-300 px-1 py-0.5 hover:bg-stone-200 shrink-0"
              >
                {copiedSession === (seat.canonicalSessionName ?? seat.logicalId) ? "Copied" : "Compact cmd"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, variant = "dim" }: { label: string; value: number; variant?: "ok" | "warn" | "alert" | "dim" }) {
  const cls =
    variant === "ok" ? "text-emerald-700"
    : variant === "warn" ? "text-amber-700"
    : variant === "alert" ? "text-red-700 font-bold"
    : "text-stone-600";
  return (
    <span data-testid={`context-stat-${label}`} className="inline-flex items-baseline gap-0.5">
      <span className="text-stone-500">{label}:</span>
      <span className={cls}>{value}</span>
    </span>
  );
}

function FilterRow({ label, values, selected, onSelect }: {
  label: string;
  values: Array<{ id: string; label: string }>;
  selected: string | null;
  onSelect: (v: string | null) => void;
}) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-1">
      <span className="font-mono text-[8px] uppercase tracking-[0.10em] text-stone-500 shrink-0 w-12">{label}</span>
      <button
        type="button"
        data-testid={`context-filter-${label}-all`}
        data-selected={selected === null}
        onClick={() => onSelect(null)}
        className={`font-mono text-[9px] border px-1.5 py-0.5 ${
          selected === null
            ? "border-stone-700 bg-stone-700 text-white"
            : "border-stone-300 text-stone-700 hover:bg-stone-100"
        }`}
      >
        all
      </button>
      {values.map((v) => (
        <button
          key={v.id}
          type="button"
          data-testid={`context-filter-${label}-${v.id}`}
          data-selected={selected === v.id}
          onClick={() => onSelect(v.id)}
          className={`font-mono text-[9px] border px-1.5 py-0.5 ${
            selected === v.id
              ? "border-stone-700 bg-stone-700 text-white"
              : "border-stone-300 text-stone-700 hover:bg-stone-100"
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

function seatComparator(a: FleetSeat, b: FleetSeat): number {
  const ap = typeof a.usedPercentage === "number" ? a.usedPercentage : -1;
  const bp = typeof b.usedPercentage === "number" ? b.usedPercentage : -1;
  if (ap !== bp) return bp - ap;
  return a.logicalId.localeCompare(b.logicalId);
}
