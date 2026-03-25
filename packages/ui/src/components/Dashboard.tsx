import { useState, useEffect } from "react";
import { RigCard } from "./RigCard.js";

interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
}

interface DashboardProps {
  onSelectRig: (rigId: string) => void;
  onImport: () => void;
}

export function Dashboard({ onSelectRig, onImport }: DashboardProps) {
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

  const handleSnapshot = async (rigId: string) => {
    await fetch(`/api/rigs/${rigId}/snapshots`, { method: "POST" });
  };

  const handleExport = async (rigId: string) => {
    const res = await fetch(`/api/rigs/${rigId}/spec`);
    if (!res.ok) return;
    const yaml = await res.text();
    const blob = new Blob([yaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${rigId}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div>Loading dashboard...</div>;
  if (error) return <div>Error: {error}</div>;

  if (rigs.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: "center" }}>
        <div>No rigs</div>
        <button onClick={onImport} style={{ marginTop: 16 }}>Import Rig</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2>Rigs</h2>
        <button onClick={onImport}>Import Rig</button>
      </div>
      {rigs.map((rig) => (
        <RigCard
          key={rig.id}
          rig={rig}
          onSelect={onSelectRig}
          onSnapshot={handleSnapshot}
          onExport={handleExport}
        />
      ))}
    </div>
  );
}
