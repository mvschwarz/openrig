// OPR.0.4.6.MH5 — the FLEET attention altitude (placement option A, the
// founder-locked /fleet route; the LOCK ships BOTH — FleetBand is option B).
//
// The blessed Mission Control grammar lifted ONE altitude above host:
// rollup header → NEEDS YOU (the fleet union, host-attributed, ● agent vs
// ▲ derived at equal rank, exceptions carry inline evidence + threshold)
// → HOSTS (the field band — every factory, honest per-host status;
// unreachable = items ABSENT-not-zero + a REAL-refetch retry) → SETTLED
// (minimal, host-chipped). Same grammar, new altitude — never a new
// interface (mini-req 3).
//
// Read + surface only (FR-5): the boundary renders ON the surface; acting
// on a remote host's item rides MH-3/MH-4. Drill-in (FR-4) = the MH-2
// selected-host retarget (the ONE selection write path) landing on the
// per-host workspace with the FLEET ▸ eyebrow; the navigation below is
// MH-2 verbatim. Rollup math renders the DAEMON's rollup (computed from
// the deduped rows — checkable against the HOSTS band on this surface).
//
// Route discipline: zoom-addressed like /agents (ADDRESSING, not nav
// chrome). Expanded state rides ?open=<fleetKey> so every state is
// deep-link addressable (the RigAgentsPage query-param idiom).

import { Link } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";
import { useFleet } from "../../hooks/useFleet.js";
import type { FleetHostRollup, FleetNeedsYouItem } from "../../hooks/useFleet.js";
import { useSelectHost } from "../../hooks/useHosts.js";

function readSearchParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
}

function HostChip({ hostId }: { hostId: string }) {
  return (
    <span
      data-testid={`fleet-item-host-${hostId}`}
      className={cn(
        "shrink-0 border px-1 font-mono text-[9px] uppercase tracking-wide",
        hostId === "local" ? "border-outline-variant text-on-surface-variant" : "border-on-surface text-on-surface",
      )}
    >
      {hostId}
    </span>
  );
}

/** FR-4: the ONE drill verb — the MH-2 selected-host retarget (the same
 *  one write path the CLI + host picker use), then the per-host workspace
 *  with drill continuity (?from=fleet renders the FLEET ▸ eyebrow; the
 *  surface below is unchanged MH-2). Selecting the already-selected host
 *  is idempotent, so the verb needs no local/remote special case. */
function useOpenHost() {
  const selectHost = useSelectHost();
  return (hostId: string) => {
    selectHost.mutate(
      { hostId },
      { onSuccess: () => window.location.assign("/project?from=fleet") },
    );
  };
}

function setAddressableOpen(fleetKey: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (fleetKey === null) url.searchParams.delete("open");
  else url.searchParams.set("open", fleetKey);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function FleetNeedsYouRow({
  item,
  expanded,
  onToggle,
  onOpenHost,
}: {
  item: FleetNeedsYouItem;
  expanded: boolean;
  onToggle: () => void;
  onOpenHost: (hostId: string) => void;
}) {
  return (
    <li data-testid={`fleet-needs-you-${item.fleetKey}`} data-source={item.source} className="px-2 py-1.5">
      <button type="button" onClick={onToggle} className="block w-full text-left">
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={cn("font-mono text-[11px]", item.source === "derived" ? "text-amber-700" : "text-emerald-700")}
            title={item.source === "derived" ? "machine-derived exception" : "agent-initiated"}
          >
            {item.source === "derived" ? "▲" : "●"}
          </span>
          <HostChip hostId={item.hostId} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-on-surface">{item.summary}</span>
          {item.derived ? (
            <span className="font-mono text-[9px] uppercase tracking-wide text-amber-700">{item.derived.kind}</span>
          ) : null}
          <span className="font-mono text-[10px] text-on-surface-variant">{item.where}</span>
          <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(item.ageIso)}</span>
        </span>
      </button>
      {item.derived ? (
        <p className="mt-0.5 pl-6 font-mono text-[10px] text-on-surface-variant">
          ▲ {item.derived.evidence} · threshold: {item.derived.threshold}
        </p>
      ) : null}
      {/* FR-3: the one-count is INSPECTABLE — the altitudes this identity
          was visible from on its host, still ONE row here. */}
      <p className="mt-0.5 pl-6 font-mono text-[9px] text-on-surface-variant/80">
        counted once · seen from {item.seenFrom.join(" · ")} on {item.hostId}
      </p>
      {expanded ? (
        <div
          data-testid={`fleet-item-expanded-${item.fleetKey}`}
          className="mt-1.5 ml-6 border border-outline-variant bg-surface-low/50 px-2 py-1.5"
        >
          {/* The Q4 one-count key, VERBATIM. */}
          <p className="font-mono text-[10px] text-on-surface">
            identity: <span className="text-on-surface-variant">{item.fleetKey}</span>
          </p>
          {item.derived ? (
            <p className="mt-0.5 font-mono text-[10px] text-on-surface">
              evidence: <span className="text-on-surface-variant">{item.derived.evidence}</span>
            </p>
          ) : null}
          {/* FR-5: read + surface only — the boundary is ON the surface. */}
          <p className="mt-1 font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">
            read-only here — acting on a remote host&apos;s item rides cross-host routing (MH-3/MH-4) ·{" "}
            <button type="button" onClick={() => onOpenHost(item.hostId)} className="underline">
              open {item.hostId} →
            </button>
          </p>
        </div>
      ) : null}
    </li>
  );
}

function hostGlyph(h: FleetHostRollup): { char: string; cls: string } {
  return h.status.status === "ok" ? { char: "●", cls: "text-emerald-700" } : { char: "✕", cls: "text-error" };
}

export function FleetPage() {
  const { data, isLoading, error, refetch } = useFleet();
  const openHost = useOpenHost();
  const openKey = readSearchParam("open");

  if (isLoading) {
    return <p className="p-4 font-mono text-[11px] text-on-surface-variant">composing the fleet glance…</p>;
  }
  if (error || !data) {
    return (
      <p data-testid="fleet-error" className="p-4 font-mono text-[11px] text-error">
        fleet glance unavailable: {error instanceof Error ? error.message : "composer unreachable"}
      </p>
    );
  }

  const okHosts = data.hosts.filter((h) => h.status.status === "ok").length;

  return (
    <div data-testid="fleet-page" className="mx-auto max-w-4xl space-y-5 p-4">
      {/* Breadcrumb — FLEET is the TOP of the spine; everything drills DOWN. */}
      <nav className="flex items-center gap-2 font-mono text-[10px] uppercase text-on-surface-variant">
        <span data-testid="fleet-crumb" className="text-on-surface">fleet</span>
        <span>·</span>
        <span>every factory, one glance</span>
      </nav>

      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold uppercase">Fleet — needs me / stuck / failing</h2>
        {/* FR-3: the DAEMON's rollup (computed from the deduped rows) —
            checkable against the HOSTS band's per-host counts below. */}
        <div data-testid="fleet-rollup" className="flex items-center gap-2 font-mono text-[10px] uppercase">
          <span className="text-emerald-700">● {data.rollup.needsYouCount} need you</span>
          <span className="text-amber-700">
            ▲ {data.rollup.exceptionCount} exceptions
            {data.rollup.exceptionsByKind.length > 0
              ? ` (${data.rollup.exceptionsByKind.map((e) => `${e.count} ${e.kind}`).join(" · ")})`
              : ""}
          </span>
          <span className="text-on-surface-variant">{data.rollup.hostCount} hosts</span>
          {data.rollup.unreachableCount > 0 ? (
            <span className="text-error">{data.rollup.unreachableCount} unreachable</span>
          ) : null}
        </div>
      </header>

      {/* An existing-but-unreadable registry is surfaced, never silent. */}
      {data.registryError ? (
        <p data-testid="fleet-registry-error" className="font-mono text-[10px] text-error">
          host registry unreadable — this glance is LOCAL-ONLY, not the fleet: {data.registryError}
        </p>
      ) : null}

      {/* Band 1: NEEDS YOU — the fleet union, host-attributed, ● and ▲ at
          equal rank (the shipped grammar, one altitude up). */}
      <section data-testid="fleet-needs-you" className={cn("space-y-1 p-2", VELLUM_CARD)}>
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">NEEDS YOU</h3>
        {data.needsYou.items.length > 0 ? (
          <ul className="divide-y divide-outline-variant/50">
            {data.needsYou.items.map((item) => (
              <FleetNeedsYouRow
                key={item.fleetKey}
                item={item}
                expanded={openKey === item.fleetKey}
                onToggle={() => setAddressableOpen(openKey === item.fleetKey ? null : item.fleetKey)}
                onOpenHost={openHost}
              />
            ))}
          </ul>
        ) : null}
        <p className="font-mono text-[9px] text-on-surface-variant">{data.needsYou.provenance}</p>
      </section>

      {/* Band 2: HOSTS — the field band at fleet altitude (each factory,
          honest status; the MH-2 drill-in is the row's verb). */}
      <section data-testid="fleet-hosts" className={cn("space-y-1 p-2", VELLUM_CARD)}>
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">HOSTS</h3>
        <ul className="divide-y divide-outline-variant/50">
          {data.hosts.map((h) => {
            const glyph = hostGlyph(h);
            const ok = h.status.status === "ok";
            return (
              <li key={h.hostId} data-testid={`fleet-host-${h.hostId}`} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                <span className={cn("font-mono text-[11px]", glyph.cls)}>{glyph.char}</span>
                <Globe className="h-3 w-3 text-on-surface-variant" />
                <span className="font-mono text-[11px] uppercase text-on-surface">{h.hostId}</span>
                {h.kind === "local" ? (
                  <span className="font-mono text-[8px] uppercase text-on-surface-variant">local</span>
                ) : null}
                {ok ? (
                  <>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-on-surface-variant">{h.topLine}</span>
                    {(h.needsYouCount ?? 0) > 0 ? (
                      <span className="font-mono text-[10px] text-emerald-700">● {h.needsYouCount}</span>
                    ) : null}
                    {(h.exceptionsByKind ?? []).map((e) => (
                      <span key={e.kind} className="font-mono text-[10px] text-amber-700">
                        ▲ {e.count} {e.kind}
                      </span>
                    ))}
                    <span className="font-mono text-[9px] text-on-surface-variant">
                      {h.rigCount} rigs · {h.seatCount} seats
                    </span>
                    <button
                      type="button"
                      data-testid={`fleet-host-${h.hostId}-open`}
                      onClick={() => openHost(h.hostId)}
                      className="font-mono text-[10px] uppercase text-on-surface hover:underline"
                    >
                      open →
                    </button>
                  </>
                ) : (
                  <>
                    {/* Honest per-host truth: items ABSENT from this glance,
                        not zero (the k9s stale-header anti-pattern). */}
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-error">
                      {h.status.status}
                      {h.status.error ? ` — ${h.status.error}` : ""} · items absent from this glance, not zero
                    </span>
                    <button
                      type="button"
                      data-testid={`fleet-host-${h.hostId}-retry`}
                      onClick={() => void refetch()}
                      className="border border-error px-1.5 py-0.5 font-mono text-[9px] uppercase text-error hover:bg-surface-low"
                    >
                      retry
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Band 3: SETTLED — the record band, minimal (D-5), host-chipped. */}
      <section data-testid="fleet-settled" className="space-y-1">
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">SETTLED</h3>
        {data.settled.length > 0 ? (
          <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
            {data.settled.map((row) => (
              <li key={`${row.hostId}|${row.qitemId}`} className="flex items-center gap-2 px-2 py-1.5">
                <HostChip hostId={row.hostId} />
                <span className="font-mono text-[10px] text-on-surface-variant">{row.fromSession.split("@")[0]}</span>
                <span className="text-on-surface-variant">→</span>
                <span className="font-mono text-[10px] text-on-surface-variant">{row.toSession.split("@")[0]}</span>
                <span className="min-w-0 flex-1 truncate text-[11px]">{row.summary ?? row.qitemId}</span>
                <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(row.closedAtIso)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="font-mono text-[9px] text-on-surface-variant">{data.settledProvenance}</p>
      </section>

      <p data-testid="fleet-fanout-footer" className="font-mono text-[10px] text-on-surface-variant">
        composed {data.composedAt} · fleet fan-out {okHosts}/{data.hosts.length} hosts ok ·{" "}
        <Link to="/agents" className="hover:underline">
          this host&apos;s agents →
        </Link>
      </p>
    </div>
  );
}
