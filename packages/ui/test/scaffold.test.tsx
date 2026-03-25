import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
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
  return { ok: true, json: async () => rigs };
}

describe("App (scaffold)", () => {
  it("shows loading state while fetching summary", () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(screen.getByText(/loading dashboard/i)).toBeDefined();
  });

  it("shows 'No rigs' when summary returns empty", async () => {
    mockFetch.mockResolvedValueOnce(mockSummaryResponse([]));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/no rigs/i)).toBeDefined();
    });
  });

  it("renders dashboard with rig cards when summary has data", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve(mockSummaryResponse([
          { id: "r1", name: "r01", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("r01")).toBeDefined();
    });
  });

  it("shows error message on fetch failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeDefined();
    });
  });

  it("dashboard fetches /api/rigs/summary", async () => {
    mockFetch.mockResolvedValueOnce(mockSummaryResponse([]));
    render(<App />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
      expect(mockFetch.mock.calls[0]![0]).toBe("/api/rigs/summary");
    });
  });
});
