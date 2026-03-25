import { useState } from "react";
import { Dashboard } from "./components/Dashboard.js";
import { RigGraph } from "./components/RigGraph.js";

type View = { type: "dashboard" } | { type: "graph"; rigId: string } | { type: "import" };

export function App() {
  const [view, setView] = useState<View>({ type: "dashboard" });

  if (view.type === "graph") {
    return (
      <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 8, borderBottom: "1px solid #ccc" }}>
          <button onClick={() => setView({ type: "dashboard" })}>Back to Dashboard</button>
        </div>
        <div style={{ flex: 1 }}>
          <RigGraph rigId={view.rigId} />
        </div>
      </div>
    );
  }

  if (view.type === "import") {
    return (
      <div style={{ padding: 32 }}>
        <button onClick={() => setView({ type: "dashboard" })}>Back to Dashboard</button>
        <div style={{ marginTop: 16 }}>Import flow placeholder</div>
      </div>
    );
  }

  return (
    <Dashboard
      onSelectRig={(rigId) => setView({ type: "graph", rigId })}
      onImport={() => setView({ type: "import" })}
    />
  );
}
