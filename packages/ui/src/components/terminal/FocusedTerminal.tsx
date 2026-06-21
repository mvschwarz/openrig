import { useEffect, useRef, useCallback, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { readTerminalBearerToken } from "../mission-control/missionControlAuth.js";
import "@xterm/xterm/css/xterm.css";

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

const SMOKED_TERMINAL_BACKGROUND = "rgba(12,10,9,0.6)";

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

interface FocusedTerminalProps {
  sessionName: string;
  daemonBaseUrl?: string;
}

export function FocusedTerminal({ sessionName, daemonBaseUrl }: FocusedTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<unknown>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<unknown>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const disposeTerminal = useCallback(() => {
    const term = termRef.current as { dispose(): void } | null;
    term?.dispose();
    termRef.current = null;
    fitAddonRef.current = null;
  }, []);

  const connectForGeneration = useCallback((gen: number) => {
    const base = daemonBaseUrl ?? window.location.origin;
    const wsUrl = base.replace(/^http/, "ws");
    const token = readTerminalBearerToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`${wsUrl}/api/terminal/${encodeURIComponent(sessionName)}${tokenParam}`);

    ws.onopen = () => {
      if (generationRef.current !== gen) { ws.close(); return; }
      const fitAddon = fitAddonRef.current as { fit(): void } | null;
      const term = termRef.current as { cols: number; rows: number } | null;
      if (fitAddon && term) {
        fitAddon.fit();
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    ws.onmessage = (evt) => {
      if (generationRef.current !== gen) return;
      const term = termRef.current as { write(data: string): void } | null;
      if (typeof evt.data === "string" && term) {
        term.write(evt.data);
      }
    };

    ws.onclose = (evt) => {
      if (generationRef.current !== gen) return;
      const definitive = evt.code === 1008 || evt.code === 1011 || evt.code === 1001;
      if (definitive) {
        disposeTerminal();
        setError(evt.reason || "Terminal unavailable: session not found on this daemon");
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
  }, [sessionName, daemonBaseUrl, disposeTerminal]);

  useEffect(() => {
    if (!containerRef.current) return;
    mountedRef.current = true;
    generationRef.current++;
    const currentGen = generationRef.current;
    let cleanedUp = false;
    let resizeObs: ResizeObserver | undefined;

    (async () => {
      try {
        if (cleanedUp) return;

        const term = new Terminal({
          cursorBlink: true,
          fontSize: 12,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          // OPR.0.4.0.1 styling polish (FR-1): the live terminal CONTENT carries
          // its OWN translucent smoked-black tint (stone-950 #0c0a09 at ~0.6 alpha)
          // so it reads as a floating smoked-glass plate on EVERY surface -- incl.
          // the truly-bare topology-tab + grid-popover surfaces that have no plate
          // behind them -- not only over the popover/shell backdrop-blur. Foreground
          // stays OPAQUE (#e0e0e0) so text is fully legible (AC-4 hard constraint);
          // alpha is the starting point, tuned toward opaque by QA if a busy backdrop
          // ever fights crispness. allowTransparency is required for a non-opaque bg.
          theme: { background: SMOKED_TERMINAL_BACKGROUND, foreground: "#e0e0e0", cursor: "#e0e0e0" },
          allowTransparency: true,
          allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current!);
        // xterm's viewport keeps its own default black background outside the
        // theme-painted row layer. Keep it aligned with the smoked live content
        // so live terminals do not regress to an opaque black panel.
        const viewport = containerRef.current!.querySelector<HTMLElement>(".xterm-viewport");
        if (viewport) viewport.style.backgroundColor = SMOKED_TERMINAL_BACKGROUND;
        fitAddon.fit();
        termRef.current = term;
        fitAddonRef.current = fitAddon;

        term.onData((data: string) => {
          const wsc = wsRef.current;
          if (!wsc || wsc.readyState !== WebSocket.OPEN) return;
          const mapped = mapXtermInput(data);
          for (const msg of mapped) {
            wsc.send(JSON.stringify(msg));
          }
        });

        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          const wsc = wsRef.current;
          if (!wsc || wsc.readyState !== WebSocket.OPEN) return;
          wsc.send(JSON.stringify({ type: "resize", cols, rows }));
        });

        connectForGeneration(currentGen);

        resizeObs = new ResizeObserver(() => { fitAddon.fit(); });
        resizeObs.observe(containerRef.current!);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terminal initialization failed");
      }
    })();

    return () => {
      cleanedUp = true;
      mountedRef.current = false;
      generationRef.current++;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      resizeObs?.disconnect();
      const activeWs = wsRef.current;
      if (activeWs) { activeWs.close(); wsRef.current = null; }
      disposeTerminal();
    };
  }, [connectForGeneration, disposeTerminal]);

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

  return (
    <div
      key={`focused-terminal-live-${sessionName}`}
      ref={containerRef}
      data-testid={`focused-terminal-${sessionName}`}
      className="h-full w-full min-h-[200px]"
    />
  );
}
