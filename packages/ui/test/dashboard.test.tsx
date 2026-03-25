import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { App } from "../src/App.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";

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

describe("Dashboard", () => {
  // Test 1: Renders rig cards from summary API
  it("renders rig cards from /api/rigs/summary", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null },
          { id: "r2", name: "beta", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeDefined();
      expect(screen.getByText("beta")).toBeDefined();
    });
  });

  // Test 2: Card shows name + node count
  it("card shows name and node count", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 5, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeDefined();
      expect(screen.getByText("5 node(s)")).toBeDefined();
    });
  });

  // Test 3: Snapshot button calls POST /api/rigs/:rigId/snapshots
  it("snapshot button calls POST /api/rigs/:rigId/snapshots", async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      if (url === "/api/rigs/r1/snapshots" && opts?.method === "POST") {
        return Promise.resolve(mockSnapshotResponse());
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    const snapshotBtn = screen.getAllByText("Snapshot")[0]!;
    fireEvent.click(snapshotBtn);

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (c: unknown[]) => c[0] === "/api/rigs/r1/snapshots" && (c[1] as RequestInit)?.method === "POST"
      );
      expect(postCall).toBeDefined();
    });
  });

  // Test 4: Export button triggers download
  it("export button fetches /api/rigs/:rigId/spec", async () => {
    // Mock URL.createObjectURL and document.createElement for download
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      if (url === "/api/rigs/r1/spec") {
        return Promise.resolve(mockExportResponse());
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    const exportBtn = screen.getAllByText("Export")[0]!;
    fireEvent.click(exportBtn);

    await waitFor(() => {
      const specCall = mockFetch.mock.calls.find(
        (c: unknown[]) => c[0] === "/api/rigs/r1/spec"
      );
      expect(specCall).toBeDefined();
    });

    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });

  // Test 5: Click card -> graph view
  it("click card -> switches to graph view", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      if (typeof url === "string" && url.includes("/graph")) {
        return Promise.resolve(mockGraphResponse());
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    // Click the card itself (not buttons)
    const card = screen.getByTestId("rig-card-r1");
    fireEvent.click(card);

    await waitFor(() => {
      expect(screen.getByText("Back to Dashboard")).toBeDefined();
    });
  });

  // Test 6: Import button sets import view
  it("import button opens import view", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    const importBtn = screen.getByText("Import Rig");
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(screen.getByText(/import flow/i)).toBeDefined();
    });
  });

  // Test 7: Empty state -> "No rigs" + import CTA
  it("empty state shows 'No rigs' + Import button", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/no rigs/i)).toBeDefined();
      expect(screen.getByText("Import Rig")).toBeDefined();
    });
  });

  // Test 8: Loading state
  it("shows loading state", () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(screen.getByText(/loading dashboard/i)).toBeDefined();
  });

  // Test 9: Clicking Snapshot does NOT trigger card navigation
  it("snapshot button click does not navigate to graph", async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      if (url === "/api/rigs/r1/snapshots" && opts?.method === "POST") {
        return Promise.resolve(mockSnapshotResponse());
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    const snapshotBtn = screen.getAllByText("Snapshot")[0]!;
    fireEvent.click(snapshotBtn);

    // Should still be on dashboard, not graph
    await waitFor(() => {
      expect(screen.queryByText("Back to Dashboard")).toBeNull();
      expect(screen.getByText("alpha")).toBeDefined();
    });
  });

  // Test 9b: Clicking Export does NOT trigger card navigation
  it("export button click does not navigate to graph", async () => {
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      if (url === "/api/rigs/r1/spec") {
        return Promise.resolve(mockExportResponse());
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    const exportBtn = screen.getAllByText("Export")[0]!;
    fireEvent.click(exportBtn);

    // Should still be on dashboard, not graph
    await waitFor(() => {
      expect(screen.queryByText("Back to Dashboard")).toBeNull();
      expect(screen.getByText("alpha")).toBeDefined();
    });
  });

  // Test 10: Back button from graph -> dashboard
  it("back button returns from graph to dashboard", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      if (typeof url === "string" && url.includes("/graph")) {
        return Promise.resolve(mockGraphResponse());
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    // Navigate to graph
    fireEvent.click(screen.getByTestId("rig-card-r1"));
    await waitFor(() => expect(screen.getByText("Back to Dashboard")).toBeDefined());

    // Navigate back
    fireEvent.click(screen.getByText("Back to Dashboard"));

    // Dashboard should re-render (will re-fetch summary)
    await waitFor(() => {
      expect(screen.queryByText("Back to Dashboard")).toBeNull();
      // Dashboard is loading or showing content
      expect(screen.getByText(/loading dashboard|alpha|no rigs/i)).toBeDefined();
    });
  });

  // Test 12: Card with latestSnapshotAt renders age string
  it("card with snapshot timestamp renders age string", async () => {
    // Use a timestamp from 2 hours ago to get a stable "2h ago" result
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: twoHoursAgo, latestSnapshotId: "snap-1" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => {
      const ageEl = screen.getByTestId("snapshot-age-r1");
      expect(ageEl.textContent).toMatch(/2h ago/);
    });
  });

  // Test 13: Card with no snapshot renders "none"
  it("card with no snapshot renders 'none'", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => {
      const ageEl = screen.getByTestId("snapshot-age-r1");
      expect(ageEl.textContent).toContain("none");
    });
  });
});
