// PL-005 Phase A: cross-CLI-version drift indicator.
//
// Keep confirmed outdated versions, unknown capabilities and unavailable
// fields separate: a missing field alone does not establish an old CLI.

export interface CliDriftIndicatorProps {
  staleCliCount: number;
  unknownCliCount?: number;
  degradedFields: string[];
  sourceFallback?: string | null;
}

export function CliDriftIndicator({
  staleCliCount,
  unknownCliCount = 0,
  degradedFields,
  sourceFallback,
}: CliDriftIndicatorProps) {
  if (staleCliCount === 0 && unknownCliCount === 0 && degradedFields.length === 0 && !sourceFallback) {
    return null;
  }
  return (
    <div
      data-testid="mc-cli-drift-indicator"
      className="border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900"
    >
      {staleCliCount > 0 ? (
        <div data-testid="mc-cli-drift-stale-count">
          <span className="font-mono uppercase text-[9px] tracking-[0.12em]">stale-cli</span>{" "}
          {staleCliCount} {staleCliCount === 1 ? "rig" : "rigs"} running stale CLI
        </div>
      ) : null}
      {unknownCliCount > 0 ? (
        <div data-testid="mc-cli-drift-unknown-count">
          {unknownCliCount} {unknownCliCount === 1 ? "rig" : "rigs"} with unknown CLI capabilities
        </div>
      ) : null}
      {degradedFields.length > 0 ? (
        <div data-testid="mc-cli-drift-fields" className="mt-1">
          <span className="font-mono uppercase text-[9px] tracking-[0.12em]">missing fields</span>{" "}
          {degradedFields.join(", ")}
        </div>
      ) : null}
      {sourceFallback ? (
        <div data-testid="mc-cli-drift-fallback" className="mt-1 text-amber-700">
          <span className="font-mono uppercase text-[9px] tracking-[0.12em]">fallback</span>{" "}
          {sourceFallback}
        </div>
      ) : null}
    </div>
  );
}

export interface MissingFieldPlaceholderProps {
  fieldName: string;
}

export function MissingFieldPlaceholder({ fieldName }: MissingFieldPlaceholderProps) {
  return (
    <span
      data-testid="mc-missing-field-placeholder"
      className="font-mono text-[10px] text-amber-700"
      title="field unavailable on this rig"
    >
      {fieldName}: field unavailable on this rig
    </span>
  );
}
