import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { readTerminalBearerToken } from "../mission-control/missionControlAuth.js";

interface FocusedTerminalProps {
  sessionName: string;
  daemonBaseUrl?: string;
}

const XTERM_KEY_MAP: Record<string, string> = {
  Enter: "C-m",
  Backspace: "BSpace",
  Tab: "Tab",
  Escape: "Escape",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Delete: "DC",
};

export function FocusedTerminal({ sessionName, daemonBaseUrl }: FocusedTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const connect = useCallback(() => {
    const base = daemonBaseUrl ?? window.location.origin;
    const wsUrl = base.replace(/^http/, "ws");
    const token = readTerminalBearerToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`${wsUrl}/api/terminal/${encodeURIComponent(sessionName)}${tokenParam}`);

    ws.onopen = () => {
      if (fitAddonRef.current && termRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = termRef.current;
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    };

    ws.onmessage = (evt) => {
      if (typeof evt.data === "string" && termRef.current) {
        termRef.current.write(evt.data);
      }
    };

    ws.onclose = () => {
      if (termRef.current) {
        termRef.current.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");
      }
    };

    wsRef.current = ws;
    return ws;
  }, [sessionName, daemonBaseUrl]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#1a1a1a",
        foreground: "#e0e0e0",
        cursor: "#e0e0e0",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.onData((data) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "text", text: data }));
    });

    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    const ws = connect();

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitAddonRef.current = null;
    };
  }, [connect]);

  return (
    <div
      ref={containerRef}
      data-testid={`focused-terminal-${sessionName}`}
      className="h-full w-full min-h-[200px] bg-[#1a1a1a]"
    />
  );
}
