import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

export interface DiscoveredSession {
  id: string;
  tmuxSession: string;
  tmuxWindow: string | null;
  tmuxPane: string | null;
  pid: number | null;
  cwd: string | null;
  activeCommand: string | null;
  runtimeHint: string;
  confidence: string;
  evidenceJson: string | null;
  configJson: string | null;
  status: string;
  claimedNodeId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Trigger a discovery scan. On success, invalidates discovery list queries. */
export function useDiscoveryScan() {
  const queryClient = useQueryClient();
  return useMutation<{ sessions: DiscoveredSession[] }, Error>({
    mutationFn: async () => {
      const res = await fetch("/api/discovery/scan", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["discovery"] });
    },
  });
}

/** Read discovered sessions list. Pure read, no scan side effect. Normalizes non-array responses. */
export function useDiscoveredSessions(status?: string, enabled: boolean = true) {
  const url = status ? `/api/discovery?status=${encodeURIComponent(status)}` : "/api/discovery";
  return useQuery<DiscoveredSession[]>({
    queryKey: ["discovery", status ?? "all"],
    queryFn: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    enabled,
  });
}

/** Conditional hook for discovered sessions — only fetches when enabled */
export function useDiscoveredSessionsConditional(enabled: boolean): DiscoveredSession[] {
  const { data } = useDiscoveredSessions("active", enabled);
  return data ?? [];
}

/** Claim a discovered session into a rig. Invalidates discovery + rig graph. */
export function useClaimSession() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true; nodeId: string; sessionId: string }, Error, { discoveredId: string; rigId: string; logicalId?: string }>({
    mutationFn: async ({ discoveredId, rigId, logicalId }) => {
      const res = await fetch(`/api/discovery/${encodeURIComponent(discoveredId)}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rigId, logicalId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["discovery"] });
      queryClient.invalidateQueries({ queryKey: ["rig", vars.rigId, "graph"] });
    },
  });
}

/** Poll-based scan trigger: scans every intervalMs while active. */
export function useDiscoveryPoll(intervalMs: number = 30_000, enabled: boolean = true) {
  const scanMutation = useDiscoveryScan();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // Initial scan on mount
    scanMutation.mutate();
    // Poll
    intervalRef.current = setInterval(() => {
      scanMutation.mutate();
    }, intervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs]);

  return scanMutation;
}
