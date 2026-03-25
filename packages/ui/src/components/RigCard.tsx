interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
}

interface RigCardProps {
  rig: RigSummary;
  onSelect: (rigId: string) => void;
  onSnapshot: (rigId: string) => void;
  onExport: (rigId: string) => void;
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

export function RigCard({ rig, onSelect, onSnapshot, onExport }: RigCardProps) {
  return (
    <div
      data-testid={`rig-card-${rig.id}`}
      onClick={() => onSelect(rig.id)}
      style={{
        border: "1px solid #ccc",
        borderRadius: 8,
        padding: 16,
        cursor: "pointer",
        marginBottom: 8,
      }}
    >
      <div style={{ fontWeight: "bold", fontSize: 16 }}>{rig.name}</div>
      <div>{rig.nodeCount} node(s)</div>
      <div data-testid={`snapshot-age-${rig.id}`}>
        Snapshot: {formatAge(rig.latestSnapshotAt)}
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <button
          onClick={(e) => { e.stopPropagation(); onSnapshot(rig.id); }}
        >
          Snapshot
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onExport(rig.id); }}
        >
          Export
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onSelect(rig.id); }}
        >
          View Graph
        </button>
      </div>
    </div>
  );
}
