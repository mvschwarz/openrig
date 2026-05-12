// V1 polish slice Phase 5.1 P5.1-7: TopologyTableView CMUX column +
// row click navigation regression guard.
//
// The table requires a cmux launch affordance and row-click
// navigation to the agent detail page.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) {
      return new Response(JSON.stringify([{ id: "rig-1", name: "test-rig" }]));
    }
    if (url.includes("/open-cmux")) {
      return new Response(JSON.stringify({ ok: true, action: "created_new" }));
    }
    if (url.includes("/api/rigs/rig-1/nodes")) {
      return new Response(
        JSON.stringify([
          {
            rigId: "rig-1",
            rigName: "test-rig",
            logicalId: "orch.lead",
            podId: "orch",
            podNamespace: "orch",
            canonicalSessionName: "orch-lead@test-rig",
            nodeKind: "agent",
            runtime: "claude-code",
            sessionStatus: "running",
            startupStatus: "ready",
            contextUsage: {
              usedPercentage: 42,
              remainingPercentage: 58,
              contextWindowSize: 320000,
              availability: "known",
              sampledAt: "2026-05-09T10:00:00Z",
              fresh: true,
              totalInputTokens: 120000,
              totalOutputTokens: 14000,
            },
            restoreOutcome: "n-a",
            tmuxAttachCommand: null,
            resumeCommand: null,
            latestError: null,
          },
        ]),
      );
    }
    return new Response("[]");
  });
});

afterEach(() => {
  cleanup();
});

function withQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("TopologyTableView P5.1-7 CMUX column + row click", () => {
  it("renders the actions column with a CMUX button per agent row", async () => {
    const { findByTestId } = withQueryClient(<TopologyTableView />);
    const cmux = await findByTestId("topology-table-cmux-orch.lead");
    expect(cmux).toBeTruthy();
    expect((cmux as HTMLButtonElement).textContent).toContain("CMUX");
    expect((cmux as HTMLButtonElement).className).not.toContain("opacity-0");
  });

  it("renders context percentage and token total from node inventory", async () => {
    const { findByTestId } = withQueryClient(<TopologyTableView />);
    const context = await findByTestId("topology-table-context-orch.lead");
    const tokens = await findByTestId("topology-table-tokens-orch.lead");
    expect(context.textContent).toBe("42%");
    expect(tokens.textContent).toBe("134k");
    expect(tokens.getAttribute("title")).toContain("Tokens: 134,000");
  });

  it("CMUX button click POSTs to /api/rigs/.../open-cmux (open-or-create launcher)", async () => {
    const { findByTestId } = withQueryClient(<TopologyTableView />);
    const cmux = await findByTestId("topology-table-cmux-orch.lead");
    fireEvent.click(cmux);
    await waitFor(() => {
      const openCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/open-cmux"),
      );
      expect(openCall).toBeDefined();
      expect(openCall![0]).toBe("/api/rigs/rig-1/nodes/orch.lead/open-cmux");
    });
  });

  it("CMUX button click does NOT trigger row navigation (stopPropagation)", async () => {
    const { findByTestId } = withQueryClient(<TopologyTableView />);
    const cmux = await findByTestId("topology-table-cmux-orch.lead");
    fireEvent.click(cmux);
    // Allow one tick for any propagation that wasn't stopped.
    await new Promise((r) => setTimeout(r, 10));
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("row click (away from action button) navigates to /topology/seat/$rigId/$logicalId", async () => {
    const { findByTestId } = withQueryClient(<TopologyTableView />);
    const row = await findByTestId("topology-table-row-orch.lead");
    fireEvent.click(row);
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/topology/seat/$rigId/$logicalId",
          params: {
            rigId: "rig-1",
            logicalId: encodeURIComponent("orch.lead"),
          },
        }),
      );
    });
  });
});
