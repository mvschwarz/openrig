import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  subscribeTopologyEvents,
  subscribeTopologyEventStatus,
} from "../lib/topology-events.js";

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
      // Only invalidate the graph query; this matches previous behavior.
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
    const unsubscribeStatus = subscribeTopologyEventStatus((status) => {
      setConnected(status.connected);
      setReconnecting(status.reconnecting);
      if (status.reconnecting) {
        hasErroredRef.current = true;
        return;
      }
      if (status.connected && hasErroredRef.current) {
        hasErroredRef.current = false;
        invalidateGraph();
      }
    });

    const unsubscribeEvents = subscribeTopologyEvents((event) => {
      if (event.rigId !== rigId) return;
      invalidateGraph();
    });

    return () => {
      unsubscribeEvents();
      unsubscribeStatus();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [rigId, invalidateGraph]);

  return { connected, reconnecting };
}
