// Slice Story View v0 + v1 — Topology tab.
//
// v0: per-rig session-name list grouped by rig with click-through to
// the main topology surface (per PRD: "this tab is read-only; clicking
// a node from here takes the operator to the regular topology /
// node-drawer surface").
//
// v1 dimension #1: when a workflow_instance is bound to the slice,
// renders the spec graph (one node per spec step; edges from each
// step's next_hop.suggested_roles). Composes with the v0 per-rig
// listing — both views render together. The current step is
// highlighted, the entry step is marked, terminal steps are marked,
// and loop-back edges are styled differently from forward edges.
//
// v1 dimension #4: edges carry a routingType field. Phase D's spec
// format does NOT yet have a routing_type metadata field (per audit-
// row-6 carve-out from the PRD), so all edges are routingType=`direct`
// at v1. The styling differentiates loop-back vs. forward; richer
// routing-type styling (artifact-pool, async, fan-out, etc.) is
// v2+ territory.

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { SliceDetail, SpecGraphPayload } from "../../../hooks/useSlices.js";
import { SessionPreviewPane } from "../../preview/SessionPreviewPane.js";

export function TopologyTab({ topology }: { topology: SliceDetail["topology"] }) {
  const { affectedRigs, totalSeats, specGraph } = topology;
  const hasAnything = affectedRigs.length > 0 || specGraph !== null;
  if (!hasAnything) {
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
          {totalSeats} seat{totalSeats === 1 ? "" : "s"}
          {" · "}{affectedRigs.length} rig{affectedRigs.length === 1 ? "" : "s"}
          {specGraph && (
            <>
              {" · spec "}
              <span data-testid="topology-spec-name">{specGraph.specName}</span>
              {" v"}{specGraph.specVersion}
            </>
          )}
        </div>
      </header>

      {specGraph && <SpecGraphPanel specGraph={specGraph} />}

      {affectedRigs.length > 0 && (
        <div data-testid="topology-rig-listing" className="space-y-3">
          {specGraph && (
            <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">
              Active seats
            </div>
          )}
          {affectedRigs.map((rig) => (
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
                  <SeatRow key={session} session={session} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// Preview Terminal v0 (PL-018) — clickable seat row.
// Click toggles inline preview for the seat using the session-keyed
// preview alias. Operator wanting persistent / multi-pin behavior
// pins from the node-detail drawer (separate flow).
function SeatRow({ session }: { session: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li
      data-testid={`topology-seat-${session}`}
      data-open={open ? "true" : "false"}
      className="px-3 py-1"
    >
      <button
        type="button"
        data-testid={`topology-seat-${session}-toggle`}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-baseline gap-2 text-left font-mono text-[10px] text-stone-700 hover:bg-stone-50 -mx-3 px-3 py-0.5"
      >
        <span className="flex-1 truncate">{session}</span>
        <span className="text-stone-400 shrink-0">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div data-testid={`topology-seat-${session}-preview`} className="mt-1">
          <SessionPreviewPane sessionName={session} testIdPrefix={`topology-preview-${session}`} />
        </div>
      )}
    </li>
  );
}

// v1 dimension #1: spec graph panel — nodes (one per step) + edges
// (derived from each step's next_hop.suggested_roles). v1 ships a
// list-based + adjacency view (not a force-laid-out canvas) — same
// "see the spec shape" intent at a fraction of the React Flow
// integration cost; v2+ can swap in a rendered subgraph.
function SpecGraphPanel({ specGraph }: { specGraph: SpecGraphPayload }) {
  return (
    <section
      data-testid="topology-spec-graph"
      data-spec-name={specGraph.specName}
      data-spec-version={specGraph.specVersion}
      className="border border-stone-300 bg-white"
    >
      <header className="border-b border-stone-200 bg-stone-50 px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">
          Spec graph · {specGraph.specName} v{specGraph.specVersion}
        </div>
      </header>
      <div className="grid grid-cols-1 divide-y divide-stone-100">
        {specGraph.nodes.map((node) => {
          const outgoingEdges = specGraph.edges.filter((e) => e.fromStepId === node.stepId);
          return (
            <div
              key={node.stepId}
              data-testid={`spec-node-${node.stepId}`}
              data-is-current={node.isCurrent}
              data-is-entry={node.isEntry}
              data-is-terminal={node.isTerminal}
              className={`px-3 py-2 ${node.isCurrent ? "bg-emerald-50" : ""}`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`font-mono text-[11px] font-bold ${
                    node.isCurrent ? "text-emerald-900" : "text-stone-900"
                  }`}
                >
                  {node.stepId}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500">
                  role: {node.role}
                </span>
                {node.isEntry && (
                  <span
                    data-testid={`spec-node-${node.stepId}-entry-badge`}
                    className="border border-blue-300 bg-blue-50 px-1 font-mono text-[8px] uppercase tracking-[0.10em] text-blue-900"
                  >
                    entry
                  </span>
                )}
                {node.isCurrent && (
                  <span
                    data-testid={`spec-node-${node.stepId}-current-badge`}
                    className="border border-emerald-400 bg-emerald-100 px-1 font-mono text-[8px] uppercase tracking-[0.10em] text-emerald-900"
                  >
                    current
                  </span>
                )}
                {node.isTerminal && (
                  <span
                    data-testid={`spec-node-${node.stepId}-terminal-badge`}
                    className="border border-stone-300 bg-stone-100 px-1 font-mono text-[8px] uppercase tracking-[0.10em] text-stone-700"
                  >
                    terminal
                  </span>
                )}
                {node.preferredTarget && (
                  <span className="ml-auto font-mono text-[9px] text-stone-400">
                    → {node.preferredTarget}
                  </span>
                )}
              </div>
              {outgoingEdges.length > 0 && (
                <ul className="mt-1 ml-4">
                  {outgoingEdges.map((edge) => (
                    <li
                      key={`${edge.fromStepId}-${edge.toStepId}`}
                      data-testid={`spec-edge-${edge.fromStepId}-${edge.toStepId}`}
                      data-routing-type={edge.routingType}
                      data-is-loop-back={edge.isLoopBack}
                      className="flex items-center gap-2"
                    >
                      <span
                        aria-label={edge.isLoopBack ? "loop-back edge" : "forward edge"}
                        className={`font-mono text-[10px] ${
                          edge.isLoopBack ? "text-amber-700" : "text-stone-500"
                        }`}
                      >
                        {edge.isLoopBack ? "↺" : "→"}
                      </span>
                      <span className="font-mono text-[10px] text-stone-700">
                        {edge.toStepId}
                      </span>
                      {edge.isLoopBack && (
                        <span className="font-mono text-[8px] uppercase tracking-[0.10em] text-amber-700">
                          loop
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
