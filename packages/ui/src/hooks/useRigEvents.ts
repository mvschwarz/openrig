import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

const DEBOUNCE_MS = 100;

export interface UseRigEventsResult {
  connected: boolean;
  reconnecting: boolean;
}

export function useRigEvents(rigId: string | null): UseRigEventsResult {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const hasErroredRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidateGraph = useCallback(() => {
    if (!rigId) return;
    if (debounceTimerRef.current) return;
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      // Only invalidate the graph query — matches previous behavior
      queryClient.invalidateQueries({ queryKey: ["rig", rigId, "graph"] });
    }, DEBOUNCE_MS);
  }, [rigId, queryClient]);

  useEffect(() => {
    if (!rigId) {
      setConnected(false);
      setReconnecting(false);
      return;
    }

    hasErroredRef.current = false;
    setConnected(false);
    setReconnecting(false);
    const es = new EventSource(`/api/events?rigId=${rigId}`);

    es.addEventListener("open", () => {
      setConnected(true);
      if (hasErroredRef.current) {
        // Reconnect after error — clear indicator and trigger graph refetch
        setReconnecting(false);
        hasErroredRef.current = false;
        invalidateGraph();
      }
      // Initial open does NOT trigger invalidation (preserving existing behavior)
    });

    es.addEventListener("message", () => {
      invalidateGraph();
    });

    es.addEventListener("error", () => {
      setConnected(false);
      setReconnecting(true);
      hasErroredRef.current = true;
    });

    return () => {
      es.close();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [rigId, invalidateGraph]);

  return { connected, reconnecting };
}
