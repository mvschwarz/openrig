// Slice 24 Checkpoint D — useRigCmuxLaunch hook tests.
// Verifies the hook calls POST /api/rigs/:rigId/cmux/launch + surfaces
// success/error data per the daemon route's response shape.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { useRigCmuxLaunch } from "../src/hooks/useRigCmuxLaunch.js";

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("useRigCmuxLaunch", () => {
  it("posts to /api/rigs/:rigId/cmux/launch", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, workspaces: [] }),
    });
    const { result } = renderHook(() => useRigCmuxLaunch(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.mutateAsync({ rigId: "my-rig" });
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/rigs/my-rig/cmux/launch",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns workspaces array on success", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        workspaces: [
          { name: "my-rig", agents: ["a", "b", "c"], blanks: 1 },
        ],
      }),
    });
    const { result } = renderHook(() => useRigCmuxLaunch(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.mutateAsync({ rigId: "my-rig" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.workspaces).toHaveLength(1);
    expect(result.current.data?.workspaces[0]!.name).toBe("my-rig");
  });

  it("throws with daemon error message on 4xx response", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 412,
      json: async () => ({ error: "rig_not_running", message: "Rig 'my-rig' has no running tmux sessions — run: rig up my-rig" }),
    });
    const { result } = renderHook(() => useRigCmuxLaunch(), { wrapper: makeWrapper() });
    await act(async () => {
      try {
        await result.current.mutateAsync({ rigId: "my-rig" });
      } catch {
        // expected
      }
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/rig_not_running|no running tmux/);
  });

  it("throws on network failure", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useRigCmuxLaunch(), { wrapper: makeWrapper() });
    await act(async () => {
      try {
        await result.current.mutateAsync({ rigId: "my-rig" });
      } catch {
        // expected
      }
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/network down/);
  });
});
