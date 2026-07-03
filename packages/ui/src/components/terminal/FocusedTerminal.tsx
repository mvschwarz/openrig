import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { readTerminalBearerToken } from "../mission-control/missionControlAuth.js";
import { useDaemonHealthSignal } from "../../hooks/useDaemonHealth.js";
import {
  LIVE_TERMINAL_RENDER_BACKGROUND,
  LIVE_TERMINAL_COLS,
  LIVE_TERMINAL_ROWS,
  LIVE_TERMINAL_FONT_SIZE,
  LIVE_TERMINAL_LINE_HEIGHT,
  LIVE_TERMINAL_FONT_FAMILY,
} from "./terminal-geometry.js";
import "@xterm/xterm/css/xterm.css";

// OPR.0.4.0.39 (selection fix): when the live terminal must fit a container, it
// scales by FONT SIZE, not a CSS transform. xterm's mouse hit-test (text selection,
// link clicks) divides a post-transform pointer offset by the pre-transform cell
// size, so a CSS transform:scale ancestor makes selection drift by the scale factor
// (xterm.js #6023). Scaling via fontSize keeps the cell metrics honest -> native
// selection. Upscale (contain mode) is capped to keep text crisp (matches
// ScaleToFitTerminal's MAX_CONTAIN_SCALE).
const MAX_FIT_UPSCALE = 2;

const SPECIAL_KEY_MAP: Record<string, string> = {
  "\t": "Tab",
  "\r": "Enter",
  "\x7f": "BSpace",
  "\x1b": "Escape",
  "\x03": "C-c",
  "\x04": "C-d",
  "\x1a": "C-z",
  "\x0c": "C-l",
  "\x01": "C-a",
  "\x05": "C-e",
  "\x0b": "C-k",
  "\x15": "C-u",
  "\x17": "C-w",
};

const ESCAPE_SEQ_MAP: Record<string, string> = {
  "\x1b[A": "Up",
  "\x1b[B": "Down",
  "\x1b[C": "Right",
  "\x1b[D": "Left",
  "\x1b[H": "Home",
  "\x1b[F": "End",
  "\x1b[5~": "PgUp",
  "\x1b[6~": "PgDn",
  "\x1b[3~": "DC",
  "\x1b[2~": "IC",
};

// OPR.0.4.3.21 — the broker's GENERIC fallback close reason (see
// TerminalSessionBroker.ts). This is the ONLY message the health-aware
// disambiguation may replace; specific reasons (`session not found: …`,
// `pipe-pane failed: …`, `tmux session terminated`, `pipe output file
// failed: …`) always pass through unchanged.
const GENERIC_BROKER_UNAVAILABLE = "terminal broker unavailable";
// The honest control-plane message shown when the broker reported the generic
// fallback WHILE daemon health is failing. Rendered under the "Terminal
// unavailable:" prefix.
const DAEMON_CONTROL_PLANE_UNHEALTHY =
  "daemon control plane unhealthy (event loop starved) — restart the daemon only; your seats are preserved";

type WsMessage = { type: "keys"; keys: string[] } | { type: "text"; text: string };

export function mapXtermInput(data: string): WsMessage[] {
  const messages: WsMessage[] = [];
  let i = 0;
  let textBuf = "";

  const flushText = () => {
    if (textBuf) { messages.push({ type: "text", text: textBuf }); textBuf = ""; }
  };

  while (i < data.length) {
    if (data[i] === "\x1b" && data[i + 1] === "[") {
      const rest = data.slice(i);
      let matched = false;
      for (const [seq, key] of Object.entries(ESCAPE_SEQ_MAP)) {
        if (rest.startsWith(seq)) {
          flushText();
          messages.push({ type: "keys", keys: [key] });
          i += seq.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        textBuf += data[i]!;
        i++;
      }
    } else {
      const key = SPECIAL_KEY_MAP[data[i]!];
      if (key) {
        flushText();
        messages.push({ type: "keys", keys: [key] });
        i++;
      } else {
        textBuf += data[i]!;
        i++;
      }
    }
  }
  flushText();
  return messages;
}

export function applyOpaqueTerminalBackground(container: HTMLElement): void {
  const surfaces = [
    container,
    container.querySelector<HTMLElement>(".xterm"),
    container.querySelector<HTMLElement>(".xterm-screen"),
    container.querySelector<HTMLElement>(".xterm-viewport"),
    container.querySelector<HTMLElement>(".xterm-rows"),
  ];
  for (const surface of surfaces) {
    if (surface) surface.style.backgroundColor = LIVE_TERMINAL_RENDER_BACKGROUND;
  }
}

export function scrollTerminalViewportToPrompt(container: HTMLElement): void {
  const scroll = () => {
    const cursor = container.querySelector<HTMLElement>("textarea.xterm-helper-textarea");
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (!cursor) {
      container.scrollTop = maxScrollTop;
      return;
    }

    const parsedCursorTop = Number.parseFloat(cursor.style.top);
    const cursorTop = Number.isFinite(parsedCursorTop) ? parsedCursorTop : cursor.offsetTop;
    const lineHeight = cursor.offsetHeight || 14;
    const cursorBottom = cursorTop + lineHeight;
    const desiredScrollTop = cursorBottom - container.clientHeight + lineHeight * 3;
    container.scrollTop = Math.min(maxScrollTop, Math.max(0, desiredScrollTop));
  };

  scroll();
  window.requestAnimationFrame(scroll);
  window.setTimeout(scroll, 50);
}

interface FocusedTerminalProps {
  sessionName: string;
  daemonBaseUrl?: string;
  /**
   * OPR.0.4.0.39: how the live xterm sizes to its container. "natural" (default) =
   * render at the native 90x27 size (callers that don't scale, e.g. the feed-card).
   * "width" = scale DOWN via fontSize to fit the container width (never upscale) -
   * the grid/graph/table cells. "contain" = fit both axes via fontSize with capped
   * upscale, centered - the node-detail panel. fontSize-scaling (not CSS transform)
   * keeps xterm's selection/click hit-testing native-correct (#6023).
   */
  fit?: "natural" | "width" | "contain";
}

export function FocusedTerminal({ sessionName, daemonBaseUrl, fit = "natural" }: FocusedTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // OPR.0.4.0.39: the fit wrapper fills the available container; the inner
  // containerRef holds the natural-sized xterm. We measure the wrapper (available)
  // vs the xterm's natural size (captured once at the base font) and set the xterm
  // fontSize so 90x27 fits - no CSS transform, so selection stays native-correct.
  const fitWrapperRef = useRef<HTMLDivElement>(null);
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const termRef = useRef<unknown>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const promptScrollUntilRef = useRef(0);
  // OPR.0.4.0.39: lines scrolled back from the live bottom (0 = live). Driven by the
  // wheel handler; the broker paints the matching tmux history window. Typing or
  // wheeling back to 0 returns to live.
  const scrollOffsetRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  // OPR.0.4.3.21 — shared daemon-health signal (context; healthy default when
  // no provider, so standalone terminal tests are unaffected). Held in a ref so
  // the ws.onclose callback reads the latest value without re-subscribing.
  const health = useDaemonHealthSignal();
  const controlPlaneUnhealthyRef = useRef(false);
  controlPlaneUnhealthyRef.current = health.controlPlaneUnhealthy;

  const sendScroll = useCallback((offset: number) => {
    const wsc = wsRef.current;
    if (wsc && wsc.readyState === WebSocket.OPEN) {
      wsc.send(JSON.stringify({ type: "scroll", offset }));
    }
  }, []);

  // OPR.0.4.0.39 (selection fix): size the xterm to its container by FONT SIZE (not a
  // CSS transform, which breaks xterm's mouse/selection coords - #6023). Reads only
  // refs so it is a stable, dependency-free callback. natural is the xterm's 90x27
  // pixel size at the base font (captured once); the wrapper is the available space.
  const applyFontSizeFit = useCallback(() => {
    const mode = fitRef.current;
    if (mode === "natural") return;
    const term = termRef.current as { options: { fontSize: number } } | null;
    const wrapper = fitWrapperRef.current;
    const natural = naturalSizeRef.current;
    if (!term || !wrapper || !natural || natural.w <= 0 || natural.h <= 0) return;
    const availW = wrapper.clientWidth;
    const availH = wrapper.clientHeight;
    if (availW <= 0) return; // not laid out yet (or jsdom) - skip, no crash
    const scale = mode === "contain" && availH > 0
      ? Math.min(MAX_FIT_UPSCALE, availW / natural.w, availH / natural.h)
      : Math.min(1, availW / natural.w); // "width": fit width, never upscale
    const nextFont = Math.max(2, LIVE_TERMINAL_FONT_SIZE * scale);
    try {
      // Only write on a meaningful change (avoids churn + ResizeObserver feedback).
      if (Math.abs(term.options.fontSize - nextFont) > 0.1) {
        term.options.fontSize = nextFont;
      }
    } catch { /* term not ready / disposed */ }
  }, []);

  const disposeTerminal = useCallback(() => {
    const term = termRef.current as { dispose(): void } | null;
    term?.dispose();
    termRef.current = null;
  }, []);

  const scrollLiveTerminalToPrompt = useCallback((term: { scrollToBottom(): void } | null) => {
    if (term) {
      term.scrollToBottom();
    }
    if (containerRef.current) {
      scrollTerminalViewportToPrompt(containerRef.current);
    }
  }, []);

  const connectForGeneration = useCallback((gen: number) => {
    const base = daemonBaseUrl ?? window.location.origin;
    const wsUrl = base.replace(/^http/, "ws");
    const token = readTerminalBearerToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`${wsUrl}/api/terminal/${encodeURIComponent(sessionName)}${tokenParam}`);

    ws.onopen = () => {
      if (generationRef.current !== gen) { ws.close(); return; }
      // The daemon broker owns fixed canonical geometry (90x27). The client keeps
      // the same grid and scrolls history server-side (per-subscriber capture-pane).
      // A (re)connect starts at the live bottom.
      scrollOffsetRef.current = 0;
      promptScrollUntilRef.current = Date.now() + 2500;
      const term = termRef.current as { scrollToBottom(): void } | null;
      scrollLiveTerminalToPrompt(term);
    };

    ws.onmessage = (evt) => {
      if (generationRef.current !== gen) return;
      const term = termRef.current as { write(data: string): void; scrollToBottom(): void } | null;
      if (typeof evt.data === "string" && term) {
        term.write(evt.data);
        if (Date.now() <= promptScrollUntilRef.current) {
          scrollLiveTerminalToPrompt(term);
        }
      }
    };

    ws.onclose = (evt) => {
      if (generationRef.current !== gen) return;
      const definitive = evt.code === 1008 || evt.code === 1011 || evt.code === 1001;
      if (definitive) {
        disposeTerminal();
        // OPR.0.4.3.21 — health-aware disambiguation: replace ONLY the broker's
        // GENERIC "terminal broker unavailable" fallback, and ONLY when daemon
        // health positively reports the control plane unhealthy. Every specific
        // broker/session reason (session not found / pipe-pane failed / tmux
        // session terminated) is preserved verbatim.
        if (evt.reason === GENERIC_BROKER_UNAVAILABLE && controlPlaneUnhealthyRef.current) {
          setError(DAEMON_CONTROL_PLANE_UNHEALTHY);
        } else {
          setError(evt.reason || "Terminal unavailable: session not found on this daemon");
        }
        return;
      }
      const term = termRef.current as { write(data: string): void } | null;
      if (term) {
        term.write("\r\n\x1b[90m[disconnected - reconnecting...]\x1b[0m\r\n");
      }
      if (mountedRef.current && generationRef.current === gen) {
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === gen) connectForGeneration(gen);
        }, 3000);
      }
    };

    wsRef.current = ws;
    return ws;
  }, [sessionName, daemonBaseUrl, disposeTerminal, scrollLiveTerminalToPrompt]);

  useEffect(() => {
    if (!containerRef.current) return;
    mountedRef.current = true;
    generationRef.current++;
    const currentGen = generationRef.current;
    let cleanedUp = false;

    (async () => {
      try {
        if (cleanedUp) return;

        const term = new Terminal({
          cursorBlink: true,
          cols: LIVE_TERMINAL_COLS,
          rows: LIVE_TERMINAL_ROWS,
          fontSize: LIVE_TERMINAL_FONT_SIZE,
          lineHeight: LIVE_TERMINAL_LINE_HEIGHT,
          fontFamily: LIVE_TERMINAL_FONT_FAMILY,
          // xterm erase/redraw needs an opaque cell background. A translucent
          // xterm render surface lets old TUI cells bleed through after clear
          // screen / absolute cursor repaint, which corrupts Claude/Codex views.
          theme: { background: LIVE_TERMINAL_RENDER_BACKGROUND, foreground: "#e0e0e0", cursor: "#e0e0e0" },
          allowTransparency: false,
          allowProposedApi: true,
        });

        term.open(containerRef.current!);
        // Some xterm DOM layers do not inherit the theme background. Pin every
        // render layer opaque so clear/erase operations actually erase.
        applyOpaqueTerminalBackground(containerRef.current!);
        term.focus();
        promptScrollUntilRef.current = Date.now() + 2500;
        scrollTerminalViewportToPrompt(containerRef.current!);
        termRef.current = term;

        term.onData((data: string) => {
          const wsc = wsRef.current;
          if (!wsc || wsc.readyState !== WebSocket.OPEN) return;
          // OPR.0.4.0.39: typing returns to the live bottom before sending input.
          if (scrollOffsetRef.current > 0) {
            scrollOffsetRef.current = 0;
            sendScroll(0);
          }
          const mapped = mapXtermInput(data);
          for (const msg of mapped) {
            wsc.send(JSON.stringify(msg));
          }
        });

        // OPR.0.4.0.39: wheel = scroll back through tmux history (server-side).
        // Up increases the offset (paints an older capture-pane window); down
        // decreases it; reaching 0 resumes live. We handle the wheel ourselves and
        // return false so xterm's local (empty) scrollback does not interfere.
        const scrollHandlerTerm = term as {
          attachCustomWheelEventHandler(handler: (ev: WheelEvent) => boolean): void;
        };
        scrollHandlerTerm.attachCustomWheelEventHandler((ev: WheelEvent) => {
          const wsc = wsRef.current;
          if (!wsc || wsc.readyState !== WebSocket.OPEN) return true;
          const STEP = 3;
          if (ev.deltaY < 0) {
            scrollOffsetRef.current += STEP;
          } else if (ev.deltaY > 0) {
            scrollOffsetRef.current = Math.max(0, scrollOffsetRef.current - STEP);
          } else {
            return true;
          }
          sendScroll(scrollOffsetRef.current);
          return false;
        });

        // OPR.0.4.0.38 FR-7: no term.onResize -> ws resize relay. The pane
        // geometry is fixed daemon-side; the client grid matches it exactly
        // and never asks the pane to resize.

        connectForGeneration(currentGen);

        // OPR.0.4.0.39 (selection fix): capture the xterm's NATURAL 90x27 pixel size
        // at the base font (before any fontSize-fit) as the fixed reference, then
        // apply the initial fit. rAF so layout has settled. Guarded for jsdom (0 size).
        requestAnimationFrame(() => {
          if (cleanedUp || !containerRef.current) return;
          if (!naturalSizeRef.current) {
            const w = containerRef.current.offsetWidth;
            const h = containerRef.current.offsetHeight;
            if (w > 0 && h > 0) naturalSizeRef.current = { w, h };
          }
          applyFontSizeFit();
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terminal initialization failed");
      }
    })();

    return () => {
      cleanedUp = true;
      mountedRef.current = false;
      generationRef.current++;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      const activeWs = wsRef.current;
      if (activeWs) { activeWs.close(); wsRef.current = null; }
      disposeTerminal();
    };
  }, [connectForGeneration, disposeTerminal]);

  // OPR.0.4.0.39 (selection fix): refit the xterm fontSize when its container resizes
  // (responsive grid columns, window resize, node-detail panel). Observes the fit
  // WRAPPER (which fills the parent), so changing the INNER xterm fontSize does not
  // feed back into the observed box. No-op in "natural" mode.
  useEffect(() => {
    if (fit === "natural") return undefined;
    const wrapper = fitWrapperRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => applyFontSizeFit());
    ro.observe(wrapper);
    applyFontSizeFit();
    return () => ro.disconnect();
  }, [fit, applyFontSizeFit]);

  if (error) {
    return (
      <div
        key={`focused-terminal-error-${sessionName}`}
        data-testid={`focused-terminal-${sessionName}`}
        className="h-full w-full min-h-[200px] flex items-center justify-center px-4 text-center text-stone-400 font-mono text-xs"
      >
        <span className="block max-w-[28ch] whitespace-normal break-all leading-relaxed">
          Terminal unavailable: {error}
        </span>
      </div>
    );
  }

  // The xterm always renders at its NATURAL full 90x27 geometry (w-max) so the WHOLE
  // screen + cursor are visible (no min-h/h-full cap that hid the bottom rows).
  const liveTerminal = (
    <div
      key={`focused-terminal-live-${sessionName}`}
      ref={containerRef}
      data-testid={`focused-terminal-${sessionName}`}
      className="w-max bg-stone-950/85 backdrop-blur-sm"
    />
  );

  // OPR.0.4.0.39 (selection fix): in "natural" mode the xterm renders at native size
  // (no scaling). In "width"/"contain" mode it is wrapped in a fit-wrapper that fills
  // the container; applyFontSizeFit sets the xterm fontSize so 90x27 fits - NO CSS
  // transform, so xterm's selection/click hit-testing stays native-correct (#6023).
  if (fit === "natural") return liveTerminal;

  return (
    <div
      ref={fitWrapperRef}
      data-testid={`focused-terminal-fit-${sessionName}`}
      className={
        fit === "contain"
          ? "flex h-full w-full items-center justify-center overflow-hidden"
          : "w-full overflow-hidden"
      }
    >
      {liveTerminal}
    </div>
  );
}
