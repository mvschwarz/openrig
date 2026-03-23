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

function mockRigsResponse(rigs: { id: string; name: string }[]) {
  return { ok: true, json: async () => rigs };
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

describe("App", () => {
  it("shows loading state while fetching rigs", () => {
    // Never resolves
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(screen.getByText(/loading rigs/i)).toBeDefined();
  });

  it("shows 'No rigs found' when API returns empty list", async () => {
    mockFetch.mockResolvedValueOnce(mockRigsResponse([]));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/no rigs found/i)).toBeDefined();
    });
  });

  it("auto-selects first rig and renders graph", async () => {
    mockFetch
      .mockResolvedValueOnce(mockRigsResponse([
        { id: "rig-1", name: "r01" },
        { id: "rig-2", name: "r02" },
      ]))
      .mockResolvedValueOnce(mockGraphResponse());

    render(<App />);

    await waitFor(() => {
      // Graph should be fetched for the first rig
      const graphCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/graph")
      );
      expect(graphCall).toBeDefined();
      expect(graphCall![0]).toBe("/api/rigs/rig-1/graph");
    });
  });

  it("'No rig selected' never appears when rigs exist (no flash)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockRigsResponse([
        { id: "rig-1", name: "r01" },
      ]))
      .mockResolvedValue(mockGraphResponse());

    render(<App />);

    // During loading, we see 'Loading rigs...' — not 'No rig selected'
    expect(screen.queryByText(/no rig selected/i)).toBeNull();

    // After rigs load, still no 'No rig selected' flash
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeDefined();
    });
    expect(screen.queryByText(/no rig selected/i)).toBeNull();
  });

  it("shows error message on fetch failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeDefined();
    });
  });

  it("useRigs hook fetches exactly /api/rigs", async () => {
    mockFetch.mockResolvedValueOnce(mockRigsResponse([]));
    render(<App />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
      expect(mockFetch.mock.calls[0]![0]).toBe("/api/rigs");
    });
  });

  it("useRigs hook returns loading=true initially", () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<App />);
    // Loading state visible immediately, not empty state
    expect(screen.getByText(/loading rigs/i)).toBeDefined();
    expect(screen.queryByText(/no rigs found/i)).toBeNull();
  });

  it("rig selector changes rigId when different rig selected", async () => {
    mockFetch
      .mockResolvedValueOnce(mockRigsResponse([
        { id: "rig-1", name: "r01" },
        { id: "rig-2", name: "r02" },
      ]))
      .mockResolvedValue(mockGraphResponse()); // all subsequent graph fetches

    render(<App />);

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeDefined();
    });

    // Wait for initial graph fetch to settle
    await waitFor(() => {
      const graphCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/graph")
      );
      expect(graphCalls.length).toBeGreaterThanOrEqual(1);
    });

    mockFetch.mockClear();
    mockFetch.mockResolvedValue(mockGraphResponse());

    // Change selection
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "rig-2" } });

    await waitFor(() => {
      const rig2Call = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string) === "/api/rigs/rig-2/graph"
      );
      expect(rig2Call).toBeDefined();
    });
  });
});
