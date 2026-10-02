import { expect, it, vi } from "vitest";
import { subscribeActivityEvents } from "../src/live-events.js";

it("backs off repeated drops until notifications resume, and cancels on shutdown", async () => {
  vi.useFakeTimers();
  const startedAt = Date.now();
  const arrivals: number[] = [];
  const events: unknown[] = [];
  const sub = subscribeActivityEvents({
    reconnectDelayMs: 80,
    open: async () => {
      arrivals.push(Date.now() - startedAt);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          if (arrivals.length === 5) return; // recovered, quiet stream stays open
          const frame = arrivals.length === 4
            ? 'data: {"type":"seat.activity_changed","seq":7}\n\n'
            : ": connected\n\n";
          controller.enqueue(new TextEncoder().encode(frame));
          controller.close();
        },
      }));
    },
    onEvent: event => events.push(event),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(arrivals).toEqual([0]);
    await vi.advanceTimersByTimeAsync(80);
    expect(arrivals).toEqual([0, 80]);
    await vi.advanceTimersByTimeAsync(160);
    expect(arrivals).toEqual([0, 80, 240]);
    await vi.advanceTimersByTimeAsync(320);
    expect(arrivals).toEqual([0, 80, 240, 560]);
    expect(events).toEqual([{ type: "seat.activity_changed", seq: 7 }]);
    await vi.advanceTimersByTimeAsync(80);
    expect(arrivals).toEqual([0, 80, 240, 560, 640]);
    sub.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(arrivals).toHaveLength(5);
  } finally {
    sub.close();
    vi.useRealTimers();
  }
});
