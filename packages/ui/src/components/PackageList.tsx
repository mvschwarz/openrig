import { useNavigate } from "@tanstack/react-router";
import { usePackages, type PackageSummary } from "../hooks/usePackages.js";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

function statusColor(status: string | null): string {
  switch (status) {
    case "applied": return "bg-success";
    case "rolled_back": return "bg-warning";
    case "failed": return "bg-destructive";
    default: return "bg-foreground-muted-on-dark";
  }
}

function statusLabel(status: string | null): string {
  switch (status) {
    case "applied": return "APPLIED";
    case "rolled_back": return "ROLLED BACK";
    case "failed": return "FAILED";
    default: return "NONE";
  }
}

function PackageCard({ pkg, onSelect }: { pkg: PackageSummary; onSelect: (id: string) => void }) {
  return (
    <div
      data-testid="package-card"
      role="link"
      tabIndex={0}
      className="card-dark p-spacing-6 mb-spacing-3 cursor-pointer"
      onClick={() => onSelect(pkg.id)}
      onKeyDown={(e) => { if (e.key === "Enter") onSelect(pkg.id); }}
    >
      <div className="flex items-baseline justify-between mb-spacing-2">
        <h3 className="text-headline-md uppercase">{pkg.name}</h3>
        <span className="text-label-md font-mono text-foreground-muted-on-dark">v{pkg.version}</span>
      </div>

      {pkg.summary && (
        <p className="text-body-sm text-foreground-muted-on-dark mb-spacing-4">{pkg.summary}</p>
      )}

      <div className="flex items-center gap-spacing-4 text-label-sm">
        <span className="text-foreground-muted-on-dark">
          SOURCE <span className="font-mono text-foreground-on-dark">{pkg.sourceRef}</span>
        </span>
      </div>

      <div className="flex items-center gap-spacing-4 mt-spacing-3 text-label-sm">
        <span className="text-foreground-muted-on-dark">
          INSTALLS <span className="font-mono text-foreground-on-dark" data-testid="install-count">{pkg.installCount}</span>
        </span>

        <span className="flex items-center gap-spacing-1">
          <span className={cn("inline-block w-[6px] h-[6px]", statusColor(pkg.latestInstallStatus))} />
          <span className="text-foreground-muted-on-dark" data-testid="install-status">
            {statusLabel(pkg.latestInstallStatus)}
          </span>
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
      <div className="p-spacing-6" data-testid="packages-loading">
        <div className="flex justify-between mb-spacing-6">
          <div className="h-8 w-32 shimmer" />
          <div className="h-8 w-28 shimmer" />
        </div>
        {[1, 2].map((i) => (
          <div key={i} className="card-dark p-spacing-6 mb-spacing-3">
            <div className="h-6 w-48 shimmer-dark mb-spacing-4" />
            <div className="h-12 shimmer-dark mb-spacing-4" />
            <div className="h-4 w-64 shimmer-dark" />
          </div>
        ))}
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-spacing-6">
        <Alert data-testid="packages-error">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Empty state
  if (sortedPackages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]" data-testid="packages-empty">
        <h2 className="text-display-lg text-foreground mb-spacing-4">NO SPECS</h2>
        <p className="text-body-md text-foreground-muted mb-spacing-8">Import a RigSpec or validate an AgentSpec to get started</p>
        <Button
          variant="default"
          size="lg"
          data-testid="empty-install-btn"
          onClick={() => navigate({ to: "/import" })}
        >
          IMPORT RIGSPEC
        </Button>
      </div>
    );
  }

  return (
    <div className="p-spacing-6 max-w-[800px]">
      {/* Page header */}
      <div className="flex justify-between items-baseline mb-spacing-6">
        <div>
          <h2 className="text-headline-lg uppercase">PACKAGES (Legacy)</h2>
          <p className="text-label-md text-foreground-muted font-grotesk mt-spacing-1">
            {sortedPackages.length} installed package{sortedPackages.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Button
          variant="default"
          size="sm"
          data-testid="header-install-btn"
          onClick={() => navigate({ to: "/packages/install" })}
        >
          INSTALL
        </Button>
      </div>

      {sortedPackages.map((pkg) => (
        <PackageCard
          key={pkg.id}
          pkg={pkg}
          onSelect={(id) => navigate({ to: "/packages/$packageId", params: { packageId: id } })}
        />
      ))}
    </div>
  );
}
