import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeTopologyEvents } from "../lib/topology-events.js";

/**
 * Global event listener. Subscribes to the shared /api/events hub and
 * invalidates relevant queries when state-changing events arrive.
 * Mounted once in AppShell.
 */
export function useGlobalEvents(): void {
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const pendingInvalidations = new Set<string>();

    const unsubscribe = subscribeTopologyEvents((parsed) => {
      const { type, rigId } = parsed;
      if (!type) return;

      // Collect affected query keys
      if (type.startsWith("node.startup_") && rigId) {
        pendingInvalidations.add(`rig:${rigId}:nodes`);
      }
      if (type === "rig.created" || type === "rig.deleted" || type === "rig.stopped" ||
          type === "rig.imported" ||
          type === "bootstrap.completed" || type === "bootstrap.partial") {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
      }
      if (type === "restore.completed") {
        // slice-04: ps + default-summary are AGGREGATE signals — queue them
        // REGARDLESS of rigId (matching the prior ActivityFeed aggregate
        // behavior). Only the rig-specific nodes key stays conditional on rigId.
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
        if (rigId) pendingInvalidations.add(`rig:${rigId}:nodes`);
      }
      // slice-04: useGlobalEvents (this one AppShell-mounted 150ms Set/timer) is
      // now the SOLE coalesced owner of the ps + default-summary invalidations
      // that ActivityFeed used to fire per-event. Rig-scoped graph/nodes/sessions
      // + discovery invalidations stay in ActivityFeed (distinct-key semantics).
      if (type === "node.claimed" && rigId) {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
      }
      if (type === "session.detached" || type === "node.removed" ||
          type === "pod.deleted" || type === "rig.expanded") {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
      }
      // OPR.0.3.3.19 (AC-7): archive/unarchive move a rig between the default
      // view and the per-host Archive section. Refetch BOTH the default summary
      // AND the archived-only summary (a separate query key) plus ps, so a CLI
      // or other-browser archive/unarchive updates a mounted UI reactively
      // instead of going stale until manual reload.
      if (type === "rig.archived" || type === "rig.unarchived") {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("rigs:summary:archived");
        pendingInvalidations.add("ps");
        if (rigId) pendingInvalidations.add(`rig:${rigId}:nodes`);
      }

      // Schedule flush
      if (debounceRef.current) return; // Already scheduled
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;

        // Flush all pending invalidations
        for (const key of pendingInvalidations) {
          if (key === "rigs:summary") {
            queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
          } else if (key === "rigs:summary:archived") {
            // OPR.0.3.3.19: the Archive section's archived-only query (see
            // useArchivedRigs, queryKey ["rigs","summary","archived"]).
            // Invalidated explicitly so it refetches even though the broader
            // ["rigs","summary"] prefix invalidation would also cover it.
            queryClient.invalidateQueries({ queryKey: ["rigs", "summary", "archived"] });
          } else if (key === "ps") {
            queryClient.invalidateQueries({ queryKey: ["ps"] });
          } else if (key.startsWith("rig:")) {
            const parts = key.split(":");
            queryClient.invalidateQueries({ queryKey: ["rig", parts[1], parts[2]] });
          }
        }
        pendingInvalidations.clear();
      }, 150);
    });

    return () => {
      unsubscribe();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [queryClient]);
}
