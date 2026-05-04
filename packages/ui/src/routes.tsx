import { useEffect } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query-client.js";
import { AppShell } from "./components/AppShell.js";
import { RigGraph } from "./components/RigGraph.js";
import { WorkspaceHome } from "./components/WorkspaceHome.js";
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
import { MissionControlSurface } from "./components/mission-control/MissionControlSurface.js";
import { SliceStoryView } from "./components/slices/SliceStoryView.js";
import { ProgressWorkspace } from "./components/progress/ProgressWorkspace.js";
import { FilesWorkspace } from "./components/files/FilesWorkspace.js";
import { SteeringWorkspace } from "./components/steering/SteeringWorkspace.js";
import { ContextWorkspace } from "./components/context/ContextWorkspace.js";
import { useRigSummary } from "./hooks/useRigSummary.js";
import { useDrawerSelection } from "./components/AppShell.js";

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

// Index route — Dashboard
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkspaceHome,
});

// Rig detail route — Graph + SnapshotPanel
function RigDetail() {
  const { rigId } = rigDetailRoute.useParams();
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

// Import route
const importRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/import",
  component: ImportFlow,
});

// Packages route
const packagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages",
  component: PackageList,
});

// Package install route
const packageInstallRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages/install",
  component: PackageInstallFlow,
});

// Bootstrap route
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

function DiscoveryRouteBridge() {
  const { setSelection } = useDrawerSelection();

  useEffect(() => {
    setSelection({ type: "discovery" });
  }, [setSelection]);

  return <WorkspaceHome />;
}

function SpecsRouteBridge() {
  const { setSelection } = useDrawerSelection();

  useEffect(() => {
    setSelection({ type: "specs" });
  }, [setSelection]);

  return <WorkspaceHome />;
}

function RigSpecReviewRoute() {
  const { setSelection } = useDrawerSelection();

  useEffect(() => {
    setSelection({ type: "specs" });
  }, [setSelection]);

  return <RigSpecReview />;
}

function AgentSpecReviewRoute() {
  const { setSelection } = useDrawerSelection();

  useEffect(() => {
    setSelection({ type: "specs" });
  }, [setSelection]);

  return <AgentSpecReview />;
}

// Discovery route
const discoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/discovery",
  component: DiscoveryRouteBridge,
});

const specsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs",
  component: SpecsRouteBridge,
});

const rigSpecReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/rig",
  component: RigSpecReviewRoute,
});

const agentSpecReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/agent",
  component: AgentSpecReviewRoute,
});

function LibraryReviewRoute() {
  const { entryId } = libraryReviewRoute.useParams();
  const { setSelection } = useDrawerSelection();

  useEffect(() => {
    setSelection({ type: "specs" });
  }, [setSelection]);

  return <LibraryReview entryId={entryId} />;
}

const libraryReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/library/$entryId",
  component: LibraryReviewRoute,
});

const discoveryInventoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/discovery/inventory",
  component: DiscoveryOverlay,
});

// Bundle routes
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

// Package detail route
const packageDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages/$packageId",
  component: PackageDetail,
});

// Route tree
// Live node full details route
const liveNodeDetailsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rigs/$rigId/nodes/$logicalId",
  component: () => {
    const { rigId, logicalId } = liveNodeDetailsRoute.useParams();
    return <LiveNodeDetails rigId={rigId} logicalId={decodeURIComponent(logicalId)} />;
  },
});

// PL-005 Phase A: Mission Control / Queue Observability surface.
const missionControlRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mission-control",
  component: MissionControlSurface,
});

// Slice Story View v0: top-level /slices route + /slices/:name detail.
// The component reads :name via useParams when present and renders
// the two-pane layout (filter+list on the left, six tabs on the right).
const slicesIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/slices",
  component: SliceStoryView,
});
const sliceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/slices/$name",
  component: SliceStoryView,
});

// UI Enhancement Pack v0: top-level Progress (item 1B) + Files
// (item 3 + item 4) workspaces. Both are read-only pages with their
// own internal layout — no left-sidebar nav coupling.
const progressRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/progress",
  component: ProgressWorkspace,
});
const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files",
  component: FilesWorkspace,
});
// Operator Surface Reconciliation v0 — top-level Steering route (item 1).
const steeringRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/steering",
  component: SteeringWorkspace,
});

// Token / Context Usage Surface v0 (PL-012) — /context portfolio dashboard.
interface ContextSearch {
  tier?: "critical" | "warning" | "low" | "unknown";
  runtime?: string;
  rigId?: string;
}
const contextRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/context",
  component: ContextWorkspace,
  validateSearch: (search: Record<string, unknown>): ContextSearch => {
    const out: ContextSearch = {};
    if (search["tier"] === "critical" || search["tier"] === "warning"
        || search["tier"] === "low" || search["tier"] === "unknown") out.tier = search["tier"];
    if (typeof search["runtime"] === "string") out.runtime = search["runtime"];
    if (typeof search["rigId"] === "string") out.rigId = search["rigId"];
    return out;
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  rigDetailRoute,
  importRoute,
  packagesRoute,
  packageInstallRoute,
  packageDetailRoute,
  bootstrapRoute,
  agentValidateRoute,
  specsRoute,
  rigSpecReviewRoute,
  agentSpecReviewRoute,
  libraryReviewRoute,
  discoveryRoute,
  discoveryInventoryRoute,
  bundleInspectRoute,
  bundleInstallRoute,
  liveNodeDetailsRoute,
  missionControlRoute,
  slicesIndexRoute,
  sliceDetailRoute,
  progressRoute,
  filesRoute,
  steeringRoute,
  contextRoute,
]);

// Router
export const router = createRouter({ routeTree });

// Type registration for type-safe navigation
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
