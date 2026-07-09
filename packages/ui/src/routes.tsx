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
  useSearch,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DaemonHealthProvider } from "./components/DaemonHealthProvider.js";
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
// Phase 3 destination components.
import { Dashboard } from "./components/dashboard/Dashboard.js";
import { Feed } from "./components/for-you/Feed.js";
import { SpecsLibraryPage } from "./components/specs/SpecsLibraryPage.js";
import { SkillDetailPage } from "./components/specs/SkillDetailPage.js";
import { SkillsIndexPage } from "./components/specs/SkillsIndexPage.js";
import { PluginsIndexPage } from "./components/specs/PluginsIndexPage.js";
// Phase 3a slice 3.3 — plugin detail page route.
import { PluginDetailPage } from "./components/specs/PluginDetailPage.js";
import { FilesWorkspace } from "./components/files/FilesWorkspace.js";
import { SettingsCenter } from "./components/system/SettingsCenter.js";
import { PoliciesPage } from "./components/system/PoliciesPage.js";
import { LogPage } from "./components/system/LogPage.js";
import { StatusPage } from "./components/system/StatusPage.js";
import {
  HostScopePage,
  RigScopePage,
  PodScopePage,
  SeatScopePage,
} from "./components/topology/ScopePages.js";
import {
  WorkspaceScopePage,
  MissionScopePage,
  SliceScopePage,
} from "./components/project/ScopePages.js";
import { RigAgentsPage } from "./components/review/RigAgentsPage.js";
import { FleetPage } from "./components/review/FleetPage.js";
import { WorkflowsPage } from "./components/workflow/WorkflowsPage.js";
import { WorkflowInstancePage } from "./components/workflow/WorkflowInstancePage.js";
import { ProjectGraphicsPreview } from "./components/lab/ProjectGraphicsPreview.js";
import { CardPreviewsLab } from "./components/lab/CardPreviewsLab.js";
import { VellumLab } from "./components/lab/VellumLab.js";
import {
  VellumBgLarge,
  VellumBgSmall,
  VellumBgAllover,
} from "./components/lab/VellumBackgroundLab.js";

// Root route — wraps everything in AppShell
const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <DaemonHealthProvider>
        <AppShell>
          <Outlet />
        </AppShell>
      </DaemonHealthProvider>
    </QueryClientProvider>
  ),
});

// =====================================================================
// Canon destinations (Phase 2 lays shells; Phase 3 fills)
// =====================================================================

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});

// Topology destination: SC-5 / SC-10 — single URL with view-mode tabs IN-PLACE
// (graph / table / terminal). Tab state is React useState INSIDE each scope
// page; URL stays at the scope path across tab switches.

const topologyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology",
  component: HostScopePage,
});

const topologyRigRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology/rig/$rigId",
  component: RigScopePage,
});

const topologyPodRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology/pod/$rigId/$podName",
  component: PodScopePage,
});

const topologySeatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology/seat/$rigId/$logicalId",
  component: SeatScopePage,
});

const forYouRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/for-you",
  component: Feed,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project",
  component: WorkspaceScopePage,
});

const projectMissionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project/mission/$missionId",
  component: MissionScopePage,
});

const projectSliceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project/slice/$sliceId",
  component: SliceScopePage,
});

// OPR.0.4.4.22 — the AGENTS altitude (rig-scope standalone panel). The
// route exists for ADDRESSING, not nav chrome: reached by ZOOM only
// (board/host agent-count chips, slice-region anchored zoom, breadcrumb
// up) — deliberately NOT added to any nav rail (arch ruling, drift-killer
// 4). Anchored/filter state rides query params (?slice=, ?group=).
const rigAgentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: RigAgentsPage,
});

// OPR.0.4.6.MH5 (C3) — the FLEET attention altitude ABOVE host (placement
// option A of the founder LOCK = BOTH; the band is option B on the per-host
// surfaces). Zoom-addressed like /agents (ADDRESSING, not nav chrome);
// reached from the FLEET band's OPEN FLEET →. Expanded-exception state
// rides ?open=<fleetKey> (read window-side per this family's idiom) so
// every state is deep-link addressable.
const fleetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/fleet",
  component: FleetPage,
});

// OPR.0.4.6.WF4 (C4) — the workflow surfaces. BOTH are zoom-addressed like
// /agents above (routes exist for ADDRESSING, not nav chrome): reached from
// NEEDS-YOU workflow rows, Library instance bands, and instance deep-links;
// deliberately NOT added to any nav rail (pm/founder confirmed v1).
const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  component: WorkflowsPage,
});

const workflowInstanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflow/instance/$instanceId",
  // FR-3 `?step=<id>` deep-link anchor (the gated/failed step the attention row
  // points at). Optional; validated to a string so the typed Link is honest.
  validateSearch: (search: Record<string, unknown>): { step?: string } => ({
    step: typeof search.step === "string" ? search.step : undefined,
  }),
  component: () => {
    const { instanceId } = useParams({ from: "/workflow/instance/$instanceId" });
    const { step } = useSearch({ from: "/workflow/instance/$instanceId" });
    return <WorkflowInstancePage instanceId={instanceId} anchorStepId={step ?? null} />;
  },
});

const specsLibraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs",
  component: SpecsLibraryPage,
});

const specsApplicationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/applications",
  component: SpecsLibraryPage,
});

// Slice 18 — Skills top-level Library index page mounted at /specs/skills.
// The detail route /specs/skills/$skillToken remains unchanged below.
const specsSkillsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/skills",
  component: SkillsIndexPage,
});

const specsSkillRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/skills/$skillToken",
  component: () => {
    const { skillToken } = useParams({ from: "/specs/skills/$skillToken" });
    return <SkillDetailPage skillToken={skillToken} />;
  },
});

const specsSkillFileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/skills/$skillToken/file/$fileToken",
  component: () => {
    const { skillToken, fileToken } = useParams({ from: "/specs/skills/$skillToken/file/$fileToken" });
    return <SkillDetailPage skillToken={skillToken} fileToken={fileToken} />;
  },
});

// Slice 18 — Plugins top-level Library index page mounted at /specs/plugins.
// The detail route /plugins/$pluginId below remains unchanged.
const specsPluginsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/plugins",
  component: PluginsIndexPage,
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files",
  component: FilesWorkspace,
});

// Phase 3a slice 3.3 — Plugin detail page mounted at /plugins/:pluginId.
// Library Explorer's Plugins section links here; AgentSpec Plugins block
// (Batch 1) navigates here too via the "view in library" affordance.
const pluginDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plugins/$pluginId",
  component: () => {
    const { pluginId } = useParams({ from: "/plugins/$pluginId" });
    return <PluginDetailPage pluginId={pluginId} />;
  },
});

// Generic spec detail by kind/name — Phase 4+ wires direct mounts of
// existing detail pages (RigSpecReview / AgentSpecReview etc) by kind.
// V1 placeholder: redirect to /specs/library/$specName when kind matches.
const specsKindRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/$specKind/$specName",
  component: () => {
    const { specName } = useParams({ from: "/specs/$specKind/$specName" });
    return <Navigate to="/specs/library/$entryId" params={{ entryId: specName }} />;
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsCenter,
});

// Slice 26 — Settings destination becomes a 4-item Explorer (Settings /
// Policies / Log / Status). Each item is its own route under the
// settings prefix; the Explorer sidebar handles navigation. Slice 27
// fills the Policies page with the Claude auto-compaction policy form.
const settingsPoliciesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/policies",
  component: PoliciesPage,
});
const settingsLogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/log",
  component: LogPage,
});
const settingsStatusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/status",
  component: StatusPage,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  component: AuditHistoryView,
});

const projectGraphicsPreviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/project-graphics-preview",
  component: ProjectGraphicsPreview,
});

// V0.3.1 slice 21 onboarding-conveyor — for-you card kind variant
// gallery. Matches the `/lab/project-graphics-preview` pattern.
const cardPreviewsLabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/card-previews",
  component: CardPreviewsLab,
});

// 2026-05-13 — vellum showcase design experiment. Static dashboard-shape
// for iterating the layered-vellum technique without touching the
// production dashboard. Once dialed in, port the recipe back to
// packages/ui/src/components/dashboard/.
const vellumLabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/vellum-lab",
  component: VellumLab,
});

// 2026-05-14 iter 2 — back-layer "all-over-print" spike per founder
// dispatch with reference photos. Iter 1 (tactical marks) was wrong
// direction; this iter uses large faded abstract graphic SHAPES
// (corporate-emblem / radiation-symbol / serif typography) at three
// size/density treatments.
const vellumBgLargeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/vellum-bg/a-large",
  component: VellumBgLarge,
});
const vellumBgSmallRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/vellum-bg/b-small",
  component: VellumBgSmall,
});
const vellumBgAlloverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/vellum-bg/c-allover",
  component: VellumBgAllover,
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
    <div className="flex h-full w-full items-center justify-center p-8">
      <EmptyState
        label="DISCOVERY"
        description="Discovery surface preserved; redesign deferred per code-map."
        variant="card"
        testId="discovery-placeholder"
      />
    </div>
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

// Exported so the OPR.0.4.1.11.1 digital-twin harness can build its own router with a
// MEMORY history (a static double-clickable intent.html has no server path to match) over
// the SAME real route tree — no forked components.
export const routeTree = rootRoute.addChildren([
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
  rigAgentsRoute,
  fleetRoute,
  workflowsRoute,
  workflowInstanceRoute,
  specsLibraryRoute,
  specsApplicationsRoute,
  specsSkillsIndexRoute,
  specsPluginsIndexRoute,
  specsSkillRoute,
  specsSkillFileRoute,
  pluginDetailRoute,
  filesRoute,
  specsKindRoute,
  settingsRoute,
  settingsPoliciesRoute,
  settingsLogRoute,
  settingsStatusRoute,
  searchRoute,
  projectGraphicsPreviewRoute,
  cardPreviewsLabRoute,
  vellumLabRoute,
  vellumBgLargeRoute,
  vellumBgSmallRoute,
  vellumBgAlloverRoute,
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
