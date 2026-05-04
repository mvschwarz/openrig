// Slice Story View v0 — top-level surface tests.
//
// Covers the Slice Story View shell (route detail pane + existing AppShell
// explorer content). Each tab's deep behavior is tested in its own focused
// component test (TestsVerificationTab.test.tsx is the load-bearing
// example); this file confirms the surface composition + filter UX +
// tab switching + the "slices indexer unavailable" graceful path.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { SliceExplorerPanel } from "../src/components/slices/SliceExplorerPanel.js";
import { SliceStoryView } from "../src/components/slices/SliceStoryView.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
});

afterEach(() => cleanup());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }) as unknown as Response;
}

function makeListEntries() {
  return [
    {
      name: "alpha-slice",
      displayName: "Alpha Slice",
      railItem: "PL-005",
      status: "active",
      rawStatus: "active",
      qitemCount: 3,
      hasProofPacket: true,
      lastActivityAt: "2026-05-04T12:00:00.000Z",
    },
    {
      name: "beta-slice",
      displayName: "Beta Slice",
      railItem: "PL-019",
      status: "done",
      rawStatus: "shipped",
      qitemCount: 5,
      hasProofPacket: true,
      lastActivityAt: "2026-05-03T12:00:00.000Z",
    },
  ];
}

function makeDetailPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "alpha-slice",
    displayName: "Alpha Slice",
    railItem: "PL-005",
    status: "active",
    rawStatus: "active",
    qitemIds: ["q1"],
    commitRefs: [],
    lastActivityAt: "2026-05-04T12:00:00.000Z",
    story: { events: [
      { ts: "2026-05-01T10:00:00.000Z", phase: "discovery", kind: "queue.created", actorSession: "intake@kernel", qitemId: "q1", summary: "intake scoped slice", detail: null },
    ] },
    acceptance: { totalItems: 4, doneItems: 2, percentage: 50, items: [
      { text: "Item 1", done: true, source: { file: "README.md", line: 12 } },
      { text: "Item 2", done: false, source: { file: "README.md", line: 13 } },
    ], closureCallout: null },
    decisions: { rows: [] },
    docs: { tree: [] },
    tests: { proofPackets: [], aggregate: { passCount: 0, failCount: 0 } },
    topology: { affectedRigs: [], totalSeats: 0 },
    ...overrides,
  };
}

describe("PL-slice-story-view-v0 SliceStoryView", () => {
  it("renders 'pick a slice' empty state when no name in URL", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ slices: makeListEntries(), totalCount: 2, filter: "active" }));
    render(createTestRouter({ component: () => <SliceStoryView />, path: "/slices", initialPath: "/slices" }));
    await waitFor(() => expect(screen.getByTestId("slice-no-selection")).toBeDefined());
  });

  it("keeps route content offset from the AppShell explorer instead of owning a second sidebar", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ slices: makeListEntries(), totalCount: 2, filter: "active" }));
    render(createTestRouter({ component: () => <SliceStoryView />, path: "/slices", initialPath: "/slices" }));
    await waitFor(() => expect(screen.getByTestId("slice-story-view")).toBeDefined());

    expect(screen.getByTestId("slice-story-view").className).toContain("lg:pl-[var(--workspace-left-offset,0px)]");
    expect(screen.getByTestId("slice-story-view").className).toContain("lg:pr-[var(--workspace-right-offset,0px)]");
    expect(screen.queryByTestId("slice-list-pane")).toBeNull();
  });

  it("SliceExplorerPanel renders the four-filter row defaulting to 'active'", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ slices: [], totalCount: 0, filter: "active" }));
    render(createTestRouter({ component: () => <SliceExplorerPanel />, path: "/slices" }));
    await waitFor(() => expect(screen.getByTestId("slice-filter-row")).toBeDefined());
    for (const filter of ["all", "active", "done", "blocked"]) {
      expect(screen.getByTestId(`slice-filter-${filter}`)).toBeDefined();
    }
    expect(screen.getByTestId("slice-filter-active").getAttribute("data-active")).toBe("true");
  });

  it("SliceExplorerPanel clicking a filter triggers a refetch with that filter", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("filter=active")) return jsonResponse({ slices: [], totalCount: 0, filter: "active" });
      if (url.includes("filter=all")) return jsonResponse({ slices: makeListEntries(), totalCount: 2, filter: "all" });
      return jsonResponse({ slices: [], totalCount: 0, filter: "all" });
    });
    render(createTestRouter({ component: () => <SliceExplorerPanel />, path: "/slices" }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/slices?filter=active"));
    fireEvent.click(screen.getByTestId("slice-filter-all"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/slices?filter=all"));
  });

  it("SliceExplorerPanel surfaces 'slices indexer unavailable' hint when daemon returns 503", async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      error: "slices_root_not_configured",
      hint: "Set OPENRIG_SLICES_ROOT to the directory containing slice folders",
    }, 503));
    render(createTestRouter({ component: () => <SliceExplorerPanel />, path: "/slices" }));
    await waitFor(() => expect(screen.getByTestId("slice-list-unavailable")).toBeDefined());
    expect(screen.getByTestId("slice-list-unavailable").textContent).toContain("OPENRIG_SLICES_ROOT");
  });

  it("renders all six tab nav buttons with the canonical labels when a slice is selected", async () => {
    // Switch the filter list response + add detail response.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/slices/alpha-slice")) return jsonResponse(makeDetailPayload());
      return jsonResponse({ slices: makeListEntries(), totalCount: 2, filter: "active" });
    });
    render(createTestRouter({
      component: () => <SliceStoryView />,
      path: "/slices/$name",
      initialPath: "/slices/alpha-slice",
    }));
    await waitFor(() => expect(screen.getByTestId("slice-tab-nav")).toBeDefined());
    for (const tab of ["story", "acceptance", "decisions", "docs", "tests", "topology"]) {
      expect(screen.getByTestId(`slice-tab-${tab}`)).toBeDefined();
    }
    // Default active tab is story.
    expect(screen.getByTestId("slice-tab-story").getAttribute("data-active")).toBe("true");
  });

  it("clicking a tab swaps the rendered content section", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/slices/alpha-slice")) return jsonResponse(makeDetailPayload());
      return jsonResponse({ slices: makeListEntries(), totalCount: 2, filter: "active" });
    });
    render(createTestRouter({
      component: () => <SliceStoryView />,
      path: "/slices/$name",
      initialPath: "/slices/alpha-slice",
    }));
    await waitFor(() => expect(screen.getByTestId("slice-tab-content-story")).toBeDefined());
    fireEvent.click(screen.getByTestId("slice-tab-acceptance"));
    await waitFor(() => expect(screen.getByTestId("slice-tab-content-acceptance")).toBeDefined());
    expect(screen.queryByTestId("slice-tab-content-story")).toBeNull();
    fireEvent.click(screen.getByTestId("slice-tab-tests"));
    await waitFor(() => expect(screen.getByTestId("slice-tab-content-tests")).toBeDefined());
  });
});
