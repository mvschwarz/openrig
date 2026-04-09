import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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

  it("renders rig name and condensed ID", async () => {
    renderPanel("rig-1");
    expect(await screen.findByText("my-rig")).toBeTruthy();
    expect(screen.getByTestId("rig-id-value").textContent).toBe("rig-1");
    expect(screen.queryByTestId("rig-full-id")).toBeNull();
  });

  it("shows node count and status", async () => {
    renderPanel("rig-1");
    expect(await screen.findByText("2/3 running")).toBeTruthy();
    expect(screen.getByTestId("rig-uptime").textContent).toBe("1h");
  });

  it("exposes rig actions in the rig drawer", async () => {
    renderPanel("rig-1");
    await screen.findByText("my-rig");
    expect(screen.getByTestId("rig-export-spec")).toBeDefined();
    expect(screen.getByTestId("rig-create-snapshot")).toBeDefined();
    expect(screen.getByTestId("rig-power-action")).toBeDefined();
  });

  it("renders the latest snapshot with a short ID", async () => {
    renderPanel("rig-1");
    await screen.findByText("my-rig");
    expect(screen.getByTestId("snap-short-01HXYZ123456SNAP01")).toBeDefined();
    expect(screen.queryByTestId("snap-full-01HXYZ123456SNAP01")).toBeNull();
  });

  it("Create Snapshot button is present", async () => {
    renderPanel("rig-1");
    await screen.findByText("my-rig");
    expect(screen.getByTestId("rig-create-snapshot")).toBeDefined();
  });

  it("emphasizes the short rig ID tail in identity", async () => {
    renderPanel("rig-1");
    await screen.findByText("my-rig");
    expect(screen.getByTestId("rig-id-tail").textContent).toBe("rig-1");
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

  it("shows actionable guidance when restore requires the rig to be stopped", async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: "rig-1", name: "my-rig", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }],
        });
      }
      if (url === "/api/ps") {
        return Promise.resolve({
          ok: true,
          json: async () => [{ rigId: "rig-1", name: "my-rig", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: null }],
        });
      }
      if (url.includes("/restore/") && opts?.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: "Rig rig-1 must be stopped before restore", code: "rig_not_stopped" }),
        });
      }
      if (url.includes("/snapshots")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: "01HXYZ123456SNAP01", kind: "manual", createdAt: "2026-04-01T10:00:00Z" }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");
    await screen.findByText("my-rig");
    const { fireEvent } = await import("@testing-library/react");

    fireEvent.click(screen.getByTestId("restore-btn-01HXYZ123456SNAP01"));
    await screen.findByText("Confirm Restore");
    fireEvent.click(screen.getByTestId("confirm-restore-01HXYZ123456SNAP01"));

    expect((await screen.findByTestId("snapshot-error")).textContent).toContain("rig down my-rig");
  });

  it("drawer shows Info | Chat Room tabs", async () => {
    renderPanel("rig-1");
    await screen.findByText("my-rig");
    expect(screen.getByTestId("drawer-tabs")).toBeDefined();
    expect(screen.getByTestId("tab-info")).toBeDefined();
    expect(screen.getByTestId("tab-chat")).toBeDefined();
    expect(screen.getByTestId("tab-info").textContent).toContain("Info");
    expect(screen.getByTestId("tab-chat").textContent).toContain("Chat Room");
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

  it("shows a pod summary with human-friendly pod names", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: "rig-1", name: "my-rig", nodeCount: 3, latestSnapshotAt: "2026-04-01T10:00:00Z", latestSnapshotId: "snap-1" },
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
      if (url === "/api/rigs/rig-1/nodes") {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { rigId: "rig-1", rigName: "my-rig", logicalId: "orch.lead", podId: "orch", nodeKind: "agent", runtime: "claude-code", startupStatus: "ready", canonicalSessionName: "orch-lead@my-rig" },
            { rigId: "rig-1", rigName: "my-rig", logicalId: "dev.impl", podId: "dev", nodeKind: "agent", runtime: "claude-code", startupStatus: "ready", canonicalSessionName: "dev-impl@my-rig" },
            { rigId: "rig-1", rigName: "my-rig", logicalId: "dev.qa", podId: "dev", nodeKind: "agent", runtime: "codex", startupStatus: "pending", canonicalSessionName: "dev-qa@my-rig" },
          ],
        });
      }
      if (url.includes("/snapshots")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: "01HXYZ123456SNAP01", kind: "manual", createdAt: "2026-04-01T10:00:00Z" }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");
    await screen.findByText("my-rig");

    expect(await screen.findByText("Pods")).toBeTruthy();
    expect(screen.getByText("orch")).toBeTruthy();
    expect(screen.getByText("dev")).toBeTruthy();
    expect(screen.getByText("impl")).toBeTruthy();
    expect(screen.getByText("qa")).toBeTruthy();
  });

  it("shows Env tab for service-backed rigs with service health and surfaces", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve({ ok: true, json: async () => [{ id: "rig-1", name: "my-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }] });
      }
      if (url === "/api/ps") {
        return Promise.resolve({ ok: true, json: async () => [{ rigId: "rig-1", name: "my-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "5m" }] });
      }
      if (url === "/api/rigs/rig-1/nodes") {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/snapshots")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === "/api/rigs/rig-1/env") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            hasServices: true,
            kind: "compose",
            composeFile: "/tmp/svc.compose.yaml",
            projectName: "test-svc",
            receipt: {
              kind: "compose",
              composeFile: "/tmp/svc.compose.yaml",
              projectName: "test-svc",
              services: [{ name: "vault", status: "running", health: "healthy" }],
              waitFor: [{ target: { url: "http://127.0.0.1:8200/health" }, status: "healthy" }],
              capturedAt: "2026-04-09T12:00:00Z",
            },
            surfaces: {
              urls: [{ name: "Vault UI", url: "http://127.0.0.1:8200/ui" }],
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");
    await screen.findByText("my-rig");

    // Env tab should exist between Info and Chat
    expect(screen.getByTestId("tab-env")).toBeDefined();
    expect(screen.getByTestId("tab-info")).toBeDefined();
    expect(screen.getByTestId("tab-chat")).toBeDefined();

    // Click Env tab
    fireEvent.click(screen.getByTestId("tab-env"));

    await waitFor(() => {
      // Overall env state
      const envState = screen.getByTestId("env-state");
      expect(envState).toBeDefined();
      expect(envState.textContent).toContain("Healthy");
      // Service health
      expect(screen.getByText("vault")).toBeDefined();
      // Surface URL
      expect(screen.getByText("Vault UI")).toBeDefined();
    });
  });

  it("does not show Env tab for non-service rigs", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve({ ok: true, json: async () => [{ id: "rig-2", name: "plain-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }] });
      }
      if (url === "/api/ps") {
        return Promise.resolve({ ok: true, json: async () => [{ rigId: "rig-2", name: "plain-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "5m" }] });
      }
      if (url === "/api/rigs/rig-2/env") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, hasServices: false }) });
      }
      if (url.includes("/snapshots")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-2");
    await screen.findByText("plain-rig");

    expect(screen.getByTestId("tab-info")).toBeDefined();
    expect(screen.getByTestId("tab-chat")).toBeDefined();
    expect(screen.queryByTestId("tab-env")).toBeNull();
  });

  it("keeps Env tab visible for service-backed rigs while env status is still loading", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: "rig-1", name: "my-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null, hasServices: true }],
        });
      }
      if (url === "/api/ps") {
        return Promise.resolve({
          ok: true,
          json: async () => [{ rigId: "rig-1", name: "my-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "5m" }],
        });
      }
      if (url === "/api/rigs/rig-1/nodes") {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes("/snapshots")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === "/api/rigs/rig-1/env") {
        return new Promise(() => {}) as Promise<Response>;
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");
    await screen.findByText("my-rig");

    expect(screen.getByTestId("tab-info")).toBeDefined();
    expect(screen.getByTestId("tab-chat")).toBeDefined();
    expect(screen.getByTestId("tab-env")).toBeDefined();
  });
});
