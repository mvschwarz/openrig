// V1 attempt-3 Phase 3 — system status panel for Settings>Status tab.
// Per code-map AFTER tree (NEW). Composes daemon health + cmux status
// from existing data sources.

import { SectionHeader } from "../ui/section-header.js";
import { StatusPip } from "../ui/status-pip.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";

export function SettingsSystemStatusPanel() {
  const { data: rigs, isLoading: rigsLoading, error: rigsError } = useRigSummary();
  const { data: psEntries } = usePsEntries();

  const daemonReachable = !rigsError && !rigsLoading;
  const totalRigs = rigs?.length ?? 0;
  const runningRigs = psEntries?.filter((p) => p.runningCount > 0).length ?? 0;

  return (
    <div data-testid="settings-status-panel" className="space-y-4">
      <section>
        <SectionHeader tone="muted">Daemon</SectionHeader>
        <div className="mt-2 flex items-center justify-between font-mono text-xs">
          <span className="text-on-surface-variant">Reachable</span>
          <StatusPip
            status={daemonReachable ? "active" : "error"}
            label={daemonReachable ? "OK" : rigsError ? "ERROR" : "LOADING"}
            variant="pill"
            testId="status-daemon"
          />
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
