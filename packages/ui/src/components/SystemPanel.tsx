import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PanelsTopLeft, ServerCog } from "lucide-react";
import { LogFeedList } from "./ActivityFeed.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";

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

interface SystemPanelProps {
  onClose: () => void;
  events: ActivityEvent[];
  initialTab?: "log" | "status";
}

function statusTone(ok: boolean | null): string {
  if (ok === null) return "text-stone-500";
  return ok ? "text-green-600" : "text-amber-600";
}

function statusLabel(ok: boolean | null, positive: string, negative: string, unknown = "unknown"): string {
  if (ok === null) return unknown;
  return ok ? positive : negative;
}

export function SystemPanel({ onClose, events, initialTab = "log" }: SystemPanelProps) {
  const [activeTab, setActiveTab] = useState<"log" | "status">(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

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

  const daemonConnected = healthQuery.isSuccess;
  const cmuxAvailable = daemonConnected ? (cmuxQuery.data?.available ?? null) : null;

  return (
    <aside
      data-testid="system-panel"
      className="absolute inset-y-0 right-0 z-20 w-80 border-l border-stone-300/25 bg-[rgba(250,249,245,0.035)] supports-[backdrop-filter]:bg-[rgba(250,249,245,0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-300/35 shrink-0">
        <h2 className="min-w-0 font-mono text-xs font-bold text-stone-900 truncate">system</h2>
        <button
          data-testid="system-close"
          onClick={onClose}
          className="text-stone-400 hover:text-stone-900 text-sm"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex border-b border-stone-300/35 shrink-0" data-testid="system-tabs">
        <button
          data-testid="system-tab-log"
          onClick={() => setActiveTab("log")}
          className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "log" ? "border-b-2 border-stone-800 font-bold text-stone-900" : "text-stone-400"}`}
        >
          Recent Log
        </button>
        <button
          data-testid="system-tab-status"
          onClick={() => setActiveTab("status")}
          className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "status" ? "border-b-2 border-stone-800 font-bold text-stone-900" : "text-stone-400"}`}
        >
          Status
        </button>
      </div>

      {activeTab === "log" ? (
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden" data-testid="system-log-tab">
          <LogFeedList events={events} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4" data-testid="system-status-tab">
          <section className="border border-stone-300/28 bg-white/12 px-3 py-3">
            <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-3">Runtime</div>
            <div className="space-y-3 font-mono text-[10px]">
              <div className="flex items-start gap-3">
                <ServerCog className={`mt-[1px] h-3.5 w-3.5 shrink-0 ${statusTone(daemonConnected)}`} />
                <div className="min-w-0">
                  <div className="text-stone-900">Daemon</div>
                  <div data-testid="system-daemon-status" className={statusTone(daemonConnected)}>
                    {statusLabel(daemonConnected, "connected", "unavailable")}
                  </div>
                  <div className="text-stone-500">Controls the local OpenRig daemon connection.</div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <PanelsTopLeft className={`mt-[1px] h-3.5 w-3.5 shrink-0 ${statusTone(cmuxAvailable)}`} />
                <div className="min-w-0">
                  <div className="text-stone-900">cmux</div>
                  <div data-testid="system-cmux-status" className={statusTone(cmuxAvailable)}>
                    {statusLabel(cmuxAvailable, "available", "unavailable")}
                  </div>
                  <div className="text-stone-500">Enables cmux surface focus and transport-aware workflows.</div>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
