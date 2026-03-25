import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { RigCard } from "./RigCard.js";

interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
}

export function Dashboard() {
  const navigate = useNavigate();
  const [rigs, setRigs] = useState<RigSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/rigs/summary");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setRigs(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [actionError, setActionError] = useState<string | null>(null);

  const handleSnapshot = async (rigId: string) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/rigs/${rigId}/snapshots`, { method: "POST" });
      if (!res.ok) {
        setActionError(`Snapshot failed (HTTP ${res.status})`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Snapshot failed");
    }
  };

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

  if (loading) return <div>Loading dashboard...</div>;
  if (error) return <div>Error: {error}</div>;

  if (rigs.length === 0) {
    return (
      <div className="p-spacing-8 text-center">
        <div className="text-foreground-muted">No rigs</div>
        <button
          onClick={() => navigate({ to: "/import" })}
          className="mt-spacing-4"
        >
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
        <RigCard
          key={rig.id}
          rig={rig}
          onSelect={(rigId) => navigate({ to: "/rigs/$rigId", params: { rigId } })}
          onSnapshot={handleSnapshot}
          onExport={handleExport}
        />
      ))}
    </div>
  );
}
