import { useState, useEffect } from "react";

interface StatusData {
  connected: boolean;
  rigCount: number | null;
  cmuxAvailable: boolean | null;
}

export function StatusBar() {
  const [status, setStatus] = useState<StatusData>({
    connected: false,
    rigCount: null,
    cmuxAvailable: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const healthRes = await fetch("/healthz");
        if (!healthRes.ok) throw new Error("unhealthy");

        const [summaryRes, cmuxRes] = await Promise.all([
          fetch("/api/rigs/summary").then((r) => r.ok ? r.json() : null).catch(() => null),
          fetch("/api/adapters/cmux/status").then((r) => r.ok ? r.json() : null).catch(() => null),
        ]);

        if (!cancelled) {
          setStatus({
            connected: true,
            rigCount: Array.isArray(summaryRes) ? summaryRes.length : null,
            cmuxAvailable: cmuxRes?.available ?? null,
          });
        }
      } catch {
        if (!cancelled) {
          setStatus({ connected: false, rigCount: null, cmuxAvailable: null });
        }
      }
    }

    poll();
    const interval = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return (
    <footer
      data-testid="status-bar"
      className="h-8 bg-surface-low bg-noise flex items-center px-spacing-6 gap-spacing-6 text-label-md font-grotesk shrink-0"
    >
      <span className="flex items-center gap-spacing-2">
        <span
          data-testid="health-dot"
          className={`inline-block w-2 h-2 ${status.connected ? "bg-primary" : "bg-destructive"}`}
        />
        <span data-testid="health-text" className="text-foreground-muted">
          {status.connected ? "CONNECTED" : "DISCONNECTED"}
        </span>
      </span>

      <span data-testid="rig-count" className="text-foreground-muted">
        RIGS: <span className="font-mono text-foreground">{status.rigCount ?? "—"}</span>
      </span>

      <span data-testid="cmux-status" className="text-foreground-muted">
        CMUX: <span className="font-mono text-foreground">
          {status.cmuxAvailable === null ? "—" : status.cmuxAvailable ? "OK" : "UNAVAILABLE"}
        </span>
      </span>
    </footer>
  );
}
