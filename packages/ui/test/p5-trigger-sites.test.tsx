// V1 attempt-3 Phase 5 P5-1 — site-of-use trigger reachability proof (ritual #6).
//
// drawer-primitives.test.tsx (Phase 4 process-gap fix) covers the unit-level
// reachability of the 4 viewer + 4 trigger primitives. P5-1 wires those
// triggers into 4 production surfaces (FeedCard / LibraryReview file lists /
// RigSpecDisplay agentRef cells / TopologyTreeView seat leaves). This file
// covers ROUTE-COMPONENT reachability per ritual #6 — a click on the named
// affordance fires setSelection with the correct DrawerSelection
// discriminator.
//
// Project queue tab (the 5th P5-1 surface in the ACK list) is wired in P5-2
// alongside the slice-tab content piping so the qitem rows arrive with the
// rest of the slice data; tested there.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// SubSpecPreview internally uses TanStack Link when entryId is present; in
// these tests we don't render SubSpecPreview directly (only its trigger).
// FeedCard renders AuthorAgentTag → useCmuxLaunch (useMutation) and a Link,
// so it needs both a QueryClientProvider and a TanStack Router context.

import { DrawerSelectionContext } from "../src/components/AppShell.js";

beforeEach(() => {
  cleanup();
});

function renderWithDrawerCtx(
  ui: React.ReactNode,
): { setSelection: ReturnType<typeof vi.fn> } & ReturnType<typeof render> {
  const setSelection = vi.fn();
  const utils = render(
    <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
      {ui}
    </DrawerSelectionContext.Provider>,
  );
  return { setSelection, ...utils };
}

// Wrapper for components that touch TanStack Router (Link) + React Query.
// FeedCard does both via the AuthorAgentTag → useCmuxLaunch path.
function renderWithRouterAndQuery(
  ui: React.ReactNode,
): { setSelection: ReturnType<typeof vi.fn> } & ReturnType<typeof render> {
  const setSelection = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
        {ui}
      </DrawerSelectionContext.Provider>
    ),
  });
  const seatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/topology/seat/$rigId/$logicalId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, seatRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { setSelection, ...utils };
}

// -----------------------------------------------------------------------
// FeedCard: "show context" QueueItemTrigger renders when source.payload has
// a qitem_id; click → setSelection({ type: 'qitem', data: {...} }).
// -----------------------------------------------------------------------

import { FeedCard } from "../src/components/for-you/FeedCard.js";
import type { FeedCard as FeedCardModel } from "../src/lib/feed-classifier.js";

function makeCard(overrides: Partial<FeedCardModel> = {}): FeedCardModel {
  return {
    id: "evt-1",
    kind: "action-required",
    title: "Need approval",
    body: "v0.3.0 RC ready, authorize tag/push?",
    authorSession: "orch-lead@openrig-velocity",
    rigId: "rig-1",
    receivedAt: 1_000_000,
    createdAt: "2026-05-06T18:00:00Z",
    source: {
      seq: 1,
      type: "queue.item.created",
      payload: {
        qitem_id: "qitem-20260506-test",
        source_session: "orch-lead@openrig-velocity",
        destination: "human-wrandom@kernel",
        state: "human-gate",
        body: "Authorize v0.3.0 RC tag/push?",
      },
      createdAt: "2026-05-06T18:00:00Z",
      receivedAt: 1_000_000,
    } as FeedCardModel["source"],
    ...overrides,
  };
}

describe("FeedCard P5-1 wiring: show-context QueueItemTrigger", () => {
  it("renders show-context trigger when source.payload has qitem_id", async () => {
    const card = makeCard();
    const { findByTestId } = renderWithRouterAndQuery(<FeedCard card={card} />);
    expect(await findByTestId(`feed-card-show-context-${card.id}`)).toBeTruthy();
  });

  it("hides show-context trigger when source.payload has no qitem_id", async () => {
    const card = makeCard({
      source: {
        seq: 2,
        type: "git.commit",
        payload: { sha: "abc123" },
        createdAt: "2026-05-06T18:00:00Z",
        receivedAt: 1_000_000,
      } as FeedCardModel["source"],
    });
    const { findByTestId, queryByTestId } = renderWithRouterAndQuery(<FeedCard card={card} />);
    // Wait for the card body itself to render (router resolution is async),
    // then assert the show-context trigger is absent.
    await findByTestId("feed-card-action");
    expect(queryByTestId(`feed-card-show-context-${card.id}`)).toBeNull();
  });

  it("show-context click → setSelection({ type: 'qitem', data: { qitemId, ... } })", async () => {
    const card = makeCard();
    const { setSelection, findByTestId } = renderWithRouterAndQuery(<FeedCard card={card} />);
    const trigger = await findByTestId(`feed-card-show-context-${card.id}`);
    fireEvent.click(trigger);
    expect(setSelection).toHaveBeenCalledOnce();
    const arg = setSelection.mock.calls[0][0];
    expect(arg.type).toBe("qitem");
    expect(arg.data.qitemId).toBe("qitem-20260506-test");
    expect(arg.data.source).toBe("orch-lead@openrig-velocity");
    expect(arg.data.destination).toBe("human-wrandom@kernel");
    expect(arg.data.state).toBe("human-gate");
    expect(arg.data.body).toBe("Authorize v0.3.0 RC tag/push?");
  });

  it("show-context handles queue.created camelCase daemon payloads", async () => {
    const card = makeCard({
      id: "queue-created-1",
      kind: "progress",
      title: "Queue item created",
      body: "orch-lead@openrig-velocity -> driver@openrig-velocity",
      authorSession: "orch-lead@openrig-velocity",
      source: {
        seq: 3,
        type: "queue.created",
        payload: {
          qitemId: "qitem-20260507-daemon",
          sourceSession: "orch-lead@openrig-velocity",
          destinationSession: "driver@openrig-velocity",
          priority: "routine",
          tier: "mode2",
        },
        createdAt: "2026-05-07T21:18:52Z",
        receivedAt: 1_000_000,
      } as FeedCardModel["source"],
    });
    const { setSelection, findByTestId } = renderWithRouterAndQuery(
      <FeedCard card={card} />,
    );
    const trigger = await findByTestId(`feed-card-show-context-${card.id}`);
    fireEvent.click(trigger);
    expect(setSelection).toHaveBeenCalledOnce();
    const arg = setSelection.mock.calls[0][0];
    expect(arg.type).toBe("qitem");
    expect(arg.data.qitemId).toBe("qitem-20260507-daemon");
    expect(arg.data.source).toBe("orch-lead@openrig-velocity");
    expect(arg.data.destination).toBe("driver@openrig-velocity");
    expect(arg.data.body).toBe(
      "orch-lead@openrig-velocity -> driver@openrig-velocity",
    );
  });

  it("prefers hydrated queue body and renders proof screenshots for shipped cards", async () => {
    const card = makeCard({
      id: "queue-shipped-1",
      kind: "shipped",
      title: "Queue item shipped: qitem-demo",
      body: "metadata-only fallback",
      source: {
        seq: 4,
        type: "queue.updated",
        payload: { qitemId: "qitem-demo", toState: "done" },
        createdAt: "2026-05-07T21:18:52Z",
        receivedAt: 1_000_000,
      } as FeedCardModel["source"],
    });
    const { findByTestId, findByText } = renderWithRouterAndQuery(
      <FeedCard
        card={card}
        queueItem={{
          qitemId: "qitem-demo",
          tsCreated: "2026-05-07T21:18:52Z",
          tsUpdated: "2026-05-07T21:20:00Z",
          sourceSession: "driver@rig",
          destinationSession: "human@host",
          state: "done",
          priority: "urgent",
          tier: "fast",
          tags: ["idea-ledger-triage-ideas-cycle-4"],
          body: "Review the completed proof packet and screenshots for the triage slice.",
        }}
        proofPreview={{
          sliceName: "idea-ledger-triage-ideas-cycle-4",
          displayName: "Idea Ledger triage ideas cycle 4",
          passFailBadge: "pass",
          screenshots: ["screenshots/for-you-live-human-pending-final.png"],
        }}
      />,
    );
    expect(await findByText("Review the completed proof packet and screenshots for the triage slice.")).toBeTruthy();
    expect(await findByTestId(`feed-card-proof-preview-${card.id}`)).toBeTruthy();
    const img = await findByTestId("feed-card-proof-screenshot-screenshots/for-you-live-human-pending-final.png") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("/api/slices/idea-ledger-triage-ideas-cycle-4/proof-asset/");
  });

  it("renders approve, deny, and route actions for actionable human queue cards", async () => {
    const card = makeCard();
    const { findByTestId, queryByTestId } = renderWithRouterAndQuery(
      <FeedCard
        card={card}
        queueItem={{
          qitemId: "qitem-20260506-test",
          tsCreated: "2026-05-06T18:00:00Z",
          tsUpdated: "2026-05-06T18:00:00Z",
          sourceSession: "orch-lead@openrig-velocity",
          destinationSession: "human@host",
          state: "human-gate",
          priority: "urgent",
          tier: "fast",
          tags: ["human-review"],
          body: "Review this proof packet and choose a queue action.",
        }}
      />,
    );

    expect(await findByTestId(`feed-card-actions-${card.id}`)).toBeTruthy();
    expect(await findByTestId("mc-verb-approve")).toBeTruthy();
    expect(await findByTestId("mc-verb-deny")).toBeTruthy();
    expect(await findByTestId("mc-verb-route")).toBeTruthy();
    expect(queryByTestId("mc-verb-handoff")).toBeNull();
  });

  it("does not render action controls for completed shipped cards", async () => {
    const card = makeCard({
      id: "queue-shipped-2",
      kind: "shipped",
      title: "Queue item shipped: qitem-demo",
      source: {
        seq: 5,
        type: "queue.updated",
        payload: { qitemId: "qitem-demo", toState: "done" },
        createdAt: "2026-05-07T21:18:52Z",
        receivedAt: 1_000_000,
      } as FeedCardModel["source"],
    });
    const { findByTestId, queryByTestId } = renderWithRouterAndQuery(
      <FeedCard
        card={card}
        queueItem={{
          qitemId: "qitem-demo",
          tsCreated: "2026-05-07T21:18:52Z",
          tsUpdated: "2026-05-07T21:20:00Z",
          sourceSession: "driver@rig",
          destinationSession: "human@host",
          state: "done",
          priority: "urgent",
          tier: "fast",
          tags: ["proof"],
          body: "Completed proof packet.",
        }}
      />,
    );

    expect(await findByTestId("feed-card-shipped")).toBeTruthy();
    expect(queryByTestId(`feed-card-actions-${card.id}`)).toBeNull();
  });
});

// V1 polish slice Phase 5.1 P5.1-D2: TopologyTreeView SeatLeaf details
// icon RETIRED. SeatDetailTrigger primitive RETIRED. SeatLeaf is now
// Link-only navigation to /topology/seat/$rigId/$logicalId. Retirement-
// regression guard lives in test/node-selection-migration.test.tsx
// (file-doesn't-exist for SeatDetailTrigger.tsx + SharedDetailDrawer
// has no 'seat-detail' kind).

// -----------------------------------------------------------------------
// RigSpecDisplay pod-member agentRef cell → SubSpecTrigger → drawer.
// -----------------------------------------------------------------------

import { SubSpecTrigger } from "../src/components/drawer-triggers/SubSpecTrigger.js";

describe("RigSpecDisplay P5-1 wiring: agentRef SubSpecTrigger contract", () => {
  it("clicking SubSpecTrigger with agent spec data fires setSelection({ type: 'sub-spec', data: {...} })", () => {
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <SubSpecTrigger
        data={{ specKind: "agent", specName: "impl", source: "user_file" }}
        testId="rs-member-test"
      >
        local:agents/impl
      </SubSpecTrigger>,
    );
    fireEvent.click(getByTestId("rs-member-test"));
    expect(setSelection).toHaveBeenCalledWith({
      type: "sub-spec",
      data: { specKind: "agent", specName: "impl", source: "user_file" },
    });
  });

  it("RigSpecDisplay source wraps m.agentRef in SubSpecTrigger (ritual #1+#9)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "../src/components/RigSpecDisplay.tsx"),
      "utf8",
    );
    expect(src).toMatch(/import\s*\{\s*SubSpecTrigger\s*\}/);
    expect(src).toMatch(/<SubSpecTrigger/);
    // parseAgentRef helper present (extracts specName + source from
    // local:agents/foo / fork:agents/foo / etc).
    expect(src).toMatch(/parseAgentRef/);
  });
});

// -----------------------------------------------------------------------
// LibraryReview Files list (context-pack + agent-image) → FileReferenceTrigger.
// -----------------------------------------------------------------------

import { FileReferenceTrigger } from "../src/components/drawer-triggers/FileReferenceTrigger.js";

describe("LibraryReview P5-1 wiring: file-list FileReferenceTrigger contract", () => {
  it("clicking FileReferenceTrigger fires setSelection({ type: 'file', data: { path } })", () => {
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <FileReferenceTrigger
        data={{ path: "context-pack/role.md" }}
        testId="lib-pack-file-trigger-test"
      >
        role.md
      </FileReferenceTrigger>,
    );
    fireEvent.click(getByTestId("lib-pack-file-trigger-test"));
    expect(setSelection).toHaveBeenCalledWith({
      type: "file",
      data: { path: "context-pack/role.md" },
    });
  });

  it("LibraryReview source wraps both context-pack and agent-image file rows in FileReferenceTrigger (ritual #1+#9)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "../src/components/LibraryReview.tsx"),
      "utf8",
    );
    expect(src).toMatch(/import\s*\{\s*FileReferenceTrigger\s*\}/);
    // Both file-list sites (context-pack lib-pack-file-trigger-* and
    // agent-image lib-image-file-trigger-*) must be present.
    expect(src).toMatch(/lib-pack-file-trigger-/);
    expect(src).toMatch(/lib-image-file-trigger-/);
  });
});
