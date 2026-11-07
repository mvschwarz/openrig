// V1 attempt-3 Phase 3 — system status panel for Settings>Status tab.
// Per code-map AFTER tree (NEW). Composes daemon health + cmux status
// from existing data sources.
//
// Phase 3 bounce-fix A4: restored cmux block (regression — extracted
// from original SystemPanel L52–L131 missed the cmux query + section).

import { useQuery } from "@tanstack/react-query";
import { StatusBadge } from "../ui/status-badge.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";

async function fetchHealth(): Promise<boolean> {
  const res = await fetch("/healthz");
  if (!res.ok) throw new Error("unhealthy");
  return true;
}

async function fetchCmux(): Promise<{ available: boolean }> {
  const res = await fetch("/api/adapters/cmux/status");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function SettingsSystemStatusPanel() {
  const healthQuery = useQuery({
    queryKey: ["daemon", "health"],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
    retry: false,
  });
  const cmuxQuery = useQuery({
    queryKey: ["daemon", "cmux"],
    queryFn: fetchCmux,
    refetchInterval: 30_000,
    retry: false,
  });

  const { data: rigs, isLoading: rigsLoading, error: rigsError } = useRigSummary();
  const { data: psEntries } = usePsEntries();

  const daemonConnected = healthQuery.isSuccess;
  const cmuxAvailable = daemonConnected ? (cmuxQuery.data?.available ?? null) : null;
  const totalRigs = rigs?.length ?? 0;
  const runningRigs = psEntries?.filter((p) => p.runningCount > 0).length ?? 0;

  const daemonStatus = daemonConnected
    ? "ready"
    : healthQuery.isError
      ? "error"
      : "unknown";
  const daemonLabel = daemonConnected
    ? "Connected"
    : healthQuery.isError
      ? "Unreachable"
      : healthQuery.isLoading
        ? "Checking"
        : "Disconnected";

  const cmuxStatus =
    cmuxAvailable === true ? "ready" : cmuxAvailable === false ? "degraded" : "unknown";
  const cmuxLabel =
    cmuxAvailable === true ? "Available" : cmuxAvailable === false ? "Unavailable" : "Unknown";

  return (
    <div data-testid="settings-status-panel" className="space-y-4 text-sm">
      <section className="rounded-lg border bg-surface-lowest p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-on-surface">Daemon</h2>
        <div className="mt-2 flex items-center justify-between text-sm">
          <span className="text-xs text-on-surface-variant">Reachable</span>
          <StatusBadge
            status={daemonStatus}
            label={daemonLabel}
            testId="status-daemon"
          />
        </div>
      </section>
      {/* A4 bounce-fix: cmux control row restored. */}
      <section className="rounded-lg border bg-surface-lowest p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-on-surface">Cmux control</h2>
        <div className="mt-2 flex items-center justify-between text-sm">
          <span className="text-xs text-on-surface-variant">Adapter</span>
          <StatusBadge
            status={cmuxStatus}
            label={cmuxLabel}
            testId="status-cmux"
          />
        </div>
        <div className="mt-1 text-xs text-on-surface-variant">
          OpenRig can control cmux surfaces for node open-or-focus.
        </div>
      </section>
      <section className="rounded-lg border bg-surface-lowest p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-on-surface">Rigs</h2>
        <div className="mt-2 space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-xs text-on-surface-variant">Total</span>
            <span className="text-on-surface font-medium" data-testid="status-rigs-total">{totalRigs}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-on-surface-variant">Running</span>
            <span className="text-on-surface font-medium" data-testid="status-rigs-running">{runningRigs}</span>
          </div>
          {rigsLoading && (
            <div className="text-xs text-on-surface-variant">Loading rig counts…</div>
          )}
          {rigsError && (
            <div className="text-xs text-on-surface-variant">Rig counts unavailable.</div>
          )}
        </div>
      </section>
    </div>
  );
}
