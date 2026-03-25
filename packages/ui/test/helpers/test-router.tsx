import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/** Creates a fresh QueryClient for test isolation */
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

/**
 * Creates a test router that renders children at a given path.
 * Wraps in QueryClientProvider for hooks that need query context.
 */
export function createTestRouter(opts: {
  component: () => ReactNode;
  path?: string;
  initialPath?: string;
}) {
  const { component: Component, path = "/", initialPath } = opts;
  const queryClient = createTestQueryClient();

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    ),
  });

  const testRoute = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: Component,
  });

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
 * Wraps in QueryClientProvider.
 */
export function createAppTestRouter(opts: {
  routes: Array<{ path: string; component: () => ReactNode }>;
  initialPath?: string;
  rootComponent?: (props: { children: ReactNode }) => ReactNode;
}) {
  const queryClient = createTestQueryClient();

  const rootRoute = createRootRoute({
    component: () => {
      const inner = opts.rootComponent
        ? opts.rootComponent({ children: <Outlet /> })
        : <Outlet />;
      return (
        <QueryClientProvider client={queryClient}>
          {inner}
        </QueryClientProvider>
      );
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
