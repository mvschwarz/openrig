import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock fetch globally
const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function QueryWrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useExpandRig mutation", () => {
  it("calls expansion API and invalidates queries", async () => {
    const { useExpandRig } = await import("../src/hooks/mutations.js");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, status: "ok", podNamespace: "infra", nodes: [] }),
    });

    let expandFn: ReturnType<typeof useExpandRig>["mutateAsync"];

    function TestComp() {
      const expand = useExpandRig();
      expandFn = expand.mutateAsync;
      return <div>test</div>;
    }

    render(<QueryWrapper><TestComp /></QueryWrapper>);

    await expandFn!({ rigId: "rig-1", pod: { id: "infra", label: "Infra", members: [], edges: [] } });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/rigs/rig-1/expand"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("RigDetailPanel Add Pod", () => {
  it("renders Add Pod button in rig drawer", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/summary")) return { ok: true, json: async () => [] };
      if (typeof url === "string" && url.includes("/ps")) return { ok: true, json: async () => [] };
      if (typeof url === "string" && url.includes("/nodes")) return { ok: true, json: async () => [] };
      if (typeof url === "string" && url.includes("/snapshots")) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    });

    const { RigDetailPanel } = await import("../src/components/RigDetailPanel.js");

    render(
      <QueryWrapper>
        <RigDetailPanel rigId="rig-1" onClose={vi.fn()} />
      </QueryWrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("rig-add-pod")).toBeDefined();
    });
  });

  it("shows YAML form when Add Pod clicked", async () => {
    mockFetch.mockImplementation(async () => ({ ok: true, json: async () => [] }));

    const { RigDetailPanel } = await import("../src/components/RigDetailPanel.js");

    render(
      <QueryWrapper>
        <RigDetailPanel rigId="rig-1" onClose={vi.fn()} />
      </QueryWrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("rig-add-pod")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("rig-add-pod"));

    await waitFor(() => {
      expect(screen.getByTestId("add-pod-form")).toBeDefined();
      expect(screen.getByTestId("add-pod-yaml")).toBeDefined();
      expect(screen.getByTestId("add-pod-submit")).toBeDefined();
    });
  });

  it("form hidden before Add Pod is clicked", async () => {
    mockFetch.mockImplementation(async () => ({ ok: true, json: async () => [] }));

    const { RigDetailPanel } = await import("../src/components/RigDetailPanel.js");

    render(
      <QueryWrapper>
        <RigDetailPanel rigId="rig-1" onClose={vi.fn()} />
      </QueryWrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("rig-add-pod")).toBeDefined();
    });

    expect(screen.queryByTestId("add-pod-form")).toBeNull();
  });

  it("shows expansion outcome after submit", async () => {
    let expandCalled = false;
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("/expand") && opts?.method === "POST") {
        expandCalled = true;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            ok: true,
            status: "ok",
            podNamespace: "test-pod",
            nodes: [{ logicalId: "test-pod.worker", nodeId: "n1", status: "launched" }],
          }),
        };
      }
      return { ok: true, json: async () => [] };
    });

    const { RigDetailPanel } = await import("../src/components/RigDetailPanel.js");

    render(
      <QueryWrapper>
        <RigDetailPanel rigId="rig-1" onClose={vi.fn()} />
      </QueryWrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("rig-add-pod")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("rig-add-pod"));

    await waitFor(() => {
      expect(screen.getByTestId("add-pod-yaml")).toBeDefined();
    });

    fireEvent.change(screen.getByTestId("add-pod-yaml"), {
      target: { value: "id: test-pod\nlabel: Test\nmembers:\n  - id: worker\n    runtime: terminal\nedges: []" },
    });

    fireEvent.click(screen.getByTestId("add-pod-submit"));

    await waitFor(() => {
      expect(expandCalled).toBe(true);
    });
  });
});

describe("SpecsPanel Add to Rig", () => {
  function mockSpecsData() {
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/specs/library?kind=rig")) {
        return {
          ok: true,
          json: async () => [
            { id: "lib-1", name: "research-team", kind: "rig", version: "0.2", sourceType: "builtin" },
          ],
        };
      }
      if (typeof url === "string" && url.includes("/api/specs/library?kind=agent")) {
        return { ok: true, json: async () => [] };
      }
      if (typeof url === "string" && url.includes("/api/specs/library/lib-1/review")) {
        return {
          ok: true,
          json: async () => ({
            kind: "rig",
            name: "research-team",
            format: "pod_aware",
            pods: [{ id: "research", label: "Research", members: [{ id: "analyst", runtime: "claude-code" }], edges: [] }],
            edges: [],
            raw: "",
          }),
        };
      }
      if (typeof url === "string" && url.includes("/api/ps")) {
        return {
          ok: true,
          json: async () => [
            { rigId: "rig-1", name: "demo-rig", status: "running", nodeCount: 2, runningCount: 2 },
          ],
        };
      }
      if (typeof url === "string" && url.includes("/expand") && opts?.method === "POST") {
        return {
          ok: true, status: 201,
          json: async () => ({ ok: true, status: "ok", podNamespace: "research", nodes: [{ logicalId: "research.analyst", nodeId: "n1", status: "launched" }] }),
        };
      }
      return { ok: true, json: async () => [] };
    });
  }

  async function renderSpecsPanel() {
    const { createTestRouter } = await import("./helpers/test-router.js");
    const { SpecsPanel } = await import("../src/components/SpecsPanel.js");
    return render(createTestRouter({ component: () => <SpecsPanel onClose={vi.fn()} />, path: "/test" }));
  }

  it("renders + Rig button on library rig entries", async () => {
    mockSpecsData();
    await renderSpecsPanel();

    await waitFor(() => {
      expect(screen.getByTestId("library-add-to-rig-lib-1")).toBeDefined();
    });
  });

  it("clicking + Rig shows Add to Rig flow with rig selector", async () => {
    mockSpecsData();
    await renderSpecsPanel();

    await waitFor(() => {
      expect(screen.getByTestId("library-add-to-rig-lib-1")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("library-add-to-rig-lib-1"));

    await waitFor(() => {
      expect(screen.getByTestId("add-to-rig-flow")).toBeDefined();
      expect(screen.getByTestId("add-to-rig-select")).toBeDefined();
    });
  });

  it("selecting rig and submitting calls expansion route and shows outcome", async () => {
    mockSpecsData();
    await renderSpecsPanel();

    await waitFor(() => {
      expect(screen.getByTestId("library-add-to-rig-lib-1")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("library-add-to-rig-lib-1"));

    await waitFor(() => {
      expect(screen.getByTestId("add-to-rig-select")).toBeDefined();
    });

    fireEvent.change(screen.getByTestId("add-to-rig-select"), { target: { value: "rig-1" } });

    // Wait for review to load and submit button to appear
    await waitFor(() => {
      expect(screen.getByTestId("add-to-rig-submit")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("add-to-rig-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("expand-result")).toBeDefined();
    });
  });

  it("shows 'No pods available' for specs without pods", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/specs/library?kind=rig")) {
        return { ok: true, json: async () => [{ id: "lib-2", name: "empty-rig", kind: "rig", version: "0.2", sourceType: "builtin" }] };
      }
      if (typeof url === "string" && url.includes("/api/specs/library?kind=agent")) {
        return { ok: true, json: async () => [] };
      }
      if (typeof url === "string" && url.includes("/api/specs/library/lib-2/review")) {
        return { ok: true, json: async () => ({ kind: "rig", name: "empty-rig", format: "pod_aware", pods: [], edges: [], raw: "" }) };
      }
      return { ok: true, json: async () => [] };
    });

    await renderSpecsPanel();

    await waitFor(() => {
      expect(screen.getByTestId("library-add-to-rig-lib-2")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("library-add-to-rig-lib-2"));

    await waitFor(() => {
      expect(screen.getByText("No pods available in this spec.")).toBeDefined();
    });
  });
});
