import { useNavigate } from "@tanstack/react-router";
import { usePackages, type PackageSummary } from "../hooks/usePackages.js";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header.js";
import { EmptyState } from "@/components/ui/empty-state.js";
import { StatusBadge } from "@/components/ui/status-badge.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { WorkspacePage } from "./WorkspacePage.js";

/** C14e: map legacy package install status to the shared status vocabulary. */
function installStatusKey(status: string | null): string {
  switch (status) {
    case "applied": return "done";
    case "rolled_back": return "recoverable";
    case "failed": return "failed";
    default: return "unknown";
  }
}

/** C14e: map legacy package install status to a sentence-case label. */
function installStatusLabel(status: string | null): string {
  switch (status) {
    case "applied": return "Applied";
    case "rolled_back": return "Rolled back";
    case "failed": return "Failed";
    default: return "None";
  }
}

function PackageCard({ pkg, onSelect }: { pkg: PackageSummary; onSelect: (id: string) => void }) {
  return (
    <div
      data-testid="package-card"
      role="link"
      tabIndex={0}
      className="rounded-lg border bg-surface-lowest mb-spacing-3 p-spacing-6 cursor-pointer shadow-sm"
      onClick={() => onSelect(pkg.id)}
      onKeyDown={(e) => { if (e.key === "Enter") onSelect(pkg.id); }}
    >
      <div className="flex items-baseline justify-between mb-spacing-2">
        <h3 className="text-sm font-semibold text-on-surface">{pkg.name}</h3>
        <span className="text-xs font-mono text-on-surface-variant">v{pkg.version}</span>
      </div>

      {pkg.summary && (
        <p className="text-sm text-on-surface-variant mb-spacing-4">{pkg.summary}</p>
      )}

      <div className="flex items-center gap-spacing-4 text-xs">
        <span className="text-on-surface-variant">
          Source <span className="font-mono text-on-surface">{pkg.sourceRef}</span>
        </span>
      </div>

      <div className="flex items-center gap-spacing-4 mt-spacing-3 text-xs">
        <span className="text-on-surface-variant">
          Installs <span className="font-mono text-on-surface" data-testid="install-count">{pkg.installCount}</span>
        </span>

        <span className="flex items-center gap-spacing-1">
          <StatusBadge status={installStatusKey(pkg.latestInstallStatus)} label={installStatusLabel(pkg.latestInstallStatus)} testId="install-status" />
        </span>
      </div>
    </div>
  );
}

export function PackageList() {
  const navigate = useNavigate();
  const { data: packages, isPending, error } = usePackages();
  const sortedPackages = packages
    ? [...packages].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];

  // Loading state
  if (isPending) {
    return (
      <WorkspacePage>
      <div data-testid="packages-loading">
        <div className="flex justify-between mb-spacing-6">
          <div className="h-8 w-32 shimmer" />
          <div className="h-8 w-28 shimmer" />
        </div>
        {[1, 2].map((i) => (
          <div key={i} className="rounded-lg border bg-surface-lowest p-spacing-6 mb-spacing-3">
            <div className="h-6 w-48 shimmer-dark mb-spacing-4" />
            <div className="h-12 shimmer-dark mb-spacing-4" />
            <div className="h-4 w-64 shimmer-dark" />
          </div>
        ))}
      </div>
      </WorkspacePage>
    );
  }

  // Error state
  if (error) {
    return (
      <WorkspacePage>
      <div>
        <Alert data-testid="packages-error">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
      </WorkspacePage>
    );
  }

  // Empty state
  if (sortedPackages.length === 0) {
    return (
      <WorkspacePage>
      <PageHeader
        title="Legacy package tools"
        description="Legacy package tools remain available for bootstrap internals, while Library is the main authoring surface."
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              data-testid="header-bootstrap-btn"
              onClick={() => navigate({ to: "/bootstrap" })}
            >
              Bootstrap
            </Button>
            <Button
              variant="default"
              size="sm"
              data-testid="header-import-btn"
              onClick={() => navigate({ to: "/import" })}
            >
              Import rigspec
            </Button>
          </>
        }
      />
      <EmptyState
        label="No legacy package installs"
        title="No legacy package installs"
        description="Legacy package tools remain available for bootstrap internals while Library becomes the main authoring surface."
        testId="packages-empty"
      />
      <div className="flex flex-col items-center gap-spacing-3">
        <Button
          variant="default"
          size="lg"
          data-testid="empty-import-btn"
          onClick={() => navigate({ to: "/import" })}
        >
          Import rigspec
        </Button>
        <Button
          variant="ghost"
          size="lg"
          data-testid="empty-bootstrap-btn"
          onClick={() => navigate({ to: "/bootstrap" })}
        >
          Bootstrap
        </Button>
      </div>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
    <div>
      {/* Page header */}
      <PageHeader
        title="Legacy package tools"
        description={`${sortedPackages.length} legacy package install${sortedPackages.length !== 1 ? "s" : ""} retained for bootstrap internals.`}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              data-testid="header-bootstrap-btn"
              onClick={() => navigate({ to: "/bootstrap" })}
            >
              Bootstrap
            </Button>
            <Button
              variant="default"
              size="sm"
              data-testid="header-import-btn"
              onClick={() => navigate({ to: "/import" })}
            >
              Import rigspec
            </Button>
          </>
        }
      />

      {sortedPackages.map((pkg) => (
        <PackageCard
          key={pkg.id}
          pkg={pkg}
          onSelect={(id) => navigate({ to: "/packages/$packageId", params: { packageId: id } })}
        />
      ))}
    </div>
    </WorkspacePage>
  );
}
