import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useRigSummary } from "../hooks/useRigSummary.js";
import { useCreateSnapshot, useTeardownRig } from "../hooks/mutations.js";
import { usePsEntries } from "../hooks/usePsEntries.js";
import { RigCard } from "./RigCard.js";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Wireframe ghost SVG — faint blueprint of a topology */
function WireframeGhost() {
  return (
    <svg
      data-testid="wireframe-ghost"
      className="absolute inset-0 w-full h-full text-foreground"
      viewBox="0 0 400 300"
      fill="none"
      style={{ opacity: 0.06 }}
    >
      <rect x="160" y="40" width="80" height="40" stroke="currentColor" strokeWidth="0.5" />
      <rect x="60" y="160" width="80" height="40" stroke="currentColor" strokeWidth="0.5" />
      <rect x="260" y="160" width="80" height="40" stroke="currentColor" strokeWidth="0.5" />
      <line x1="200" y1="80" x2="100" y2="160" stroke="currentColor" strokeWidth="0.5" strokeDasharray="4 4" />
      <line x1="200" y1="80" x2="300" y2="160" stroke="currentColor" strokeWidth="0.5" strokeDasharray="4 4" />
      <circle cx="200" cy="80" r="2" fill="currentColor" />
      <circle cx="100" cy="160" r="2" fill="currentColor" />
      <circle cx="300" cy="160" r="2" fill="currentColor" />
    </svg>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const { data: rigs, isPending, error } = useRigSummary();
  const { data: psEntries, isPending: psPending, error: psError } = usePsEntries();
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDown, setConfirmDown] = useState<string | null>(null);
  const [teardownError, setTeardownError] = useState<string | null>(null);

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

  // Aggregate stats from PsEntry data (null when ps unavailable)
  const psAvailable = !psPending && !psError && psEntries != null;
  const totalNodes = psAvailable ? psEntries.reduce((sum, e) => sum + e.runningCount, 0) : null;

  // PsEntry lookup by rigId
  const psMap = new Map(psEntries?.map((e) => [e.rigId, e]) ?? []);

  // Loading state
  if (isPending) {
    return (
      <div className="p-spacing-6" data-testid="dashboard-loading">
        <div className="flex justify-between mb-spacing-6">
          <div className="h-8 w-24 shimmer" />
          <div className="h-8 w-32 shimmer" />
        </div>
        {[1, 2].map((i) => (
          <div key={i} className="card-dark p-spacing-6 mb-spacing-3">
            <div className="h-6 w-48 shimmer-dark mb-spacing-4" />
            <div className="h-16 shimmer-dark mb-spacing-4" />
            <div className="h-8 w-64 shimmer-dark" />
          </div>
        ))}
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-spacing-6">
        <Alert data-testid="dashboard-error">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Empty state
  if (!rigs || rigs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] relative" data-testid="dashboard-empty">
        <WireframeGhost />
        <div className="relative z-10 text-center">
          <h2 className="text-display-lg text-foreground mb-spacing-4">NO RIGS</h2>
          <p className="text-body-md text-foreground-muted mb-spacing-8">Set up a rig to get started</p>
          <Button
            variant="default"
            size="lg"
            data-testid="empty-up-btn"
            onClick={() => navigate({ to: "/bootstrap" })}
          >
            SET UP YOUR FIRST RIG
          </Button>
        </div>
      </div>
    );
  }

  const confirmRig = rigs.find((r) => r.id === confirmDown);

  return (
    <div className="p-spacing-6 max-w-[800px]">
      {/* Page header */}
      <div className="flex justify-between items-baseline mb-spacing-6">
        <div>
          <h2 className="text-headline-lg uppercase">RIGS</h2>
          <p className="text-label-md text-foreground-muted font-grotesk mt-spacing-1" data-testid="aggregate-header">
            {rigs.length} rig{rigs.length !== 1 ? "s" : ""}{totalNodes !== null ? `, ${totalNodes} node${totalNodes !== 1 ? "s" : ""} running` : ""}
          </p>
        </div>
        <Button variant="default" size="sm" data-testid="header-up-btn" onClick={() => navigate({ to: "/bootstrap" })}>
          UP
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
          psEntry={psMap.get(rig.id)}
          onSelect={(rigId) => navigate({ to: "/rigs/$rigId", params: { rigId } })}
          onExport={() => handleExport(rig.id)}
          onActionError={setActionError}
          onDown={() => { setTeardownError(null); setConfirmDown(rig.id); }}
        />
      ))}

      {/* Teardown confirmation dialog */}
      <Dialog open={confirmDown !== null} onOpenChange={(open) => { if (!open) { setConfirmDown(null); setTeardownError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tear Down Rig</DialogTitle>
            <DialogDescription>
              Tear down <strong>{confirmRig?.name}</strong>? This will kill all running sessions.
            </DialogDescription>
          </DialogHeader>
          {teardownError && (
            <Alert data-testid="teardown-error">
              <AlertDescription>{teardownError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setConfirmDown(null); setTeardownError(null); }}>Cancel</Button>
            {confirmDown && (
              <ConfirmDownButton
                rigId={confirmDown}
                onSuccess={() => { setConfirmDown(null); setTeardownError(null); }}
                onError={(msg) => setTeardownError(msg)}
              />
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConfirmDownButton({
  rigId,
  onSuccess,
  onError,
}: {
  rigId: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const teardown = useTeardownRig(rigId);

  return (
    <Button
      variant="destructive"
      data-testid="confirm-down-btn"
      disabled={teardown.isPending}
      onClick={() => {
        teardown.mutate(undefined, {
          onSuccess: () => onSuccess(),
          onError: (err) => onError(err.message),
        });
      }}
    >
      {teardown.isPending ? "Tearing down…" : "Confirm"}
    </Button>
  );
}

function DashboardRigCard({
  rig,
  psEntry,
  onSelect,
  onExport,
  onActionError,
  onDown,
}: {
  rig: { id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null };
  psEntry?: import("../hooks/usePsEntries.js").PsEntry;
  onSelect: (rigId: string) => void;
  onExport: () => void;
  onActionError: (error: string | null) => void;
  onDown: () => void;
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
      psEntry={psEntry}
      onSelect={onSelect}
      onSnapshot={handleSnapshot}
      onExport={onExport}
      onDown={onDown}
    />
  );
}
