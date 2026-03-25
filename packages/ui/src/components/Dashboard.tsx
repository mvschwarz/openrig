import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useRigSummary } from "../hooks/useRigSummary.js";
import { useCreateSnapshot } from "../hooks/mutations.js";
import { RigCard } from "./RigCard.js";

export function Dashboard() {
  const navigate = useNavigate();
  const { data: rigs, isPending, error } = useRigSummary();
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeSnapshotRig, setActiveSnapshotRig] = useState<string | null>(null);

  const handleExport = async (rigId: string) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/rigs/${rigId}/spec`);
      if (!res.ok) {
        setActionError(`Export failed (HTTP ${res.status})`);
        return;
      }
      const yaml = await res.text();
      const blob = new Blob([yaml], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${rigId}.yaml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Export failed");
    }
  };

  if (isPending) return <div>Loading dashboard...</div>;
  if (error) return <div>Error: {error.message}</div>;

  if (!rigs || rigs.length === 0) {
    return (
      <div className="p-spacing-8 text-center">
        <div className="text-foreground-muted">No rigs</div>
        <button onClick={() => navigate({ to: "/import" })} className="mt-spacing-4">
          Import Rig
        </button>
      </div>
    );
  }

  return (
    <div className="p-spacing-4">
      <div className="flex justify-between mb-spacing-4">
        <h2 className="text-headline-md uppercase">Rigs</h2>
        <button onClick={() => navigate({ to: "/import" })}>Import Rig</button>
      </div>
      {actionError && <div className="text-destructive mb-spacing-2">{actionError}</div>}
      {rigs.map((rig) => (
        <DashboardRigCard
          key={rig.id}
          rig={rig}
          onSelect={(rigId) => navigate({ to: "/rigs/$rigId", params: { rigId } })}
          onExport={handleExport}
          onActionError={setActionError}
        />
      ))}
    </div>
  );
}

/** Wrapper that provides the useCreateSnapshot mutation per rig */
function DashboardRigCard({
  rig,
  onSelect,
  onExport,
  onActionError,
}: {
  rig: { id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null };
  onSelect: (rigId: string) => void;
  onExport: (rigId: string) => void;
  onActionError: (error: string | null) => void;
}) {
  const createSnapshot = useCreateSnapshot(rig.id);

  const handleSnapshot = () => {
    onActionError(null);
    createSnapshot.mutate(undefined, {
      onError: (err) => onActionError(err.message),
    });
  };

  return (
    <RigCard
      rig={rig}
      onSelect={onSelect}
      onSnapshot={handleSnapshot}
      onExport={onExport}
    />
  );
}
