import { render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { notifyError } from "../src/lib/notify.js";
import { useStartRig } from "../src/hooks/mutations.js";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

function StartRigProbe({ rigId }: { rigId: string }) {
  const mutation = useStartRig(rigId);
  return (
    <button type="button" onClick={() => mutation.mutate()}>
      start
    </button>
  );
}

describe("notify", () => {
  it("notifyError shows the title and the error message", async () => {
    render(<Toaster />);
    await act(async () => {
      notifyError("X", new Error("boom"));
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(await screen.findByText("X")).toBeTruthy();
    expect(await screen.findByText("boom")).toBeTruthy();
  });

  it("useStartRig failure toasts \"Couldn't start rig\"", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Toaster />
        <StartRigProbe rigId="rig-1" />
      </QueryClientProvider>,
    );
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByText("start"));
    expect(await screen.findByText("Couldn't start rig")).toBeTruthy();
  });
});
