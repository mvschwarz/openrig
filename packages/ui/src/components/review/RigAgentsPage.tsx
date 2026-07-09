// OPR.0.4.4.22 — the AGENTS altitude: the rig-scope standalone coordination
// panel (the fourth altitude of the blessed spine HOST — MISSION — SLICE —
// AGENTS; the ZOOM target of the slice page's AGENTS region and the board/
// host agent-count chips).
//
// PURE PROJECTION rendered: NEEDS YOU + AGENTS (health line) + SETTLED from
// the composed rig read root. Agents author nothing for it; nothing polls
// them; a ▲ is information for the human only. Plain language first (BR-10);
// raw ids live in the drill-in tier.
//
// Route discipline (arch plan-review ruling, drift-killer 4): this route
// exists for ADDRESSING, not nav chrome — reached by ZOOM only (board/host
// chips, slice-region anchored zoom, breadcrumb up); it is NEVER a top-level
// nav entry. Anchored/filter state = query params (?slice=<name>,
// ?group=agent|slice), so every state is deep-link addressable.

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useRigAgents } from "../../hooks/useReview.js";
import { NeedsYouAccordion } from "./NeedsYouAccordion.js";
import { AgentsBandView } from "./AgentsBandView.js";
// OPR.0.4.6.MH5 (C4) — the FLEET band, placement option B of the founder
// LOCK (= BOTH). v1 MOUNT ENUMERATION (the LOCK's "wherever the per-host
// surfaces render" read as ALLOWING a single mount; the pm coherence leg
// confirms): this /agents rig-altitude root is the ONE v1 mount. The band
// renders NOTHING for a single-host operator, so this page stays
// byte-identical pre-fleet (the leg-7 zero-regression pin).
import { FleetBand } from "./FleetBand.js";
import type { EvidenceContext } from "./EvidenceOpener.js";
import { sessionMemberLabel } from "../../lib/session-name.js";

const SURFACE_ACTOR = "human@host";

/** Rig altitude has no single slice dir; evidence refs render as honest
 *  non-openable pointers here and open fully at the slice drill. */
const RIG_EVIDENCE_CTX: EvidenceContext = { root: null, relPath: null, slicePath: null };

function readSearchParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

function ageLabel(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
}

export function RigAgentsPage() {
  const { data, isLoading, error } = useRigAgents();
  const anchoredSlice = readSearchParam("slice");
  const initialGroup = readSearchParam("group") === "slice" ? "slice" : "agent";
  const [grouping, setGrouping] = useState<"agent" | "slice">(initialGroup);
  const setAddressableGrouping = (next: "agent" | "slice") => {
    setGrouping(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("group", next);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };

  // FR-5 anchored zoom: the slice page's AGENTS region opens this page
  // FILTERED to that slice's agents, with the full rig context one clear
  // step away. The filter is display-level; membership stays work-on-scope.
  const band = useMemo(() => {
    if (!data) return null;
    if (!anchoredSlice) return data.agents;
    const rows = data.agents.rows.filter((r) => r.slices.includes(anchoredSlice));
    return {
      ...data.agents,
      rows,
      provenance:
        rows.length === 0
          ? `no agents holding or recently holding work on ${anchoredSlice} — ${data.agents.provenance}`
          : `anchored to ${anchoredSlice} — ${data.agents.provenance}`,
    };
  }, [data, anchoredSlice]);

  if (isLoading) {
    return <p className="p-4 font-mono text-[11px] text-on-surface-variant">composing the rig coordination story…</p>;
  }
  if (error || !data || !band) {
    return (
      <p data-testid="rig-agents-error" className="p-4 font-mono text-[11px] text-red-700">
        rig agents panel unavailable: {error instanceof Error ? error.message : "composer unreachable"}
      </p>
    );
  }

  return (
    <div data-testid="rig-agents-page" className="mx-auto max-w-4xl space-y-5 p-4">
      {/* MH-5: the fleet altitude's ambient band above the rig altitude. */}
      <FleetBand />
      {/* Breadcrumb up the spine — one unbroken gesture both directions. */}
      <nav className="flex items-center gap-2 font-mono text-[10px] uppercase text-on-surface-variant">
        <Link to="/project" className="hover:underline">
          project
        </Link>
        <span>/</span>
        <span data-testid="rig-agents-crumb">agents (rig)</span>
        {anchoredSlice ? (
          <>
            <span>·</span>
            <span data-testid="rig-agents-anchor">anchored: {anchoredSlice}</span>
            <a href="/agents" className="hover:underline" data-testid="rig-agents-unanchor">
              [full rig]
            </a>
          </>
        ) : null}
      </nav>

      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">AGENTS — the coordination story</h2>
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase">
          <span className="text-on-surface-variant">group by</span>
          {(["agent", "slice"] as const).map((g) => (
            <button
              key={g}
              type="button"
              data-testid={`rig-agents-group-${g}`}
              onClick={() => setAddressableGrouping(g)}
              className={`border px-2 py-0.5 ${grouping === g ? "border-outline bg-surface-variant" : "border-outline-variant hover:bg-surface-variant/50"}`}
            >
              {g}
            </button>
          ))}
        </div>
      </header>

      {/* Band 1: NEEDS YOU — the attention band at rig scope. APPROVE is a
          slice-terminal act and is hidden here (zoom into the slice). */}
      <NeedsYouAccordion
        band={data.needsYou}
        slice="rig"
        actorSession={SURFACE_ACTOR}
        ctx={RIG_EVIDENCE_CTX}
        showApprove={false}
      />

      {/* Band 2: AGENTS — the field band (the shared P2 FR-4 anatomy at rig
          scope; grouping is page-level arrangement in the one home). */}
      <AgentsBandView band={band} itemRef="rig" grouping={grouping} />

      {/* Band 3: SETTLED — the record band (today's closed handoffs). */}
      <section data-testid="settled-band" className="space-y-1">
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">SETTLED</h3>
        {data.settled.length === 0 ? (
          <p data-testid="settled-empty" className="font-mono text-[11px] text-on-surface-variant">
            {data.settledProvenance}
          </p>
        ) : (
          <>
            <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
              {data.settled.map((row) => (
                <li key={`${row.qitemId}-${row.closedAtIso}`} className="flex items-center gap-2 px-2 py-1.5">
                  <span className="font-mono text-[10px] text-on-surface-variant">{sessionMemberLabel(row.fromSession)}</span>
                  <span className="text-on-surface-variant">→</span>
                  <span className="font-mono text-[10px] text-on-surface-variant">{sessionMemberLabel(row.toSession)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px]" data-testid={`settled-summary-${row.qitemId}`}>
                    {row.summary ?? row.qitemId}
                  </span>
                  <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(row.closedAtIso)}</span>
                </li>
              ))}
            </ul>
            <p className="font-mono text-[10px] text-on-surface-variant">{data.settledProvenance}</p>
          </>
        )}
      </section>

      <p className="font-mono text-[10px] text-on-surface-variant">composed {data.composedAt}</p>
    </div>
  );
}
