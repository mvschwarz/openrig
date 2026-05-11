// V0.3.1 slice 17 walk-item 8 forward-fix #2 — focus-refetch regression test.
//
// The Explorer sidebar's auto-show behavior on window focus requires
// useFilesList + useSlices to refetch when the operator switches away
// and back, even if the last fetch was very recent. With staleTime
// configured (15s for files, 30s for slices) AND
// refetchOnWindowFocus: true (the slice 17 initial impl), react-query
// gates the refetch on staleness — a refocus within the stale window
// produces no refetch, which is exactly what velocity-qa observed in
// the VM verify proof.
//
// Fix: `refetchOnWindowFocus: 'always'` bypasses staleness. This test
// asserts the focus-triggered refetch fires regardless of staleness.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useFilesList } from "../src/hooks/useFiles.js";
import { useSlices } from "../src/hooks/useSlices.js";

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

function makeWrapper() {
  // Use the same staleTime defaults the production QueryClient ships
  // with so the test discriminates against the same gating predicate
  // production hits.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  // Start focused so the initial query mount fires normally.
  focusManager.setFocused(true);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("useFilesList focus-refetch (walk-item 8 forward-fix #2)", () => {
  it("refetches on focus regardless of staleTime (refetchOnWindowFocus: 'always')", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({
        root: "workspace",
        path: "missions",
        entries: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const { result } = renderHook(
      () => useFilesList("workspace", "missions"),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const initialCallCount = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).startsWith("/api/files/list"),
    ).length;
    expect(initialCallCount).toBe(1);

    // Simulate tab blur + focus WITHIN the staleTime window. With
    // refetchOnWindowFocus: true (pre-fix), this would be no-op.
    // With 'always' (post-fix), a second fetch fires.
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(
        (c) => String(c[0]).startsWith("/api/files/list"),
      );
      expect(calls.length).toBe(2);
    });
  });
});

describe("useSlices focus-refetch (walk-item 8 forward-fix #2)", () => {
  it("refetches on focus regardless of staleTime (refetchOnWindowFocus: 'always')", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({
        slices: [],
        totalCount: 0,
        filter: "all",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const { result } = renderHook(
      () => useSlices("all"),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const initialCallCount = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).startsWith("/api/slices"),
    ).length;
    expect(initialCallCount).toBe(1);

    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(
        (c) => String(c[0]).startsWith("/api/slices"),
      );
      expect(calls.length).toBe(2);
    });
  });
});
