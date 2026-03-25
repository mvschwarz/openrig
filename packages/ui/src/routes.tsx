import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { AppShell } from "./components/AppShell.js";
import { Dashboard } from "./components/Dashboard.js";
import { RigGraph } from "./components/RigGraph.js";
import { SnapshotPanel } from "./components/SnapshotPanel.js";
import { ImportFlow } from "./components/ImportFlow.js";

// Root route — wraps everything in AppShell
const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
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
    <div className="flex flex-1 h-full">
      <div className="flex-1">
        <RigGraph rigId={rigId} />
      </div>
      <SnapshotPanel rigId={rigId} />
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
