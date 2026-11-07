// C10: shared Dashboard route harness for dashboard-v2 + dashboard-fidelity.
// Both suites render Dashboard at "/" with stubbed link targets and a
// caller-seeded QueryClient (seeded via setQueryData with the hooks' keys).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { Dashboard } from "../../src/components/dashboard/Dashboard.js";

const STUB_PATHS = [
  "/import",
  "/specs/rig",
  "/topology",
  "/topology/rig/$rigId",
  "/for-you",
  "/agents",
  "/settings/status",
];

export function renderDashboard(seed: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(qc);
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Dashboard });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const routeTree = rootRoute.addChildren([indexRoute, ...STUB_PATHS.map(stub)]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // Cast: the test stub tree differs from the app's generated route tree.
  return render(<RouterProvider router={router as never} />);
}
