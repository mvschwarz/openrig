// PL-005 Phase A: fleet view (rig roll-up + CLI drift indicator).
//
// Per PRD § Acceptance Criteria: combines per-rig activity state with
// the cross-CLI-version drift indicator (sub-clause 4 of graceful
// degradation). Renders both a fleet-level "stale CLI" badge AND a
// per-row indicator on each rig that's reporting drift.

import { CompactStatusRow } from "../components/CompactStatusRow.js";
import {
  CliDriftIndicator,
  MissingFieldPlaceholder,
} from "../components/CliDriftIndicator.js";
import { useMissionControlView } from "../hooks/useMissionControlView.js";
import { useMissionControlCliCapabilities } from "../hooks/useMissionControlCliCapabilities.js";

export function FleetView() {
  const fleetView = useMissionControlView("fleet");
  const cliCapabilities = useMissionControlCliCapabilities();

  return (
    <div data-testid="mc-view-fleet" className="space-y-3 p-3">
      <header className="space-y-0.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-500">
          fleet
        </div>
        <h2 className="font-headline text-lg text-stone-900">Fleet</h2>
        <p className="text-xs text-stone-600">
          Per-rig activity and per-rig CLI capability honesty.
        </p>
      </header>
      {cliCapabilities.data ? (
        <CliDriftIndicator
          staleCliCount={cliCapabilities.data.staleCliCount}
          degradedFields={cliCapabilities.data.degradedFields}
          sourceFallback={cliCapabilities.data.sourceFallback}
        />
      ) : null}
      {fleetView.isLoading ? (
        <div data-testid="mc-view-loading" className="font-mono text-[10px] text-stone-500">
          loading...
        </div>
      ) : fleetView.isError ? (
        <div data-testid="mc-view-error" className="font-mono text-[11px] text-red-700">
          error: {fleetView.error.message}
        </div>
      ) : fleetView.data?.rows.length === 0 ? (
        <div data-testid="mc-view-empty" className="font-mono text-[11px] text-stone-500">
          No rigs registered.
        </div>
      ) : (
        <ul data-testid="mc-view-rows" className="space-y-1.5">
          {fleetView.data?.rows.map((row, idx) => {
            const driftRow = cliCapabilities.data?.rows.find(
              (r) => r.rigName === row.rigOrMissionName,
            );
            return (
              <li key={`fleet-${idx}-${row.rigOrMissionName}`} className="space-y-1">
                <CompactStatusRow row={row} density="expanded" />
                {driftRow?.cliDriftDetected ? (
                  <div className="pl-3">
                    <MissingFieldPlaceholder fieldName="recoveryGuidance" />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
