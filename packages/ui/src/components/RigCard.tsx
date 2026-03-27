import { useCountUp } from "../hooks/useCountUp.js";
import type { PsEntry } from "../hooks/usePsEntries.js";

export interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
}

interface RigCardProps {
  rig: RigSummary;
  psEntry?: PsEntry;
  onSelect: (rigId: string) => void;
  onSnapshot: () => void;
  onExport: () => void;
  onDown?: () => void;
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

function statusColor(status: PsEntry["status"]): string {
  switch (status) {
    case "running": return "text-success";
    case "partial": return "text-warning";
    case "stopped": return "text-foreground-muted-on-dark";
  }
}

export function RigCard({ rig, psEntry, onSelect, onSnapshot, onExport, onDown }: RigCardProps) {
  const animatedCount = useCountUp(rig.nodeCount);
  const isStopped = psEntry?.status === "stopped";

  return (
    <div
      data-testid={`rig-card-${rig.id}`}
      className={`card-dark p-spacing-6 mb-spacing-3 cursor-pointer transition-all duration-150 ease-tactical hover:bg-surface-mid group ${isStopped ? "opacity-60" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(rig.id)}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onSelect(rig.id); } }}
    >
      {/* Header: name + node count */}
      <div className="flex justify-between items-baseline mb-spacing-4">
        <h3 className="text-headline-md uppercase text-foreground-on-dark">{rig.name}</h3>
        <span className="text-label-md font-mono text-foreground-muted-on-dark" data-testid={`node-count-${rig.id}`}>
          {animatedCount} NODE{rig.nodeCount !== 1 ? "S" : ""}
        </span>
      </div>

      {/* Telemetry section */}
      <div className="inset-dark p-spacing-4 mb-spacing-4">
        <div className="flex gap-spacing-8 text-label-md">
          <div>
            <span className="text-foreground-muted-on-dark/60 uppercase text-label-sm tracking-[0.06em]">SNAPSHOT </span>
            <span className="font-mono text-foreground-on-dark" data-testid={`snapshot-age-${rig.id}`}>
              {formatAge(rig.latestSnapshotAt)}
            </span>
          </div>
          <div>
            <span className="text-foreground-muted-on-dark/60 uppercase text-label-sm tracking-[0.06em]">STATUS </span>
            <span className={`font-mono ${psEntry ? statusColor(psEntry.status) : "text-foreground-muted-on-dark"}`} data-testid={`status-badge-${rig.id}`}>
              {psEntry ? psEntry.status.toUpperCase() : "—"}
            </span>
          </div>
          {psEntry?.uptime && (
            <div>
              <span className="text-foreground-muted-on-dark/60 uppercase text-label-sm tracking-[0.06em]">UPTIME </span>
              <span className="font-mono text-foreground-on-dark">{psEntry.uptime}</span>
            </div>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-spacing-2">
        <button
          className="px-spacing-3 py-spacing-1 text-label-md uppercase tracking-[0.04em] text-foreground-muted-on-dark bg-white/6 border border-white/10 hover:bg-white/12 hover:text-foreground-on-dark transition-all"
          onClick={(e) => { e.stopPropagation(); onSnapshot(); }}
        >
          SNAPSHOT
        </button>
        <button
          className="px-spacing-3 py-spacing-1 text-label-md uppercase tracking-[0.04em] text-foreground-muted-on-dark bg-white/6 border border-white/10 hover:bg-white/12 hover:text-foreground-on-dark transition-all"
          onClick={(e) => { e.stopPropagation(); onExport(); }}
        >
          EXPORT
        </button>
        {onDown && (
          <button
            data-testid={`down-btn-${rig.id}`}
            className="px-spacing-3 py-spacing-1 text-label-md uppercase tracking-[0.04em] text-destructive bg-white/6 border border-destructive/20 hover:bg-destructive/10 transition-all"
            onClick={(e) => { e.stopPropagation(); onDown(); }}
          >
            DOWN
          </button>
        )}
        <button
          className="px-spacing-3 py-spacing-1 text-label-md uppercase tracking-[0.04em] text-foreground-on-dark bg-white/10 border border-white/15 hover:bg-white/20 transition-all ml-auto"
          onClick={(e) => { e.stopPropagation(); onSelect(rig.id); }}
        >
          GRAPH &rarr;
        </button>
      </div>
    </div>
  );
}
