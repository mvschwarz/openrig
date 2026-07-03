// OPR.0.4.3.21 — shared daemon-health signal.
//
// A daemon can be alive + listening yet have a WEDGED event loop so it cannot
// service requests. `/healthz` runs on that same loop, so a failing/timing-out
// health poll (or an enriched body whose event-loop verdict is `healthy:false`)
// is the honest "control plane is unhealthy" signal.
//
// This is the ONE source both the System panel and the live terminal read: the
// panel via {@link useDaemonHealth}, the terminal via the React context
// (so it degrades gracefully — `useContext` returns the healthy default when no
// provider is mounted, e.g. in the many terminal unit tests that render
// FocusedTerminal standalone).

import { createContext, useContext } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

export interface DaemonEventLoopEvidence {
  lagMeanMs: number;
  lagP99Ms: number;
  utilization: number;
  lastTickAgeMs: number;
  healthy: boolean;
}

export interface DaemonHealthPayload {
  status: string;
  /** Present only when the daemon has the event-loop monitor wired (OPR.0.4.3.21+). */
  eventLoop?: DaemonEventLoopEvidence;
}

async function fetchDaemonHealth(): Promise<DaemonHealthPayload> {
  const res = await fetch("/healthz");
  if (!res.ok) throw new Error("unhealthy");
  return (await res.json()) as DaemonHealthPayload;
}

export interface DaemonHealthSignal {
  /**
   * True only when we POSITIVELY know the control plane is unhealthy: the
   * health poll failed (a wedged loop can't answer /healthz) OR healthz
   * answered but its event-loop verdict is `healthy:false`. Never true on the
   * unknown/first-load state — so the terminal only overrides the broker's
   * generic message when there is a real signal.
   */
  controlPlaneUnhealthy: boolean;
  evidence: DaemonEventLoopEvidence | null;
}

/**
 * The daemon-health query. Same queryKey the System panel has always used, so
 * every consumer shares ONE poll / one cache entry.
 */
export function useDaemonHealthQuery(): UseQueryResult<DaemonHealthPayload> {
  return useQuery({
    queryKey: ["daemon", "health"],
    queryFn: fetchDaemonHealth,
    refetchInterval: 10_000,
    retry: false,
  });
}

export function deriveDaemonHealthSignal(query: UseQueryResult<DaemonHealthPayload>): DaemonHealthSignal {
  const evidence = query.data?.eventLoop ?? null;
  const controlPlaneUnhealthy = query.isError || evidence?.healthy === false;
  return { controlPlaneUnhealthy, evidence };
}

/** Convenience: the query plus the derived signal, for panel-style consumers. */
export function useDaemonHealth(): { query: UseQueryResult<DaemonHealthPayload>; signal: DaemonHealthSignal } {
  const query = useDaemonHealthQuery();
  return { query, signal: deriveDaemonHealthSignal(query) };
}

// Healthy default: no provider mounted → the terminal never overrides. This is
// what keeps every provider-less FocusedTerminal unit test behaving as before.
export const DaemonHealthContext = createContext<DaemonHealthSignal>({
  controlPlaneUnhealthy: false,
  evidence: null,
});

export function useDaemonHealthSignal(): DaemonHealthSignal {
  return useContext(DaemonHealthContext);
}
