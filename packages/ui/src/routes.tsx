// V1 Shell Redesign Phase 2 — canonical routes per shell-redesign-v1
// canon docs (universal-shell.md / dashboard.md / topology-tree.md /
// project-tree.md / specs-tree.md / for-you-feed.md / agent-chat-surface.md).
//
// Phase 2 lays the route shells. Phase 3 fills tree contents +
// destination cards + view-mode tab CONTENTS. View-mode tabs are
// IN-PLACE within a single URL per SC-5 / SC-10 (NOT separate URLs).
//
// Daemon /api/* UNTOUCHED (SC-29).

import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query-client.js";
import { AppShell } from "./components/AppShell.js";
import { RigGraph } from "./components/RigGraph.js";
import { ImportFlow } from "./components/ImportFlow.js";
import { PackageList } from "./components/PackageList.js";
import { PackageInstallFlow } from "./components/PackageInstallFlow.js";
import { PackageDetail } from "./components/PackageDetail.js";
import { BootstrapWizard } from "./components/BootstrapWizard.js";
import { AgentSpecValidateFlow } from "./components/AgentSpecValidateFlow.js";
import { RigSpecReview } from "./components/RigSpecReview.js";
import { AgentSpecReview } from "./components/AgentSpecReview.js";
import { BundleInspector } from "./components/BundleInspector.js";
import { BundleInstallFlow } from "./components/BundleInstallFlow.js";
import { LibraryReview } from "./components/LibraryReview.js";
import { LiveNodeDetails } from "./components/LiveNodeDetails.js";
import { DiscoveryOverlay } from "./components/DiscoveryOverlay.js";
import { AuditHistoryView } from "./components/mission-control/views/AuditHistoryView.js";
import { useRigSummary } from "./hooks/useRigSummary.js";
import { EmptyState } from "./components/ui/empty-state.js";

// Phase 2 placeholder for canon destinations Phase 3 will fill.
function DestinationPlaceholder({ label, description }: { label: string; description?: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <EmptyState
        label={label}
        description={description ?? "Phase 3 will fill this destination."}
        variant="card"
        testId={`placeholder-${label.toLowerCase().replace(/\s+/g, "-")}`}
      />
    </div>
  );
}

// Root route — wraps everything in AppShell
const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <AppShell>
        <Outlet />
      </AppShell>
    </QueryClientProvider>
  ),
});

// =====================================================================
// Canon destinations (Phase 2 lays shells; Phase 3 fills)
// =====================================================================

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <DestinationPlaceholder
      label="DASHBOARD"
      description="6-card launcher (Topology / Project / For You / Specs / Search / Settings) — Phase 3 fills."
    />
  ),
});

// Topology destination: SC-5 / SC-10 — single URL with view-mode tabs IN-PLACE
// (graph / table / terminal). Phase 2 lays the four scope routes; Phase 3
// renders the tabs and fills view-mode content.

const topologyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology",
  component: () => (
    <DestinationPlaceholder
      label="TOPOLOGY"
      description="Host scope (graph / table / terminal view-mode tabs IN-PLACE per SC-10) — Phase 3 fills."
    />
  ),
});

const topologyRigRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology/rig/$rigId",
  component: () => (
    <DestinationPlaceholder
      label="TOPOLOGY — RIG SCOPE"
      description="Rig-scoped graph / table / terminal / overview tabs — Phase 3 fills."
    />
  ),
});

const topologyPodRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology/pod/$rigId/$podName",
  component: () => (
    <DestinationPlaceholder
      label="TOPOLOGY — POD SCOPE"
      description="Pod-scoped graph / table / terminal / overview tabs — Phase 3 fills."
    />
  ),
});

const topologySeatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology/seat/$rigId/$logicalId",
  component: () => (
    <DestinationPlaceholder
      label="TOPOLOGY — SEAT SCOPE"
      description="Seat-scoped detail / transcript / terminal tabs — Phase 3 fills."
    />
  ),
});

const forYouRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/for-you",
  component: () => (
    <DestinationPlaceholder
      label="FOR YOU"
      description="Cross-cutting attention feed (5 card types: ACTION / APPROVAL / SHIPPED / PROGRESS / OBSERVATION) — Phase 3 fills."
    />
  ),
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project",
  component: () => (
    <DestinationPlaceholder
      label="PROJECT"
      description="Workspace > mission > slice tree — Phase 3 fills."
    />
  ),
});

const projectMissionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project/mission/$missionId",
  component: () => (
    <DestinationPlaceholder
      label="PROJECT — MISSION"
      description="Mission scope — Phase 3 fills."
    />
  ),
});

const projectSliceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project/slice/$sliceId",
  component: () => (
    <DestinationPlaceholder
      label="PROJECT — SLICE"
      description="Slice scope (story / overview / progress / artifacts / tests / queue / topology tabs) — Phase 3 fills."
    />
  ),
});

const specsLibraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs",
  component: () => (
    <DestinationPlaceholder
      label="SPECS LIBRARY"
      description="Top-level: toolbar + tanstack-table + search + filter chips — Phase 3 fills."
    />
  ),
});

const specsApplicationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/applications",
  component: () => (
    <DestinationPlaceholder
      label="SPECS — APPLICATIONS"
      description="Phase 3 fills."
    />
  ),
});

// Generic spec detail by kind/name — Phase 3 fills with kind-aware routing
// (rigs / workspaces / workflows / context-packs / agent-images / applications).
const specsKindRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/$specKind/$specName",
  component: () => {
    const { specKind, specName } = useParams({ from: "/specs/$specKind/$specName" });
    return (
      <DestinationPlaceholder
        label={`SPEC: ${specKind.toUpperCase()} / ${specName}`}
        description="Existing spec detail page mounted here — Phase 3 wires."
      />
    );
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => (
    <DestinationPlaceholder
      label="SETTINGS"
      description="3-tab Settings / Log / Status — Phase 3 fills. Mounts in CENTER workspace per SC-7 (NOT right sidebar)."
    />
  ),
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  component: AuditHistoryView,
});

// =====================================================================
// Existing routes preserved per code-map AFTER tree (not in delete list)
// =====================================================================

// Rig graph (legacy detail; topology destination supersedes — keep until
// Phase 3 wires /topology/rig/$rigId).
function RigDetail() {
  const { rigId } = useParams({ from: "/rigs/$rigId" });
  const { data: rigs } = useRigSummary();
  const rigName = rigs?.find((r: { id: string; name: string }) => r.id === rigId)?.name;
  return (
    <div className="flex flex-col flex-1 h-full">
      <div className="flex-1 min-h-[400px] relative">
        <RigGraph rigId={rigId} rigName={rigName ?? null} showDiscovered={false} />
      </div>
    </div>
  );
}

const rigDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rigs/$rigId",
  component: RigDetail,
});

const liveNodeDetailsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rigs/$rigId/nodes/$logicalId",
  component: () => {
    const { rigId, logicalId } = useParams({ from: "/rigs/$rigId/nodes/$logicalId" });
    return <LiveNodeDetails rigId={rigId} logicalId={decodeURIComponent(logicalId)} />;
  },
});

const importRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/import",
  component: ImportFlow,
});

const packagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages",
  component: PackageList,
});

const packageInstallRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages/install",
  component: PackageInstallFlow,
});

const packageDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages/$packageId",
  component: PackageDetail,
});

const bootstrapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bootstrap",
  component: BootstrapWizard,
});

const agentValidateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/validate",
  component: AgentSpecValidateFlow,
});

// /specs/rig + /specs/agent + /specs/library/$entryId — existing review
// surfaces preserved per code-map AFTER tree. No drawer auto-open
// (SC-6: drawer default-closed; opens only on named triggers).
const rigSpecReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/rig",
  component: RigSpecReview,
});

const agentSpecReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/agent",
  component: AgentSpecReview,
});

const libraryReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/library/$entryId",
  component: () => {
    const { entryId } = useParams({ from: "/specs/library/$entryId" });
    return <LibraryReview entryId={entryId} />;
  },
});

// Discovery — preserved per code-map ("discovery surface — keep but evaluate route").
// No drawer auto-open (SC-6).
const discoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/discovery",
  component: () => (
    <DestinationPlaceholder
      label="DISCOVERY"
      description="Discovery surface preserved; redesign deferred per code-map."
    />
  ),
});

const discoveryInventoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/discovery/inventory",
  component: DiscoveryOverlay,
});

const bundleInspectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bundles/inspect",
  component: BundleInspector,
});

const bundleInstallRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bundles/install",
  component: BundleInstallFlow,
});

// =====================================================================
// Redirects from deleted routes
// =====================================================================

// /context redirects to /topology (SC-25 — relocates to topology table view; Phase 3 wires the actual view).
const contextRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/context",
  component: () => <Navigate to="/topology" />,
});

// /mission-control DELETED per SC-18 — redirect to /for-you (which replaces it).
const missionControlRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mission-control",
  component: () => <Navigate to="/for-you" />,
});

// /slices DELETED per project-tree.md — redirect to /project.
const slicesRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/slices",
  component: () => <Navigate to="/project" />,
});

const sliceDetailRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/slices/$name",
  component: () => {
    const { name } = useParams({ from: "/slices/$name" });
    return <Navigate to="/project/slice/$sliceId" params={{ sliceId: name }} />;
  },
});

// /progress folds into Project tabs (Phase 3) — redirect to /project.
const progressRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/progress",
  component: () => <Navigate to="/project" />,
});

// /steering folds into Project workspace overview tab (Phase 3) — redirect to /project.
const steeringRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/steering",
  component: () => <Navigate to="/project" />,
});

// =====================================================================
// Route tree
// =====================================================================

const routeTree = rootRoute.addChildren([
  // Canon destinations
  indexRoute,
  topologyRoute,
  topologyRigRoute,
  topologyPodRoute,
  topologySeatRoute,
  forYouRoute,
  projectRoute,
  projectMissionRoute,
  projectSliceRoute,
  specsLibraryRoute,
  specsApplicationsRoute,
  specsKindRoute,
  settingsRoute,
  searchRoute,
  // Preserved existing routes
  rigDetailRoute,
  liveNodeDetailsRoute,
  importRoute,
  packagesRoute,
  packageInstallRoute,
  packageDetailRoute,
  bootstrapRoute,
  agentValidateRoute,
  rigSpecReviewRoute,
  agentSpecReviewRoute,
  libraryReviewRoute,
  discoveryRoute,
  discoveryInventoryRoute,
  bundleInspectRoute,
  bundleInstallRoute,
  // Redirects from deleted routes
  contextRedirectRoute,
  missionControlRedirectRoute,
  slicesRedirectRoute,
  sliceDetailRedirectRoute,
  progressRedirectRoute,
  steeringRedirectRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
