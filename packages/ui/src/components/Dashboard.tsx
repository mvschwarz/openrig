import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useRigSummary } from "../hooks/useRigSummary.js";
import { useCreateSnapshot } from "../hooks/mutations.js";
import { RigCard } from "./RigCard.js";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";

/** Wireframe ghost SVG — faint blueprint of a topology */
function WireframeGhost() {
  return (
    <svg
      data-testid="wireframe-ghost"
      className="absolute inset-0 w-full h-full"
      viewBox="0 0 400 300"
      fill="none"
      style={{ opacity: 0.06 }}
    >
      {/* Nodes */}
      <rect x="160" y="40" width="80" height="40" stroke="currentColor" strokeWidth="0.5" />
      <rect x="60" y="160" width="80" height="40" stroke="currentColor" strokeWidth="0.5" />
      <rect x="260" y="160" width="80" height="40" stroke="currentColor" strokeWidth="0.5" />
      {/* Edges */}
      <line x1="200" y1="80" x2="100" y2="160" stroke="currentColor" strokeWidth="0.5" strokeDasharray="4 4" />
      <line x1="200" y1="80" x2="300" y2="160" stroke="currentColor" strokeWidth="0.5" strokeDasharray="4 4" />
      {/* Connection dots */}
      <circle cx="200" cy="80" r="2" fill="currentColor" />
      <circle cx="100" cy="160" r="2" fill="currentColor" />
      <circle cx="300" cy="160" r="2" fill="currentColor" />
      {/* Extra ghost nodes for atmosphere */}
      <rect x="30" y="240" width="60" height="30" stroke="currentColor" strokeWidth="0.3" opacity="0.5" />
      <rect x="310" y="240" width="60" height="30" stroke="currentColor" strokeWidth="0.3" opacity="0.5" />
      <line x1="100" y1="200" x2="60" y2="240" stroke="currentColor" strokeWidth="0.3" strokeDasharray="2 6" opacity="0.5" />
      <line x1="300" y1="200" x2="340" y2="240" stroke="currentColor" strokeWidth="0.3" strokeDasharray="2 6" opacity="0.5" />
    </svg>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const { data: rigs, isPending, error } = useRigSummary();
  const [actionError, setActionError] = useState<string | null>(null);

  const handleExport = async (rigId: string) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/spec`);
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

  // Loading state — skeleton cards with shimmer
  if (isPending) {
    return (
      <div className="p-spacing-8" data-testid="dashboard-loading">
        <div className="flex justify-between mb-spacing-8">
          <div className="h-8 w-24 shimmer" />
          <div className="h-8 w-32 shimmer" />
        </div>
        {[1, 2].map((i) => (
          <Card key={i} className="mb-spacing-2">
            <CardContent className="p-spacing-6">
              <div className="h-6 w-48 shimmer mb-spacing-4" />
              <div className="h-20 shimmer mb-spacing-4" />
              <div className="h-8 w-64 shimmer" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-spacing-8">
        <Alert data-testid="dashboard-error">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Empty state
  if (!rigs || rigs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] relative text-foreground-muted" data-testid="dashboard-empty">
        <WireframeGhost />
        <div className="relative z-10 text-center">
          <h2 className="text-display-lg text-foreground mb-spacing-4">NO RIGS</h2>
          <p className="text-body-md text-foreground-muted mb-spacing-8">Import a rig spec to get started</p>
          <Button
            variant="tactical"
            size="lg"
            onClick={() => navigate({ to: "/import" })}
          >
            IMPORT YOUR FIRST RIG
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-spacing-8 max-w-[960px]">
      {/* Page header */}
      <div className="flex justify-between items-baseline mb-spacing-8">
        <div>
          <h2 className="text-headline-lg uppercase tracking-[0.06em] mb-spacing-1">RIGS</h2>
          <p className="text-label-md text-foreground-muted font-grotesk">
            {rigs.length} active topolog{rigs.length !== 1 ? "ies" : "y"}
          </p>
        </div>
        <Button variant="tactical" onClick={() => navigate({ to: "/import" })}>
          IMPORT
        </Button>
      </div>

      {actionError && (
        <Alert className="mb-spacing-4" data-testid="action-error">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {rigs.map((rig) => (
        <DashboardRigCard
          key={rig.id}
          rig={rig}
          onSelect={(rigId) => navigate({ to: "/rigs/$rigId", params: { rigId } })}
          onExport={() => handleExport(rig.id)}
          onActionError={setActionError}
        />
      ))}
    </div>
  );
}

function DashboardRigCard({
  rig,
  onSelect,
  onExport,
  onActionError,
}: {
  rig: { id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null };
  onSelect: (rigId: string) => void;
  onExport: () => void;
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
