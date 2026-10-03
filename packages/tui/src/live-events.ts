// OPR.0.5.5.19 AM-R18 — the TUI's oracle SUBSCRIPTION path. HTTP lives in
// daemon-client (FR-8 one-module rule): this module consumes an OPENER and parses SSE
// frames. Pushes are CHANGE NOTIFICATIONS ONLY (seat + seq) — the open view re-renders
// by rehydrating the same /api/ps projection, so no second activity derivation exists
// anywhere on this path (desk-accepted shape, ruling row qitem-20260827001530).
// A definite null open (non-OK / non-SSE answer) disables the leg permanently.
// Opening deadlines and network errors are temporary connection failures, like an
// established stream dropping. Retry with doubling backoff, capped at 30 seconds;
// reconnection is connection maintenance, never a data poll (timers unref'd).

export interface ActivityEventsSubscription {
  close: () => void;
}

export interface SubscribeActivityEventsOpts {
  /** Opens the SSE stream (daemon-client.openActivityEvents). null = leg unavailable —
   *  disable permanently, never retry. Rejection means a temporary open failure. */
  open: () => Promise<Response | null>;
  /** One pushed oracle change (parsed SSE data line). The consumer refreshes; it never
   *  reads activity fields from the push. */
  onEvent: (event: { type: string; seatNodeId?: string; seq?: number }) => void;
  /** Connection lifecycle notes (drop/reconnect/unavailable) — surfaced, never fatal. */
  onStatus?: (status: "connected" | "dropped" | "reconnecting" | "unavailable") => void;
  /** Initial backoff (ms) after a temporary open failure or stream drop; 30s cap. */
  reconnectDelayMs?: number;
}

const RECONNECT_CAP_MS = 30_000;
// Notifications are tiny. Bound retained decoded characters (UTF-16 code units),
// including data-field separators, when a malformed stream omits a delimiter.
const MAX_FRAME_CHARS = 1_048_576;

export function subscribeActivityEvents(opts: SubscribeActivityEventsOpts): ActivityEventsSubscription {
  const baseDelayMs = opts.reconnectDelayMs ?? 1_000;
  let delayMs = baseDelayMs;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const connect = async (): Promise<void> => {
    if (closed) return;
    let retry = false;
    try {
      const res = await opts.open();
      if (closed) {
        await res?.body?.cancel();
        return;
      }
      if (!res?.body) {
        opts.onStatus?.("unavailable");
        return; // feature-detect said no — the leg stays off, S16 behavior intact
      }
      retry = true;
      opts.onStatus?.("connected");
      const reader = res.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      let skipLF = false;
      let data: string[] = [];
      let dataChars = 0;
      const lineReceived = (line: string): void => {
        if (line !== "") {
          // Each data field contributes one line; other SSE fields are framing.
          if (line.startsWith("data:") || line === "data") {
            const value = line === "data" ? "" : line.slice(5).replace(/^ /, "");
            dataChars += value.length + 1;
            if (dataChars > MAX_FRAME_CHARS) throw new Error("SSE frame too long");
            data.push(value);
          }
          return;
        }
        const raw = data.join("\n");
        data = [];
        dataChars = 0;
        if (!raw.trim()) return;
        try {
          const event = JSON.parse(raw) as { type: string; seatNodeId?: string; seq?: number };
          // Headers and keepalives can precede another immediate disconnect.
          // Reset only when the stream resumes delivering notifications.
          delayMs = baseDelayMs;
          opts.onEvent(event);
        } catch {
          // a non-JSON keepalive is framing, not an event
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (buffer.length) {
          // A CR terminates a line immediately. Its optional LF may be in the
          // following network chunk and must not create an extra blank line.
          if (skipLF) {
            if (buffer.startsWith("\n")) buffer = buffer.slice(1);
            skipLF = false;
          }
          const end = /[\r\n]/.exec(buffer);
          if (dataChars + (end ? end.index : buffer.length) > MAX_FRAME_CHARS) {
            throw new Error("SSE frame too long");
          }
          if (!end) break;
          const line = buffer.slice(0, end.index);
          skipLF = end[0] === "\r";
          buffer = buffer.slice(end.index + 1);
          lineReceived(line);
        }
      }
    } catch {
      retry = true;
      // Opening errors are temporary; read/parser errors on an established stream are drops. Start cancelling
      // its body before reconnecting, without waiting for underlying cleanup.
      void activeReader?.cancel().catch(() => {});
    } finally {
      activeReader = null;
    }
    if (!closed && retry) {
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
