// V1 attempt-3 Phase 3 — Topology tree per topology-tree.md L13–L29 + SC-9 + SC-11b.
//
// host > rig > pod > seat. Multi-host envelope: V1 has only one host
// node ("localhost") above all rigs; V2 adds remote host registration.
//
// V1 attempt-3 Phase 5 P5-1: seat leaves gain a "details" icon that opens
// SeatDetailViewer in the right drawer per content-drawer.md L40 manual-open
// contract ("'details' icon on any topology node — replaces current auto-open
// behavior"). The seat row remains a Link to /topology/seat/$rigId/$logicalId
// for explicit center navigation; the icon is the named-trigger drawer surface.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Globe, PanelRightOpen } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { useNodeInventory } from "../../hooks/useNodeInventory.js";
import { displayPodName, inferPodName } from "../../lib/display-name.js";
import { SeatDetailTrigger } from "../drawer-triggers/SeatDetailTrigger.js";

function SeatLeaf({ rigId, logicalId, label }: { rigId: string; logicalId: string; label: string }) {
  return (
    <li className="group flex items-center gap-1 px-2 py-0.5 hover:bg-surface-low">
      <Link
        to="/topology/seat/$rigId/$logicalId"
        params={{ rigId, logicalId: encodeURIComponent(logicalId) }}
        data-testid={`topology-seat-${rigId}-${logicalId}`}
        className="flex-1 min-w-0 font-mono text-xs text-on-surface hover:text-stone-900 truncate"
      >
        {label}
      </Link>
      <SeatDetailTrigger
        rigId={rigId}
        logicalId={logicalId}
        testId={`topology-seat-details-${rigId}-${logicalId}`}
        className="shrink-0 p-0.5 rounded-sm text-on-surface-variant hover:text-stone-900 hover:bg-stone-200/60 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
      >
        <PanelRightOpen className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
        <span className="sr-only">Open details in drawer</span>
      </SeatDetailTrigger>
    </li>
  );
}

function PodBranch({ rigId, podName, seats }: {
  rigId: string;
  podName: string;
  seats: Array<{ logicalId: string; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li data-testid={`topology-pod-${rigId}-${podName}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 px-2 py-0.5 hover:bg-surface-low text-left"
      >
        {open ? <ChevronDown className="h-3 w-3 text-on-surface-variant" /> : <ChevronRight className="h-3 w-3 text-on-surface-variant" />}
        <Link
          to="/topology/pod/$rigId/$podName"
          params={{ rigId, podName }}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-[11px] text-stone-900 flex-1 truncate hover:underline"
        >
          {displayPodName(podName)}
        </Link>
        <span className="font-mono text-[9px] text-on-surface-variant">{seats.length}</span>
      </button>
      {open ? (
        <ul className="ml-4 border-l border-stone-200">
          {seats.map((s) => (
            <SeatLeaf key={s.logicalId} rigId={rigId} logicalId={s.logicalId} label={s.label} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function RigBranch({ rigId, rigName }: { rigId: string; rigName: string }) {
  const [open, setOpen] = useState(false);
  const { data: nodes } = useNodeInventory(open ? rigId : null);
  const podsMap = new Map<string, Array<{ logicalId: string; label: string }>>();
  for (const n of nodes ?? []) {
    const pod = inferPodName(n.logicalId) ?? "default";
    if (!podsMap.has(pod)) podsMap.set(pod, []);
    podsMap.get(pod)!.push({ logicalId: n.logicalId, label: n.canonicalSessionName ?? n.logicalId });
  }
  const pods = Array.from(podsMap.entries());

  return (
    <li data-testid={`topology-rig-${rigId}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
      >
        {open ? <ChevronDown className="h-3 w-3 text-on-surface-variant" /> : <ChevronRight className="h-3 w-3 text-on-surface-variant" />}
        <Link
          to="/topology/rig/$rigId"
          params={{ rigId }}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-[11px] uppercase text-stone-900 flex-1 truncate hover:underline"
        >
          {rigName}
        </Link>
      </button>
      {open ? (
        <ul className="ml-4 border-l border-stone-200">
          {pods.length === 0 ? (
            <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
              Loading…
            </li>
          ) : (
            pods.map(([pod, seats]) => (
              <PodBranch key={pod} rigId={rigId} podName={pod} seats={seats} />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

export function TopologyTreeView() {
  const { data: rigs } = useRigSummary();
  const [hostOpen, setHostOpen] = useState(true);

  return (
    <div data-testid="topology-tree-view" className="flex-1 overflow-y-auto py-2">
      <ul>
        <li data-testid="topology-host-localhost">
          <button
            type="button"
            onClick={() => setHostOpen((o) => !o)}
            className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
          >
            {hostOpen ? <ChevronDown className="h-3 w-3 text-on-surface-variant" /> : <ChevronRight className="h-3 w-3 text-on-surface-variant" />}
            <Globe className="h-3 w-3 text-on-surface-variant" />
            <Link
              to="/topology"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-[11px] uppercase text-stone-900 flex-1 hover:underline"
            >
              localhost
            </Link>
            <span className="font-mono text-[9px] text-on-surface-variant">{rigs?.length ?? 0}</span>
          </button>
          {hostOpen ? (
            <ul className="ml-5">
              {rigs && rigs.length > 0 ? (
                rigs.map((r) => <RigBranch key={r.id} rigId={r.id} rigName={r.name} />)
              ) : (
                <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
                  No rigs.
                </li>
              )}
            </ul>
          ) : null}
        </li>
      </ul>
    </div>
  );
}
