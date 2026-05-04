// Workflows in Spec Library + Activation Lens v0 — lens consumption.
//
// Verifies that SliceExplorerPanel reads /api/specs/library/active-lens,
// passes boundToWorkflow=<name>:<version> to /api/slices when a lens is
// active, renders the lens indicator + Clear button + Show All toggle.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { SliceExplorerPanel } from "../src/components/slices/SliceExplorerPanel.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }) as unknown as Response;
}

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
});

afterEach(() => cleanup());

describe("SliceExplorerPanel — active lens consumption (Workflows in Spec Library v0)", () => {
  it("does not render the lens indicator when no lens is active", async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/specs/library/active-lens")) {
        return jsonResponse({ activeLens: null });
      }
      return jsonResponse({ slices: [], totalCount: 0, filter: "active" });
    });

    render(createTestRouter({ component: () => <SliceExplorerPanel />, path: "/slices" }));

    await waitFor(() => expect(screen.getByTestId("slice-list-pane")).toBeDefined());
    expect(screen.queryByTestId("slice-lens-indicator")).toBeNull();
  });

  it("renders lens indicator + sends boundToWorkflow to /api/slices when lens is active", async () => {
    const sliceCalls: string[] = [];
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/specs/library/active-lens")) {
        return jsonResponse({
          activeLens: { specName: "rsi-v2-hot-potato", specVersion: "1", activatedAt: "2026-05-04T00:00:00Z" },
        });
      }
      if (url.includes("/api/slices")) {
        sliceCalls.push(url);
        return jsonResponse({
          slices: [{
            name: "alpha", displayName: "Alpha", railItem: null, status: "active", rawStatus: "active",
            qitemCount: 1, hasProofPacket: false, lastActivityAt: "2026-05-04T00:00:00Z",
          }],
          totalCount: 1,
          filter: "active",
          boundToWorkflow: { specName: "rsi-v2-hot-potato", specVersion: "1", matched: 1, total: 5 },
        });
      }
      return jsonResponse({});
    });

    render(createTestRouter({ component: () => <SliceExplorerPanel />, path: "/slices" }));

    await waitFor(() => expect(screen.getByTestId("slice-lens-indicator")).toBeDefined());
    expect(screen.getByTestId("slice-lens-indicator").textContent).toContain("rsi-v2-hot-potato");
    expect(screen.getByTestId("slice-lens-indicator").textContent).toContain("v1");

    await waitFor(() => {
      expect(sliceCalls.some((u) => u.includes("boundToWorkflow=rsi-v2-hot-potato%3A1") || u.includes("boundToWorkflow=rsi-v2-hot-potato:1"))).toBe(true);
    });
  });

  it("Show All toggle clears the boundToWorkflow filter param", async () => {
    const sliceCalls: string[] = [];
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/specs/library/active-lens")) {
        return jsonResponse({
          activeLens: { specName: "rsi", specVersion: "1", activatedAt: "2026-05-04T00:00:00Z" },
        });
      }
      if (url.includes("/api/slices")) {
        sliceCalls.push(url);
        return jsonResponse({ slices: [], totalCount: 0, filter: "active" });
      }
      return jsonResponse({});
    });

    render(createTestRouter({ component: () => <SliceExplorerPanel />, path: "/slices" }));

    await waitFor(() => expect(screen.getByTestId("slice-lens-show-all-toggle")).toBeDefined());

    sliceCalls.length = 0;
    fireEvent.click(screen.getByTestId("slice-lens-show-all-toggle"));

    await waitFor(() => {
      // After toggle, expect at least one slice fetch without boundToWorkflow
      expect(sliceCalls.some((u) => !u.includes("boundToWorkflow"))).toBe(true);
    });
  });

  it("Clear button calls DELETE /api/specs/library/active-lens", async () => {
    let deleteCalled = false;
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/specs/library/active-lens")) {
        if (init?.method === "DELETE") {
          deleteCalled = true;
          return jsonResponse({ activeLens: null });
        }
        return jsonResponse({
          activeLens: { specName: "rsi", specVersion: "1", activatedAt: "2026-05-04T00:00:00Z" },
        });
      }
      if (url.includes("/api/slices")) {
        return jsonResponse({ slices: [], totalCount: 0, filter: "active" });
      }
      return jsonResponse({});
    });

    render(createTestRouter({ component: () => <SliceExplorerPanel />, path: "/slices" }));

    await waitFor(() => expect(screen.getByTestId("slice-lens-clear")).toBeDefined());
    fireEvent.click(screen.getByTestId("slice-lens-clear"));

    await waitFor(() => expect(deleteCalled).toBe(true));
  });
});
