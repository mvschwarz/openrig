// V1 attempt-3 Phase 3 — Topology scope pages per topology-tree.md.
//
// SC-10 LOAD-BEARING: view-mode tabs IN-PLACE — single URL across tab
// switches. Tab state is React useState, NOT URL params. Each scope
// page renders its tab nav + the active view-mode panel.
// (Attempt-2 violated this by using separate routes per view-mode.)

import { useState, useEffect } from "react";
import { useParams, Link } from "@tanstack/react-router";
import { PageHeader } from "../ui/page-header.js";
import { StatusBadge } from "../ui/status-badge.js";
import { Button } from "../ui/button.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";
import { useStartRig, useLaunchRig, useTeardownRig, useCreateSnapshot } from "../../hooks/mutations.js";
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
import { ErrorBoundary } from "../ui/ErrorBoundary.js";
// OPR.0.4.6.2 (FR-5): the shipped rig-scope "Launch in CMUX" button generalizes
// to a provider + view picker (herdr primary, cmux best-effort). Same tab-bar
// trailing slot; LaunchCmuxButton.tsx stays (its graph/detail affordances are
// untouched), superseded HERE by TerminalLauncher.
import { TerminalLauncher } from "./TerminalLauncher.js";
import { TopologyTerminalView } from "./TopologyTerminalView.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { RigGraph } from "../RigGraph.js";
import { RigSpecDisplay } from "../RigSpecDisplay.js";
import { RigStatusControl } from "../RigStatusControl.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { useHosts, useSelectHost, useHostSelection } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { useRigSpecExport } from "../../hooks/useRigSpecExport.js";
import { useRigSpecReview } from "../../hooks/useSpecReview.js";
import { WorkflowCodePreview } from "../WorkflowScaffold.js";
import { LiveNodeDetails } from "../LiveNodeDetails.js";
import { useTopologyOverlay } from "./topology-overlay-context.js";
// V1 attempt-3 Phase 5 P5-9: graph view-mode degrades to table on
// narrow viewports per universal-shell.md L143 ("Topology graph view
// degrades to table view by default on mobile (graph is too dense for
// phone screens)").
import { useShellViewport } from "../../hooks/useShellViewport.js";
import { useNodeInventory } from "../../hooks/useNodeInventory.js";
import { computeActivityRollup, formatRollupLabel } from "../../lib/activity-visuals.js";

function ActivityRollupBar({ rigId }: { rigId: string }) {
  const { data: nodes } = useNodeInventory(rigId);
  if (!nodes || nodes.length === 0) return null;
  const rollup = computeActivityRollup(
    nodes.map((n) => ({ activity: n.agentActivity, terminalActive: n.terminalActive })),
  );
  return (
    <div
      data-testid="activity-rollup-bar"
      className="px-6 py-2 font-mono text-[11px] text-on-surface-variant border-b border-outline-variant bg-surface-lowest/30"
    >
      {formatRollupLabel(rollup)}
    </div>
  );
}
// V1 polish slice Phase 5.2: HostScopePage graph view-mode replaces
// the prior placeholder with the multi-rig single-canvas component
// (rig-collapse affordance; default-all-collapsed; auto-expand on URL).
import { HostMultiRigGraph } from "./HostMultiRigGraph.js";
import { useRigStatusResolver } from "../../hooks/useRigStatusResolver.js";
// OPR.0.4.0.1: one global LiveTerminalProvider per scope page bounds the total
// live terminals across the page's graph + table + terminal tab-surfaces.
import { LiveTerminalProvider, useTerminalCap } from "../terminal/LiveTerminalProvider.js";

/** Set the AppShell's Explorer overlay mode based on the scope page's
 *  active view-mode. Graph view-mode → overlay (vellum-translucent
 *  Explorer over canvas); table/terminal → opaque. Resets to opaque
 *  when the component unmounts so non-topology destinations don't
 *  inherit overlay state. */
function useOverlayForActiveTab(active: string) {
  const { setMode } = useTopologyOverlay();
  useEffect(() => {
    setMode(active === "graph" ? "overlay" : "opaque");
    return () => {
      setMode("opaque");
    };
  }, [active, setMode]);
}

/** Anchored bar: sits at left = var(--explorer-anchor-left)
 *  (set on <main> in AppShell) so position is identical across graph /
 *  table / terminal switches. Transparent over the canvas — paper-grid
 *  shows through. z-30 keeps content above the Explorer overlay in graph
 *  mode (anchored past the Explorer's right edge so overlap shouldn't
 *  happen, but z-order is the safety net). C12 renders the PageHeader in
 *  one and the tab nav in another so they share the same left edge. */
function ScopeAnchoredBar({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="relative z-30 px-6 pt-4"
      style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {children}
    </div>
  );
}

function ScopeShell({
  header,
  tabsNav,
  children,
}: {
  /** Optional C12 PageHeader rendered above the tab nav at the same
   *  anchored left offset (graph-overlay alignment). */
  header?: React.ReactNode;
  /** Eyebrow + title are no longer rendered: tabs only, anchored to
   *  the right of Explorer. The scope
   *  identity reads from the URL + Explorer tree active state, so the
   *  big DISCOVERY.INTAKE-ROUTER style title in the canvas is redundant.
   *  Keeping the prop names for now in case Phase 5 wants to revive a
   *  smaller breadcrumb. */
  eyebrow?: string;
  title?: string;
  tabsNav: React.ReactNode;
  children: React.ReactNode;
}) {
  // Class B fixed-anchor: header and tabsNav each sit in a ScopeAnchoredBar
  // at left = var(--explorer-anchor-left) (set on <main> in AppShell) so
  // position is identical across graph / table / terminal switches.
  return (
    <div className="flex flex-col h-full">
      {header ? (
        <ScopeAnchoredBar testId="scope-page-header-anchor">
          {header}
        </ScopeAnchoredBar>
      ) : null}
      <ScopeAnchoredBar>
        {tabsNav}
      </ScopeAnchoredBar>
      {/* flex column so the active view-mode panel can fill remaining
          height. min-h-0 lets the flex child shrink correctly inside
          the AppShell main scroll container. */}
      <div className="flex-1 min-h-0 flex flex-col">
        {children}
      </div>
    </div>
  );
}

// V1 attempt-3 Phase 5 P5-7: TopologyTerminalView replaces the placeholder
// with a real safe-N=12 paginated pinned-card grid + pulsing-ring on active
// terminals (per topology-terminal-view.md L47/L60-65/L70-80).

export function HostScopePage() {
  const [active, setActive] = useState<TopologyHostScopeTab>("graph");
  const { data: rigs, error: rigsError, isFetching, isPlaceholderData, refetch } = useRigSummary();
  const { isWideLayout } = useShellViewport();
  useOverlayForActiveTab(active);

  // OPR.0.4.6.MH2 FR-3/FR-6 — the page title names the ACTUAL data source
  // (the hardcoded "localhost" is gone): local renders the MH-1 own-name,
  // a remote selection renders its host id. Remote read states are honest:
  // a failed read replaces the canvas with the host-named unreachable
  // panel (retry + back-to-local, per the locked fr6-unreachable twin);
  // an in-flight pull shows a truthful banner over the previous view
  // (keepPreviousData, per fr6-loading). Local never gains either.
  const { data: hostsData } = useHosts();
  const selectHost = useSelectHost();
  const selectedHost = hostsData?.selected ?? LOCAL_HOST_ID;
  const isRemote = selectedHost !== LOCAL_HOST_ID;
  const ownName = hostsData?.ownName && hostsData.ownName.trim() !== "" ? hostsData.ownName : "localhost";

  // P5-9 mobile graph degradation: at <lg viewport, treat graph view-mode
  // as table per universal-shell.md L143. The tab nav still shows graph
  // selected (operator may resize to wide and the graph reactivates).
  const effectiveActive = !isWideLayout && active === "graph" ? "table" : active;
  const liveCap = useTerminalCap();

  const remoteUnreachable = isRemote && !!rigsError;
  const remoteLoading = isRemote && !remoteUnreachable && (isPlaceholderData || (isFetching && rigs === undefined));

  return (
    <LiveTerminalProvider cap={liveCap}>
    <ScopeShell
      eyebrow="Topology · Host"
      title={isRemote ? selectedHost : ownName}
      header={
        <PageHeader
          title="Rigs"
          description="Every rig on this host. Open one to see its agents."
          actions={
            <Button asChild data-testid="new-rig-button">
              <Link to="/specs/rig">New rig</Link>
            </Button>
          }
        />
      }
      tabsNav={<TopologyViewModeTabs tabs={HOST_SCOPE_TABS} active={active} onSelect={setActive} testIdPrefix="topology-host" />}
    >
      {remoteUnreachable ? (
        <div
          className="px-6 py-6"
          style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
        >
          <div
            data-testid="topology-remote-unreachable"
            className="max-w-2xl border-l-2 border-error bg-surface-low px-4 py-4 font-mono text-xs"
          >
            <div className="mb-2 text-[11px] font-bold text-error">
              {selectedHost} is unreachable
            </div>
            <p className="mb-1 text-on-surface">
              The local daemon could not reach {selectedHost}&apos;s daemon. Its workspace can&apos;t be shown.
            </p>
            <p className="mb-3 text-[11px] text-on-surface-variant">
              Check the host is up and paired (rig host ls), then retry. Other hosts are unaffected.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="topology-remote-retry"
                onClick={() => void refetch()}
                className="border border-outline px-3 py-1 text-[11px] text-on-surface hover:bg-surface-low/60"
              >
                Retry
              </button>
              <button
                type="button"
                data-testid="topology-remote-back-local"
                onClick={() => selectHost.mutate({ hostId: LOCAL_HOST_ID })}
                className="border border-outline-variant px-3 py-1 text-[11px] text-on-surface-variant hover:text-on-surface"
              >
                Back to {ownName} (local)
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {remoteLoading ? (
        <div
          data-testid="topology-remote-loading"
          className="mr-6 mt-3 border border-outline-variant bg-surface-low px-3 py-2 font-mono text-[11px] text-on-surface-variant"
          style={{ marginLeft: "calc(var(--header-anchor-offset, 0px) + 1.5rem)" }}
        >
          Pulling {selectedHost}&apos;s workspace over the network… showing the previous view until it arrives.
        </div>
      ) : null}
      {!remoteUnreachable && effectiveActive === "graph" ? (
        <div className="flex-1 min-h-0 relative">
          <HostMultiRigGraph />
        </div>
      ) : null}
      {effectiveActive === "table" ? (
        <div className="px-6 pb-6">
          {!isWideLayout && active === "graph" ? (
            <p
              data-testid="topology-mobile-graph-degraded"
              className="font-mono text-[11px] text-on-surface-variant italic mb-2"
            >
              Graph view degrades to table on narrow viewports.
            </p>
          ) : null}
          {/* OPR.0.4.1.13: contain a table render-throw so it can't white-screen the page. */}
          <ErrorBoundary label="Table view">
            <TopologyTableView />
          </ErrorBoundary>
        </div>
      ) : null}
      {effectiveActive === "terminal" ? <TopologyTerminalView scope="host" /> : null}
    </ScopeShell>
    </LiveTerminalProvider>
  );
}

/**
 * C12 rig actions menu: Start (`useStartRig`, mutate() — bodyless
 * POST /api/rigs/:id/up), Launch (`useLaunchRig`, mutate() — POST with
 * `{}` body when no fresh seat list), Save snapshot (`useCreateSnapshot`,
 * mutate() — bodyless POST /api/rigs/:id/snapshots), separator, Stop rig
 * (`useTeardownRig`, mutate() — POST /api/down with
 * `{ rigId }` JSON body, `destructive`). Rendered only for a known-local
 * host selection (OPR.0.4.6.MH2 B1: remote gets no local mutation affordance).
 * "Stop rig" opens a confirm Dialog; dialog "Stop rig" calls teardown.mutate().
 */
export function RigActionsMenu({ rigId, rigName }: { rigId: string; rigName: string }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const startMut = useStartRig(rigId);
  const launchMut = useLaunchRig(rigId);
  const snapshotMut = useCreateSnapshot(rigId);
  const teardownMut = useTeardownRig(rigId);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button data-testid="rig-actions" variant="outline">
            Actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => startMut.mutate(undefined)}>Start</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => launchMut.mutate(undefined)}>Launch</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => snapshotMut.mutate(undefined)}>Save snapshot</DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Defer the dialog open one task: mounting a Radix Dialog
              synchronously inside the menu's select dispatch fights the
              menu-close focus handoff (infinite focus loop in jsdom; flaky
              focus steal in real browsers). The menu finishes closing, then
              the confirm dialog opens. */}
          <DropdownMenuItem destructive onSelect={() => window.setTimeout(() => setConfirmOpen(true), 0)}>
            Stop rig
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent data-testid="rig-stop-confirm">
          <DialogHeader>
            <DialogTitle>Stop {rigName}?</DialogTitle>
            <DialogDescription>
              All agents in this rig will be stopped. You can start it again later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="rig-stop-confirm-button"
              onClick={() => {
                teardownMut.mutate();
                setConfirmOpen(false);
              }}
            >
              Stop rig
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RigScopePage() {
  // OPR.0.4.6.MH2 guard delta-confirm blocker: lifecycle/action surfaces are
  // TRI-STATE — unknown selection mounts NO local controls and fires NO bare
  // status read (useSelectedHostId defaults local pre-cache, which fails
  // OPEN for a surface whose mount fires a read). ACTIVE observer: the page
  // learns the selection itself.
  const { known: hostSelectionKnown, isLocal: hostSelectionLocal } = useHostSelection();
  const rigScopeIsRemote = hostSelectionKnown && !hostSelectionLocal;
  const rigScopeActionsAllowed = hostSelectionKnown && hostSelectionLocal;
  const { rigId } = useParams({ from: "/topology/rig/$rigId" });
  const { data: rigs } = useRigSummary();
  const rigStatus = useRigStatusResolver();
  const rig = rigs?.find((r) => r.id === rigId);
  const [active, setActive] = useState<TopologyRigPodScopeTab>("graph");
  const { isWideLayout } = useShellViewport();
  useOverlayForActiveTab(active);

  const effectiveActive = !isWideLayout && active === "graph" ? "table" : active;
  const liveCap = useTerminalCap();

  return (
    <LiveTerminalProvider cap={liveCap}>
    <ScopeShell
      eyebrow="Topology · Rig"
      title={rig?.name ?? rigId}
      header={
        <PageHeader
          title={rig?.name ?? rigId}
          meta={
            <>
              <StatusBadge status={rigStatus(rigId, rig?.lifecycleState)} testId="rig-lifecycle-badge" />
              <span className="font-mono text-xs text-on-surface-variant" data-testid="rig-id-mono">
                {rigId}
              </span>
            </>
          }
          actions={rigScopeActionsAllowed ? <RigActionsMenu rigId={rigId} rigName={rig?.name ?? rigId} /> : null}
        />
      }
      tabsNav={
        <TopologyViewModeTabs
          tabs={RIG_POD_SCOPE_TABS}
          active={active}
          onSelect={setActive}
          testIdPrefix="topology-rig"
          // OPR.0.4.6.MH2 rev1-r2 B1 — Launch-in-CMUX is a LOCAL action
          // (bare local open-cmux POST); no cross-host mutation affordance
          // on remote views (FR-7).
          trailing={rigScopeActionsAllowed ? <TerminalLauncher rigId={rigId} rigName={rig?.name ?? null} /> : null}
        />
      }
    >
      {/* OPR.0.4.3.22 — rig-status + launch/recovery control near the rig title.
          Terminal-surface actions (Launch in CMUX) render SEPARATELY in the tab
          bar (trailing, above) and never restore or fresh-prime.
          OPR.0.4.6.MH2 rev1-r2 re-verdict B1: the whole control is a LOCAL
          restore/launch surface (bare /api/rigs/:id/status read + launch-plan
          + /up POSTs) — under a remote selection it never mounts; an honest
          read-only marker stands in (FR-7). */}
      {!hostSelectionKnown ? (
        <div
          className="px-6 pt-4 max-w-md"
          style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
        >
          <div
            data-testid="rig-status-selection-pending"
            className="text-[11px] text-on-surface-variant italic"
          >
            Resolving selected host…
          </div>
        </div>
      ) : rigScopeIsRemote ? (
        <div
          className="px-6 pt-4 max-w-md"
          // the same anchoring discipline as the FR-6 surfaces: legible past
          // the explorer overlay in graph-overlay mode; 0px fallback keeps
          // non-overlay modes unchanged.
          style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
        >
          <div
            data-testid="rig-status-remote-readonly"
            data-remote-readonly="true"
            className="text-[11px] text-on-surface-variant"
          >
            read-only — remote host (launch/recovery is a local action)
          </div>
        </div>
      ) : (
        // OPR.0.4.7.1 — compact control, RIGHT-aligned: the explorer overlay
        // anchors left, so right alignment keeps the launch control fully
        // visible in graph-overlay mode (the reproduced obscured-card bug).
        <div className="px-6 pt-4 flex justify-end">
          <ErrorBoundary label="Rig status">
            <RigStatusControl rigId={rigId} rigName={rig?.name ?? rigId} />
          </ErrorBoundary>
        </div>
      )}
      <ActivityRollupBar rigId={rigId} />
      {effectiveActive === "graph" ? (
        <div className="flex-1 min-h-0 relative">
          <RigGraph rigId={rigId} rigName={rig?.name ?? null} showDiscovered={false} />
        </div>
      ) : null}
      {effectiveActive === "table" ? (
        <div className="px-6 pb-6">
          {!isWideLayout && active === "graph" ? (
            <p
              data-testid="topology-mobile-graph-degraded"
              className="font-mono text-[11px] text-on-surface-variant italic mb-2"
            >
              Graph view degrades to table on narrow viewports.
            </p>
          ) : null}
          {/* OPR.0.4.1.13: contain a table render-throw so it can't white-screen the page. */}
          <ErrorBoundary label="Table view">
            <TopologyTableView rigIdScope={rigId} />
          </ErrorBoundary>
        </div>
      ) : null}
      {effectiveActive === "terminal" ? <TopologyTerminalView scope="rig" rigId={rigId} /> : null}
      {active === "overview" ? <RigOverviewTab rigId={rigId} rigName={rig?.name ?? null} /> : null}
    </ScopeShell>
    </LiveTerminalProvider>
  );
}

/** The running-rig view reads the selected instance, not a reusable library template. */
export function RigOverviewTab({ rigId }: { rigId: string; rigName: string | null }) {
  const exported = useRigSpecExport(rigId);
  const preview = useRigSpecReview(exported.hostSelection === "local" ? exported.data ?? null : null);

  if (exported.hostSelection === "loading" || (exported.hostSelection === "local" && exported.isLoading)) {
    return <div className="p-6 font-mono text-[11px] text-on-surface-variant">Loading current rig spec…</div>;
  }
  if (exported.hostSelection !== "local" || exported.isError || exported.data === undefined) {
    return (
      <div className="p-6">
        <EmptyState
          label="CURRENT RIG SPEC UNAVAILABLE"
          description={exported.hostSelection === "remote"
            ? "The current spec is not available on a selected remote host. No local configuration or library template was substituted."
            : exported.hostSelection === "unavailable"
              ? "The selected host could not be determined. No local configuration or library template was substituted."
              : `The selected rig's configuration could not be read${exported.error ? ` (${exported.error.message})` : ""}. No library template was substituted.`}
          variant="card"
          testId="topology-rig-overview-unavailable"
        />
      </div>
    );
  }
  return (
    <div className="px-6 pb-6" data-testid="topology-rig-overview">
      <p className="mb-3 font-mono text-[11px] text-on-surface-variant">
        Current rig configuration — exported from this instance, not the Specs library template.
      </p>
      {preview.data ? (
        <RigSpecDisplay review={preview.data} yaml={exported.data} testIdPrefix="topology-rig-overview-" />
      ) : (
        <>
          <p className="mb-3 font-mono text-[11px] text-on-surface-variant">
            {preview.isError ? "Topology preview unavailable. The current export is shown below." : "Preparing topology preview…"}
          </p>
          <WorkflowCodePreview title="Current configuration" testId="topology-rig-overview-yaml">
            {exported.data}
          </WorkflowCodePreview>
        </>
      )}
    </div>
  );
}

export function PodScopePage() {
  // V1 polish slice Phase 5.1 P5.1-5: pod-scope graph wires through
  // RigGraph's new podScope prop (filters nodes + edges + pod groups
  // to the matching pod only). Default tab moved to "graph" so the
  // graph view-mode is the landing surface (matches host/rig scope
  // pattern; pod scope should honor the same graph/table/terminal
  // grammar as other scopes.
  const { rigId, podName } = useParams({ from: "/topology/pod/$rigId/$podName" });
  const [active, setActive] = useState<TopologyRigPodScopeTab>("graph");
  const { isWideLayout } = useShellViewport();
  useOverlayForActiveTab(active);
  const effectiveActive = !isWideLayout && active === "graph" ? "table" : active;

  return (
    <ScopeShell
      eyebrow="Topology · Pod"
      title={`${rigId} / ${podName}`}
      tabsNav={<TopologyViewModeTabs tabs={RIG_POD_SCOPE_TABS} active={active} onSelect={setActive} testIdPrefix="topology-pod" />}
    >
      {effectiveActive === "graph" ? (
        <div className="flex-1 min-h-0 relative">
          <RigGraph rigId={rigId} rigName={null} showDiscovered={false} podScope={podName} />
        </div>
      ) : null}
      {effectiveActive === "table" ? (
        <div className="px-6 pb-6">
          {!isWideLayout && active === "graph" ? (
            <p
              data-testid="topology-mobile-graph-degraded"
              className="font-mono text-[11px] text-on-surface-variant italic mb-2"
            >
              Graph view degrades to table on narrow viewports.
            </p>
          ) : null}
          {/* OPR.0.4.1.13: contain a table render-throw so it can't white-screen the page. */}
          <ErrorBoundary label="Table view">
            <TopologyTableView rigIdScope={rigId} podNameScope={podName} />
          </ErrorBoundary>
        </div>
      ) : null}
      {effectiveActive === "terminal" ? (
        <TopologyTerminalView scope="pod" rigId={rigId} podName={podName} />
      ) : null}
      {active === "overview" ? (
        <div className="p-6">
          <EmptyState label="POD OVERVIEW" description="Pod detail (Phase 5)." variant="card" />
        </div>
      ) : null}
    </ScopeShell>
  );
}

export function SeatScopePage() {
  // V1 polish slice Phase 5.1 P5.1-1 + DRIFT P5.1-D1: outer scope tabs
  // (detail / transcript / terminal) RETIRED at V1 polish.
  // LiveNodeDetails owns the canonical 5-tab body row inline
  // (Identity / Agent Spec / Startup / Transcript / Terminal). The
  // ScopeShell wrapper is dropped too — LiveNodeDetails is the page.
  const { rigId, logicalId } = useParams({ from: "/topology/seat/$rigId/$logicalId" });
  const decodedLogicalId = decodeURIComponent(logicalId);
  return (
    <div data-testid="seat-scope-page" className="flex flex-col h-full">
      <LiveNodeDetails rigId={rigId} logicalId={decodedLogicalId} />
    </div>
  );
}
