import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createTestRouter, createAppTestRouter } from "./helpers/test-router.js";
import { Dashboard } from "../src/components/Dashboard.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(() => {
  mockFetch.mockReset();
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
});

afterEach(() => {
  if (OriginalEventSource) {
    globalThis.EventSource = OriginalEventSource;
  }
  cleanup();
});

function mockSummaryResponse(rigs: Array<{
  id: string; name: string; nodeCount: number;
  latestSnapshotAt: string | null; latestSnapshotId: string | null;
}>) {
  return { ok: true, json: async () => rigs, text: async () => JSON.stringify(rigs) };
}

function mockGraphResponse() {
  return {
    ok: true,
    json: async () => ({
      nodes: [{
        id: "n1", type: "rigNode", position: { x: 0, y: 0 },
        data: { logicalId: "worker", role: "worker", runtime: "claude-code", model: null, status: null, binding: null },
      }],
      edges: [],
    }),
  };
}

function mockSnapshotResponse() {
  return { ok: true, json: async () => ({ id: "snap-new" }) };
}

function mockExportResponse() {
  return { ok: true, text: async () => "schema_version: 1\nname: test\n" };
}

function setupSummaryMock(rigs: Array<{
  id: string; name: string; nodeCount: number;
  latestSnapshotAt: string | null; latestSnapshotId: string | null;
}>) {
  mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
    if (url === "/api/rigs/summary") return Promise.resolve(mockSummaryResponse(rigs));
    if (typeof url === "string" && url.includes("/graph")) return Promise.resolve(mockGraphResponse());
    if (typeof url === "string" && url.includes("/snapshots") && opts?.method === "POST") return Promise.resolve(mockSnapshotResponse());
    if (typeof url === "string" && url.includes("/snapshots")) return Promise.resolve({ ok: true, json: async () => [] });
    if (typeof url === "string" && url.includes("/spec")) return Promise.resolve(mockExportResponse());
    if (url === "/api/healthz") return Promise.resolve({ ok: true, json: async () => ({ status: "ok" }) });
    if (url === "/api/adapters/cmux/status") return Promise.resolve({ ok: true, json: async () => ({ available: false }) });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

const TWO_RIGS = [
  { id: "r1", name: "alpha", nodeCount: 3, latestSnapshotAt: "2026-03-24 01:00:00", latestSnapshotId: "snap-1" },
  { id: "r2", name: "beta", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
];

describe("Dashboard", () => {
  it("renders rig cards from /api/rigs/summary", async () => {
    setupSummaryMock(TWO_RIGS);
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeDefined();
      expect(screen.getByText("beta")).toBeDefined();
    });
  });

  it("card shows name and node count", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 5, latestSnapshotAt: null, latestSnapshotId: null }]);
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeDefined();
      expect(screen.getByText("5 node(s)")).toBeDefined();
    });
  });

  it("snapshot button calls POST /api/rigs/:rigId/snapshots", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }]);
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    fireEvent.click(screen.getAllByText("Snapshot")[0]!);

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (c: unknown[]) => c[0] === "/api/rigs/r1/snapshots" && (c[1] as RequestInit)?.method === "POST"
      );
      expect(postCall).toBeDefined();
    });
  });

  it("export button fetches /api/rigs/:rigId/spec", async () => {
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    fireEvent.click(screen.getAllByText("Export")[0]!);

    await waitFor(() => {
      const specCall = mockFetch.mock.calls.find((c: unknown[]) => c[0] === "/api/rigs/r1/spec");
      expect(specCall).toBeDefined();
    });
  });

  it("click card navigates (View Graph button)", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);

    render(createAppTestRouter({
      routes: [
        { path: "/", component: Dashboard },
        { path: "/rigs/$rigId", component: () => <div data-testid="rig-detail">detail</div> },
      ],
    }));

    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());
    fireEvent.click(screen.getAllByText("View Graph")[0]!);

    await waitFor(() => {
      expect(screen.getByTestId("rig-detail")).toBeDefined();
    });
  });

  it("import button navigates to /import", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);

    render(createAppTestRouter({
      routes: [
        { path: "/", component: Dashboard },
        { path: "/import", component: () => <div data-testid="import-page">import</div> },
      ],
    }));

    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());
    fireEvent.click(screen.getByText("Import Rig"));

    await waitFor(() => {
      expect(screen.getByTestId("import-page")).toBeDefined();
    });
  });

  it("empty state shows 'No rigs' + Import button", async () => {
    setupSummaryMock([]);
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => {
      expect(screen.getByText(/no rigs/i)).toBeDefined();
      expect(screen.getByText("Import Rig")).toBeDefined();
    });
  });

  it("shows loading state", async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => {
      expect(screen.getByText(/loading dashboard/i)).toBeDefined();
    });
  });

  it("snapshot button click does not navigate away", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    fireEvent.click(screen.getAllByText("Snapshot")[0]!);

    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeDefined();
    });
  });

  it("export button click does not navigate away", async () => {
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    fireEvent.click(screen.getAllByText("Export")[0]!);

    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeDefined();
    });
  });

  it("card with snapshot timestamp renders age string", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: twoHoursAgo, latestSnapshotId: "snap-1" }]);

    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => {
      const ageEl = screen.getByTestId("snapshot-age-r1");
      expect(ageEl.textContent).toMatch(/2h ago/);
    });
  });

  it("card with no snapshot renders 'none'", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);

    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => {
      const ageEl = screen.getByTestId("snapshot-age-r1");
      expect(ageEl.textContent).toContain("none");
    });
  });
});
