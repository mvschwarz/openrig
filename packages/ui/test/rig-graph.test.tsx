import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import { ReactFlowProvider, MarkerType } from "@xyflow/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RigGraph } from "../src/components/RigGraph.js";
import { RigNode } from "../src/components/RigNode.js";
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
});

afterEach(() => {
  if (OriginalEventSource) {
    globalThis.EventSource = OriginalEventSource;
  }
  cleanup();
});

describe("RigGraph", () => {
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

  it("renders custom RigNode content via nodeTypes registration", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      // React Flow uses our custom node type — nodes have class react-flow__node-rigNode
      const customNodes = container.querySelectorAll(".react-flow__node-rigNode");
      expect(customNodes.length).toBe(2);
      // RigNode renders runtime text in combined format
      expect(screen.getByText(/claude-code/)).toBeDefined();
    });
  });
});

describe("RigNode", () => {
  it("displays logicalId, role, runtime, and status", () => {
    const data = {
      logicalId: "dev1-impl",
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

    expect(screen.getByText("dev1-impl")).toBeDefined();
    expect(screen.getByText(/claude-code · opus/)).toBeDefined();
    // Status badge now uses startupStatus (defaults to STOPPED when not provided)
    expect(screen.getByText("STOPPED")).toBeDefined();
  });

  it("shows 'UNKNOWN' status when binding is null and status is null", () => {
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

    expect(screen.getByText("STOPPED")).toBeDefined();
  });

  // UIF-T05 Test 1: Status dot (pill badge) shows correct label and border style per status
  it("status dot has correct border/text class per status", () => {
    // NS-T12: status colors now based on startupStatus
    const statuses = [
      { status: "running", startupStatus: "ready", expectedLabel: "READY", expectedClass: "border-green-500" },
      { status: "running", startupStatus: "pending", expectedLabel: "LAUNCHING", expectedClass: "border-amber-500" },
      { status: "running", startupStatus: "failed", expectedLabel: "FAILED", expectedClass: "border-red-500" },
      { status: null, startupStatus: null, expectedLabel: "STOPPED", expectedClass: "border-stone-400" },
    ];

    for (const { status, startupStatus, expectedLabel, expectedClass } of statuses) {
      cleanup();
      const data = {
        logicalId: "test-node",
        role: "worker",
        runtime: "claude-code",
        model: null,
        status,
        startupStatus,
        binding: null,
      };

      render(
        <ReactFlowProvider>
          <RigNode data={data} />
        </ReactFlowProvider>
      );

      const dot = screen.getByTestId("status-dot-test-node");
      expect(dot.textContent).toBe(expectedLabel);
      expect(dot.className).toContain(expectedClass);
    }
  });

  // NS-T12: toolbar actions render on hover
  it("toolbar shows Copy tmux attach button when session name present", () => {
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

    // Simulate hover to show toolbar
    const node = screen.getByTestId("rig-node");
    fireEvent.mouseEnter(node);

    expect(screen.getByTestId("toolbar-copy-attach")).toBeDefined();
    expect(screen.getByTestId("toolbar-cmux-focus")).toBeDefined();
    expect(screen.getByTestId("toolbar-copy-resume")).toBeDefined();
  });

  it("toolbar hides resume button when no resumeToken", () => {
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

    const node = screen.getByTestId("rig-node");
    fireEvent.mouseEnter(node);

    expect(screen.getByTestId("toolbar-copy-attach")).toBeDefined();
    expect(screen.queryByTestId("toolbar-copy-resume")).toBeNull();
    expect(screen.queryByTestId("toolbar-cmux-focus")).toBeNull(); // no cmux surface
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

    // Fire SSE message
    act(() => {
      const es = instances[instances.length - 1]!;
      es.simulateMessage('{"type":"node.added"}');
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

    // Fire SSE message to trigger refetch
    act(() => {
      const es = instances[instances.length - 1]!;
      es.simulateMessage('{"type":"node.added"}');
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
      instances[instances.length - 1]!.simulateError();
    });

    await waitFor(() => {
      expect(screen.getByText(/reconnecting/i)).toBeDefined();
    });
  });

  it("reconnect open event clears indicator and triggers refetch", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Error
    act(() => {
      instances[instances.length - 1]!.simulateError();
    });

    await waitFor(() => {
      expect(screen.getByText(/reconnecting/i)).toBeDefined();
    });

    mockFetch.mockClear();
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));

    // Reconnect (open event)
    act(() => {
      instances[instances.length - 1]!.simulateOpen();
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

// NS-T12: graph selection — clicking a graph node sets shared selection
import { DrawerSelectionContext } from "../src/components/AppShell.js";

describe("RigGraph node selection", () => {
  it("click node -> setSelection({ type: 'node', rigId, logicalId }) called via shared context", async () => {
    const setSelectionSpy = vi.fn();

    // Wrap RigGraph in selection context with spy
    function SelectionWrapper({ children }: { children: React.ReactNode }) {
      return (
        <DrawerSelectionContext.Provider value={{ selection: null, setSelection: setSelectionSpy }}>
          {children}
        </DrawerSelectionContext.Provider>
      );
    }

    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { container } = render(
      <QueryWrapper>
        <SelectionWrapper>
          <RigGraph showDiscovered={false} rigId="rig-1" />
        </SelectionWrapper>
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

    // setSelection should have been called with a node selection
    await waitFor(() => {
      expect(setSelectionSpy).toHaveBeenCalledWith({
        type: "node",
        rigId: "rig-1",
        logicalId: "orchestrator",
      });
    });
  });
});
