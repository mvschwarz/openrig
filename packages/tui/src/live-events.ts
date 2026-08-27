// OPR.0.5.5.19 AM-R18 — the TUI's oracle SUBSCRIPTION path: an SSE connection to the
// daemon's GET /api/activity/events. Pushes are CHANGE NOTIFICATIONS ONLY (seat + seq) —
// the open view re-renders by rehydrating the same /api/ps projection, so no second
// activity derivation exists anywhere on this path (desk-accepted shape, ruling row
// qitem-20260827001530). NO IDLE POLLING: onEvent fires only on pushed changes; the
// only timer here is connection-maintenance backoff after a DROP, never a data poll.

export interface ActivityEventsSubscription {
  close: () => void;
}

export interface SubscribeActivityEventsOpts {
  baseUrl: string;
  /** One pushed oracle change (parsed SSE data line). The consumer refreshes; it never
   *  reads activity fields from the push. */
  onEvent: (event: { type: string; seatNodeId?: string; seq?: number }) => void;
  /** Connection lifecycle notes (drop/reconnect) — surfaced, never fatal. */
  onStatus?: (status: "connected" | "dropped" | "reconnecting") => void;
  /** Reconnect backoff (ms) after a drop. Connection maintenance, not data polling. */
  reconnectDelayMs?: number;
}

export function subscribeActivityEvents(opts: SubscribeActivityEventsOpts): ActivityEventsSubscription {
  const reconnectDelayMs = opts.reconnectDelayMs ?? 1_000;
  let closed = false;
  let controller: AbortController | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const connect = async (): Promise<void> => {
    if (closed) return;
    controller = new AbortController();
    try {
      const res = await fetch(`${opts.baseUrl}/api/activity/events`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`events stream: HTTP ${res.status}`);
      opts.onStatus?.("connected");
      const reader = res.body.getReader();
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
      // drop — handled below; a failed connect and a mid-stream drop reconnect the same way
    }
    if (!closed) {
      opts.onStatus?.("dropped");
      reconnectTimer = setTimeout(() => {
        opts.onStatus?.("reconnecting");
        void connect();
      }, reconnectDelayMs);
      reconnectTimer.unref?.();
    }
  };

  void connect();
  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller?.abort();
    },
  };
}
