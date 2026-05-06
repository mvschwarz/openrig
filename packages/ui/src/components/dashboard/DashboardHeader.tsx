// V1 attempt-3 Phase 3 — Dashboard header per dashboard.md L80–L87.
//
// Shows env / host name + greeting + quick stats line (rigs / agents /
// active work / attention) per SC-12 Dashboard top section.

import { useRigSummary } from "../../hooks/useRigSummary.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { formatHostLabel } from "../../lib/host-label.js";

export function DashboardHeader() {
  const { data: rigs } = useRigSummary();
  const { data: psEntries } = usePsEntries();

  const totalRigs = rigs?.length ?? 0;
  const totalAgents = rigs?.reduce((acc, r) => acc + r.nodeCount, 0) ?? 0;
  const activeAgents =
    psEntries?.reduce((acc, p) => acc + p.runningCount, 0) ?? 0;

  return (
    <header
      data-testid="dashboard-header"
      className="border-b border-outline-variant pb-4 mb-6"
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant mb-1">
        {formatHostLabel()}
      </div>
      <h1
        data-testid="dashboard-greeting"
        className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900"
      >
        Welcome back
      </h1>
      <div
        data-testid="dashboard-stats"
        className="font-mono text-xs text-on-surface-variant mt-2"
      >
        <span data-testid="stat-rigs">{totalRigs} rigs</span>
        <span className="mx-2">·</span>
        <span data-testid="stat-agents">
          {totalAgents} agents ({activeAgents} active)
        </span>
      </div>
    </header>
  );
}
