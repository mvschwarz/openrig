import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ServerCog } from "lucide-react";
import { LogFeedList } from "./ActivityFeed.js";
import { SettingsTab } from "./system/SettingsTab.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";
import { ToolMark } from "./graphics/RuntimeMark.js";
// OPR.0.4.3.21 — the ONE daemon-health source (shared with the live terminal's
// control-plane-unhealthy disambiguation) instead of a panel-local /healthz poll.
import { useDaemonHealth } from "../hooks/useDaemonHealth.js";

type SystemTab = "log" | "status" | "settings";

async function fetchCmux(): Promise<{ available: boolean }> {
  const res = await fetch("/api/adapters/cmux/status");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface SystemPanelProps {
  onClose: () => void;
  events: ActivityEvent[];
  initialTab?: SystemTab;
}

function statusTone(ok: boolean | null): string {
  if (ok === null) return "text-on-surface-variant";
  return ok ? "text-green-600" : "text-amber-600";
}

function statusLabel(ok: boolean | null, positive: string, negative: string, unknown = "unknown"): string {
  if (ok === null) return unknown;
  return ok ? positive : negative;
}

// OPR.0.4.3.21 forward-fix — the daemon health surface is honest about the
// wedge condition: a daemon whose /healthz answers (process present) but whose
// event-loop verdict is `healthy:false` renders UNHEALTHY-with-evidence, NOT
// "connected". `unavailable` = /healthz did not answer; `unknown` = still
// loading.
type DaemonUiState = "unknown" | "connected" | "unhealthy" | "unavailable";

function daemonStateTone(state: DaemonUiState): string {
  switch (state) {
    case "connected": return "text-green-600";
    case "unhealthy": return "text-amber-600";
    case "unavailable": return "text-amber-600";
    default: return "text-on-surface-variant";
  }
}

function daemonStateLabel(state: DaemonUiState): string {
  switch (state) {
    case "connected": return "connected";
    case "unhealthy": return "process present, unhealthy";
    case "unavailable": return "unavailable";
    default: return "unknown";
  }
}

export function SystemPanel({ onClose, events, initialTab = "log" }: SystemPanelProps) {
  const [activeTab, setActiveTab] = useState<SystemTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const { query: healthQuery, signal: healthSignal } = useDaemonHealth();

  const cmuxQuery = useQuery({
    queryKey: ["daemon", "cmux"],
    queryFn: fetchCmux,
    refetchInterval: 30_000,
    retry: false,
  });

  // OPR.0.4.3.21 forward-fix — derive from isSuccess AND the event-loop verdict.
  // The healthy/connected path is unchanged when eventLoop.healthy !== false.
  const eventLoopUnhealthy = healthQuery.isSuccess && healthSignal.evidence?.healthy === false;
  const daemonState: DaemonUiState =
    eventLoopUnhealthy ? "unhealthy"
    : healthQuery.isSuccess ? "connected"
    : healthQuery.isError ? "unavailable"
    : "unknown";
  // cmux status is only meaningful once the daemon answered (present), whether
  // or not its event loop is starved.
  const daemonResponded = healthQuery.isSuccess;
  const cmuxAvailable = daemonResponded ? (cmuxQuery.data?.available ?? null) : null;

  return (
    <aside
      data-testid="system-panel"
      className="absolute inset-y-0 right-0 z-20 w-80 border-l border-outline-variant/25 bg-[hsl(var(--background)/0.035)] supports-[backdrop-filter]:bg-[hsl(var(--background)/0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/35 shrink-0">
        <h2 className="min-w-0 font-mono text-xs font-bold text-on-surface truncate">system</h2>
        <button
          data-testid="system-close"
          onClick={onClose}
          className="text-on-surface-variant hover:text-on-surface text-sm"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex border-b border-outline-variant/35 shrink-0" data-testid="system-tabs">
        <button
          data-testid="system-tab-log"
          onClick={() => setActiveTab("log")}
          className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "log" ? "border-b-2 border-on-surface font-bold text-on-surface" : "text-on-surface-variant"}`}
        >
          Recent Log
        </button>
        <button
          data-testid="system-tab-status"
          onClick={() => setActiveTab("status")}
          className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "status" ? "border-b-2 border-on-surface font-bold text-on-surface" : "text-on-surface-variant"}`}
        >
          Status
        </button>
        <button
          data-testid="system-tab-settings"
          onClick={() => setActiveTab("settings")}
          className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "settings" ? "border-b-2 border-on-surface font-bold text-on-surface" : "text-on-surface-variant"}`}
        >
          Settings
        </button>
      </div>

      {activeTab === "log" && (
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden" data-testid="system-log-tab">
          <LogFeedList events={events} />
        </div>
      )}
      {activeTab === "status" && (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4" data-testid="system-status-tab">
          <section className="border border-outline-variant/28 bg-surface-lowest/[0.12] px-3 py-3">
            <div className="font-mono text-[8px] text-on-surface-variant uppercase tracking-wider mb-3">Runtime</div>
            <div className="space-y-3 font-mono text-[10px]">
              <div className="flex items-start gap-3">
                <ServerCog className={`mt-[1px] h-3.5 w-3.5 shrink-0 ${daemonStateTone(daemonState)}`} />
                <div className="min-w-0">
                  <div className="text-on-surface">Daemon</div>
                  <div data-testid="system-daemon-status" className={daemonStateTone(daemonState)}>
                    {daemonStateLabel(daemonState)}
                  </div>
                  {/* OPR.0.4.3.21 forward-fix — show the event-loop evidence
                      when the process is present but the loop is starved. */}
                  {eventLoopUnhealthy && healthSignal.evidence && (
                    <div data-testid="system-daemon-evidence" className="text-amber-600">
                      event loop starved — lag {healthSignal.evidence.lagMeanMs.toFixed(0)}ms,
                      last-tick {healthSignal.evidence.lastTickAgeMs.toFixed(0)}ms
                    </div>
                  )}
                  <div className="text-on-surface-variant">Controls the local OpenRig daemon connection.</div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <ToolMark tool="cmux" size="sm" className={`mt-[1px] ${statusTone(cmuxAvailable)}`} />
                <div className="min-w-0">
                  <div className="text-on-surface">cmux control</div>
                  <div data-testid="system-cmux-status" className={statusTone(cmuxAvailable)}>
                    {statusLabel(cmuxAvailable, "available", "unavailable")}
                  </div>
                  <div className="text-on-surface-variant">OpenRig can control cmux surfaces for node open-or-focus.</div>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
      {activeTab === "settings" && <SettingsTab />}
    </aside>
  );
}
