import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query-client.js";
import { AppShell } from "./components/AppShell.js";
import { Dashboard } from "./components/Dashboard.js";
import { RigGraph } from "./components/RigGraph.js";
import { SnapshotPanel } from "./components/SnapshotPanel.js";
import { ImportFlow } from "./components/ImportFlow.js";

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
  return (
    <div className="flex flex-col flex-1 h-full">
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 relative">
          <RigGraph rigId={rigId} />
        </div>
        <div className="relative border-l border-ghost-border/30">
          <SnapshotPanel rigId={rigId} />
        </div>
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

// Route tree
const routeTree = rootRoute.addChildren([indexRoute, rigDetailRoute, importRoute]);

// Router
export const router = createRouter({ routeTree });

// Type registration for type-safe navigation
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
