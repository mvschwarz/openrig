import { useEffect, useRef, useCallback, useState } from "react";
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
  }, [sessionName, daemonBaseUrl]);

  useEffect(() => {
    if (!containerRef.current) return;
    mountedRef.current = true;
    generationRef.current++;
    const currentGen = generationRef.current;
    let cleanedUp = false;
    let resizeObs: ResizeObserver | undefined;

    (async () => {
      try {
        const { Terminal } = await import("@xterm/xterm");
        const { FitAddon } = await import("@xterm/addon-fit");

        if (cleanedUp) return;

        const term = new Terminal({
          cursorBlink: true,
          fontSize: 12,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          theme: { background: "#1a1a1a", foreground: "#e0e0e0", cursor: "#e0e0e0" },
          allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current!);
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
      const term = termRef.current as { dispose(): void } | null;
      term?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [connectForGeneration]);

  if (error) {
    return (
      <div
        data-testid={`focused-terminal-${sessionName}`}
        className="h-full w-full min-h-[200px] bg-[#1a1a1a] flex items-center justify-center text-stone-400 font-mono text-xs"
      >
        Terminal unavailable: {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid={`focused-terminal-${sessionName}`}
      className="h-full w-full min-h-[200px] bg-[#1a1a1a]"
    />
  );
}
