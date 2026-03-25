import { useRef, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RigSummary } from "../hooks/useRigSummary.js";

async function fetchHealth(): Promise<boolean> {
  const res = await fetch("/healthz");
  if (!res.ok) throw new Error("unhealthy");
  return true;
}

async function fetchSummary(): Promise<RigSummary[]> {
  const res = await fetch("/api/rigs/summary");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchCmux(): Promise<{ available: boolean }> {
  const res = await fetch("/api/adapters/cmux/status");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function StatusBar() {
  const healthQuery = useQuery({
    queryKey: ["daemon", "health"],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
    retry: false,
  });

  const summaryQuery = useQuery({
    queryKey: ["rigs", "summary"],
    queryFn: fetchSummary,
    refetchInterval: 30_000,
  });

  const cmuxQuery = useQuery({
    queryKey: ["daemon", "cmux"],
    queryFn: fetchCmux,
    refetchInterval: 30_000,
  });

  const isConnected = healthQuery.isSuccess;

  // Track reconnect for pulse animation + data refresh
  const queryClient = useQueryClient();
  const prevConnectedRef = useRef<boolean | null>(null);
  const [reconnectPulse, setReconnectPulse] = useState(false);

  useEffect(() => {
    if (prevConnectedRef.current === false && isConnected) {
      // Transitioned from disconnected -> connected
      setReconnectPulse(true);
      const timer = setTimeout(() => setReconnectPulse(false), 600);
      // Immediately refresh summary + cmux on reconnect
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["daemon", "cmux"] });
      prevConnectedRef.current = isConnected;
      return () => clearTimeout(timer);
    }
    prevConnectedRef.current = isConnected;
  }, [isConnected, queryClient]);

  const rigCount = isConnected ? (summaryQuery.data?.length ?? null) : null;
  const cmuxAvailable = isConnected ? (cmuxQuery.data?.available ?? null) : null;

  return (
    <footer
      data-testid="status-bar"
      className="h-8 bg-surface-low bg-noise flex items-center px-spacing-6 gap-spacing-6 text-label-md font-grotesk shrink-0 relative"
    >
      {/* Top edge */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-ghost-border to-transparent" />

      {/* Health status */}
      <span className="flex items-center gap-spacing-2">
        <span
          data-testid="health-dot"
          className={`inline-block w-[6px] h-[6px] ${isConnected ? "bg-primary" : "bg-destructive"} ${reconnectPulse ? "status-changed" : ""} ${isConnected ? "status-dot-running" : ""}`}
        />
        <span
          data-testid="health-text"
          className={isConnected ? "text-foreground-muted" : "text-destructive"}
        >
          {isConnected ? "CONNECTED" : "DISCONNECTED"}
        </span>
      </span>

      {/* Separator dot */}
      <span className="text-foreground-muted opacity-30">&middot;</span>

      <span data-testid="rig-count" className="text-foreground-muted uppercase">
        RIGS <span className="font-mono text-foreground">{rigCount ?? "\u2014"}</span>
      </span>

      <span className="text-foreground-muted opacity-30">&middot;</span>

      <span data-testid="cmux-status" className="text-foreground-muted uppercase">
        CMUX <span className="font-mono text-foreground">
          {cmuxAvailable === null ? "\u2014" : cmuxAvailable ? "OK" : "UNAVAILABLE"}
        </span>
      </span>

      {/* Right-aligned timestamp */}
      <span className="ml-auto text-label-sm font-mono text-foreground-muted opacity-30">
        {new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}
      </span>
    </footer>
  );
}
