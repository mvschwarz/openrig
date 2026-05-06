// V1 attempt-3 Phase 3 — system status panel for Settings>Status tab.
// Per code-map AFTER tree (NEW). Composes daemon health + cmux status
// from existing data sources.
//
// Phase 3 bounce-fix A4: restored cmux block (regression — extracted
// from original SystemPanel L52–L131 missed the cmux query + section).

import { useQuery } from "@tanstack/react-query";
import { SectionHeader } from "../ui/section-header.js";
import { StatusPip } from "../ui/status-pip.js";
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

  const daemonStatus: React.ComponentProps<typeof StatusPip>["status"] =
    daemonConnected
      ? "active"
      : healthQuery.isError
      ? "error"
      : healthQuery.isLoading
      ? "info"
      : "stopped";

  const cmuxStatus: React.ComponentProps<typeof StatusPip>["status"] =
    cmuxAvailable === true
      ? "active"
      : cmuxAvailable === false
      ? "warning"
      : "info";

  return (
    <div data-testid="settings-status-panel" className="space-y-4">
      <section>
        <SectionHeader tone="muted">Daemon</SectionHeader>
        <div className="mt-2 flex items-center justify-between font-mono text-xs">
          <span className="text-on-surface-variant">Reachable</span>
          <StatusPip
            status={daemonStatus}
            label={
              daemonConnected
                ? "OK"
                : healthQuery.isError
                ? "ERROR"
                : healthQuery.isLoading
                ? "LOADING"
                : "DISCONNECTED"
            }
            variant="pill"
            testId="status-daemon"
          />
        </div>
      </section>
      {/* A4 bounce-fix: cmux control row restored. */}
      <section>
        <SectionHeader tone="muted">Cmux control</SectionHeader>
        <div className="mt-2 flex items-center justify-between font-mono text-xs">
          <span className="text-on-surface-variant">Adapter</span>
          <StatusPip
            status={cmuxStatus}
            label={
              cmuxAvailable === true
                ? "AVAILABLE"
                : cmuxAvailable === false
                ? "UNAVAILABLE"
                : "UNKNOWN"
            }
            variant="pill"
            testId="status-cmux"
          />
        </div>
        <div className="mt-1 font-mono text-[10px] text-on-surface-variant">
          OpenRig can control cmux surfaces for node open-or-focus.
        </div>
      </section>
      <section>
        <SectionHeader tone="muted">Rigs</SectionHeader>
        <div className="mt-2 space-y-1.5 font-mono text-xs">
          <div className="flex justify-between">
            <span className="text-on-surface-variant">Total</span>
            <span className="text-stone-900 font-bold" data-testid="status-rigs-total">{totalRigs}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-on-surface-variant">Running</span>
            <span className="text-stone-900 font-bold" data-testid="status-rigs-running">{runningRigs}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
