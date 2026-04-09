import { useCountUp } from "../hooks/useCountUp.js";
import type { PsEntry } from "../hooks/usePsEntries.js";

export interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  hasServices?: boolean;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
}

interface RigCardProps {
  rig: RigSummary;
  psEntry?: PsEntry;
  onSelect: (rigId: string) => void;
  onSnapshot: () => void;
  onExport: () => void;
  onDown: () => void;
}

function formatAge(timestamp: string | null): string {
  if (!timestamp) return "none";
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function RigCard({ rig, psEntry, onSelect, onSnapshot, onExport, onDown }: RigCardProps) {
  const animatedCount = useCountUp(rig.nodeCount);
  const isRunning = psEntry && psEntry.runningCount > 0;
  const statusLabel = isRunning ? "RUNNING" : "STOPPED";

  return (
    <div
      data-testid={`rig-card-${rig.id}`}
      className="bg-white border border-stone-900 hard-shadow mb-spacing-4 cursor-pointer hover:hard-shadow-hover transition-all relative"
      role="button"
      tabIndex={0}
      onClick={() => onSelect(rig.id)}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onSelect(rig.id); } }}
    >
      {/* Dark header stripe */}
      <div className="bg-stone-900 text-white px-4 py-1.5 font-mono text-[10px] flex justify-between items-center">
        <span>RIG: {rig.name.toUpperCase()}</span>
        <span className="material-symbols-outlined text-[12px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 300" }}>
          settings
        </span>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        {/* Name + status */}
        <div className="flex justify-between items-end border-b border-stone-100 pb-2">
          <span className="font-headline font-bold text-lg tracking-tight uppercase">{rig.name}</span>
          <span className={`px-2 py-0.5 border font-mono text-[8px] uppercase ${
            isRunning ? "border-stone-900" : "border-stone-400 text-stone-400"
          }`}>
            {statusLabel}
          </span>
        </div>

        {/* Telemetry grid */}
        <div className="space-y-1">
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>NODES</span>
            <span data-testid={`node-count-${rig.id}`}>{animatedCount}</span>
          </div>
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>SNAPSHOT</span>
            <span data-testid={`snapshot-age-${rig.id}`}>{formatAge(rig.latestSnapshotAt)}</span>
          </div>
          {psEntry && psEntry.uptime != null && (
            <div className="flex justify-between font-mono text-[9px] text-secondary">
              <span>UPTIME</span>
              <span>{psEntry.uptime}</span>
            </div>
          )}
        </div>

        {/* Status indicator */}
        {isRunning && (
          <div className="bg-success/10 border border-success/20 px-2 py-1 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-success" />
            <span className="font-mono text-[9px] text-success font-bold">ACTIVE</span>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-spacing-2 pt-1">
          <button
            className="px-2 py-0.5 border border-outline font-mono text-[9px] text-secondary hover:border-stone-900 hover:text-stone-900 transition-colors"
            onClick={(e) => { e.stopPropagation(); onSnapshot(); }}
          >
            SNAPSHOT
          </button>
          <button
            className="px-2 py-0.5 border border-outline font-mono text-[9px] text-secondary hover:border-stone-900 hover:text-stone-900 transition-colors"
            onClick={(e) => { e.stopPropagation(); onExport(); }}
          >
            EXPORT
          </button>
          {isRunning && (
            <button
              className="px-2 py-0.5 border border-tertiary/30 font-mono text-[9px] text-tertiary hover:bg-tertiary hover:text-white transition-colors"
              onClick={(e) => { e.stopPropagation(); onDown(); }}
            >
              DOWN
            </button>
          )}
          <button
            className="px-2 py-0.5 bg-stone-900 text-white font-mono text-[9px] hover:bg-stone-800 transition-colors ml-auto"
            onClick={(e) => { e.stopPropagation(); onSelect(rig.id); }}
          >
            GRAPH &rarr;
          </button>
        </div>
      </div>
    </div>
  );
}
