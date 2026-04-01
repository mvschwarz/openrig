import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RigDetailPanel } from "../src/components/RigDetailPanel.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function renderPanel(rigId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RigDetailPanel rigId={rigId} onClose={vi.fn()} />
    </QueryClientProvider>
  );
}

describe("RigDetailPanel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: "rig-1", name: "my-rig", nodeCount: 3, latestSnapshotAt: "2026-04-01T10:00:00Z", latestSnapshotId: "snap-1" },
            { id: "rig-2", name: "empty-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
          ],
        });
      }
      if (url === "/api/ps") {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { rigId: "rig-1", name: "my-rig", nodeCount: 3, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: null },
          ],
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders rig name and ID", async () => {
    renderPanel("rig-1");
    expect(await screen.findByText("my-rig")).toBeTruthy();
    expect(screen.getByText("rig-1")).toBeTruthy();
  });

  it("shows node count and status", async () => {
    renderPanel("rig-1");
    expect(await screen.findByText("running")).toBeTruthy();
    expect(screen.getByText("2/3 running")).toBeTruthy();
  });

  it("shows snapshot age when available, not 'No snapshots'", async () => {
    renderPanel("rig-1");
    // Wait for data to load
    await screen.findByText("my-rig");
    const panel = screen.getByTestId("rig-detail-panel");
    // Should show an age indicator (contains "ago" or "< 1m"), not "No snapshots"
    const text = panel.textContent ?? "";
    expect(text).not.toContain("No snapshots");
    expect(text).toMatch(/ago|< 1m/);
  });
});
