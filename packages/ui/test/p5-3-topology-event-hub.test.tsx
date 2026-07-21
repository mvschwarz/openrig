import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useActivityFeed } from "../src/hooks/useActivityFeed.js";
import { useGlobalEvents } from "../src/hooks/useGlobalEvents.js";
import {
  resetTopologyActivityStoreForTests,
  useTopologyActivity,
} from "../src/hooks/useTopologyActivity.js";
import { useTopologyEdgeActivity } from "../src/hooks/useTopologyEdgeActivity.js";
import { buildTopologySessionIndex } from "../src/lib/topology-activity.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";

let OriginalEventSource: typeof EventSource | undefined;

function EventHubHarness() {
  useGlobalEvents();
  const feed = useActivityFeed();
  const edgeActivity = useTopologyEdgeActivity();
  const topologyActivity = useTopologyActivity(buildTopologySessionIndex([
    {
      nodeId: "rig-1::orch.lead",
      rigId: "rig-1",
      rigName: "rig-1",
      logicalId: "orch.lead",
      canonicalSessionName: "orch.lead@rig-1",
    },
    {
      nodeId: "rig-1::dev.driver",
      rigId: "rig-1",
      rigName: "rig-1",
      logicalId: "dev.driver",
      canonicalSessionName: "dev.driver@rig-1",
    },
  ]));
  return (
    <div>
      <span data-testid="hub-connected">{String(feed.connected)}</span>
      <span data-testid="hub-event-count">{feed.events.length}</span>
      <span data-testid="hub-edge-version">{edgeActivity.version}</span>
      <span data-testid="hub-packet-count">{topologyActivity.packets.length}</span>
    </div>
  );
}

function renderHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <EventHubHarness />
    </QueryClientProvider>,
  );
}

describe("P5.3 shared topology event hub", () => {
  beforeEach(() => {
    resetTopologyActivityStoreForTests();
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  });

  afterEach(() => {
    cleanup();
    if (OriginalEventSource) {
      globalThis.EventSource = OriginalEventSource;
    }
  });

  it("feeds activity, invalidation, and edge activity hooks from one /api/events connection", async () => {
    const { unmount } = renderHarness();

    await waitFor(() => {
      expect(instances).toHaveLength(1);
      expect(instances[0]!.url).toBe("/api/events");
    });
    await waitFor(() => {
      expect(screen.getByTestId("hub-connected").textContent).toBe("true");
    });

    act(() => {
      instances[0]!.simulateMessage(JSON.stringify({
        type: "queue.created",
        sourceSession: "orch.lead@rig-1",
        destinationSession: "dev.driver@rig-1",
        seq: 1,
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("hub-event-count").textContent).toBe("1");
      expect(Number(screen.getByTestId("hub-edge-version").textContent)).toBeGreaterThan(0);
      expect(screen.getByTestId("hub-packet-count").textContent).toBe("1");
    });

    unmount();
    expect(instances[0]!.readyState).toBe(2);
  });

  it("keeps EventSource construction centralized in topology-events", () => {
    const srcRoot = path.resolve(__dirname, "../src");
    const hookFiles = [
      "hooks/useActivityFeed.ts",
      "hooks/useGlobalEvents.ts",
      "hooks/useRigEvents.ts",
      "hooks/useTopologyEdgeActivity.ts",
      "hooks/useTopologyActivity.ts",
    ];
    for (const relative of hookFiles) {
      const src = readFileSync(path.join(srcRoot, relative), "utf8");
      expect(src).not.toMatch(/new\s+EventSource/);
      expect(src).toMatch(/subscribeTopology/);
    }

    const hubSrc = readFileSync(path.join(srcRoot, "lib/topology-events.ts"), "utf8");
    expect(hubSrc.match(/new\s+EventSource/g) ?? []).toHaveLength(1);
  });

  // slice-04 qitem-20260721000001-ps-stall-driver — U1 (regression pin; genuine RED
  // at the test-only gate, green now) + U3 (GREEN pins).
  function renderSpied() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalSpy = vi.spyOn(qc, "invalidateQueries");
    const utils = render(
      <QueryClientProvider client={qc}>
        <EventHubHarness />
      </QueryClientProvider>,
    );
    return { qc, invalSpy, ...utils };
  }
  const keyEq = (k: unknown, want: unknown[]) =>
    Array.isArray(k) && k.length === want.length && k.every((v, i) => v === want[i]);

  it("U1 regression: a host-derived SSE burst coalesces ps + default-summary invalidations to one each after 150ms", async () => {
    vi.useFakeTimers();
    try {
      const { invalSpy } = renderSpied();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(instances).toHaveLength(1);

      // Host-derived 594-event qualifying burst (the useActivityFeed ps+summary types).
      const burst: Array<[string, number]> = [
        ["session.detached", 437], ["rig.deleted", 49], ["rig.expanded", 35],
        ["restore.completed", 35], ["node.claimed", 21], ["node.removed", 14], ["pod.deleted", 3],
      ];
      let seq = 1;
      act(() => {
        for (const [type, n] of burst) {
          for (let i = 0; i < n; i++) {
            instances[0]!.simulateMessage(JSON.stringify({ type, rigId: "rig-1", seq: seq++ }));
          }
        }
      });
      act(() => { vi.advanceTimersByTime(200); }); // flush the 150ms useGlobalEvents debounce

      const calls = invalSpy.mock.calls.map((c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey);
      const countKey = (want: unknown[]) => calls.filter((k) => keyEq(k, want)).length;
      const countPrefix = (p0: string) => calls.filter((k) => Array.isArray(k) && k[0] === p0).length;

      // Genuine RED at the test-only gate; regression now. Pre-fix, useActivityFeed
      // invalidated ps + default-summary PER event (no debounce); now coalesced to one.
      expect(countKey(["ps"])).toBe(1);
      expect(countKey(["rigs", "summary"])).toBe(1);
      // GREEN pins that must survive the fix: distinct-key rig/discovery fan + the 100 feed cap.
      expect(countPrefix("rig")).toBeGreaterThan(0);
      expect(countPrefix("discovery")).toBeGreaterThan(0);
      expect(Number(screen.getByTestId("hub-event-count").textContent)).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("U3 pin: agent.activity produces no ps/default-summary invalidation", async () => {
    vi.useFakeTimers();
    try {
      const { invalSpy } = renderSpied();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      act(() => {
        for (let i = 0; i < 50; i++) {
          instances[0]!.simulateMessage(JSON.stringify({ type: "agent.activity", rigId: "rig-1", nodeId: "rig-1::orch.lead", seq: i + 1 }));
        }
      });
      act(() => { vi.advanceTimersByTime(200); });
      const psSummary = invalSpy.mock.calls
        .map((c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey)
        .filter((k) => Array.isArray(k) && (k[0] === "ps" || (k[0] === "rigs" && k[1] === "summary")));
      expect(psSummary).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
