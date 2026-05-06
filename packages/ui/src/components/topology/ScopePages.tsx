// V1 attempt-3 Phase 3 — Topology scope pages per topology-tree.md.
//
// SC-10 LOAD-BEARING: view-mode tabs IN-PLACE — single URL across tab
// switches. Tab state is React useState, NOT URL params. Each scope
// page renders its tab nav + the active view-mode panel.
// (Attempt-2 violated this by using separate routes per view-mode.)

import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import {
  TopologyViewModeTabs,
  HOST_SCOPE_TABS,
  RIG_POD_SCOPE_TABS,
  SEAT_SCOPE_TABS,
  type TopologyHostScopeTab,
  type TopologyRigPodScopeTab,
  type TopologySeatScopeTab,
} from "./TopologyViewModeTabs.js";
import { TopologyTableView } from "./TopologyTableView.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { RigGraph } from "../RigGraph.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { LiveNodeDetails } from "../LiveNodeDetails.js";

function ScopeShell({
  eyebrow,
  title,
  tabsNav,
  children,
}: {
  eyebrow: string;
  title: string;
  tabsNav: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-2 border-b border-outline-variant">
        <SectionHeader tone="muted">{eyebrow}</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900 mt-1 mb-3">
          {title}
        </h1>
        {tabsNav}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {children}
      </div>
    </div>
  );
}

function TerminalGridPlaceholder({ scope }: { scope: string }) {
  return (
    <div className="p-6">
      <EmptyState
        label="TERMINAL GRID"
        description={`${scope} terminals — pinned-card grid (Phase 5 polish; safe-N pagination per topology-terminal-view.md L70-80).`}
        variant="card"
        testId="topology-terminal-placeholder"
      />
    </div>
  );
}

export function HostScopePage() {
  const [active, setActive] = useState<TopologyHostScopeTab>("graph");
  const { data: rigs } = useRigSummary();

  return (
    <ScopeShell
      eyebrow="Topology · Host"
      title="localhost"
      tabsNav={<TopologyViewModeTabs tabs={HOST_SCOPE_TABS} active={active} onSelect={setActive} testIdPrefix="topology-host" />}
    >
      {active === "graph" ? (
        <div className="p-6">
          <EmptyState
            label="HOST GRAPH"
            description="Multi-rig graph view at host scope; click a rig to drill in."
            variant="card"
            testId="topology-host-graph-placeholder"
            action={
              rigs && rigs[0]
                ? { label: `Open ${rigs[0].name}`, href: `/topology/rig/${rigs[0].id}` }
                : undefined
            }
          />
        </div>
      ) : null}
      {active === "table" ? (
        <div className="px-6 pb-6">
          <TopologyTableView />
        </div>
      ) : null}
      {active === "terminal" ? <TerminalGridPlaceholder scope="Host" /> : null}
    </ScopeShell>
  );
}

export function RigScopePage() {
  const { rigId } = useParams({ from: "/topology/rig/$rigId" });
  const { data: rigs } = useRigSummary();
  const rig = rigs?.find((r) => r.id === rigId);
  const [active, setActive] = useState<TopologyRigPodScopeTab>("graph");

  return (
    <ScopeShell
      eyebrow="Topology · Rig"
      title={rig?.name ?? rigId}
      tabsNav={<TopologyViewModeTabs tabs={RIG_POD_SCOPE_TABS} active={active} onSelect={setActive} testIdPrefix="topology-rig" />}
    >
      {active === "graph" ? (
        <div className="flex-1 min-h-[400px] relative">
          <RigGraph rigId={rigId} rigName={rig?.name ?? null} showDiscovered={false} />
        </div>
      ) : null}
      {active === "table" ? (
        <div className="px-6 pb-6">
          <TopologyTableView rigIdScope={rigId} />
        </div>
      ) : null}
      {active === "terminal" ? <TerminalGridPlaceholder scope="Rig" /> : null}
      {active === "overview" ? (
        <div className="p-6">
          <EmptyState
            label="RIG OVERVIEW"
            description="Existing rig spec / detail page mounted here in Phase 5 polish."
            variant="card"
            testId="topology-rig-overview-placeholder"
          />
        </div>
      ) : null}
    </ScopeShell>
  );
}

export function PodScopePage() {
  const { rigId, podName } = useParams({ from: "/topology/pod/$rigId/$podName" });
  const [active, setActive] = useState<TopologyRigPodScopeTab>("table");

  return (
    <ScopeShell
      eyebrow="Topology · Pod"
      title={`${rigId} / ${podName}`}
      tabsNav={<TopologyViewModeTabs tabs={RIG_POD_SCOPE_TABS} active={active} onSelect={setActive} testIdPrefix="topology-pod" />}
    >
      {active === "graph" ? (
        <div className="p-6">
          <EmptyState label="POD GRAPH" description="Pod-scoped graph view (Phase 5 polish)." variant="card" />
        </div>
      ) : null}
      {active === "table" ? (
        <div className="px-6 pb-6">
          <TopologyTableView rigIdScope={rigId} />
        </div>
      ) : null}
      {active === "terminal" ? <TerminalGridPlaceholder scope="Pod" /> : null}
      {active === "overview" ? (
        <div className="p-6">
          <EmptyState label="POD OVERVIEW" description="Pod detail (Phase 5)." variant="card" />
        </div>
      ) : null}
    </ScopeShell>
  );
}

export function SeatScopePage() {
  const { rigId, logicalId } = useParams({ from: "/topology/seat/$rigId/$logicalId" });
  const decodedLogicalId = decodeURIComponent(logicalId);
  const [active, setActive] = useState<TopologySeatScopeTab>("detail");

  return (
    <ScopeShell
      eyebrow="Topology · Seat"
      title={decodedLogicalId}
      tabsNav={<TopologyViewModeTabs tabs={SEAT_SCOPE_TABS} active={active} onSelect={setActive} testIdPrefix="topology-seat" />}
    >
      {active === "detail" ? (
        <LiveNodeDetails rigId={rigId} logicalId={decodedLogicalId} />
      ) : null}
      {active === "transcript" ? (
        <div className="p-6">
          <EmptyState label="TRANSCRIPT" description="Existing transcript view re-mounts here in Phase 5 polish." variant="card" />
        </div>
      ) : null}
      {active === "terminal" ? (
        <div className="p-6">
          <EmptyState label="SEAT TERMINAL" description="Pinned terminal card (Phase 5); V2 web terminal." variant="card" />
        </div>
      ) : null}
    </ScopeShell>
  );
}
