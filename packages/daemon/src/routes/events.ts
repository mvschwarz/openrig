import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { PersistedEvent } from "../domain/types.js";

export const eventsRoute = new Hono();

function getEventBus(c: { get: (key: string) => unknown }): EventBus {
  return c.get("eventBus" as never) as EventBus;
}

eventsRoute.get("/", (c) => {
  const rigId = c.req.query("rigId");
  if (!rigId) {
    return c.json({ error: "rigId query parameter is required" }, 400);
  }

  const lastEventIdRaw = c.req.header("Last-Event-ID") ?? "0";
  const lastEventId = parseInt(lastEventIdRaw, 10);
  const lastSeq = isNaN(lastEventId) ? 0 : lastEventId;

  const eventBus = getEventBus(c);

  return streamSSE(c, async (stream) => {
    // Buffer for live events arriving during replay
    const buffer: PersistedEvent[] = [];
    let replaying = true;
    let maxReplayedSeq = lastSeq;

    // 1. Subscribe to live bus BEFORE replay query (no gap)
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.rigId !== rigId) return;
      if (replaying) {
        buffer.push(event);
      } else {
        // Stream directly — skip if already sent during replay
        if (event.seq <= maxReplayedSeq) return;
        stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) }).catch(() => {});
      }
    });

    try {
      // 2. Replay missed events from DB
      const missed = eventBus.replaySince(lastSeq, rigId);
      for (const event of missed) {
        await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
        if (event.seq > maxReplayedSeq) maxReplayedSeq = event.seq;
      }

      // 3. Drain buffer while still in replaying mode (new live events
      //    continue to buffer, preserving monotonic ordering)
      //    Drain in a loop since new events may arrive during drain.
      while (buffer.length > 0) {
        const snapshot = buffer.splice(0);
        for (const event of snapshot) {
          if (event.seq <= maxReplayedSeq) continue; // dedup
          await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
          if (event.seq > maxReplayedSeq) maxReplayedSeq = event.seq;
        }
      }

      // 4. Switch to live mode — new events go directly to stream
      replaying = false;

      // 4. Keep stream alive until client disconnects
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    } finally {
      unsubscribe();
    }
  });
});
