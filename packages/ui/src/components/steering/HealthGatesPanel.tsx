// Operator Surface Reconciliation v0 — Compact Health Gates panel.
//
// Item 1F: rig ps + rig context summaries via /api/health-summary/*.
// Each badge is read-only at v0; deeper drill-down (e.g., clicking
// "attention-required: N") is a v1+ ergonomic upgrade and surfaced
// here as a copy-able CLI hint instead of a daemon write.
//
// PL-012: context-tier badges are now click-through links to the
// /context dashboard filtered by the corresponding tier. Operator
// scans steering, sees "critical: 2", clicks → /context filtered.

import { Link } from "@tanstack/react-router";
import { useContextHealth, useNodeHealth } from "../../hooks/useSteering.js";

export function HealthGatesPanel() {
  const nodeHealth = useNodeHealth();
  const contextHealth = useContextHealth();
  return (
    <section data-testid="steering-health-gates" className="border border-stone-300 bg-white">
      <header className="border-b border-stone-200 bg-stone-50 px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-700">
          Compact health gates
        </div>
      </header>
      <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
        <NodeGate />
        <ContextGate />
      </div>
    </section>
  );

  function NodeGate() {
    if (nodeHealth.isLoading) return <div className="font-mono text-[10px] text-stone-400">Loading nodes…</div>;
    if (nodeHealth.isError) return <div data-testid="steering-health-nodes-error" className="font-mono text-[10px] text-red-600">Health summary unavailable (nodes).</div>;
    if (!nodeHealth.data) return null;
    const { total, bySessionStatus, attentionRequired } = nodeHealth.data;
    return (
      <div data-testid="steering-health-nodes" className="space-y-1">
        <div className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">Nodes</div>
        <div className="flex flex-wrap items-baseline gap-2 font-mono text-[10px]">
          <Stat label="total" value={total} />
          <Stat label="running" value={bySessionStatus["running"] ?? 0} variant="ok" />
          <Stat label="detached" value={bySessionStatus["detached"] ?? 0} variant="warn" />
          <Stat label="exited" value={bySessionStatus["exited"] ?? 0} variant="dim" />
          <Stat label="attention" value={attentionRequired} variant={attentionRequired > 0 ? "alert" : "dim"} />
        </div>
        <div className="font-mono text-[8px] text-stone-400">via rig ps --nodes --summary</div>
      </div>
    );
  }

  function ContextGate() {
    if (contextHealth.isLoading) return <div className="font-mono text-[10px] text-stone-400">Loading context…</div>;
    if (contextHealth.isError) return <div data-testid="steering-health-context-error" className="font-mono text-[10px] text-red-600">Health summary unavailable (context).</div>;
    if (!contextHealth.data) return null;
    const { total, byUrgency, critical, warning, stale } = contextHealth.data;
    return (
      <div data-testid="steering-health-context" className="space-y-1">
        <div className="flex items-baseline justify-between">
          <div className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">Context usage</div>
          <Link
            to="/context"
            data-testid="steering-context-open"
            className="font-mono text-[9px] uppercase tracking-[0.10em] text-blue-700 hover:underline"
          >
            Open dashboard →
          </Link>
        </div>
        <div className="flex flex-wrap items-baseline gap-2 font-mono text-[10px]">
          <Stat label="total" value={total} />
          {/* PL-012: tier counts are click-through to /context?tier=…. */}
          <TierStatLink tier="low" label="ok" value={byUrgency["low"] ?? 0} variant="ok" />
          <TierStatLink tier="warning" label="warning" value={warning} variant={warning > 0 ? "warn" : "dim"} />
          <TierStatLink tier="critical" label="critical" value={critical} variant={critical > 0 ? "alert" : "dim"} />
          <Stat label="stale" value={stale} variant={stale > 0 ? "warn" : "dim"} />
        </div>
        <div className="font-mono text-[8px] text-stone-400">via rig context --json</div>
      </div>
    );
  }
}

function TierStatLink({
  tier,
  label,
  value,
  variant = "dim",
}: {
  tier: "critical" | "warning" | "low";
  label: string;
  value: number;
  variant?: "ok" | "warn" | "alert" | "dim";
}) {
  const cls =
    variant === "ok" ? "text-emerald-700"
    : variant === "warn" ? "text-amber-700"
    : variant === "alert" ? "text-red-700 font-bold"
    : "text-stone-600";
  return (
    <Link
      to="/context"
      search={{ tier }}
      data-testid={`steering-stat-${label}`}
      className="inline-flex items-baseline gap-0.5 hover:underline"
    >
      <span className="text-stone-500">{label}:</span>
      <span className={cls}>{value}</span>
    </Link>
  );
}

function Stat({ label, value, variant = "dim" }: { label: string; value: number; variant?: "ok" | "warn" | "alert" | "dim" }) {
  const cls =
    variant === "ok" ? "text-emerald-700"
    : variant === "warn" ? "text-amber-700"
    : variant === "alert" ? "text-red-700 font-bold"
    : "text-stone-600";
  return (
    <span data-testid={`steering-stat-${label}`} className="inline-flex items-baseline gap-0.5">
      <span className="text-stone-500">{label}:</span>
      <span className={cls}>{value}</span>
    </span>
  );
}
