// PL-005 Phase A: cross-CLI-version drift indicator.
//
// Per PRD § Runtime/Source Drift Acceptance sub-clause 4: surfaces a
// fleet-level "rigs running stale CLI" indicator + per-row "field
// unavailable on this rig's daemon version" placeholders.

export interface CliDriftIndicatorProps {
  staleCliCount: number;
  degradedFields: string[];
  sourceFallback?: string | null;
}

export function CliDriftIndicator({
  staleCliCount,
  degradedFields,
  sourceFallback,
}: CliDriftIndicatorProps) {
  if (staleCliCount === 0 && degradedFields.length === 0 && !sourceFallback) {
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
      title={`field unavailable on this rig's daemon version`}
    >
      {fieldName}: field unavailable on this rig's daemon version
    </span>
  );
}
