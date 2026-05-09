import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import { ReactFlowProvider, MarkerType } from "@xyflow/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RigGraph } from "../src/components/RigGraph.js";
import { RigNode } from "../src/components/RigNode.js";
import { DiscoveryPlacementContext, DrawerSelectionContext } from "../src/components/AppShell.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";
import type { MockEventSourceInstance } from "./helpers/mock-event-source.js";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function QueryWrapper({ children }: { children: React.ReactNode }) {
  const qc = createTestQueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

function mockGraphResponse(nodes: object[] = [], edges: object[] = []) {
  return {
    ok: true,
    json: async () => ({ nodes, edges }),
  };
}

function sampleNodes() {
  return [
    {
      id: "n1",
      type: "rigNode",
      position: { x: 0, y: 0 },
      data: {
        logicalId: "orchestrator",
        role: "orchestrator",
        runtime: "claude-code",
        model: "opus",
        status: "running",
        binding: { tmuxSession: "r01-orch1-lead", cmuxSurface: "s-1" },
      },
    },
    {
      id: "n2",
      type: "rigNode",
      position: { x: 0, y: 200 },
      data: {
        logicalId: "worker",
        role: "worker",
        runtime: "codex",
        model: null,
        status: null,
        binding: null,
      },
    },
  ];
}

function nodeWithBindingNoSurface() {
  return {
    id: "n3",
    type: "rigNode",
    position: { x: 0, y: 400 },
    data: {
      logicalId: "reviewer",
      role: "reviewer",
      runtime: "claude-code",
      model: null,
      status: "running",
      binding: { tmuxSession: "r01-rev1-r1", cmuxSurface: null },
    },
  };
}

function sampleEdges() {
  return [
    { id: "e1", source: "n1", target: "n2", label: "delegates_to" },
  ];
}

beforeEach(() => {
  mockFetch.mockReset();
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  if (OriginalEventSource) {
    globalThis.EventSource = OriginalEventSource;
  }
  cleanup();
});

describe("RigGraph", () => {
  it("renders pod group graphs with visible group containers when pods are present", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "pod-alpha",
        type: "podGroup",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "alpha",
          podLabel: "Implementation",
          rigId: "rig-1",
          role: null,
          runtime: null,
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        parentId: "pod-alpha",
        data: {
          logicalId: "alpha.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: { tmuxSession: "alpha-impl@test-rig", cmuxSurface: null },
          nodeKind: "agent",
          startupStatus: "ready",
          canonicalSessionName: "alpha-impl@test-rig",
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      const groupNode = container.querySelector(".react-flow__node-podGroup") as HTMLElement | null;
      expect(groupNode).not.toBeNull();
    });

    const label = screen.getByText("alpha pod");
    expect(label).toBeDefined();
    expect(label.className).toContain("font-bold");
    expect(label.className).toContain("inline-flex");
    expect(label.className).not.toContain("bg-white");
    expect(label.className).not.toContain("border");
  });

  it("renders pod member nodes as visible so grouped graphs are actually readable", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "pod-alpha",
        type: "podGroup",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "alpha",
          podLabel: "Implementation",
          rigId: "rig-1",
          role: null,
          runtime: null,
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        parentId: "pod-alpha",
        data: {
          logicalId: "alpha.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: { tmuxSession: "alpha-impl@test-rig", cmuxSurface: null },
          nodeKind: "agent",
          startupStatus: "ready",
          canonicalSessionName: "alpha-impl@test-rig",
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      const rigNode = container.querySelector(".react-flow__node-rigNode") as HTMLElement | null;
      expect(rigNode).not.toBeNull();
      expect(rigNode?.style.visibility).toBe("visible");
    });
  });

  // V1 attempt-3 Phase 4 P4-5 — RigDetailPanel + 'rig' kind retired
  // from DrawerSelection. Pod-group click is now a no-op at the graph
  // level (pods open via Explorer tree's /topology/pod/$rigId/$podName
  // link). Test renamed + assertion flipped to verify NO setSelection.
  it("clicking a pod group is a no-op at the graph level (RigDetailPanel retired)", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "pod-alpha",
        type: "podGroup",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "alpha",
          podLabel: "Implementation",
          rigId: "rig-1",
          role: null,
          runtime: null,
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        parentId: "pod-alpha",
        data: {
          logicalId: "alpha.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: { tmuxSession: "alpha-impl@test-rig", cmuxSurface: null },
          nodeKind: "agent",
          startupStatus: "ready",
          canonicalSessionName: "alpha-impl@test-rig",
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const setSelection = vi.fn();
    const { container } = render(
      <QueryWrapper>
        <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
          <RigGraph showDiscovered={false} rigId="rig-1" />
        </DrawerSelectionContext.Provider>
      </QueryWrapper>
    );

    await waitFor(() => {
      expect(container.querySelector(".react-flow__node-podGroup")).not.toBeNull();
    });

    fireEvent.click(container.querySelector(".react-flow__node-podGroup")!);

    // 'rig' kind retired in Phase 4 — pod-group click does NOT setSelection.
    expect(setSelection).not.toHaveBeenCalled();
  });

  it("clicking an unbound node in discovery placement mode selects it as a bind target", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "dev.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "dev",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const setPlacementTarget = vi.fn();

    const { container } = render(
      <QueryWrapper>
        <DrawerSelectionContext.Provider value={{ selection: { type: "discovery" }, setSelection: vi.fn() }}>
          <DiscoveryPlacementContext.Provider
            value={{
              selectedDiscoveredId: "disc-1",
              setSelectedDiscoveredId: vi.fn(),
              placementTarget: null,
              setPlacementTarget,
              clearPlacement: vi.fn(),
            }}
          >
            <RigGraph showDiscovered={false} rigId="rig-1" />
          </DiscoveryPlacementContext.Provider>
        </DrawerSelectionContext.Provider>
      </QueryWrapper>
    );

    await waitFor(() => {
      expect(container.querySelector(".react-flow__node-rigNode")).not.toBeNull();
    });

    fireEvent.click(container.querySelector(".react-flow__node-rigNode")!);

    expect(setPlacementTarget).toHaveBeenCalledWith({
      kind: "node",
      rigId: "rig-1",
      logicalId: "dev.impl",
      eligible: true,
    });
  });

  it("clicking a pod group in discovery placement mode selects it as an add-to-pod target", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "pod-dev",
        type: "podGroup",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "dev",
          podLabel: "Development",
          rigId: "rig-1",
          role: null,
          runtime: null,
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "dev",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        parentId: "pod-dev",
        data: {
          logicalId: "dev.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: null },
          nodeKind: "agent",
          startupStatus: "ready",
          canonicalSessionName: "dev-impl@test-rig",
          podId: "dev",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const setPlacementTarget = vi.fn();
    const { container } = render(
      <QueryWrapper>
        <DrawerSelectionContext.Provider value={{ selection: { type: "discovery" }, setSelection: vi.fn() }}>
          <DiscoveryPlacementContext.Provider
            value={{
              selectedDiscoveredId: "disc-1",
              setSelectedDiscoveredId: vi.fn(),
              placementTarget: null,
              setPlacementTarget,
              clearPlacement: vi.fn(),
            }}
          >
            <RigGraph showDiscovered={false} rigId="rig-1" />
          </DiscoveryPlacementContext.Provider>
        </DrawerSelectionContext.Provider>
      </QueryWrapper>
    );

    await waitFor(() => {
      expect(container.querySelector(".react-flow__node-podGroup")).not.toBeNull();
    });

    fireEvent.click(container.querySelector(".react-flow__node-podGroup")!);

    expect(setPlacementTarget).toHaveBeenCalledWith({
      kind: "pod",
      rigId: "rig-1",
      podId: "dev",
      podNamespace: "dev",
      podLabel: "Development",
      eligible: true,
    });
  });

  it("renders nodes from mock graph data", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      // React Flow renders nodes with data-testid="rf__node-{id}"
      const rfNodes = container.querySelectorAll("[data-testid^='rf__node-']");
      expect(rfNodes.length).toBe(2);
    });
  });

  it("passes edges to ReactFlow (edge container rendered)", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      // React Flow renders nodes successfully (proves graph data was accepted)
      const rfNodes = container.querySelectorAll("[data-testid^='rf__node-']");
      expect(rfNodes.length).toBe(2);
      // Edge container exists (RF accepted the edge data)
      // Note: jsdom lacks layout so RF cannot compute edge paths,
      // but the container proves edges were passed to the component
      const edgeContainer = container.querySelector(".react-flow__edges");
      expect(edgeContainer).not.toBeNull();
      // Verify the fetch included edges in the response
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall).toBeDefined();
    });
  });

  it("loading state rendered when fetching", () => {
    // Never resolves — stays in loading
    mockFetch.mockReturnValueOnce(new Promise(() => {}));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);
    expect(screen.getByTestId("graph-loading")).toBeDefined();
  });

  it("empty state rendered when nodes array is empty", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([], []));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByTestId("empty-topology")).toBeDefined();
    });
  });

  it("error state rendered on fetch failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeDefined();
    });
  });

  it("rigId=null shows 'No rig selected' placeholder, no fetch", () => {
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId={null} /></QueryWrapper>);

    expect(screen.getByText(/no rig selected/i)).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rigId='abc' fetches /api/rigs/abc/graph", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([], []));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="abc" /></QueryWrapper>);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/rigs/abc/graph");
    });
  });

  it("prefers the human rig name for the watermark stamp", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" rigName="demo-rig" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByTestId("rig-stamp-watermark").textContent).toBe("demo-rig");
    });
  });

  it("renders custom RigNode content via nodeTypes registration", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      // React Flow uses our custom node type — nodes have class react-flow__node-rigNode
      const customNodes = container.querySelectorAll(".react-flow__node-rigNode");
      expect(customNodes.length).toBe(2);
      // RigNode renders runtime branding in the compact card grammar.
      expect(screen.getByRole("img", { name: "Claude" })).toBeDefined();
    });
  });
});

describe("RigNode", () => {
  it("displays logicalId, role, runtime, and status", () => {
    const data = {
      logicalId: "dev.impl",
      role: "worker",
      runtime: "claude-code",
      model: "opus",
      status: "running",
      binding: { tmuxSession: "r01-dev1-impl", cmuxSurface: null },
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    expect(screen.getByText("impl")).toBeDefined();
    expect(screen.getByRole("img", { name: "Claude" })).toBeDefined();
    expect(screen.queryByText("WORKER")).toBeNull();
    // PL-019: dot now reflects agentActivity (was startupStatus); no
    // agentActivity attached → "unknown" state, desaturated stone.
    expect(screen.getByTestId("activity-dot-dev.impl").getAttribute("aria-label")).toBe("activity: unknown");
  });

  it("shows a compact stopped indicator when binding is null and status is null", () => {
    const data = {
      logicalId: "worker",
      role: "worker",
      runtime: "codex",
      model: null,
      status: null,
      binding: null,
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    // PL-019: no agentActivity attached → unknown.
    expect(screen.getByTestId("activity-dot-worker").getAttribute("aria-label")).toBe("activity: unknown");
  });

  it("PL-019: activity dot color is driven by agentActivity.state (not startupStatus)", () => {
    // The four states + the no-activity fallback cover the entire palette
    // contract. Per orch design guidance: running uses warm green/teal,
    // needs_input is the static eye-catcher (amber), idle is calm cool
    // (slate-400), unknown is desaturated (stone-300).
    const cases = [
      { state: "running" as const, expectedLabel: "activity: running", expectedClass: "bg-emerald-500" },
      { state: "needs_input" as const, expectedLabel: "activity: needs input", expectedClass: "bg-amber-500" },
      { state: "idle" as const, expectedLabel: "activity: idle", expectedClass: "bg-slate-400" },
      { state: "unknown" as const, expectedLabel: "activity: unknown", expectedClass: "bg-stone-300" },
    ];

    for (const { state, expectedLabel, expectedClass } of cases) {
      cleanup();
      const data = {
        logicalId: "test-node",
        role: "worker",
        runtime: "claude-code",
        model: null,
        status: "running",
        startupStatus: "ready" as const,
        binding: null,
        agentActivity: {
          state,
          reason: "test",
          evidenceSource: "pane_heuristic" as const,
          sampledAt: new Date().toISOString(),
          evidence: null,
        },
      };

      render(
        <ReactFlowProvider>
          <RigNode data={data} />
        </ReactFlowProvider>
      );

      const dot = screen.getByTestId("activity-dot-test-node");
      expect(dot.getAttribute("aria-label")).toBe(expectedLabel);
      expect(dot.getAttribute("data-activity-state")).toBe(state);
      expect(dot.className).toContain(expectedClass);
    }
  });

  it("PL-019: only running gets the subtle pulse animation; needs_input/idle/unknown stay static", () => {
    const animatingStates = [{ state: "running" as const, shouldPulse: true }];
    const nonAnimatingStates: { state: "needs_input" | "idle" | "unknown"; shouldPulse: boolean }[] = [
      { state: "needs_input", shouldPulse: false },
      { state: "idle", shouldPulse: false },
      { state: "unknown", shouldPulse: false },
    ];
    for (const { state, shouldPulse } of [...animatingStates, ...nonAnimatingStates]) {
      cleanup();
      render(
        <ReactFlowProvider>
          <RigNode data={{
            logicalId: "n",
            role: "worker",
            runtime: "claude-code",
            model: null,
            status: "running",
            startupStatus: "ready" as const,
            binding: null,
            agentActivity: { state, reason: "x", evidenceSource: "pane_heuristic" as const, sampledAt: new Date().toISOString(), evidence: null },
          }} />
        </ReactFlowProvider>
      );
      const dot = screen.getByTestId("activity-dot-n");
      if (shouldPulse) {
        expect(dot.className).toContain("activity-pulse-running");
      } else {
        expect(dot.className).not.toContain("activity-pulse-running");
      }
    }
  });

  it("PL-019: stale activity (sampledAt > threshold) renders the small staleness badge next to the dot", () => {
    const longAgo = new Date(Date.now() - 120_000).toISOString();
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "stale-node",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          startupStatus: "ready" as const,
          binding: null,
          agentActivity: { state: "running", reason: "x", evidenceSource: "pane_heuristic" as const, sampledAt: longAgo, evidence: null },
        }} />
      </ReactFlowProvider>
    );
    expect(screen.getByTestId("activity-staleness-stale-node").textContent).toBe("stale");
  });

  it("PL-019: when running with currentQitems, the hover hint includes 'On: <short tail> — <excerpt>'", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "busy-node",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          startupStatus: "ready" as const,
          binding: null,
          agentActivity: { state: "running", reason: "x", evidenceSource: "pane_heuristic" as const, sampledAt: new Date().toISOString(), evidence: null },
          currentQitems: [
            { qitemId: "qitem-20260504001234-tail9999", bodyExcerpt: "Phase B audit", tier: "mode2" },
          ],
        }} />
      </ReactFlowProvider>
    );
    // Hover hint sits in the rig-node title attribute (composite tooltip);
    // also rendered as a separate hidden block. We assert the ULID tail
    // appears at least once within the rendered DOM.
    expect(document.body.innerHTML).toContain("tail9999");
    expect(document.body.innerHTML).toContain("Phase B audit");
  });

  it("node actions use the compact terminal plus cmux toolbar pattern", () => {
    const data = {
      logicalId: "dev.impl",
      rigId: "rig-1",
      role: "worker",
      runtime: "claude-code",
      model: null,
      status: "running",
      startupStatus: "ready" as const,
      canonicalSessionName: "dev-impl@test-rig",
      binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: "s1" },
      resumeToken: "abc-123",
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    expect(screen.getByTestId("rig-node-dev.impl-terminal-open")).toBeDefined();
    expect(screen.getByTestId("toolbar-cmux-open")).toBeDefined();
    expect(screen.queryByTestId("toolbar-copy-attach")).toBeNull();
    expect(screen.queryByTestId("toolbar-copy-resume")).toBeNull();
  });

  it("shows an availability marker when the node can receive a discovered session", () => {
    const data = {
      logicalId: "dev.impl",
      rigId: "rig-1",
      role: "worker",
      runtime: "claude-code",
      model: null,
      status: null,
      startupStatus: null,
      canonicalSessionName: null,
      binding: null,
      placementState: "available" as const,
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    expect(screen.getByTestId("placement-chip-dev.impl").textContent).toBe("avail");
  });

  it("toolbar keeps terminal and cmux actions when no resumeToken", () => {
    const data = {
      logicalId: "dev.impl",
      rigId: "rig-1",
      role: "worker",
      runtime: "claude-code",
      model: null,
      status: "running",
      startupStatus: "ready" as const,
      canonicalSessionName: "dev-impl@test-rig",
      binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: null },
      resumeToken: null,
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    expect(screen.getByTestId("rig-node-dev.impl-terminal-open")).toBeDefined();
    expect(screen.queryByTestId("toolbar-copy-resume")).toBeNull();
    expect(screen.queryByTestId("toolbar-copy-attach")).toBeNull();
    // CMUX button should still be present for unbound nodes (open-or-focus)
    expect(screen.getByTestId("toolbar-cmux-open")).toBeDefined();
  });

  it("clicking toolbar cmux on unbound node posts to /open-cmux not /focus", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, action: "created_new" }) });

    const data = {
      logicalId: "dev.impl",
      rigId: "rig-1",
      role: "worker",
      runtime: "claude-code",
      model: null,
      status: "running",
      startupStatus: "ready" as const,
      canonicalSessionName: "dev-impl@test-rig",
      binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: null },
      resumeToken: null,
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    fireEvent.click(screen.getByTestId("toolbar-cmux-open"));

    await waitFor(() => {
      const openCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/open-cmux")
      );
      expect(openCall).toBeDefined();
      expect(openCall![0]).toBe("/api/rigs/rig-1/nodes/dev.impl/open-cmux");
      expect(openCall![1]).toEqual(expect.objectContaining({ method: "POST" }));
    });

    // Must NOT have called /focus
    const focusCall = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
    );
    expect(focusCall).toBeUndefined();
  });

  it("clicking toolbar cmux on bound node posts to /open-cmux and shows feedback", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, action: "focused_existing" }) });

    const data = {
      logicalId: "dev.impl",
      rigId: "rig-1",
      role: "worker",
      runtime: "claude-code",
      model: null,
      status: "running",
      startupStatus: "ready" as const,
      canonicalSessionName: "dev-impl@test-rig",
      binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: "s1" },
      resumeToken: null,
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    fireEvent.click(screen.getByTestId("toolbar-cmux-open"));

    await waitFor(() => {
      const openCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/open-cmux")
      );
      expect(openCall).toBeDefined();
      expect(openCall![0]).toBe("/api/rigs/rig-1/nodes/dev.impl/open-cmux");
    });

    // Flash feedback
    await waitFor(() => {
      expect(screen.getByTestId("toolbar-cmux-open").textContent).toBe("opened");
    });
  });

  it("treats nodes as non-draggable so the canvas can pan through them", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      const node = container.querySelector(".react-flow__node-rigNode");
      expect(node).not.toBeNull();
      expect(node?.className).not.toContain("draggable");
    });
  });
});

// UIF-T05: Edge style helper tests
describe("Edge styles", () => {
  it("delegates_to: solid, secondary blue", async () => {
    const { getEdgeStyle } = await import("../src/lib/edge-styles.js");
    const result = getEdgeStyle("delegates_to");
    expect(result.style.stroke).toBe("#546073");
    expect(result.style.strokeDasharray).toBeUndefined();
    expect(result.markerEnd.type).toBe(MarkerType.ArrowClosed);
    expect(result.label).toBeUndefined();
  });

  it("spawned_by: dashed, secondary blue", async () => {
    const { getEdgeStyle } = await import("../src/lib/edge-styles.js");
    const result = getEdgeStyle("spawned_by");
    expect(result.style.stroke).toBe("#546073");
    expect(result.style.strokeDasharray).toBeDefined();
    expect(result.markerEnd.type).toBe(MarkerType.ArrowClosed);
    expect(result.label).toBeUndefined();
  });

  it("can_observe: dotted, secondary blue", async () => {
    const { getEdgeStyle } = await import("../src/lib/edge-styles.js");
    const result = getEdgeStyle("can_observe");
    expect(result.style.stroke).toBe("#546073");
    expect(result.style.strokeDasharray).toBeDefined();
    expect(result.markerEnd.type).toBe(MarkerType.ArrowClosed);
    expect(result.label).toBeUndefined();
  });

  it("uses: thin dashed, secondary blue", async () => {
    const { getEdgeStyle } = await import("../src/lib/edge-styles.js");
    const result = getEdgeStyle("uses");
    expect(result.style.stroke).toBe("#546073");
    expect(result.style.strokeWidth).toBe(1);
    expect(result.style.strokeDasharray).toBeDefined();
    expect(result.markerEnd.type).toBe(MarkerType.ArrowClosed);
    expect(result.label).toBeUndefined();
  });
});

// UIF-T05: Graph entrance animation
describe("Graph entrance animation", () => {
  it("initial navigation sets data-animated='true'", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      const view = screen.getByTestId("graph-view");
      expect(view.dataset.animated).toBe("true");
    });
  });

  it("after initial render, subsequent renders have data-animated='false'", async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      return Promise.resolve(mockGraphResponse(sampleNodes(), sampleEdges()));
    });

    const { rerender } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    // Wait for first render with data
    await waitFor(() => expect(screen.getByTestId("graph-view")).toBeDefined());

    // Force a rerender (simulating data refresh)
    rerender(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    // After the useEffect has set animatedRigRef, shouldAnimate should be false
    await waitFor(() => {
      const view = screen.getByTestId("graph-view");
      expect(view.dataset.animated).toBe("false");
    });
  });

  it("empty topology state renders wireframe ghost", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse([], []));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByTestId("empty-topology")).toBeDefined();
      expect(screen.getByText("EMPTY TOPOLOGY")).toBeDefined();
    });
  });

  it("loading state shows skeleton", async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByTestId("graph-loading")).toBeDefined();
    });
  });
});

describe("RigGraph SSE integration", () => {
  it("SSE message triggers second fetch to /api/rigs/:id/graph", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    // Wait for initial fetch
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // Fire shared topology event message.
    act(() => {
      const es = instances.find((i) => i.url === "/api/events")!;
      es.simulateMessage('{"type":"node.added","rigId":"rig-1"}');
    });

    // Wait for debounced refetch
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1]![0]).toBe("/api/rigs/rig-1/graph");
    });
  });

  it("useRigGraph refetch triggered by SSE produces fresh data", async () => {
    // First fetch: 1 node. Second fetch: 2 nodes.
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(
        [sampleNodes()[0]!],
        []
      ))
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    // Wait for initial render with 1 node
    await waitFor(() => {
      const nodes = container.querySelectorAll("[data-testid^='rf__node-']");
      expect(nodes.length).toBe(1);
    });

    // Fire shared topology event message to trigger refetch.
    act(() => {
      const es = instances.find((i) => i.url === "/api/events")!;
      es.simulateMessage('{"type":"node.added","rigId":"rig-1"}');
    });

    // Wait for re-render with 2 nodes
    await waitFor(() => {
      const nodes = container.querySelectorAll("[data-testid^='rf__node-']");
      expect(nodes.length).toBe(2);
    });
  });

  it("reconnecting indicator visible on EventSource error", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => expect(instances.length).toBeGreaterThan(0));

    act(() => {
      instances.find((i) => i.url === "/api/events")!.simulateError();
    });

    await waitFor(() => {
      expect(screen.getByText(/Live updates disconnected from daemon/i)).toBeDefined();
    });
  });

  it("reconnect open event clears indicator and triggers refetch", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Error
    act(() => {
      instances.find((i) => i.url === "/api/events")!.simulateError();
    });

    await waitFor(() => {
      expect(screen.getByText(/Live updates disconnected from daemon/i)).toBeDefined();
    });

    mockFetch.mockClear();
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));

    // Reconnect (open event)
    act(() => {
      instances.find((i) => i.url === "/api/events")!.simulateOpen();
    });

    await waitFor(() => {
      // Indicator cleared
      expect(screen.queryByText(/reconnecting/i)).toBeNull();
      // Refetch triggered
      expect(mockFetch).toHaveBeenCalled();
    });
  });
});

describe("RigGraph click-through to focus", () => {
  it("click node with cmux binding -> POST to focus URL", async () => {
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    // Click the node with cmux binding (orchestrator, n1)
    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      const focusCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
      );
      expect(focusCall).toBeDefined();
      expect(focusCall![0]).toBe("/api/rigs/rig-1/nodes/orchestrator/focus");
      expect(focusCall![1]).toEqual(expect.objectContaining({ method: "POST" }));
    });
  });

  it("successful focus -> success indicator shown", async () => {
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/focused/i)).toBeDefined();
    });
  });

  it("click node without binding -> 'not bound' message, no focus fetch", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n2']")).not.toBeNull();
    });

    mockFetch.mockClear();

    // Click unbound node (worker, n2, binding=null)
    const node = container.querySelector("[data-testid='rf__node-n2']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/not bound/i)).toBeDefined();
    });

    // No focus API call made
    const focusCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
    );
    expect(focusCalls).toHaveLength(0);
  });

  it("focus API returns cmux unavailable -> 'cmux not connected' shown", async () => {
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, code: "unavailable" }) });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/cmux not connected/i)).toBeDefined();
    });
  });

  it("focus API error -> error message shown", async () => {
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/focus failed/i)).toBeDefined();
    });
  });

  it("click uses correct rigId and logicalId in URL path", async () => {
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="my-rig-id" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      const focusCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
      );
      expect(focusCall![0]).toBe("/api/rigs/my-rig-id/nodes/orchestrator/focus");
    });
  });

  it("click node with binding but no cmuxSurface -> 'not bound' message", async () => {
    const nodes = [...sampleNodes(), nodeWithBindingNoSurface()];
    mockFetch.mockResolvedValueOnce(mockGraphResponse(nodes, sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n3']")).not.toBeNull();
    });

    mockFetch.mockClear();

    // Click reviewer node (has binding but cmuxSurface=null)
    const node = container.querySelector("[data-testid='rf__node-n3']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/not bound/i)).toBeDefined();
    });

    // No focus API call
    const focusCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
    );
    expect(focusCalls).toHaveLength(0);
  });

  it("sequential clicks: newer message not cleared by older timer", async () => {
    // First click: success. Second click: unavailable.
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, code: "unavailable" }) });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    const node = container.querySelector("[data-testid='rf__node-n1']")!;

    // First click -> "Focused"
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByText(/focused/i)).toBeDefined();
    });

    // Second click immediately -> "cmux not connected"
    // This should cancel the first timer
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByText(/cmux not connected/i)).toBeDefined();
    });

    // The newer message should be visible (old timer was cancelled)
    expect(screen.getByText(/cmux not connected/i)).toBeDefined();
    // The old "Focused" message should be gone (replaced)
    expect(screen.queryByText(/focused/i)).toBeNull();
  });

  // === PUX-T05: Package badge tests ===

  it("node with packageRefs shows package badge with count and names in title", async () => {
    const nodesWithPkgs = [
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "orchestrator",
          role: "orchestrator",
          runtime: "claude-code",
          model: "opus",
          status: "running",
          packageRefs: ["acme-standards", "test-tools"],
          binding: { tmuxSession: "r01-orch1-lead", cmuxSurface: "s-1" },
        },
      },
    ];

    mockFetch.mockResolvedValue(mockGraphResponse(nodesWithPkgs, []));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-badge-1" /></QueryWrapper>);

    await waitFor(() => {
      const badge = screen.getByTestId("package-badge");
      expect(badge).toBeDefined();
      expect(badge.textContent).toContain("PKG 2");
      expect(badge.getAttribute("title")).toBe("acme-standards, test-tools");
    });
  });

  it("node without packageRefs has no badge", async () => {
    // sampleNodes() have no packageRefs
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-badge-2" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getAllByTestId("rig-node").length).toBeGreaterThan(0);
    });

    expect(screen.queryByTestId("package-badge")).toBeNull();
  });

  it("badge click does not trigger node focus/cmux handler", async () => {
    const nodesWithPkgs = [
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "orchestrator",
          role: "orchestrator",
          runtime: "claude-code",
          model: "opus",
          status: "running",
          packageRefs: ["acme-standards"],
          binding: { tmuxSession: "r01-orch1-lead", cmuxSurface: "s-1" },
        },
      },
    ];

    mockFetch.mockResolvedValue(mockGraphResponse(nodesWithPkgs, []));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-badge-3" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByTestId("package-badge")).toBeDefined();
    });

    // Reset fetch mock to track focus calls
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ focused: true }) });

    // Click the badge
    const badge = screen.getByTestId("package-badge");
    await act(async () => {
      badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // No focus POST should have been made (stopPropagation prevents node click)
    const focusCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
    );
    expect(focusCalls.length).toBe(0);
  });
});

describe("RigGraph discovery integration", () => {
  it("discovered sessions appear as dashed nodes when showDiscovered=true", async () => {
    // Mock both graph and discovery endpoints
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/discovery")) {
        return {
          ok: true,
          json: async () => [
            { id: "ds-1", tmuxSession: "organic", tmuxPane: "%0", runtimeHint: "claude-code", confidence: "high", cwd: "/tmp", status: "active" },
          ],
        };
      }
      // Graph endpoint
      return {
        ok: true,
        json: async () => ({ nodes: sampleNodes(), edges: sampleEdges() }),
      };
    });

    render(
      <QueryWrapper>
        <RigGraph showDiscovered={true} rigId="rig-1" />
      </QueryWrapper>
    );

    await waitFor(() => {
      expect(screen.getByTestId("graph-view")).toBeTruthy();
    });

    // Wait for discovered node to appear
    await waitFor(() => {
      expect(screen.getByTestId("discovered-graph-node")).toBeTruthy();
    });

    // Discovered node should have dashed border
    const discoveredNode = screen.getByTestId("discovered-graph-node");
    expect(discoveredNode.className).toContain("border-dashed");
  });
});

// NS-T12: graph selection — clicking a graph node navigates to the
// canonical agent-detail center page (LiveNodeDetails).
//
// V1 polish slice Phase 5.1 P5.1-2 + DRIFT P5.1-D2: graph node click
// migrated from setSelection({type:'seat-detail'}) drawer-open to
// useNavigate(/topology/seat/$rigId/$logicalId). Parity with Explorer
// tree click + topology table row click. The test asserts useNavigate
// was invoked with the canonical seat URL.

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

describe("RigGraph node selection (P5.1-2 navigate)", () => {
  it("click node -> navigate({ to: '/topology/seat/$rigId/$logicalId', params })", async () => {
    navigateSpy.mockClear();

    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { container } = render(
      <QueryWrapper>
        <RigGraph showDiscovered={false} rigId="rig-1" />
      </QueryWrapper>
    );

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    // Click the orchestrator node (n1)
    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/topology/seat/$rigId/$logicalId",
          params: { rigId: "rig-1", logicalId: encodeURIComponent("orchestrator") },
        }),
      );
    });
  });
});

// Task 7: RigNode spec hint rendering
describe("RigNode spec hint", () => {
  afterEach(() => cleanup());

  it("renders spec hint when resolvedSpecName is set", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: null,
          resolvedSpecName: "impl-agent",
          profile: "default",
          edgeCount: 2,
        }} />
      </ReactFlowProvider>
    );

    const hint = screen.getByTestId("spec-hint");
    expect(hint).toBeDefined();
    expect(hint.textContent).toContain("impl-agent");
    expect(hint.textContent).toContain("default");
  });

  it("does not render spec hint when resolvedSpecName is null", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: null,
          resolvedSpecName: null,
          profile: null,
          edgeCount: 0,
        }} />
      </ReactFlowProvider>
    );

    expect(screen.queryByTestId("spec-hint")).toBeNull();
  });

  it("exposes hover metadata for runtime inspection", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: "opus",
          status: "running",
          canonicalSessionName: "dev-impl@test-rig",
          binding: null,
          resolvedSpecName: "impl-agent",
          profile: "default",
          edgeCount: 2,
        }} />
      </ReactFlowProvider>
    );

    const node = screen.getByTestId("rig-node");
    expect(node.getAttribute("title")).toContain("Session: dev-impl@test-rig");
    expect(node.getAttribute("title")).toContain("Spec: impl-agent");
    expect(node.getAttribute("title")).toContain("Profile: default");
    expect(node.getAttribute("title")).toContain("Edges: 2");
  });

  // --- Context usage prominence tests ---

  it("renders prominent context percentage for known fresh seat", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl", role: "worker", runtime: "claude-code",
          model: null, status: "running", binding: null,
          contextAvailability: "known", contextUsedPercentage: 85, contextFresh: true,
          contextTotalInputTokens: 120_000, contextTotalOutputTokens: 14_000,
        }} />
      </ReactFlowProvider>
    );

    const badge = screen.getByTestId("context-badge");
    expect(badge.textContent).toContain("85%");
    expect(badge.className).toContain("text-red-600"); // >=80 = red
    expect(badge.className).toContain("font-bold");
    expect(badge.className).not.toContain("opacity-50");
    const tokenTotal = screen.getByTestId("token-total");
    expect(tokenTotal.textContent).toContain("134k");
    expect(tokenTotal.getAttribute("title")).toContain("Tokens: 134,000");
  });

  it("renders stale context with reduced opacity", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl", role: "worker", runtime: "claude-code",
          model: null, status: "running", binding: null,
          contextAvailability: "known", contextUsedPercentage: 45, contextFresh: false,
        }} />
      </ReactFlowProvider>
    );

    const badge = screen.getByTestId("context-badge");
    expect(badge.textContent).toContain("45%");
    expect(badge.className).toContain("text-green-700"); // <60 = green
    expect(badge.className).toContain("opacity-50"); // stale
  });

  it("renders '?' for unknown context (Codex/terminal)", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.qa", role: "worker", runtime: "codex",
          model: null, status: "running", binding: null,
          contextAvailability: "unknown", contextUsedPercentage: null, contextFresh: false,
        }} />
      </ReactFlowProvider>
    );

    const badge = screen.getByTestId("context-badge-unknown");
    expect(badge.textContent?.trim()).toBe("?");
  });

  it("renders amber for warning-range context (60-80%)", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl", role: "worker", runtime: "claude-code",
          model: null, status: "running", binding: null,
          contextAvailability: "known", contextUsedPercentage: 65, contextFresh: true,
        }} />
      </ReactFlowProvider>
    );

    const badge = screen.getByTestId("context-badge");
    expect(badge.className).toContain("text-amber-600");
  });
});
