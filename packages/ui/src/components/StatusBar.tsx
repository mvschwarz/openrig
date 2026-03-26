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

interface StatusBarProps {
  onToggleFeed?: () => void;
  feedOpen?: boolean;
  eventCount?: number;
}

export function StatusBar({ onToggleFeed, feedOpen, eventCount }: StatusBarProps = {}) {
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

  const queryClient = useQueryClient();
  const prevConnectedRef = useRef<boolean | null>(null);
  const [reconnectPulse, setReconnectPulse] = useState(false);

  useEffect(() => {
    if (prevConnectedRef.current === false && isConnected) {
      setReconnectPulse(true);
      const timer = setTimeout(() => setReconnectPulse(false), 600);
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
      className="h-7 bg-surface-dark flex items-center px-spacing-4 gap-spacing-4 text-label-sm font-grotesk text-foreground-muted-on-dark shrink-0"
    >
      <span className="flex items-center gap-spacing-1">
        <span
          data-testid="health-dot"
          className={`inline-block w-[5px] h-[5px] ${isConnected ? "bg-success" : "bg-destructive"} ${reconnectPulse ? "status-changed" : ""}`}
        />
        <span data-testid="health-text">
          {isConnected ? "CONNECTED" : "DISCONNECTED"}
        </span>
      </span>

      <span className="text-foreground-muted-on-dark/30">&middot;</span>

      <span data-testid="rig-count">
        RIGS <span className="font-mono text-foreground-on-dark">{rigCount ?? "\u2014"}</span>
      </span>

      <span className="text-foreground-muted-on-dark/30">&middot;</span>

      <span data-testid="cmux-status">
        CMUX <span className="font-mono text-foreground-on-dark">
          {cmuxAvailable === null ? "\u2014" : cmuxAvailable ? "OK" : "UNAVAILABLE"}
        </span>
      </span>

      {onToggleFeed && (
        <>
          <span className="flex-1" />
          <button
            data-testid="feed-toggle"
            onClick={onToggleFeed}
            className="flex items-center gap-spacing-1 text-label-sm text-foreground-muted-on-dark hover:text-foreground-on-dark transition-colors duration-150 ease-tactical"
            aria-label="Toggle activity feed"
            aria-expanded={feedOpen}
          >
            ACTIVITY
            {(eventCount ?? 0) > 0 && (
              <span className="font-mono text-foreground-on-dark">{eventCount}</span>
            )}
          </button>
        </>
      )}
    </footer>
  );
}
