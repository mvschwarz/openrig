import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useRigStatusResolver } from "../src/hooks/useRigStatusResolver.js";
import { LOCAL_HOST_ID } from "../src/lib/host-param.js";

function wrapper(ps: unknown[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["ps", LOCAL_HOST_ID], ps);
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useRigStatusResolver", () => {
  const ps = [
    { rigId: "a", name: "a", nodeCount: 1, runningCount: 1, status: "partial" },
    { rigId: "b", name: "b", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "degraded" },
  ];
  it("prefers the summary lifecycleState", () => {
    const { result } = renderHook(() => useRigStatusResolver(), { wrapper: wrapper(ps) });
    expect(result.current("a", "running")).toBe("running");
  });
  it("falls back to the ps lifecycleState, then the ps status", () => {
    const { result } = renderHook(() => useRigStatusResolver(), { wrapper: wrapper(ps) });
    expect(result.current("b", undefined)).toBe("degraded");
    expect(result.current("a", null)).toBe("partial");
  });
  it("returns unknown for a rig with no ps row", () => {
    const { result } = renderHook(() => useRigStatusResolver(), { wrapper: wrapper(ps) });
    expect(result.current("zzz")).toBe("unknown");
  });
});
