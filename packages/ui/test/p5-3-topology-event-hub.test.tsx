import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
