import { useState } from "react";
import { RigGraph } from "./components/RigGraph.js";
import { useRigs } from "./hooks/useRigs.js";

export function App() {
  const { rigs, loading, error } = useRigs();
  const [userSelectedRigId, setUserSelectedRigId] = useState<string | null>(null);

  if (loading) {
    return <div>Loading rigs...</div>;
  }

  if (error) {
    return <div>Error loading rigs: {error}</div>;
  }

  if (rigs.length === 0) {
    return <div>No rigs found — create one via the API</div>;
  }

  // Derive effective rigId synchronously — no flash to null
  // If user hasn't explicitly selected, use the first rig
  const effectiveRigId =
    userSelectedRigId && rigs.some((r) => r.id === userSelectedRigId)
      ? userSelectedRigId
      : rigs[0]!.id;

  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 8, borderBottom: "1px solid #ccc", display: "flex", alignItems: "center", gap: 8 }}>
        <label htmlFor="rig-select">Rig:</label>
        <select
          id="rig-select"
          value={effectiveRigId}
          onChange={(e) => setUserSelectedRigId(e.target.value)}
        >
          {rigs.map((rig) => (
            <option key={rig.id} value={rig.id}>
              {rig.name} ({rig.id.slice(0, 8)})
            </option>
          ))}
        </select>
      </div>
      <div style={{ flex: 1 }}>
        <RigGraph rigId={effectiveRigId} />
      </div>
    </div>
  );
}
