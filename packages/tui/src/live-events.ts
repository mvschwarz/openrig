// OPR.0.5.5.19 AM-R18 — the TUI's oracle SUBSCRIPTION path. HTTP lives in
// daemon-client (FR-8 one-module rule): this module consumes an OPENER and parses SSE
// frames. Pushes are CHANGE NOTIFICATIONS ONLY (seat + seq) — the open view re-renders
// by rehydrating the same /api/ps projection, so no second activity derivation exists
// anywhere on this path (desk-accepted shape, ruling row qitem-20260827001530).
// NO IDLE POLLING: a null open (endpoint absent / daemon unreachable / non-SSE answer)
// DISABLES the leg permanently — zero retries, the S16 cadence contract holds
// (one feature-detect request at startup, then silence). Reconnect happens ONLY after a
// genuinely-established stream drops, with doubling backoff (connection maintenance,
// never a data poll; timers unref'd).

export interface ActivityEventsSubscription {
  close: () => void;
}

export interface SubscribeActivityEventsOpts {
  /** Opens the SSE stream (daemon-client.openActivityEvents). null = leg unavailable —
   *  disable permanently, never retry. */
  open: () => Promise<Response | null>;
  /** One pushed oracle change (parsed SSE data line). The consumer refreshes; it never
   *  reads activity fields from the push. */
  onEvent: (event: { type: string; seatNodeId?: string; seq?: number }) => void;
  /** Connection lifecycle notes (drop/reconnect/unavailable) — surfaced, never fatal. */
  onStatus?: (status: "connected" | "dropped" | "reconnecting" | "unavailable") => void;
  /** Initial reconnect backoff (ms) after a REAL stream drops; doubles to 30s cap. */
  reconnectDelayMs?: number;
}

const RECONNECT_CAP_MS = 30_000;

export function subscribeActivityEvents(opts: SubscribeActivityEventsOpts): ActivityEventsSubscription {
  const baseDelayMs = opts.reconnectDelayMs ?? 1_000;
  let delayMs = baseDelayMs;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const connect = async (): Promise<void> => {
    if (closed) return;
    let established = false;
    try {
      const res = await opts.open();
      if (closed) return;
      if (!res?.body) {
        opts.onStatus?.("unavailable");
        return; // feature-detect said no — the leg stays off, S16 behavior intact
      }
      established = true;
      delayMs = baseDelayMs; // a real connection resets the backoff
      opts.onStatus?.("connected");
      const reader = res.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue; // comments/event-name lines are framing
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              opts.onEvent(JSON.parse(raw) as { type: string; seatNodeId?: string; seq?: number });
            } catch {
              // a non-JSON keepalive line is framing, not an event
            }
          }
        }
      }
    } catch {
      // read error on an established stream — handled as a drop below
    } finally {
      activeReader = null;
    }
    if (!closed && established) {
      opts.onStatus?.("dropped");
      reconnectTimer = setTimeout(() => {
        opts.onStatus?.("reconnecting");
        void connect();
      }, delayMs);
      delayMs = Math.min(delayMs * 2, RECONNECT_CAP_MS);
      reconnectTimer.unref?.();
    }
  };

  void connect();
  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      void activeReader?.cancel().catch(() => {});
    },
  };
}
