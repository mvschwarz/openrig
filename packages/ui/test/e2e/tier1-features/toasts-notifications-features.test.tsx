import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { Toaster } from "sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { notifySuccess, notifyError } from "../../../src/lib/notify.js";
import { useCreateSnapshot, useTeardownRig } from "../../../src/hooks/mutations.js";
import { UndoToast } from "../../../src/components/for-you/UndoToast.js";

function createTestClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function SnapshotProbe({ rigId }: { rigId: string }) {
  const mutation = useCreateSnapshot(rigId);
  return (
    <button type="button" onClick={() => mutation.mutate("prod-backup")}>
      Save Snapshot
    </button>
  );
}

function TeardownProbe({ rigId }: { rigId: string }) {
  const mutation = useTeardownRig(rigId);
  return (
    <button type="button" onClick={() => mutation.mutate()}>
      Stop Rig
    </button>
  );
}

describe("Tier 1 Feature Coverage: Toasts & Action Notifications", () => {
  it("notifySuccess renders toast title and detailed description", async () => {
    render(<Toaster />);
    await act(async () => {
      notifySuccess("Snapshot saved", "Snapshot snap-001 created successfully");
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(await screen.findByText("Snapshot saved")).toBeTruthy();
    expect(await screen.findByText("Snapshot snap-001 created successfully")).toBeTruthy();
  });

  it("notifyError extracts message from Error object", async () => {
    render(<Toaster />);
    await act(async () => {
      notifyError("Connection failed", new Error("Network timeout after 5000ms"));
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(await screen.findByText("Connection failed")).toBeTruthy();
    expect(await screen.findByText("Network timeout after 5000ms")).toBeTruthy();
  });

  it("notifyError accepts string description", async () => {
    render(<Toaster />);
    await act(async () => {
      notifyError("Operation rejected", "Unauthorized agent session");
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(await screen.findByText("Operation rejected")).toBeTruthy();
    expect(await screen.findByText("Unauthorized agent session")).toBeTruthy();
  });

  it("useCreateSnapshot settlement triggers 'Snapshot saved' toast", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ snapshotId: "snap-123" }),
    });

    render(
      <QueryClientProvider client={createTestClient()}>
        <Toaster />
        <SnapshotProbe rigId="rig_alpha" />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText("Save Snapshot"));
    expect(await screen.findByText("Snapshot saved")).toBeTruthy();
  });

  it("useTeardownRig settlement triggers 'Rig stopped' toast", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    render(
      <QueryClientProvider client={createTestClient()}>
        <Toaster />
        <TeardownProbe rigId="rig_alpha" />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText("Stop Rig"));
    expect(await screen.findByText("Rig stopped")).toBeTruthy();
  });

  it("UndoToast displays feedback and fires onUndo without firing onExpire", () => {
    const onUndo = vi.fn();
    const onExpire = vi.fn();

    render(
      <UndoToast
        label="Item marked as resolved"
        onUndo={onUndo}
        onExpire={onExpire}
        durationMs={5000}
      />,
    );

    expect(screen.getByTestId("undo-toast")).toBeTruthy();
    expect(screen.getByText("Item marked as resolved")).toBeTruthy();

    const undoBtn = screen.getByTestId("undo-toast-button");
    fireEvent.click(undoBtn);

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
