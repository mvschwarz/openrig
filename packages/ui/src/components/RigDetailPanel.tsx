import { useState } from "react";
import { useRigSummary, type RigSummary } from "../hooks/useRigSummary.js";
import { usePsEntries, type PsEntry } from "../hooks/usePsEntries.js";
import { useSnapshots } from "../hooks/useSnapshots.js";
import { useCreateSnapshot, useRestoreSnapshot } from "../hooks/mutations.js";
import { getRestoreStatusColorClass } from "../lib/restore-status-colors.js";
import { shortId } from "../lib/display-id.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface RestoreNodeResult {
  nodeId: string;
  logicalId: string;
  status: string;
  error?: string;
}

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
  const { data: snapshots = [], isPending: snapshotsLoading, error: snapshotsFetchError } = useSnapshots(rigId);
  const createSnapshot = useCreateSnapshot(rigId);
  const restoreSnapshot = useRestoreSnapshot(rigId);

  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreNodeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary: RigSummary | undefined = summaries?.find((s) => s.id === rigId);
  const ps: PsEntry | undefined = psEntries?.find((p) => p.rigId === rigId);

  const handleCreate = () => {
    setError(null);
    createSnapshot.mutate(undefined, {
      onError: (err) => setError(err.message),
    });
  };

  const handleRestore = (snapshotId: string) => {
    setError(null);
    setRestoreResult(null);
    restoreSnapshot.mutate(snapshotId, {
      onSuccess: (data) => {
        setRestoreResult((data as { nodes?: RestoreNodeResult[] }).nodes ?? []);
        setConfirmRestore(null);
      },
      onError: (err) => {
        setError(err.message);
        setConfirmRestore(null);
      },
    });
  };

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
          <p data-testid="rig-full-id" className="text-xs text-stone-500 font-mono truncate">{rigId}</p>
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
      <div className="p-4 space-y-3 border-b border-stone-200">
        <div>
          <div className="text-xs font-bold uppercase text-stone-500 mb-1">Status</div>
          <div className="font-mono text-sm">{ps?.status ?? "unknown"}</div>
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

      {/* Snapshots */}
      <div className="p-4">
        <div className="flex justify-between items-center mb-3">
          <div className="text-xs font-bold uppercase text-stone-500">
            Snapshots ({snapshots.length})
          </div>
          <button
            data-testid="create-snapshot"
            onClick={handleCreate}
            disabled={createSnapshot.isPending}
            className="px-2 py-0.5 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200"
          >
            {createSnapshot.isPending ? "Creating..." : "Create"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div data-testid="snapshot-error" className="mb-2 p-2 bg-red-50 border border-red-200 font-mono text-[9px] text-red-700">
            {error}
          </div>
        )}

        {/* Restore result */}
        {restoreResult && (
          <div data-testid="restore-result" className="mb-3 p-2 bg-stone-50 border border-stone-200">
            <div className="font-mono text-[9px] text-stone-500 uppercase mb-1">Restore Complete</div>
            {restoreResult.map((n) => (
              <div key={n.nodeId} className="flex items-center justify-between font-mono text-[10px]">
                <span>{n.logicalId}</span>
                <span className={getRestoreStatusColorClass(n.status)} data-testid={`restore-status-${n.logicalId}`}>
                  {n.status}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Snapshot fetch error */}
        {snapshotsFetchError && (
          <div data-testid="snapshot-fetch-error" className="mb-2 p-2 bg-red-50 border border-red-200 font-mono text-[9px] text-red-700">
            Failed to load snapshots
          </div>
        )}

        {/* Snapshot list */}
        {snapshotsLoading ? (
          <div className="font-mono text-[10px] text-stone-400 py-2 text-center">Loading snapshots...</div>
        ) : snapshots.length === 0 && !snapshotsFetchError ? (
          <div className="font-mono text-[10px] text-stone-400 py-2 text-center italic">
            No snapshots yet
          </div>
        ) : (
          <div className="space-y-1">
            {snapshots.map((snap) => (
              <div key={snap.id} className="p-2 bg-stone-50 hover:bg-stone-100 transition-colors">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-mono text-[10px] font-bold" data-testid={`snap-short-${snap.id}`}>
                      {shortId(snap.id)}
                    </div>
                    <div className="font-mono text-[8px] text-stone-400 truncate" data-testid={`snap-full-${snap.id}`}>
                      {snap.id}
                    </div>
                    <div className="font-mono text-[9px] text-stone-400 mt-0.5">
                      {snap.kind} · {formatSnapshotAge(snap.createdAt)}
                    </div>
                  </div>
                  <button
                    data-testid={`restore-btn-${snap.id}`}
                    onClick={() => setConfirmRestore(snap.id)}
                    className="font-mono text-[8px] border border-stone-300 px-1 py-0.5 hover:bg-stone-200"
                  >
                    Restore
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Restore confirmation dialog */}
      <Dialog open={confirmRestore !== null} onOpenChange={(open) => { if (!open) setConfirmRestore(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-headline text-lg font-bold uppercase">Restore Snapshot</DialogTitle>
            <DialogDescription className="text-sm text-stone-500">
              Restore from {confirmRestore ? shortId(confirmRestore) : ""}? Existing sessions will be restarted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRestore(null)}>Cancel</Button>
            <Button
              variant="default"
              data-testid={confirmRestore ? `confirm-restore-${confirmRestore}` : undefined}
              onClick={() => confirmRestore && handleRestore(confirmRestore)}
            >
              Confirm Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
