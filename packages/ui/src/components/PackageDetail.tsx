import { useState } from "react";
import { useParams } from "@tanstack/react-router";
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
import { PageHeader } from "@/components/ui/page-header.js";
import { EmptyState } from "@/components/ui/empty-state.js";
import { StatusBadge } from "@/components/ui/status-badge.js";
import { WorkspacePage } from "./WorkspacePage.js";

/** C14e: map legacy install status to the shared status vocabulary. */
function installStatusKey(status: string): string {
  switch (status) {
    case "applied": return "done";
    case "rolled_back": return "recoverable";
    case "failed": return "failed";
    default: return status;
  }
}

/** C14e: map legacy install status to a sentence-case label. */
function installStatusLabel(status: string): string {
  switch (status) {
    case "applied": return "Applied";
    case "rolled_back": return "Rolled back";
    case "failed": return "Failed";
    default: return status.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
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
          className="flex items-center gap-spacing-3 text-xs py-spacing-1 border-b border-foreground/6 last:border-0"
        >
          <span className="text-on-surface-variant w-6 text-right font-mono">{entry.seq}</span>
          <span>{entry.action}</span>
          <span className="text-on-surface-variant font-mono">{entry.exportType}</span>
          <span className="text-on-surface-variant truncate max-w-[200px] font-mono">{entry.targetPath}</span>
          <span className="text-on-surface-variant ml-auto">{entry.status}</span>
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
    <div data-testid="install-row" className="rounded-lg border bg-surface-lowest p-spacing-4 mb-spacing-2 shadow-sm">
      <div className="flex items-center gap-spacing-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-spacing-3 mb-spacing-1">
            <span className="font-mono text-xs text-on-surface-variant">
              {install.createdAt}
            </span>
            <StatusBadge status={installStatusKey(install.status)} label={installStatusLabel(install.status)} testId="install-status-badge" />
          </div>
          <div className="text-xs font-mono text-on-surface-variant">
            {install.targetRoot}
          </div>
          <div className="flex items-center gap-spacing-3 mt-spacing-1 text-xs text-on-surface-variant">
            <span data-testid="applied-count">
              <span className="font-mono text-on-surface">{install.appliedCount}</span> applied
            </span>
            <span data-testid="deferred-placeholder">
              &mdash; deferred
            </span>
          </div>
        </div>

        <div className="flex items-center gap-spacing-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            data-testid="expand-btn"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Collapse" : "Expand"}
          </Button>
          {install.status === "applied" && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="rollback-btn"
              onClick={() => onRollback(install.id)}
            >
              Rollback
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
        <div className="rounded-lg border bg-surface-lowest p-spacing-6 mb-spacing-4">
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
        <div data-testid="package-header">
          <PageHeader
            title={`${pkg.name} (legacy)`}
            description={pkg.summary ?? "Legacy package details and install history."}
            meta={
              <>
                <span className="font-mono text-xs text-on-surface-variant">
                  v{pkg.version}
                </span>
                <span className="text-xs text-on-surface-variant">
                  Source{" "}
                  <span className="font-mono text-on-surface" data-testid="package-source">
                    {pkg.sourceRef}
                  </span>
                </span>
              </>
            }
          />
        </div>
      )}

      {/* Install history */}
      <h3 className="text-sm font-semibold text-on-surface mb-spacing-4">Install history</h3>

      {sortedInstalls.length === 0 ? (
        <EmptyState
          label="No installs yet"
          title="No installs yet"
          description="No installs recorded for this package yet. Install it from the packages page to see history here."
          testId="empty-installs"
        />
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
            <DialogTitle>Confirm rollback</DialogTitle>
            <DialogDescription>
              This will roll back the install and restore previous file states. This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          {rollbackMutation.isError && (
            <p className="text-destructive text-xs" data-testid="rollback-error">
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
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRollbackConfirm}
              data-testid="rollback-confirm"
              disabled={rollbackMutation.isPending}
            >
              {rollbackMutation.isPending ? "Rolling back..." : "Rollback"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </WorkspacePage>
  );
}
