// V1 polish slice Phase 5.1 P5.1-7 — TopologyTableView CMUX column +
// row click navigation regression guard.
//
// Founder direction at V1 founder-walk:
// > "[Table view] is missing some columns... missing the CMUX button
// > where you can basically click a button to launch cmux. Also you
// > should be able to click one of the agents and it should open up
// > the agent detail page."

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
  });

  it("CMUX button click POSTs to /api/rigs/.../focus (existing useCmuxLaunch hook)", async () => {
    const { findByTestId } = withQueryClient(<TopologyTableView />);
    const cmux = await findByTestId("topology-table-cmux-orch.lead");
    fireEvent.click(cmux);
    await waitFor(() => {
      const focusCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus"),
      );
      expect(focusCall).toBeDefined();
      expect(focusCall![0]).toBe("/api/rigs/rig-1/nodes/orch.lead/focus");
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
