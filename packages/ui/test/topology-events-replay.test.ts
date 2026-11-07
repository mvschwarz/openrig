import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";
import { subscribeTopologyEvents, TOPOLOGY_EVENT_HUB_URL } from "../src/lib/topology-events.js";

let OriginalEventSource: typeof EventSource | undefined;

describe("topology event hub: the first connection replays only the newest 100 events", () => {
  beforeEach(() => {
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  });

  afterEach(() => {
    if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  });

  it("opens /api/events?replay=100, not the whole log", () => {
    const stop = subscribeTopologyEvents(() => {});
    try {
      expect(instances).toHaveLength(1);
      expect(instances[0]!.url).toBe("/api/events?replay=100");
      expect(TOPOLOGY_EVENT_HUB_URL).toBe("/api/events?replay=100");
    } finally {
      stop();
    }
  });

  it("keeps the newest 100 events for a late subscriber after 150 arrive", () => {
    const stop = subscribeTopologyEvents(() => {});
    try {
      for (let seq = 1; seq <= 150; seq++) {
        instances[0]!.simulateMessage(JSON.stringify({ type: "queue.created", seq }));
      }
      const replayed: number[] = [];
      const stopLate = subscribeTopologyEvents((event) => replayed.push(event.seq as number));
      stopLate();
      expect(replayed).toHaveLength(100);
      expect(replayed[0]).toBe(51);
      expect(replayed.at(-1)).toBe(150);
    } finally {
      stop();
    }
  });
});
