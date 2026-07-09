// OPR.0.4.6.MH5 — the FLEET band (placement option B of the founder LOCK =
// BOTH; /fleet FleetPage is option A). The AMBIENT manage-by-exception
// reminder mounted ABOVE the per-host Mission Control: rollup + the single
// worst line (host-chipped) + OPEN FLEET → (which lands on the route — the
// LOCK's glance-while-working → zoom-to-triage loop). Same useFleet read as
// the route (ONE aggregate, two surfaces — the LOCK's shared contract), so
// the two placements can never disagree.
//
// EXPLICIT no-fleet behavior (rev1-r1 note #3, a code-level decision not a
// proof-leg implication): with NO remote hosts registered (a single-host
// operator — the fleet is just this host) the band renders NOTHING — the
// per-host Mission Control below stays byte-identical to the pre-MH5
// render (the leg-7 zero-regression pin). An existing-but-unreadable
// registry still renders (honest ambient signal), as does any fleet with
// ≥1 remote member. Loading/error states render nothing: an AMBIENT band
// never blocks or alarms the page it rides on.
//
// Inspection-only (guard binding note #1): this band renders text + ONE
// navigation verb. No action imports, no mutation affordances.

import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";
import { useFleet } from "../../hooks/useFleet.js";
import { useHosts } from "../../hooks/useHosts.js";

function BandHostChip({ hostId }: { hostId: string }) {
  return (
    <span
      className={cn(
        "shrink-0 border px-1 font-mono text-[9px] uppercase tracking-wide",
        hostId === "local" ? "border-outline-variant text-on-surface-variant" : "border-on-surface text-on-surface",
      )}
    >
      {hostId}
    </span>
  );
}

export function FleetBand() {
  // FETCH gate, not just a render gate (the FS-1 amplifier discipline): the
  // fleet read is enabled when a registered host EXISTS — the signal is the
  // app's own ["hosts"] cache (this observer dedupes with the always-mounted
  // HostIndicator poller, so it adds zero request volume).
  //
  // guard B1 (2a9e1dbf fixback): a FAILING hosts read must never hide
  // registry truth — /api/hosts 500s on an unreadable registry, so gating
  // on its success alone would silently swallow exactly the state the
  // registryError line exists to surface. When the hosts query ERRORS, the
  // fleet read is ENABLED: the daemon-side composer is the SSOT and returns
  // either the fleet or an honest registryError. Only a KNOWN-empty
  // registry (a successful hosts read with zero rows — the single-host
  // operator) keeps the fetch gated.
  const { data: hostsData, isError: hostsUnavailable } = useHosts();
  const fleetExists = (hostsData?.hosts?.length ?? 0) > 0;
  const { data } = useFleet({ enabled: fleetExists || hostsUnavailable });
  // Single-host operator: no fleet read fired, nothing rendered — the page
  // below stays byte-identical pre-MH5.
  if (!data) return null;
  if (data.hosts.length <= 1 && !data.registryError) return null;

  // The worst line: the first ▲ if any exception exists, else the first ●
  // (rows arrive in the composer's total order — worst-first).
  const worst = data.needsYou.items.find((i) => i.source === "derived") ?? data.needsYou.items[0];

  return (
    <div data-testid="fleet-band" className={cn("flex flex-wrap items-center gap-2 px-2 py-1.5", VELLUM_CARD)}>
      <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface">FLEET</span>
      <span data-testid="fleet-band-rollup" className="flex items-center gap-2 font-mono text-[10px]">
        <span className="text-emerald-700">● {data.rollup.needsYouCount}</span>
        <span className="text-amber-700">▲ {data.rollup.exceptionCount}</span>
        <span className="text-on-surface-variant">
          {data.rollup.hostCount} hosts
          {data.rollup.unreachableCount > 0 ? ` · ${data.rollup.unreachableCount} unreachable` : ""}
        </span>
      </span>
      {data.registryError ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-error">
          host registry unreadable — local-only glance
        </span>
      ) : worst ? (
        <span data-testid="fleet-band-worst" className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-[10px] text-on-surface-variant">
          worst: <BandHostChip hostId={worst.hostId} />
          <span className="min-w-0 truncate">{worst.summary}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-on-surface-variant">quiet</span>
      )}
      <a href="/fleet" data-testid="fleet-band-open" className="font-mono text-[10px] uppercase text-on-surface hover:underline">
        open fleet →
      </a>
    </div>
  );
}
