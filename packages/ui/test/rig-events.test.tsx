import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRigEvents } from "../src/hooks/useRigEvents.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";
import type { MockEventSourceInstance } from "./helpers/mock-event-source.js";

let OriginalEventSource: typeof EventSource | undefined;

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

beforeEach(() => {
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
});

afterEach(() => {
  if (OriginalEventSource) {
    globalThis.EventSource = OriginalEventSource;
  }
  cleanup();
});

function HookHarness({ rigId }: { rigId: string | null }) {
  const { connected, reconnecting } = useRigEvents(rigId);
  return (
    <div>
      <span data-testid="connected">{String(connected)}</span>
      <span data-testid="reconnecting">{String(reconnecting)}</span>
    </div>
  );
}

function ChangingRigHarness() {
  const [rigId, setRigId] = useState<string | null>("rig-1");
  return (
    <div>
      <HookHarness rigId={rigId} />
      <button onClick={() => setRigId("rig-2")}>change</button>
      <button onClick={() => setRigId(null)}>clear</button>
    </div>
  );
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

function getLastInstance(): MockEventSourceInstance {
  return instances[instances.length - 1]!;
}

describe("useRigEvents hook", () => {
  it("opens EventSource to correct URL", async () => {
    renderWithQuery(<HookHarness rigId="rig-1" />);

    await waitFor(() => {
      expect(instances).toHaveLength(1);
      expect(instances[0]!.url).toBe("/api/events?rigId=rig-1");
    });
  });

  it("on SSE message -> invalidates graph query (debounced)", async () => {
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(
      <QueryClientProvider client={qc}>
        <HookHarness rigId="rig-1" />
      </QueryClientProvider>
    );

    await waitFor(() => expect(instances).toHaveLength(1));
    const es = getLastInstance();

    act(() => { es.simulateMessage("event1"); });

    // Wait for debounce (100ms)
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rig", "rig-1", "graph"] });
    });
  });

  it("debounce: rapid events -> one invalidation per batch", async () => {
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(
      <QueryClientProvider client={qc}>
        <HookHarness rigId="rig-1" />
      </QueryClientProvider>
    );

    await waitFor(() => expect(instances).toHaveLength(1));
    const es = getLastInstance();

    // Rapid fire — all within debounce window
    act(() => {
      es.simulateMessage("e1");
      es.simulateMessage("e2");
      es.simulateMessage("e3");
    });

    await waitFor(() => {
      const graphCalls = invalidateSpy.mock.calls.filter(
        (c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: ["rig", "rig-1", "graph"] })
      );
      expect(graphCalls).toHaveLength(1);
    });
  });

  it("rigId=null -> no EventSource opened", () => {
    renderWithQuery(<HookHarness rigId={null} />);
    expect(instances).toHaveLength(0);
  });

  it("EventSource error -> reconnecting=true", async () => {
    renderWithQuery(<HookHarness rigId="rig-1" />);

    await waitFor(() => expect(instances).toHaveLength(1));
    const es = getLastInstance();

    act(() => { es.simulateError(); });

    await waitFor(() => {
      expect(screen.getByTestId("reconnecting").textContent).toBe("true");
      expect(screen.getByTestId("connected").textContent).toBe("false");
    });
  });

  it("unmount -> EventSource.close() called", async () => {
    const { unmount } = renderWithQuery(<HookHarness rigId="rig-1" />);

    await waitFor(() => expect(instances).toHaveLength(1));
    const es = getLastInstance();

    unmount();
    expect(es.readyState).toBe(2); // CLOSED
  });

  it("rigId change -> old EventSource closed, new one opened", async () => {
    const { getByText } = renderWithQuery(<ChangingRigHarness />);

    await waitFor(() => expect(instances).toHaveLength(1));
    const first = instances[0]!;
    expect(first.url).toContain("rig-1");

    act(() => { getByText("change").click(); });

    await waitFor(() => {
      expect(instances).toHaveLength(2);
      expect(first.readyState).toBe(2); // CLOSED
      expect(instances[1]!.url).toContain("rig-2");
    });
  });

  it("reconnect: open after error -> reconnecting=false, invalidates graph", async () => {
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(
      <QueryClientProvider client={qc}>
        <HookHarness rigId="rig-1" />
      </QueryClientProvider>
    );

    await waitFor(() => expect(instances).toHaveLength(1));
    const es = getLastInstance();

    // Simulate error then reconnect
    act(() => { es.simulateError(); });
    await waitFor(() => expect(screen.getByTestId("reconnecting").textContent).toBe("true"));

    act(() => { es.simulateOpen(); });

    await waitFor(() => {
      expect(screen.getByTestId("reconnecting").textContent).toBe("false");
      expect(screen.getByTestId("connected").textContent).toBe("true");
    });

    // Reconnect should trigger graph invalidation
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rig", "rig-1", "graph"] });
    });
  });

  it("initial open does NOT trigger invalidation", async () => {
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(
      <QueryClientProvider client={qc}>
        <HookHarness rigId="rig-1" />
      </QueryClientProvider>
    );

    await waitFor(() => expect(instances).toHaveLength(1));
    const es = getLastInstance();

    act(() => { es.simulateOpen(); });
    await waitFor(() => expect(screen.getByTestId("connected").textContent).toBe("true"));

    // No invalidation on initial open
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("error on rig-1 then change to rig-2 -> reconnecting clears", async () => {
    const { getByText } = renderWithQuery(<ChangingRigHarness />);

    await waitFor(() => expect(instances).toHaveLength(1));
    const first = instances[0]!;

    act(() => { first.simulateError(); });
    await waitFor(() => expect(screen.getByTestId("reconnecting").textContent).toBe("true"));

    act(() => { getByText("change").click(); });

    await waitFor(() => {
      expect(screen.getByTestId("reconnecting").textContent).toBe("false");
    });
  });
});
