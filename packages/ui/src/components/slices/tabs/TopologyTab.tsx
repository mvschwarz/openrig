// Slice Story View v0 + v1 — Topology tab.
//
// v0: per-rig session-name list grouped by rig with click-through to
// the main topology surface. The tab remains a read-current-state view
// and links out to the canonical topology surface for deeper action.
//
// v1 dimension #1: when a workflow_instance is bound to the slice,
// renders the spec graph (one node per spec step; edges from each
// step's next_hop.suggested_roles). Composes with the v0 per-rig
// listing. The current step is highlighted, the entry step is marked,
// terminal steps are marked, and loop-back edges are styled differently
// from forward edges.
//
// v1 dimension #4: edges carry a routingType field. Phase D's spec
// format does NOT yet have a routing_type metadata field (per audit-
// row-6 carve-out from the PRD), so all edges are routingType=`direct`
// at v1. The styling differentiates loop-back vs. forward; richer
// routing-type styling (artifact-pool, async, fan-out, etc.) is
// v2+ territory.

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { SliceDetail } from "../../../hooks/useSlices.js";
import { SessionPreviewPane } from "../../preview/SessionPreviewPane.js";
import { SliceWorkflowGraph } from "./SliceWorkflowGraph.js";

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

      {specGraph && <SliceWorkflowGraph specGraph={specGraph} />}

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
