import { useState } from "react";
import { Dashboard } from "./components/Dashboard.js";
import { RigGraph } from "./components/RigGraph.js";
import { SnapshotPanel } from "./components/SnapshotPanel.js";
import { ImportFlow } from "./components/ImportFlow.js";

type View = { type: "dashboard" } | { type: "graph"; rigId: string } | { type: "import" };

export function App() {
  const [view, setView] = useState<View>({ type: "dashboard" });

  if (view.type === "graph") {
    return (
      <div className="bg-background text-foreground rounded-md" style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 8, borderBottom: "1px solid #ccc" }}>
          <button onClick={() => setView({ type: "dashboard" })}>Back to Dashboard</button>
        </div>
        <div style={{ flex: 1, display: "flex" }}>
          <div style={{ flex: 1 }}>
            <RigGraph rigId={view.rigId} />
          </div>
          <SnapshotPanel rigId={view.rigId} />
        </div>
      </div>
    );
  }

  if (view.type === "import") {
    return <ImportFlow onBack={() => setView({ type: "dashboard" })} />;
  }

  return (
    <Dashboard
      onSelectRig={(rigId) => setView({ type: "graph", rigId })}
      onImport={() => setView({ type: "import" })}
    />
  );
}
