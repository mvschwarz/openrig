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
      if (url.includes("/snapshots")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: "01HXYZ123456SNAP01", kind: "manual", createdAt: "2026-04-01T10:00:00Z" },
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

  it("renders snapshot list with short IDs and full IDs accessible", async () => {
    renderPanel("rig-1");
    // Wait for snapshots to load
    await screen.findByText("my-rig");
    // Short ID (ULID tail)
    expect(screen.getByTestId("snap-short-01HXYZ123456SNAP01")).toBeDefined();
    // Full ID accessible as secondary text
    expect(screen.getByTestId("snap-full-01HXYZ123456SNAP01")).toBeDefined();
    expect(screen.getByTestId("snap-full-01HXYZ123456SNAP01").textContent).toBe("01HXYZ123456SNAP01");
  });

  it("Create Snapshot button is present", async () => {
    renderPanel("rig-1");
    await screen.findByText("my-rig");
    expect(screen.getByTestId("create-snapshot")).toBeDefined();
  });

  it("full rig ID is accessible as secondary text", async () => {
    renderPanel("rig-1");
    await screen.findByText("my-rig");
    expect(screen.getByTestId("rig-full-id").textContent).toBe("rig-1");
  });

  it("restore confirm flow triggers mutation", async () => {
    // Add restore endpoint mock
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/rigs/summary") return Promise.resolve({ ok: true, json: async () => [{ id: "rig-1", name: "my-rig", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }] });
      if (url === "/api/ps") return Promise.resolve({ ok: true, json: async () => [{ rigId: "rig-1", name: "my-rig", nodeCount: 2, runningCount: 1, status: "running", uptime: "1h", latestSnapshot: null }] });
      if (url.includes("/restore/") && opts?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ nodes: [{ nodeId: "n1", logicalId: "dev.impl", status: "resumed" }, { nodeId: "n2", logicalId: "dev.qa", status: "fresh" }] }) });
      }
      if (url.includes("/snapshots")) return Promise.resolve({ ok: true, json: async () => [{ id: "01HXYZ123456SNAP01", kind: "manual", createdAt: "2026-04-01T10:00:00Z" }] });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");
    await screen.findByText("my-rig");
    const { fireEvent, waitFor } = await import("@testing-library/react");

    // Click restore, then confirm
    fireEvent.click(screen.getByTestId("restore-btn-01HXYZ123456SNAP01"));
    await screen.findByText("Confirm Restore");
    fireEvent.click(screen.getByTestId("confirm-restore-01HXYZ123456SNAP01"));

    // Wait for restore result with per-node status and color classes
    await waitFor(() => {
      expect(screen.getByTestId("restore-result")).toBeDefined();
      const resumed = screen.getByTestId("restore-status-dev.impl");
      expect(resumed.textContent).toBe("resumed");
      expect(resumed.className).toContain("text-success");
      const fresh = screen.getByTestId("restore-status-dev.qa");
      expect(fresh.textContent).toBe("fresh");
      expect(fresh.className).toContain("text-foreground-muted");
    });
  });

  it("restore button opens confirm dialog", async () => {
    renderPanel("rig-1");
    await screen.findByText("my-rig");
    // Click restore on the snapshot
    const restoreBtn = screen.getByTestId("restore-btn-01HXYZ123456SNAP01");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(restoreBtn);
    // Confirm dialog should appear
    expect(await screen.findByText("Confirm Restore")).toBeDefined();
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
