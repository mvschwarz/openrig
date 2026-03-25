import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Creates a test router that renders children at a given path.
 * Use for testing components that need router context (useNavigate, useParams, etc.)
 */
export function createTestRouter(opts: {
  component: () => ReactNode;
  path?: string;
  initialPath?: string;
}) {
  const { component: Component, path = "/", initialPath } = opts;

  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });

  const testRoute = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: Component,
  });

  // Add a catch-all so navigation doesn't fail
  const catchAllRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => <div data-testid="navigated">navigated</div>,
  });

  const routeTree = rootRoute.addChildren([testRoute, catchAllRoute]);

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath ?? path] }),
  });

  return <RouterProvider router={router} />;
}

/**
 * Creates a full app-like router for integration tests.
 * Renders the given routes at specific paths.
 */
export function createAppTestRouter(opts: {
  routes: Array<{ path: string; component: () => ReactNode }>;
  initialPath?: string;
  rootComponent?: (props: { children: ReactNode }) => ReactNode;
}) {
  const rootRoute = createRootRoute({
    component: () => {
      if (opts.rootComponent) {
        return opts.rootComponent({ children: <Outlet /> });
      }
      return <Outlet />;
    },
  });

  const children = opts.routes.map((r) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: r.path,
      component: r.component,
    })
  );

  const routeTree = rootRoute.addChildren(children);

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: [opts.initialPath ?? opts.routes[0]?.path ?? "/"],
    }),
  });

  return <RouterProvider router={router} />;
}
