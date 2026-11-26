// A feed card's seat tag names a session (`dev-impl@my-rig`), while the seat page and the cmux launcher take the rig's
// id and the seat's logical id (`dev.impl`). The tag resolves the seat against the rig's own node inventory, so a click
// opens the seat the card is about. A session that resolves to no seat shows as plain text: a guessed id would open the
// wrong seat or none.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { AuthorAgentTag } from "../src/components/for-you/AuthorAgentTag.js";

const rigs = [{ rigId: "rig-1", name: "my-rig", nodeCount: 2, runningCount: 2, status: "running", uptime: null, latestSnapshot: null }];
const nodes = [
  { rigId: "rig-1", rigName: "my-rig", logicalId: "dev.impl", canonicalSessionName: "dev-impl@my-rig" },
  { rigId: "rig-1", rigName: "my-rig", logicalId: "orch.lead", canonicalSessionName: "orch-lead@my-rig" },
];
const mockFetch = vi.fn();

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/ps") return json(rigs);
    if (url === "/api/rigs/rig-1/nodes") return json(nodes);
    if (url.endsWith("/open-cmux") && init?.method === "POST") return json({ ok: true, action: "focused" });
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

function renderTag(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <>{ui}</> });
  const seatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/topology/seat/$rigId/$logicalId", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, seatRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
}

const openCmuxCalls = () => mockFetch.mock.calls.filter(([url]) => String(url).endsWith("/open-cmux")).map(([url]) => url);

describe("a feed card's seat tag for a pod-namespaced seat", () => {
  it.each([["a card that knows its rig", "rig-1"], ["a card that only names its session's rig", undefined]] as const)(
    "opens and links the seat the session names, for %s", async (_label, rigId) => {
      const { findByTestId } = renderTag(<AuthorAgentTag authorSession="dev-impl@my-rig" rigId={rigId} />);
      await waitFor(async () => expect((await findByTestId("author-agent-tag")).tagName).toBe("A"));
      const tag = await findByTestId("author-agent-tag");
      expect(tag.getAttribute("href")).toBe("/topology/seat/rig-1/dev.impl");
      expect(tag.textContent).toBe("dev-impl@my-rig");
      fireEvent.click(tag);
      await waitFor(() => expect(openCmuxCalls()).toEqual(["/api/rigs/rig-1/nodes/dev.impl/open-cmux"]));
    });

  it("shows a session that matches no seat as plain text, and opens nothing", async () => {
    const { findByTestId } = renderTag(<AuthorAgentTag authorSession="gone-seat@my-rig" rigId="rig-1" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/rigs/rig-1/nodes"));
    const tag = await findByTestId("author-agent-tag");
    expect(tag.tagName).toBe("SPAN");
    expect(tag.textContent).toBe("gone-seat@my-rig");
    fireEvent.click(tag);
    expect(openCmuxCalls()).toEqual([]);
  });
});
