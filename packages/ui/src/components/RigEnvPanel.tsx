import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { RigEnvData } from "../hooks/useRigEnv.js";

interface RigEnvPanelProps {
  rigId: string;
  envData: RigEnvData;
}

export function RigEnvPanel({ rigId, envData }: RigEnvPanelProps) {
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [downPending, setDownPending] = useState(false);
  const [downResult, setDownResult] = useState<string | null>(null);

  const receipt = envData.receipt;
  const surfaces = envData.surfaces;
  const services = receipt?.services ?? [];
  const waitFor = receipt?.waitFor ?? [];

  function formatWaitTarget(target: Record<string, unknown>): string {
    if (typeof target.url === "string") return target.url;
    if (typeof target.tcp === "string") return target.tcp;
    if (typeof target.service === "string") {
      return typeof target.condition === "string"
        ? `${target.service} (${target.condition})`
        : target.service;
    }
    return JSON.stringify(target);
  }

  function deriveEnvState(): "Healthy" | "Degraded" | "Stopped" | "Unknown" {
    if (!receipt) return "Unknown";
    const allHealthyServices = services.length > 0 && services.every((s) => s.health === "healthy");
    const anyRunningServices = services.some((s) => s.status === "running");
    const allHealthyWaits = waitFor.length > 0 && waitFor.every((gate) => gate.status === "healthy");
    const anyPendingWaits = waitFor.some((gate) => gate.status === "pending");
    const anyUnhealthyWaits = waitFor.some((gate) => gate.status === "unhealthy");

    if (allHealthyServices && (waitFor.length === 0 || allHealthyWaits)) return "Healthy";
    if (anyRunningServices || anyPendingWaits) return "Degraded";
    if (anyUnhealthyWaits) return "Stopped";
    if (allHealthyWaits) return "Healthy";
    if (services.length > 0) return "Stopped";
    return "Unknown";
  }

  const envState = deriveEnvState();

  const fetchLogs = async () => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/env/logs?tail=100`);
      const data = await res.json() as { ok: boolean; output?: string; error?: string };
      if (!data.ok) {
        setLogsError(data.error ?? "Failed to fetch logs");
      } else {
        setLogs(data.output ?? "");
      }
    } catch (err) {
      setLogsError((err as Error).message);
    } finally {
      setLogsLoading(false);
    }
  };

  const stopEnv = async () => {
    setDownPending(true);
    setDownResult(null);
    try {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/env/down`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      setDownResult(data.ok ? "Environment stopped." : (data.error ?? "Failed to stop environment."));
    } catch (err) {
      setDownResult((err as Error).message);
    } finally {
      setDownPending(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto" data-testid="env-panel">
      {/* Overall env state */}
      <section className="px-4 py-3 border-b border-stone-100">
        <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-1">Environment</div>
        <div data-testid="env-state" className={`font-mono text-[12px] font-bold ${
          envState === "Healthy" ? "text-green-700"
            : envState === "Degraded" ? "text-amber-600"
            : envState === "Stopped" ? "text-red-600"
            : "text-stone-500"
        }`}>
          {envState}
        </div>
      </section>

      {/* Services */}
      {services.length > 0 && (
        <section className="px-4 py-3 border-b border-stone-100">
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Services</div>
          <div className="space-y-1">
            {services.map((svc) => (
              <div key={svc.name} className="flex items-center justify-between font-mono text-[10px]">
                <span className="text-stone-800">{svc.name}</span>
                <span className={svc.health === "healthy" ? "text-green-700" : "text-stone-500"}>
                  {svc.health ?? svc.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Health gates */}
      {waitFor.length > 0 && (
        <section className="px-4 py-3 border-b border-stone-100">
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Health Gates</div>
          <div className="space-y-2">
            {waitFor.map((gate, index) => (
              <div key={`${formatWaitTarget(gate.target)}-${index}`} className="space-y-1 font-mono text-[10px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-stone-800 break-all">{formatWaitTarget(gate.target)}</span>
                  <span className={
                    gate.status === "healthy"
                      ? "text-green-700"
                      : gate.status === "pending"
                        ? "text-amber-600"
                        : "text-red-600"
                  }>
                    {gate.status}
                  </span>
                </div>
                {gate.detail && <div className="text-stone-500 break-all">{gate.detail}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Surfaces */}
      {surfaces && (surfaces.urls?.length || surfaces.commands?.length) && (
        <section className="px-4 py-3 border-b border-stone-100">
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Surfaces</div>
          <div className="space-y-1">
            {surfaces.urls?.map((u) => (
              <div key={u.name} className="flex items-center justify-between font-mono text-[10px]">
                <span className="text-stone-800">{u.name}</span>
                <a href={u.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate ml-2">
                  {u.url}
                </a>
              </div>
            ))}
            {surfaces.commands?.map((cmd) => (
              <div key={cmd.name} className="flex items-center justify-between font-mono text-[10px]">
                <span className="text-stone-800">{cmd.name}</span>
                <span className="text-stone-500 truncate ml-2">{cmd.command}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Actions */}
      <section className="px-4 py-3 border-b border-stone-100">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void fetchLogs()} disabled={logsLoading}>
            {logsLoading ? "Loading..." : "View Logs"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void stopEnv()} disabled={downPending}>
            {downPending ? "Stopping..." : "Stop Env"}
          </Button>
        </div>
        {downResult && <div className="mt-2 font-mono text-[9px] text-stone-600">{downResult}</div>}
      </section>

      {/* Logs output */}
      {logsError && (
        <section className="px-4 py-3">
          <div className="font-mono text-[9px] text-red-600">{logsError}</div>
        </section>
      )}
      {logs !== null && !logsError && (
        <section className="px-4 py-3">
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Logs</div>
          <pre className="font-mono text-[9px] text-stone-700 whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-stone-50 p-2 border border-stone-200">
            {logs || "(empty)"}
          </pre>
        </section>
      )}
    </div>
  );
}
