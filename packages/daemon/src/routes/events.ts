import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { PersistedEvent } from "../domain/types.js";

export const eventsRoute = new Hono();

/** A replay is read and written this many events at a time, never built whole. */
const REPLAY_PAGE = 500;

function getEventBus(c: { get: (key: string) => unknown }): EventBus {
  return c.get("eventBus" as never) as EventBus;
}

eventsRoute.get("/", (c) => {
  const rigId = c.req.query("rigId"); // Optional — omit for global stream
  // `?replay=<n>` asks for the newest n events (0: none); `all`, no `replay` or any other value, the whole log, as before
  // the parameter existed.
  const replay = c.req.query("replay");
  const replayCount = replay !== undefined && /^\d+$/.test(replay) ? Number(replay) : null;

  // EventSource sends Last-Event-ID when it reconnects: the events after it are replayed, whatever `replay` says.
  const lastEventIdRaw = c.req.header("Last-Event-ID");
  const lastEventId = lastEventIdRaw === undefined ? null : parseInt(lastEventIdRaw, 10);

  const eventBus = getEventBus(c);

  return streamSSE(c, async (stream) => {
    // Buffer for live events arriving during replay
    const buffer: PersistedEvent[] = [];
    let replaying = true;
    let maxReplayedSeq = 0;

    // 1. Subscribe to live bus BEFORE replay query (no gap)
    const unsubscribe = eventBus.subscribe((event) => {
      // Rig-scoped: filter by rigId. Global: accept all events.
      if (rigId) {
        const eventRigId = "rigId" in event ? (event as { rigId: string }).rigId : null;
        if (eventRigId !== rigId) return;
      }
      if (replaying) {
        buffer.push(event);
      } else {
        // Stream directly — skip if already sent during replay
        if (event.seq <= maxReplayedSeq) return;
        stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) }).catch(() => {});
      }
    });

    const aborted = new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });

    try {
      // Where the replay starts, read once subscribed: an event stored after it is either replayed or buffered. Without
      // Last-Event-ID, `?replay=<n>` replays the newest n (0: from now on), the whole log when it holds no more.
      const lastSeq = lastEventId !== null ? (isNaN(lastEventId) ? 0 : lastEventId)
        : replayCount === null ? 0
        : eventBus.seqBeforeNewest(replayCount, rigId);
      maxReplayedSeq = lastSeq;
      // Where it ends, read once subscribed too: an event stored after it is buffered, so events arriving while the
      // pages are written can neither keep the replay going nor be sent twice.
      const upTo = eventBus.maxSeq();

      // 2. Replay missed events from DB, a page at a time
      for (let page = eventBus.replayPage(lastSeq, upTo, REPLAY_PAGE, rigId); page.length > 0 && !stream.aborted;
        page = eventBus.replayPage(maxReplayedSeq, upTo, REPLAY_PAGE, rigId)) {
        for (const event of page) {
          await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
          if (event.seq > maxReplayedSeq) maxReplayedSeq = event.seq;
        }
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
      await aborted;
    } finally {
      unsubscribe();
    }
  });
});
