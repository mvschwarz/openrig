// OPR.0.4.6.MH1 FR-5 — the dashboard host-config data layer.
//
// READS ride GET /api/hosts (pointers-only rows + selected marker +
// coarse status — the daemon-side sibling of `rig host ls --json`).
// WRITES ride the narrow named add/pair route family (arch P1) with the
// mission-control bearer posture; the SWITCHER and RENAME deliberately
// do NOT live here — they are plain settings writes (host.selected /
// host.name via useSetSetting → POST /api/config/:key), the ONE write
// path both surfaces converge on.

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { missionControlAuthHeaders } from "../components/mission-control/missionControlAuth.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";

export interface HostRow {
  id: string;
  transport: "ssh" | "http";
  target?: string;
  url?: string;
  bearer_env?: string;
  bearer_file?: string;
  notes?: string;
  selected: boolean;
  status: "reachable" | "unreachable" | "unknown";
}

export interface HostsResponse {
  ownName: string;
  selected: string;
  hosts: HostRow[];
}

async function fetchHosts(): Promise<HostsResponse> {
  const res = await fetch("/api/hosts");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as HostsResponse;
}

export function useHosts() {
  return useQuery<HostsResponse>({
    queryKey: ["hosts"],
    queryFn: fetchHosts,
    refetchInterval: 5_000,
  });
}

// OPR.0.4.6.MH2 FR-1/FR-3 — the ONE selection source for the whole app.
// The `["hosts"]` cache entry (polled by the always-mounted HostIndicator
// + the explorer trees via useHosts) carries the same `host.selected`
// config key the CLI writes, so indicator + data derive from a single
// state source: every read hook keys on this value and the k9s
// stale-header class (A-label-over-B-data) is structurally excluded.
//
// CACHE OBSERVER, deliberately no fetch of its own (enabled: false): this
// hook rides inside all seven read hooks, and issuing a request per
// consumer would add an /api/hosts call to every surface — breaking every
// sequenced-fetch-mock harness and multiplying polls for zero information
// (the active useHosts observers keep the entry warm on every real
// screen). Absent cache ⇒ local — the safe/truthful initial render.
export function useSelectedHostId(): string {
  const { data } = useQuery<HostsResponse>({
    queryKey: ["hosts"],
    queryFn: fetchHosts,
    enabled: false,
  });
  return data?.selected ?? LOCAL_HOST_ID;
}

/** OPR.0.4.6.MH2 guard-B1 — the shared host-selection state for LOCAL-
 *  filesystem-backed surfaces: `known` = the hosts payload landed;
 *  `isLocal` = the selection is the local host. Components render LOADING
 *  while !known (never the remote-gated copy — no misleading flash on a
 *  local cold start) and the gated copy only when known-remote.
 *
 *  ACTIVE observer (unlike useSelectedHostId): the consumers are LEAF
 *  panels (BriefPanel, MissionGlance) that must be correct standalone —
 *  with no page-level useHosts in the tree a disabled observer would
 *  never learn the selection and load forever. In-app it dedupes with the
 *  page poller on the same ["hosts"] key; the high-fanout READ hooks keep
 *  the disabled-observer pattern (they always render under active pages). */
export function useHostSelection(): { known: boolean; isLocal: boolean } {
  const { data } = useHosts();
  return { known: data !== undefined, isLocal: (data?.selected ?? LOCAL_HOST_ID) === LOCAL_HOST_ID };
}

/** OPR.0.4.6.MH2 guard-B1 — the ONE shared FETCH gate for LOCAL-filesystem
 *  reads (/api/files/* is local-only and excluded from the read-through).
 *  True ONLY when the selection is KNOWN AND local: gating on not-remote
 *  alone races on first render (local-presumed reads fired before a remote
 *  selection resolved). Every file-backed surface consumes THIS hook so no
 *  future call site re-derives the gate wrong. */
export function useLocalFilesAllowed(): boolean {
  const { known, isLocal } = useHostSelection();
  return known && isLocal;
}

/** OPR.0.4.6.MH2 rev1-r2 re-re-verdict B1 — discovery placement targets
 *  feed the LOCAL adopt mutation; a target created while local must not
 *  survive a host switch (stale ADOPT actionable under a remote label).
 *  The shell calls this with its clearPlacement so ANY selected-host
 *  change drops the stale target + discovered-session selection (belt;
 *  the panel additionally suppresses the target/adopt UI under a remote
 *  selection — braces). */
export function useClearPlacementOnHostSwitch(clear: () => void) {
  const hostId = useSelectedHostId();
  const prev = useRef(hostId);
  useEffect(() => {
    if (prev.current !== hostId) {
      prev.current = hostId;
      clear();
    }
  }, [hostId, clear]);
}

/** Selection WRITE — the same one write path as the CLI (`rig host select`
 *  is a thin client of POST /api/config/host.selected). Invalidate the
 *  hosts query so indicator + all host-keyed reads retarget immediately
 *  instead of waiting out the 5s poll. */
export function useSelectHost() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { hostId: string }>({
    mutationFn: async ({ hostId }) => {
      const res = await fetch(`/api/config/${encodeURIComponent("host.selected")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: hostId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export interface PairStart {
  pairId: string;
  code: string;
  target: string;
}

export function usePairHost() {
  return useMutation<PairStart, Error, { url: string; id?: string }>({
    mutationFn: async (input) => {
      const res = await fetch("/api/hosts/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...missionControlAuthHeaders() },
        body: JSON.stringify(input),
      });
      const body = (await res.json().catch(() => ({}))) as PairStart & { error?: string; message?: string };
      if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      return body;
    },
  });
}

export interface PairPollResult {
  status: "pending" | "approved" | "denied" | "expired";
  code?: string;
  entry?: HostRow;
}

/** Poll the local daemon's pull-through pair leg while a pairing is live.
 *  Pass null to idle the hook (no request). */
export function usePairPoll(pairId: string | null) {
  const qc = useQueryClient();
  return useQuery<PairPollResult>({
    queryKey: ["hosts-pair", pairId],
    enabled: pairId !== null,
    queryFn: async () => {
      const res = await fetch(`/api/hosts/pair/${pairId}`, {
        headers: { ...missionControlAuthHeaders() },
      });
      const body = (await res.json().catch(() => ({}))) as PairPollResult & { error?: string; message?: string };
      if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      if (body.status === "approved") void qc.invalidateQueries({ queryKey: ["hosts"] });
      return body;
    },
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === undefined || s === "pending" ? 2_000 : false;
    },
  });
}
