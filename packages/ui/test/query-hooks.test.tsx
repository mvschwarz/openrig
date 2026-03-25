import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRigSummary } from "../src/hooks/useRigSummary.js";
import { useRigGraph } from "../src/hooks/useRigGraph.js";
import { useSnapshots } from "../src/hooks/useSnapshots.js";
import { useCreateSnapshot, useRestoreSnapshot, useImportRig } from "../src/hooks/mutations.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

let qc: QueryClient;

beforeEach(() => {
  mockFetch.mockReset();
  qc = createTestQueryClient();
});

afterEach(() => { cleanup(); });

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// Test harness for useRigSummary
function SummaryHarness() {
  const { data, isPending, error } = useRigSummary();
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">data: {data?.length}</div>;
}

// Test harness for useRigGraph
function GraphHarness({ rigId }: { rigId: string }) {
  const { data, isPending, error } = useRigGraph(rigId);
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">nodes: {data?.nodes.length}</div>;
}

// Test harness for useSnapshots
function SnapshotsHarness({ rigId }: { rigId: string }) {
  const { data, isPending, error } = useSnapshots(rigId);
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">snaps: {data?.length}</div>;
}

// Mutation test harnesses
function CreateSnapshotHarness({ rigId }: { rigId: string }) {
  const mutation = useCreateSnapshot(rigId);
  return (
    <div>
      <button data-testid="create" onClick={() => mutation.mutate()}>Create</button>
      <span data-testid="status">{mutation.isPending ? "pending" : mutation.isSuccess ? "success" : "idle"}</span>
    </div>
  );
}

function RestoreHarness({ rigId }: { rigId: string }) {
  const mutation = useRestoreSnapshot(rigId);
  return (
    <div>
      <button data-testid="restore" onClick={() => mutation.mutate("snap-1")}>Restore</button>
      <span data-testid="status">{mutation.isPending ? "pending" : mutation.isSuccess ? "success" : "idle"}</span>
    </div>
  );
}

function ImportHarness() {
  const mutation = useImportRig();
  return (
    <div>
      <button data-testid="import" onClick={() => mutation.mutate("yaml content")}>Import</button>
      <span data-testid="status">{mutation.isPending ? "pending" : mutation.isSuccess ? "success" : "idle"}</span>
    </div>
  );
}

describe("TanStack Query hooks", () => {
  // Test 1: QueryClientProvider wraps app — component can useQuery
  it("component can use useQuery within QueryClientProvider", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    render(<Wrapper><SummaryHarness /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("data: 0"));
  });

  // Test 2: useRigSummary returns summary data
  it("useRigSummary returns summary data with loading/success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "r1", name: "alpha", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null }],
    });
    render(<Wrapper><SummaryHarness /></Wrapper>);

    // Initially pending
    expect(screen.getByTestId("state").textContent).toBe("pending");

    // Then data
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("data: 1"));
  });

  // Test 3: useRigGraph returns graph data
  it("useRigGraph returns graph data for specific rigId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ nodes: [{ id: "n1" }, { id: "n2" }], edges: [] }),
    });
    render(<Wrapper><GraphHarness rigId="r1" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("nodes: 2"));
    expect(mockFetch).toHaveBeenCalledWith("/api/rigs/r1/graph");
  });

  // Test 4: useSnapshots returns snapshot list
  it("useSnapshots returns snapshot list for rigId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    });
    render(<Wrapper><SnapshotsHarness rigId="r1" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("snaps: 3"));
    expect(mockFetch).toHaveBeenCalledWith("/api/rigs/r1/snapshots");
  });

  // Test 5: SSE event triggers graph invalidation — covered in rig-events.test.tsx

  // Test 6: useCreateSnapshot mutation invalidates snapshot list
  it("useCreateSnapshot invalidates snapshot query on success", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "snap-new" }) });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><CreateSnapshotHarness rigId="r1" /></Wrapper>);
    act(() => { screen.getByTestId("create").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rig", "r1", "snapshots"] });
  });

  // Test 7: useRestoreSnapshot mutation invalidates rig data
  it("useRestoreSnapshot invalidates rig query on success", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><RestoreHarness rigId="r1" /></Wrapper>);
    act(() => { screen.getByTestId("restore").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rig", "r1"] });
  });

  // Test 8: Error state propagates from failed query
  it("error state propagates from failed query", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    render(<Wrapper><SummaryHarness /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId("state").textContent).toContain("error"));
  });

  // Test 9: useCreateSnapshot invalidates BOTH snapshots AND summary
  it("useCreateSnapshot invalidates both snapshots and summary queries", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "snap-new" }) });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><CreateSnapshotHarness rigId="r1" /></Wrapper>);
    act(() => { screen.getByTestId("create").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));

    const calls = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls).toContain(JSON.stringify({ queryKey: ["rig", "r1", "snapshots"] }));
    expect(calls).toContain(JSON.stringify({ queryKey: ["rigs", "summary"] }));
  });

  // Test 10: useImportRig invalidates summary query after successful instantiate
  it("useImportRig invalidates summary query on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rigId: "new-rig", specName: "test", nodes: [] }),
    });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><ImportHarness /></Wrapper>);
    act(() => { screen.getByTestId("import").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rigs", "summary"] });
  });
});
