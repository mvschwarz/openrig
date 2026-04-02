import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  usePackageInfo,
  useInstallHistory,
  useJournalEntries,
  useRollbackInstall,
  type InstallSummary,
} from "../hooks/usePackageDetail.js";
import { WorkspacePage } from "./WorkspacePage.js";

function statusBadgeColor(status: string): string {
  switch (status) {
    case "applied":
      return "bg-success";
    case "rolled_back":
      return "bg-warning";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-foreground-muted";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "applied":
      return "APPLIED";
    case "rolled_back":
      return "ROLLED BACK";
    case "failed":
      return "FAILED";
    default:
      return status.toUpperCase();
  }
}

function JournalSubList({ installId }: { installId: string }) {
  const { data: entries, isPending, isError } = useJournalEntries(installId);

  if (isPending) {
    return (
      <div className="pl-spacing-6 py-spacing-2 text-label-sm text-foreground-muted">
        Loading journal...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="pl-spacing-6 py-spacing-2 text-label-sm text-destructive" data-testid="journal-error">
        Failed to load journal entries
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div className="pl-spacing-6 py-spacing-2 text-label-sm text-foreground-muted">
        No journal entries
      </div>
    );
  }

  return (
    <div className="pl-spacing-6 py-spacing-2 space-y-spacing-1" data-testid="journal-entries">
      {entries.map((entry) => (
        <div
          key={entry.id}
          data-testid="journal-entry"
          className="flex items-center gap-spacing-3 text-label-sm font-mono py-spacing-1 border-b border-foreground/6 last:border-0"
        >
          <span className="text-foreground-muted w-6 text-right">{entry.seq}</span>
          <span className="uppercase">{entry.action}</span>
          <span className="text-foreground-muted">{entry.exportType}</span>
          <span className="text-foreground-muted truncate max-w-[200px]">{entry.targetPath}</span>
          <span className="text-foreground-muted ml-auto">{entry.status}</span>
        </div>
      ))}
    </div>
  );
}

function InstallRow({
  install,
  onRollback,
}: {
  install: InstallSummary;
  onRollback: (installId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div data-testid="install-row" className="card-dark p-spacing-4 mb-spacing-2">
      <div className="flex items-center gap-spacing-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-spacing-3 mb-spacing-1">
            <span className="font-mono text-label-sm text-foreground-muted">
              {install.createdAt}
            </span>
            <span
              data-testid="install-status-badge"
              className={cn(
                "inline-block px-spacing-2 py-px text-label-sm uppercase",
                statusBadgeColor(install.status)
              )}
            >
              {statusLabel(install.status)}
            </span>
          </div>
          <div className="text-label-sm font-mono text-foreground-muted-on-dark">
            {install.targetRoot}
          </div>
          <div className="flex items-center gap-spacing-3 mt-spacing-1 text-label-sm">
            <span data-testid="applied-count">
              <span className="font-mono">{install.appliedCount}</span> applied
            </span>
            <span data-testid="deferred-placeholder" className="text-foreground-muted">
              &mdash; deferred
            </span>
          </div>
        </div>

        <div className="flex items-center gap-spacing-2 shrink-0">
          <Button
            variant="tactical"
            size="sm"
            data-testid="expand-btn"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "COLLAPSE" : "EXPAND"}
          </Button>
          {install.status === "applied" && (
            <Button
              variant="tactical"
              size="sm"
              data-testid="rollback-btn"
              onClick={() => onRollback(install.id)}
            >
              ROLLBACK
            </Button>
          )}
        </div>
      </div>

      {expanded && <JournalSubList installId={install.id} />}
    </div>
  );
}

export function PackageDetail() {
  const { packageId } = useParams({ strict: false }) as { packageId: string };
  const { data: pkg, isPending: pkgPending, error: pkgError } = usePackageInfo(packageId);
  const { data: installs, isPending: installsPending, error: installsError } = useInstallHistory(packageId);
  const rollbackMutation = useRollbackInstall(packageId);

  const [rollbackTargetId, setRollbackTargetId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleRollbackClick = (installId: string) => {
    setRollbackTargetId(installId);
    setDialogOpen(true);
  };

  const handleRollbackConfirm = () => {
    if (rollbackTargetId) {
      rollbackMutation.mutate(rollbackTargetId, {
        onSuccess: () => {
          setDialogOpen(false);
          setRollbackTargetId(null);
        },
      });
    }
  };

  // Loading
  if (pkgPending || installsPending) {
    return (
      <WorkspacePage>
      <div data-testid="detail-loading">
        <div className="h-8 w-48 shimmer mb-spacing-4" />
        <div className="card-dark p-spacing-6 mb-spacing-4">
          <div className="h-6 w-64 shimmer-dark mb-spacing-3" />
          <div className="h-4 w-full shimmer-dark" />
        </div>
      </div>
      </WorkspacePage>
    );
  }

  // Error
  if (pkgError) {
    return (
      <WorkspacePage>
      <div data-testid="detail-error">
        <p className="text-destructive">{pkgError.message}</p>
      </div>
      </WorkspacePage>
    );
  }

  if (installsError) {
    return (
      <WorkspacePage>
      <div data-testid="installs-error">
        <p className="text-destructive">Failed to load install history</p>
      </div>
      </WorkspacePage>
    );
  }

  // API returns installs newest-first with deterministic tiebreaker
  const sortedInstalls = installs ?? [];

  return (
    <WorkspacePage>
    <div>
      {/* Package header */}
      {pkg && (
        <div className="card-dark p-spacing-6 mb-spacing-6" data-testid="package-header">
          <div className="flex items-baseline justify-between mb-spacing-2">
            <h2 className="text-headline-lg uppercase">{pkg.name} (Legacy)</h2>
            <span className="text-label-md font-mono text-foreground-muted-on-dark">
              v{pkg.version}
            </span>
          </div>
          <div className="text-label-sm text-foreground-muted-on-dark mb-spacing-2">
            SOURCE{" "}
            <span className="font-mono text-foreground-on-dark" data-testid="package-source">
              {pkg.sourceRef}
            </span>
          </div>
          {pkg.summary && (
            <p className="text-body-sm text-foreground-muted-on-dark">{pkg.summary}</p>
          )}
        </div>
      )}

      {/* Install history */}
      <h3 className="text-headline-md uppercase mb-spacing-4">INSTALL HISTORY</h3>

      {sortedInstalls.length === 0 ? (
        <div data-testid="empty-installs" className="text-body-md text-foreground-muted">
          No installs yet
        </div>
      ) : (
        <div data-testid="install-list">
          {sortedInstalls.map((install) => (
            <InstallRow
              key={install.id}
              install={install}
              onRollback={handleRollbackClick}
            />
          ))}
        </div>
      )}

      {/* Rollback confirmation dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!rollbackMutation.isPending) { setDialogOpen(open); if (!open) rollbackMutation.reset(); } }}>
        <DialogContent data-testid="rollback-dialog" onPointerDownOutside={(e) => { if (rollbackMutation.isPending) e.preventDefault(); }} onEscapeKeyDown={(e) => { if (rollbackMutation.isPending) e.preventDefault(); }} hideCloseButton={rollbackMutation.isPending}>
          <DialogHeader>
            <DialogTitle className="text-headline-md uppercase">CONFIRM ROLLBACK</DialogTitle>
            <DialogDescription>
              This will roll back the install and restore previous file states. This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          {rollbackMutation.isError && (
            <p className="text-destructive text-label-sm" data-testid="rollback-error">
              Rollback failed: {rollbackMutation.error?.message ?? "Unknown error"}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { rollbackMutation.reset(); setDialogOpen(false); }}
              data-testid="rollback-cancel"
              disabled={rollbackMutation.isPending}
            >
              CANCEL
            </Button>
            <Button
              variant="destructive"
              onClick={handleRollbackConfirm}
              data-testid="rollback-confirm"
              disabled={rollbackMutation.isPending}
            >
              {rollbackMutation.isPending ? "ROLLING BACK..." : "ROLLBACK"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </WorkspacePage>
  );
}
