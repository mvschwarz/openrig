import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  Link,
} from "@tanstack/react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient } from "./lib/query-client.js";
import { AppShell } from "./components/AppShell.js";
import { Dashboard } from "./components/Dashboard.js";
import { RigGraph } from "./components/RigGraph.js";
import { SnapshotPanel } from "./components/SnapshotPanel.js";
import { ImportFlow } from "./components/ImportFlow.js";
import { PackageList } from "./components/PackageList.js";
import { PackageInstallFlow } from "./components/PackageInstallFlow.js";
import { PackageDetail } from "./components/PackageDetail.js";

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
  component: Dashboard,
});

// Rig detail route — Graph + SnapshotPanel
function RigDetail() {
  const { rigId } = rigDetailRoute.useParams();

  // Fetch rig name from summary cache or fresh
  const { data: rigs } = useQuery({
    queryKey: ["rigs", "summary"],
    queryFn: async () => {
      const res = await fetch("/api/rigs/summary");
      if (!res.ok) return [];
      return res.json();
    },
  });
  const rigName = rigs?.find((r: { id: string; name: string }) => r.id === rigId)?.name;

  return (
    <div className="flex flex-col flex-1 h-full">
      {/* Rig header bar */}
      <div className="flex items-center gap-spacing-3 px-spacing-4 py-spacing-2 bg-background border-b border-foreground/6 shrink-0">
        <Link to="/" className="text-label-md text-foreground-muted hover:text-foreground transition-colors">
          &larr; RIGS
        </Link>
        <span className="text-foreground/20">/</span>
        <span className="text-label-lg font-bold uppercase">{rigName ?? rigId.slice(0, 8)}</span>
      </div>

      {/* Graph + Snapshots: side-by-side on wide, stacked on narrow */}
      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
        <div className="flex-1 relative min-h-[300px]">
          <RigGraph rigId={rigId} />
        </div>
        <SnapshotPanel rigId={rigId} />
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

// Package detail route
const packageDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages/$packageId",
  component: PackageDetail,
});

// Route tree
const routeTree = rootRoute.addChildren([indexRoute, rigDetailRoute, importRoute, packagesRoute, packageInstallRoute, packageDetailRoute]);

// Router
export const router = createRouter({ routeTree });

// Type registration for type-safe navigation
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
