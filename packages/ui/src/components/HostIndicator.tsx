// OPR.0.4.6.MH2 FR-3 — the which-host indicator (the AppShell topbar's
// reserved V2 right-slot affordance).
//
// TRUTHFUL TO THE DATA SOURCE, ALWAYS: this component and every retargeted
// read hook derive from the SAME selection value (useHosts().selected →
// useSelectedHostId), so the indicator and the on-screen data move together
// — the k9s stale-header class (host-A label over host-B data) is
// structurally excluded. States per the locked twin frames:
//   local           → quiet `<OWN-NAME> · LOCAL` (fr1 — local looks like today)
//   remote settled  → emphasized `⊕ VIEWING <HOST>` chip (fr2-fr3)
//   remote fetching → pulsing `CONNECTING TO <HOST>…` (fr6-loading;
//                     VS Code Remote state-machine precedent)
//   remote unreachable (registry probe) → red `<HOST> · UNREACHABLE`
//                     (fr6-unreachable)

import { useIsFetching } from "@tanstack/react-query";
import { useHosts } from "../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";

export function HostIndicator() {
  const { data } = useHosts();
  const selected = data?.selected ?? LOCAL_HOST_ID;
  // Only the retargeted read queries carry the selected hostId in their
  // keys, so this counts exactly the remote reads in flight.
  const remoteFetches = useIsFetching({
    predicate: (query) => selected !== LOCAL_HOST_ID && query.queryKey.includes(selected),
  });

  if (selected === LOCAL_HOST_ID) {
    const ownName = data?.ownName && data.ownName.trim() !== "" ? data.ownName : "localhost";
    return (
      <span
        data-testid="host-indicator"
        data-host={LOCAL_HOST_ID}
        data-state="local"
        className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant"
      >
        {ownName} · local
      </span>
    );
  }

  const row = data?.hosts.find((h) => h.id === selected);
  if (row?.status === "unreachable") {
    return (
      <span
        data-testid="host-indicator"
        data-host={selected}
        data-state="unreachable"
        className="inline-flex items-center gap-1 border border-error px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-error"
      >
        ⊕ {selected} · unreachable
      </span>
    );
  }
  if (remoteFetches > 0) {
    return (
      <span
        data-testid="host-indicator"
        data-host={selected}
        data-state="connecting"
        className="inline-flex animate-pulse items-center gap-1 border border-outline px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface"
      >
        ⊕ connecting to {selected}…
      </span>
    );
  }
  return (
    <span
      data-testid="host-indicator"
      data-host={selected}
      data-state="viewing"
      className="inline-flex items-center gap-1 bg-inverse-surface px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-background"
    >
      ⊕ viewing {selected}
    </span>
  );
}
