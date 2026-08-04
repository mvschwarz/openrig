import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
} from "@tanstack/react-router";

afterEach(() => cleanup());

// Slice-03 Atom 5 — the context-pack entry id is `context-pack:<ref>` and a ref
// can contain '/'. This proves the shared `/specs/library/$entryId` route
// round-trips such an id: build a link with it → URL → read the param back →
// byte-identical id (so LibraryReview's startsWith dispatch + p.id===entryId
// find keep working with the new id form).
describe("context-pack id route round-trip (Atom 5)", () => {
  const ID = "context-pack:packs/compaction-restore";

  function router() {
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const home = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => {
        const navigate = useNavigate();
        return (
          <button data-testid="go" onClick={() => void navigate({ to: "/specs/library/$entryId", params: { entryId: ID } })}>
            go
          </button>
        );
      },
    });
    const review = createRoute({
      getParentRoute: () => rootRoute,
      path: "/specs/library/$entryId",
      component: () => {
        const { entryId } = useParams({ from: "/specs/library/$entryId" });
        return <div data-testid="entryid">{entryId}</div>;
      },
    });
    return createRouter({
      routeTree: rootRoute.addChildren([home, review]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }

  it("navigate(build) → useParams(read) preserves a slash-containing context-pack:<ref> id", async () => {
    render(<RouterProvider router={router()} />);
    await waitFor(() => expect(screen.getByTestId("go")).toBeDefined());
    fireEvent.click(screen.getByTestId("go"));
    await waitFor(() => expect(screen.getByTestId("entryid")).toBeDefined());
    expect(screen.getByTestId("entryid").textContent).toBe(ID);
  });

  it("a direct deep-link to the encoded URL decodes back to the id", async () => {
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const review = createRoute({
      getParentRoute: () => rootRoute,
      path: "/specs/library/$entryId",
      component: () => {
        const { entryId } = useParams({ from: "/specs/library/$entryId" });
        return <div data-testid="entryid">{entryId}</div>;
      },
    });
    const r = createRouter({
      routeTree: rootRoute.addChildren([review]),
      history: createMemoryHistory({ initialEntries: [`/specs/library/${encodeURIComponent(ID)}`] }),
    });
    render(<RouterProvider router={r} />);
    await waitFor(() => expect(screen.getByTestId("entryid")).toBeDefined());
    expect(screen.getByTestId("entryid").textContent).toBe(ID);
  });
});
