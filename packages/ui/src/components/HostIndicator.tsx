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
        className="hidden text-xs text-on-surface-variant sm:inline"
      >
        <span className="font-mono">{ownName}</span> · Local
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
        className="inline-flex max-w-[40vw] items-center gap-1 truncate rounded-full border border-error px-2 py-0.5 text-xs font-medium text-error"
      >
        ⊕ <span className="font-mono">{selected}</span> · Unreachable
      </span>
    );
  }
  if (remoteFetches > 0) {
    return (
      <span
        data-testid="host-indicator"
        data-host={selected}
        data-state="connecting"
        className="inline-flex max-w-[40vw] animate-pulse items-center gap-1 truncate rounded-full border border-outline px-2 py-0.5 text-xs font-medium text-on-surface motion-reduce:animate-none"
      >
        ⊕ Connecting to <span className="font-mono">{selected}</span>…
      </span>
    );
  }
  return (
    <span
      data-testid="host-indicator"
      data-host={selected}
      data-state="viewing"
      className="inline-flex max-w-[40vw] items-center gap-1 truncate rounded-full bg-inverse-surface px-2 py-0.5 text-xs font-medium text-background"
    >
      ⊕ Viewing <span className="font-mono">{selected}</span>
    </span>
  );
}
