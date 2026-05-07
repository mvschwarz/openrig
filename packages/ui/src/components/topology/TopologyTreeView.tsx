// V1 attempt-3 Phase 3 — Topology tree per topology-tree.md L13–L29 + SC-9 + SC-11b.
//
// host > rig > pod > seat. Multi-host envelope: V1 has only one host
// node ("localhost") above all rigs; V2 adds remote host registration.
//
// V1 polish slice Phase 5.1 P5.1-2 + DRIFT P5.1-D2: SeatLeaf details
// icon (P5-1) RETIRED at V1 polish. Founder direction: graph node
// click + tree click + table row click all navigate to the canonical
// /topology/seat/$rigId/$logicalId center page. The drawer-as-seat-
// detail mode is gone; SeatDetailTrigger primitive deleted.
//
// P5.1-2 second part — auto-expand: when the route is on a seat URL,
// expand the matching rig + pod branches automatically so the user
// sees where the agent lives in the tree. Implemented via
// useRouterState pathname parsing inside RigBranch + PodBranch.

import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Globe } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { useNodeInventory } from "../../hooks/useNodeInventory.js";
import { displayPodName, inferPodName } from "../../lib/display-name.js";

/** Parse the active topology pathname for the seat-scope rigId+logicalId
 *  and (when on a rig/pod URL) the active rigId / podName. Used for
 *  auto-expand of the matching branches. */
function useActiveTopologyContext(): {
  rigId: string | null;
  podName: string | null;
  logicalId: string | null;
} {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // /topology/seat/$rigId/$logicalId
  const seatMatch = pathname.match(/^\/topology\/seat\/([^/]+)\/(.+)$/);
  if (seatMatch) {
    const rigId = decodeURIComponent(seatMatch[1]!);
    const logicalId = decodeURIComponent(seatMatch[2]!);
    const podName = inferPodName(logicalId) ?? "default";
    return { rigId, podName, logicalId };
  }
  // /topology/pod/$rigId/$podName
  const podMatch = pathname.match(/^\/topology\/pod\/([^/]+)\/([^/]+)$/);
  if (podMatch) {
    return {
      rigId: decodeURIComponent(podMatch[1]!),
      podName: decodeURIComponent(podMatch[2]!),
      logicalId: null,
    };
  }
  // /topology/rig/$rigId
  const rigMatch = pathname.match(/^\/topology\/rig\/([^/]+)$/);
  if (rigMatch) {
    return { rigId: decodeURIComponent(rigMatch[1]!), podName: null, logicalId: null };
  }
  return { rigId: null, podName: null, logicalId: null };
}

function SeatLeaf({ rigId, logicalId, label, isActive }: {
  rigId: string;
  logicalId: string;
  label: string;
  isActive: boolean;
}) {
  return (
    <li className="px-2 py-0.5 hover:bg-surface-low">
      <Link
        to="/topology/seat/$rigId/$logicalId"
        params={{ rigId, logicalId: encodeURIComponent(logicalId) }}
        data-testid={`topology-seat-${rigId}-${logicalId}`}
        data-active={isActive}
        className={cn(
          "block w-full min-w-0 font-mono text-xs truncate",
          isActive
            ? "text-stone-900 font-bold"
            : "text-on-surface hover:text-stone-900",
        )}
      >
        {label}
      </Link>
    </li>
  );
}

function PodBranch({ rigId, podName, seats, activeRigId, activePodName, activeLogicalId }: {
  rigId: string;
  podName: string;
  seats: Array<{ logicalId: string; label: string }>;
  activeRigId: string | null;
  activePodName: string | null;
  activeLogicalId: string | null;
}) {
  const [open, setOpen] = useState(false);
  // P5.1-2 auto-expand: when current route is on this pod (via pod URL
  // OR via a seat URL whose pod resolves to this pod), force-expand.
  const shouldAutoExpand =
    activeRigId === rigId && activePodName === podName;
  useEffect(() => {
    if (shouldAutoExpand && !open) setOpen(true);
  }, [shouldAutoExpand, open]);
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
            <SeatLeaf
              key={s.logicalId}
              rigId={rigId}
              logicalId={s.logicalId}
              label={s.label}
              isActive={activeRigId === rigId && activeLogicalId === s.logicalId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function RigBranch({ rigId, rigName, activeRigId, activePodName, activeLogicalId }: {
  rigId: string;
  rigName: string;
  activeRigId: string | null;
  activePodName: string | null;
  activeLogicalId: string | null;
}) {
  // P5.1-2 auto-expand: when the active route lives in this rig (rig
  // scope URL OR pod/seat scope URL whose rigId matches), force-expand.
  const shouldAutoExpand = activeRigId === rigId;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (shouldAutoExpand && !open) setOpen(true);
  }, [shouldAutoExpand, open]);
  // When auto-expanded, fetch nodes eagerly so the pod tree resolves
  // even if user lands on a deep URL without manually expanding the rig.
  const eagerFetch = open || shouldAutoExpand;
  const { data: nodes } = useNodeInventory(eagerFetch ? rigId : null);
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
              <PodBranch
                key={pod}
                rigId={rigId}
                podName={pod}
                seats={seats}
                activeRigId={activeRigId}
                activePodName={activePodName}
                activeLogicalId={activeLogicalId}
              />
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
  // P5.1-2 auto-expand: pull active route context once at the tree root
  // and thread down through RigBranch + PodBranch.
  const { rigId: activeRigId, podName: activePodName, logicalId: activeLogicalId } =
    useActiveTopologyContext();

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
                rigs.map((r) => (
                  <RigBranch
                    key={r.id}
                    rigId={r.id}
                    rigName={r.name}
                    activeRigId={activeRigId}
                    activePodName={activePodName}
                    activeLogicalId={activeLogicalId}
                  />
                ))
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
