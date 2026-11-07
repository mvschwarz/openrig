import { render, screen, fireEvent } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { notifyError } from "../src/lib/notify.js";
import {
  useStartRig,
  useExpandRig,
  useRemoveLibrarySpec,
  useRenameLibrarySpec,
} from "../src/hooks/mutations.js";

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

function ExpandRigProbe({ rigId }: { rigId: string }) {
  const mutation = useExpandRig();
  return (
    <button type="button" onClick={() => mutation.mutate({ rigId, pod: {} })}>
      expand
    </button>
  );
}

function RemoveSpecProbe({ entryId }: { entryId: string }) {
  const mutation = useRemoveLibrarySpec();
  return (
    <button type="button" onClick={() => mutation.mutate(entryId)}>
      remove-spec
    </button>
  );
}

function RenameSpecProbe({ entryId, name }: { entryId: string; name: string }) {
  const mutation = useRenameLibrarySpec();
  return (
    <button type="button" onClick={() => mutation.mutate({ entryId, name })}>
      rename-spec
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
    fireEvent.click(screen.getByText("start"));
    expect(await screen.findByText("Couldn't start rig")).toBeTruthy();
  });

  it("useExpandRig triggers success toast on 200 and error toast on failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const { unmount } = render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Toaster />
        <ExpandRigProbe rigId="rig-1" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("expand"));
    expect(await screen.findByText("Rig expanded")).toBeTruthy();
    unmount();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Toaster />
        <ExpandRigProbe rigId="rig-1" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("expand"));
    expect(await screen.findByText("Couldn't expand rig")).toBeTruthy();
  });

  it("useRemoveLibrarySpec triggers success and error toasts", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const { unmount } = render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Toaster />
        <RemoveSpecProbe entryId="spec-1" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("remove-spec"));
    expect(await screen.findByText("Spec removed")).toBeTruthy();
    unmount();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Toaster />
        <RemoveSpecProbe entryId="spec-1" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("remove-spec"));
    expect(await screen.findByText("Couldn't remove spec")).toBeTruthy();
  });

  it("useRenameLibrarySpec triggers success and error toasts", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const { unmount } = render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Toaster />
        <RenameSpecProbe entryId="spec-1" name="New Name" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("rename-spec"));
    expect(await screen.findByText("Spec renamed")).toBeTruthy();
    unmount();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Toaster />
        <RenameSpecProbe entryId="spec-1" name="New Name" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("rename-spec"));
    expect(await screen.findByText("Couldn't rename spec")).toBeTruthy();
  });
});
