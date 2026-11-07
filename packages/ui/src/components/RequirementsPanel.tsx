import { StatusDot } from "@/components/ui/status-badge.js";

export interface RequirementResult {
  name: string;
  kind: string;
  status: string;
  version: string | null;
  detectedPath: string | null;
}

/** C14e: map installer requirement status to the shared status vocabulary. */
function statusKey(status: string): string {
  switch (status) {
    case "installed": return "ready";
    case "missing": return "failed";
    case "unsupported":
    case "unknown": return "attention_required";
    default: return status;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "installed": return "Ok";
    case "missing": return "Missing";
    case "unsupported": return "Manual";
    case "unknown": return "Unknown";
    default: return status.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}

export function RequirementsPanel({ results }: { results: RequirementResult[] }) {
  if (results.length === 0) {
    return (
      <div className="text-body-sm text-foreground-muted" data-testid="no-requirements">
        No requirements declared.
      </div>
    );
  }

  return (
    <div className="space-y-spacing-1" data-testid="requirements-panel">
      {results.map((r) => (
        <div
          key={`${r.kind}:${r.name}`}
          data-testid="requirement-row"
          className="flex items-center gap-spacing-3 py-spacing-1 text-sm"
        >
          <StatusDot status={statusKey(r.status)} className="shrink-0" />
          <span
            data-testid="requirement-status"
            className="w-16 text-xs text-on-surface-variant"
          >
            {statusLabel(r.status)}
          </span>
          <span className="text-on-surface-variant w-24">{r.kind}</span>
          <span>{r.name}</span>
          {r.detectedPath && (
            <span className="text-on-surface-variant ml-auto truncate max-w-[200px] font-mono text-xs">
              {r.detectedPath}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
