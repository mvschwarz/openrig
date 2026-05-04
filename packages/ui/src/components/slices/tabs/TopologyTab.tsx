// Slice Story View v0 — Topology tab.
//
// Read-only consumer of PL-019's extended graph payload (the route at
// /api/rigs/:rigId/graph already carries agentActivity + currentQitems
// per PL-019 commit ee39768). v0 ships a list-based view of the seats
// touching this slice grouped by rig — clicking through opens the main
// topology surface for the operator's deep-dive (per PRD: "this tab is
// read-only; clicking a node from here takes the operator to the
// regular topology / node-drawer surface").
//
// v1 will inline the actual rendered subgraph composing PL-019's
// RigNode + edge components, but v0's slimmer list satisfies the
// "see the seats" intent without re-mounting React Flow inside the
// slice context.

import { Link } from "@tanstack/react-router";
import type { SliceDetail } from "../../../hooks/useSlices.js";

export function TopologyTab({ topology }: { topology: SliceDetail["topology"] }) {
  if (topology.affectedRigs.length === 0) {
    return (
      <div className="p-4 font-mono text-[10px] text-stone-400" data-testid="topology-empty">
        No seats found for this slice's qitem chain.
      </div>
    );
  }
  return (
    <div data-testid="topology-tab" className="p-4 space-y-4">
      <header className="flex items-center justify-between border-b border-stone-200 pb-2">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-stone-700">
          Topology
        </div>
        <div className="font-mono text-[10px] text-stone-500" data-testid="topology-aggregate">
          {topology.totalSeats} seat{topology.totalSeats === 1 ? "" : "s"}
          {" · "}{topology.affectedRigs.length} rig{topology.affectedRigs.length === 1 ? "" : "s"}
        </div>
      </header>
      {topology.affectedRigs.map((rig) => (
        <section
          key={rig.rigName}
          data-testid={`topology-rig-${rig.rigName}`}
          className="border border-stone-200 bg-white"
        >
          <header className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-3 py-2">
            <div className="font-mono text-[10px] font-bold text-stone-900">{rig.rigName}</div>
            <Link
              to="/rigs/$rigId"
              params={{ rigId: rig.rigId }}
              data-testid={`topology-rig-${rig.rigName}-open`}
              className="font-mono text-[9px] uppercase tracking-[0.10em] text-blue-700 hover:underline"
            >
              Open topology →
            </Link>
          </header>
          <ul className="divide-y divide-stone-100">
            {rig.sessionNames.map((session) => (
              <li
                key={session}
                data-testid={`topology-seat-${session}`}
                className="px-3 py-1 font-mono text-[10px] text-stone-700"
              >
                {session}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
