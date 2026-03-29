import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "../src/components/StatusBar.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function mockConnected() {
  mockFetch.mockImplementation((url: string) => {
    if (url === "/healthz") return Promise.resolve({ ok: true, json: async () => ({ status: "ok" }) });
    if (url === "/api/rigs/summary") return Promise.resolve({ ok: true, json: async () => [{ id: "r1" }, { id: "r2" }] });
    if (url === "/api/adapters/cmux/status") return Promise.resolve({ ok: true, json: async () => ({ available: true }) });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

function mockDisconnected() {
  mockFetch.mockImplementation(() => Promise.reject(new Error("connection refused")));
}

describe("StatusBar", () => {
  // Test 1: Connected state
  it("shows SYSTEM_STABLE with health dot bg-success", async () => {
    mockConnected();
    const qc = createTestQueryClient();
    render(<QueryClientProvider client={qc}><StatusBar /></QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("SYSTEM_STABLE");
      expect(screen.getByTestId("health-dot").className).toContain("bg-success");
    });
  });

  // Test 2: Rig count from summary
  it("shows rig count from summary query", async () => {
    mockConnected();
    const qc = createTestQueryClient();
    render(<QueryClientProvider client={qc}><StatusBar /></QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("rig-count").textContent).toContain("2");
    });
  });

  // Test 3: Disconnected state
  it("shows DISCONNECTED with dashes when health fails", async () => {
    mockDisconnected();
    const qc = createTestQueryClient();
    render(<QueryClientProvider client={qc}><StatusBar /></QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("DISCONNECTED");
      expect(screen.getByTestId("health-dot").className).toContain("bg-tertiary");
      expect(screen.getByTestId("rig-count").textContent).toContain("—");
      expect(screen.getByTestId("cmux-status").textContent).toContain("—");
    });
  });

  // Test 4: Reconnect text transition
  it("transitions from DISCONNECTED to CONNECTED on recovery", async () => {
    // Start disconnected
    mockDisconnected();
    const qc = createTestQueryClient();
    render(<QueryClientProvider client={qc}><StatusBar /></QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("DISCONNECTED");
    });

    // Switch to connected and trigger refetch
    mockConnected();
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["daemon", "health"] });
    });

    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("SYSTEM_STABLE");
    });
  });

  // Test 5: Connected -> disconnected shows dashes (not stale values)
  it("connected->disconnected replaces values with dashes", async () => {
    mockConnected();
    const qc = createTestQueryClient();
    render(<QueryClientProvider client={qc}><StatusBar /></QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("rig-count").textContent).toContain("2");
    });

    // Switch to disconnected and invalidate
    mockDisconnected();
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["daemon", "health"] });
    });

    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("DISCONNECTED");
      expect(screen.getByTestId("rig-count").textContent).toContain("—");
    });
  });

  // Test 6: Reconnect refreshes summary + cmux immediately
  it("reconnect refreshes rig count and cmux", async () => {
    mockDisconnected();
    const qc = createTestQueryClient();
    render(<QueryClientProvider client={qc}><StatusBar /></QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("DISCONNECTED");
      expect(screen.getByTestId("rig-count").textContent).toContain("—");
    });

    // Reconnect
    mockConnected();
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["daemon", "health"] });
    });

    // Rig count and cmux should refresh after reconnect
    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("SYSTEM_STABLE");
      expect(screen.getByTestId("rig-count").textContent).toContain("2");
      expect(screen.getByTestId("cmux-status").textContent).toContain("OK");
    });
  });

  // Test 7: Reconnect pulse — status-changed class on health dot
  it("reconnect applies status-changed class to health dot", async () => {
    mockDisconnected();
    const qc = createTestQueryClient();
    render(<QueryClientProvider client={qc}><StatusBar /></QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("DISCONNECTED");
    });

    // Reconnect
    mockConnected();
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["daemon", "health"] });
    });

    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("SYSTEM_STABLE");
      expect(screen.getByTestId("health-dot").className).toContain("status-changed");
    });
  });
});
