import { useRigSummary, type RigSummary } from "../hooks/useRigSummary.js";
import { usePsEntries, type PsEntry } from "../hooks/usePsEntries.js";

interface RigDetailPanelProps {
  rigId: string;
  onClose: () => void;
}

function formatSnapshotAge(timestamp: string | null): string {
  if (!timestamp) return "No snapshots";
  const age = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(age / 60000);
  if (minutes < 1) return "< 1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function RigDetailPanel({ rigId, onClose }: RigDetailPanelProps) {
  const { data: summaries } = useRigSummary();
  const { data: psEntries } = usePsEntries();

  const summary: RigSummary | undefined = summaries?.find((s) => s.id === rigId);
  const ps: PsEntry | undefined = psEntries?.find((p) => p.rigId === rigId);

  return (
    <aside
      data-testid="rig-detail-panel"
      className="w-80 shrink-0 border-l border-stone-300 bg-background overflow-y-auto"
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-stone-200">
        <div className="min-w-0">
          <h2 className="font-headline font-bold text-base truncate">
            {summary?.name ?? rigId}
          </h2>
          <p className="text-xs text-stone-500 font-mono truncate">{rigId}</p>
        </div>
        <button
          data-testid="close-drawer"
          onClick={onClose}
          className="p-1 hover:bg-stone-200 transition-colors text-stone-400 shrink-0"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {/* Status */}
      <div className="p-4 space-y-3">
        <div>
          <div className="text-xs font-bold uppercase text-stone-500 mb-1">Status</div>
          <div className="font-mono text-sm">
            {ps?.status ?? "unknown"}
          </div>
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-stone-500 mb-1">Nodes</div>
          <div className="font-mono text-sm">
            {ps ? `${ps.runningCount}/${ps.nodeCount} running` : `${summary?.nodeCount ?? 0} total`}
          </div>
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-stone-500 mb-1">Latest Snapshot</div>
          <div className="font-mono text-sm">
            {formatSnapshotAge(summary?.latestSnapshotAt ?? null)}
          </div>
        </div>
      </div>
    </aside>
  );
}
