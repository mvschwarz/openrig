import { useState } from "react";
import { useSnapshots } from "../hooks/useSnapshots.js";
import { useCreateSnapshot, useRestoreSnapshot } from "../hooks/mutations.js";

interface RestoreNodeResult {
  nodeId: string;
  logicalId: string;
  status: string;
  error?: string;
}

interface SnapshotPanelProps {
  rigId: string;
}

export function SnapshotPanel({ rigId }: SnapshotPanelProps) {
  const { data: snapshots = [], isPending: loading, error: fetchError } = useSnapshots(rigId);
  const createSnapshot = useCreateSnapshot(rigId);
  const restoreSnapshot = useRestoreSnapshot(rigId);

  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreNodeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div data-testid="snapshot-panel" style={{ padding: 16, borderLeft: "1px solid #ccc", minWidth: 280 }}>
      <h3>Snapshots</h3>
      <button onClick={handleCreate} disabled={createSnapshot.isPending}>
        {createSnapshot.isPending ? "Creating..." : "Create Snapshot"}
      </button>

      {(error ?? fetchError?.message) && (
        <div data-testid="restore-error" style={{ color: "red", marginTop: 8 }}>
          {error ?? fetchError?.message}
        </div>
      )}

      {restoreResult && (
        <div data-testid="restore-result" style={{ marginTop: 8 }}>
          <strong>Restore complete:</strong>
          {restoreResult.map((n) => (
            <div key={n.nodeId}>{n.logicalId}: {n.status}</div>
          ))}
        </div>
      )}

      {restoreSnapshot.isPending && <div data-testid="restore-loading">Restoring...</div>}

      {loading ? (
        <div>Loading snapshots...</div>
      ) : snapshots.length === 0 ? (
        <div>No snapshots</div>
      ) : (
        <div style={{ marginTop: 8 }}>
          {snapshots.map((snap) => (
            <div key={snap.id} style={{ marginBottom: 8, padding: 8, border: "1px solid #eee", borderRadius: 4 }}>
              <div>{snap.id.slice(0, 12)}</div>
              <div>{snap.kind} · {snap.status} · {snap.createdAt}</div>
              {confirmRestore === snap.id ? (
                <div style={{ marginTop: 4 }}>
                  <span>Restore this snapshot?</span>
                  <button
                    data-testid={`confirm-restore-${snap.id}`}
                    onClick={() => handleRestore(snap.id)}
                    style={{ marginLeft: 8 }}
                  >
                    Confirm
                  </button>
                  <button
                    data-testid={`cancel-restore-${snap.id}`}
                    onClick={() => setConfirmRestore(null)}
                    style={{ marginLeft: 4 }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  data-testid={`restore-btn-${snap.id}`}
                  onClick={() => setConfirmRestore(snap.id)}
                  style={{ marginTop: 4 }}
                >
                  Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
