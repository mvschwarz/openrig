// V1 attempt-3 Phase 3 — Dashboard Topology card per dashboard.md L44–L50 + SC-13.
//
// **V1 = COUNTS ONLY** (NOT live graph rendering). Founder direction
// 2026-05-05: count fallback as default; live mini-mode RigGraph render
// is V2 candidate only if a memoized / reduced-dagre variant is cheap
// enough at audit.

import { Link } from "@tanstack/react-router";
import { Network } from "lucide-react";
import { VellumCard } from "../../ui/vellum-card.js";
import { SectionHeader } from "../../ui/section-header.js";
import { useRigSummary } from "../../../hooks/useRigSummary.js";
import { usePsEntries } from "../../../hooks/usePsEntries.js";

export function TopologyCard() {
  const { data: rigs } = useRigSummary();
  const { data: psEntries } = usePsEntries();
  const totalRigs = rigs?.length ?? 0;
  const totalAgents = rigs?.reduce((a, r) => a + r.nodeCount, 0) ?? 0;
  const activeAgents = psEntries?.reduce((a, p) => a + p.runningCount, 0) ?? 0;

  return (
    <Link
      to="/topology"
      data-testid="dashboard-card-topology"
      className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 focus-visible:outline-offset-2"
    >
      <VellumCard className="h-full hover:hard-shadow-hover">
        <div className="bg-stone-900 text-white px-4 py-1.5 flex items-center gap-2">
          <Network className="h-3 w-3" />
          <SectionHeader tone="default" className="text-stone-50">
            Topology
          </SectionHeader>
        </div>
        <div className="p-4 space-y-3">
          <div data-testid="topology-card-counts" className="space-y-1.5">
            <div className="flex justify-between font-mono text-xs">
              <span className="text-on-surface-variant">Rigs</span>
              <span className="text-stone-900 font-bold">{totalRigs}</span>
            </div>
            <div className="flex justify-between font-mono text-xs">
              <span className="text-on-surface-variant">Agents</span>
              <span className="text-stone-900 font-bold">{totalAgents}</span>
            </div>
            <div className="flex justify-between font-mono text-xs">
              <span className="text-on-surface-variant">Active</span>
              <span className="text-success font-bold">{activeAgents}</span>
            </div>
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant pt-1">
            host · rig · pod · seat tree →
          </div>
        </div>
      </VellumCard>
    </Link>
  );
}
