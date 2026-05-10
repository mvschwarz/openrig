import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { DiscoveredSession } from "../src/hooks/useDiscovery.js";
import { createTestRouter } from "./helpers/test-router.js";
import { DiscoveryPanel } from "../src/components/DiscoveryPanel.js";

const mockUseDiscoveredSessions = vi.fn();
const mockUseDiscoveryScan = vi.fn();
const mockUseAdoptSession = vi.fn();

vi.mock("../src/hooks/useDiscovery.js", async () => {
  const actual = await vi.importActual("../src/hooks/useDiscovery.js");
  return {
    ...actual,
    useDiscoveredSessions: (...args: unknown[]) => mockUseDiscoveredSessions(...args),
    useDiscoveryScan: () => mockUseDiscoveryScan(),
    useAdoptSession: () => mockUseAdoptSession(),
  };
});

const SESSIONS: DiscoveredSession[] = [
  {
    id: "ds-1",
    tmuxSession: "proof-ui-add-pod",
    tmuxWindow: "0",
    tmuxPane: "%7",
    pid: 111,
    cwd: "/Users/example/code/openrig",
    activeCommand: "codex",
    runtimeHint: "codex",
    confidence: "high",
    evidenceJson: null,
    configJson: null,
    status: "active",
    claimedNodeId: null,
    firstSeenAt: "2026-04-02 10:00:00",
    lastSeenAt: "2026-04-02 10:05:00",
  },
];

function renderPanel(props?: {
  selectedDiscoveredId?: string | null;
  placementTarget?: import("../src/components/DiscoveryPanel.js").DiscoveryPlacementTarget;
}) {
  return render(
    createTestRouter({
      path: "/rigs/$rigId",
      initialPath: "/rigs/rig-1",
      component: () => (
        <DiscoveryPanel
          onClose={vi.fn()}
          selectedDiscoveredId={props?.selectedDiscoveredId ?? null}
          onSelectDiscoveredId={vi.fn()}
          placementTarget={props?.placementTarget ?? null}
          onClearPlacement={vi.fn()}
        />
      ),
    })
  );
}

describe("DiscoveryPanel", () => {
  beforeEach(() => {
    mockUseDiscoveredSessions.mockReturnValue({ data: SESSIONS });
    mockUseDiscoveryScan.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseAdoptSession.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the inventory link and no global placement status banner", async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("discovery-panel")).toBeDefined();
    });

    expect(screen.getByTestId("discovery-open-inventory")).toBeDefined();
    expect(screen.getByTestId("discovery-open-inventory").textContent).toBe("Legacy Inventory Page");
    expect(screen.queryByTestId("discovery-placement-status")).toBeNull();
  });

  it("renders placement feedback inside the selected session card", async () => {
    renderPanel({
      selectedDiscoveredId: "ds-1",
      placementTarget: {
        kind: "pod",
        rigId: "rig-1",
        podId: "intake",
        podNamespace: "intake",
        podLabel: "intake",
        eligible: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("discovery-session-ds-1")).toBeDefined();
    });

    expect(screen.getByTestId("discovery-selected-session-status").textContent).toContain("proof-ui-add-pod");
    expect(screen.getByTestId("discovery-target-summary").textContent).toContain("intake");
    expect(screen.getByTestId("discovery-member-name-input")).toBeDefined();
  });

  it("shows friendly node names instead of raw logical ids in the target summary", async () => {
    renderPanel({
      selectedDiscoveredId: "ds-1",
      placementTarget: {
        kind: "node",
        rigId: "rig-1",
        logicalId: "research.mapper",
        eligible: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("discovery-target-summary")).toBeDefined();
    });

    expect(screen.getByTestId("discovery-selected-session-status").textContent).toContain("mapper");
    expect(screen.getByTestId("discovery-target-summary").textContent).toBe("mapper selected");
    expect(screen.getByTestId("discovery-target-summary").textContent).not.toContain("research.mapper");
  });
});
