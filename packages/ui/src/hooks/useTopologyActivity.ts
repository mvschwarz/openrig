import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subscribeTopologyEvents } from "../lib/topology-events.js";
import {
  HOT_POTATO_TRAIL_TTL_MS,
  TOPOLOGY_NODE_ACTIVITY_TTL_MS,
  TOPOLOGY_RIG_ACTIVITY_TTL_MS,
  computeActivityVisual,
  isRigRecentlyActive,
  makeHotPotatoPacket,
  parseTopologyActivityEvent,
  resolveTopologySession,
  type ActivityRingState,
  type HotPotatoPacket,
  type TopologyActivityBaseline,
  type TopologyActivityVisual,
  type TopologyRecentNodeActivity,
  type TopologySessionIndex,
} from "../lib/topology-activity.js";

interface TopologyActivityStore {
  nodeActivity: Map<string, TopologyRecentNodeActivity>;
  rigActivity: Map<string, number>;
  packets: HotPotatoPacket[];
  unresolvedCount: number;
  sequence: number;
}

export interface TopologyActivitySnapshot {
  version: number;
  unresolvedCount: number;
  packets: HotPotatoPacket[];
  getNodeActivity(nodeId: string, baseline?: TopologyActivityBaseline | null): TopologyActivityVisual;
  isRigRecentlyActive(rigId: string | null | undefined): boolean;
}

function createStore(): TopologyActivityStore {
  return {
    nodeActivity: new Map(),
    rigActivity: new Map(),
    packets: [],
    unresolvedCount: 0,
    sequence: 0,
  };
}

let sharedTopologyActivityStore: TopologyActivityStore = createStore();

export function resetTopologyActivityStoreForTests(): void {
  sharedTopologyActivityStore = createStore();
}

function recordNodeActivity(
  store: TopologyActivityStore,
  nodeId: string,
  state: ActivityRingState,
  nowMs: number,
  flash: "source" | "target" | null,
): void {
  const existing = store.nodeActivity.get(nodeId);
  const existingLive = existing && nowMs - existing.lastActiveAt <= TOPOLOGY_NODE_ACTIVITY_TTL_MS
    ? existing
    : undefined;
  const next: TopologyRecentNodeActivity = {
    state: strongestRecentState(existingLive?.state ?? "idle", state),
    lastActiveAt: nowMs,
    sourceFlashAt: flash === "source" ? nowMs : existingLive?.sourceFlashAt,
    targetFlashAt: flash === "target" ? nowMs : existingLive?.targetFlashAt,
  };
  store.nodeActivity.set(nodeId, next);
}

function strongestRecentState(a: ActivityRingState, b: ActivityRingState): ActivityRingState {
  const rank = (state: ActivityRingState) =>
    state === "blocked" ? 3 : state === "needs_input" ? 2 : state === "active" ? 1 : 0;
  return rank(b) > rank(a) ? b : a;
}

function pruneStore(store: TopologyActivityStore, nowMs: number): boolean {
  let changed = false;
  const packetCount = store.packets.length;
  store.packets = store.packets.filter((packet) => nowMs - packet.createdAt <= HOT_POTATO_TRAIL_TTL_MS);
  changed ||= store.packets.length !== packetCount;

  for (const [nodeId, activity] of store.nodeActivity.entries()) {
    if (nowMs - activity.lastActiveAt > TOPOLOGY_NODE_ACTIVITY_TTL_MS) {
      store.nodeActivity.delete(nodeId);
      changed = true;
    }
  }

  for (const [rigId, lastActiveAt] of store.rigActivity.entries()) {
    if (nowMs - lastActiveAt > TOPOLOGY_RIG_ACTIVITY_TTL_MS) {
      store.rigActivity.delete(rigId);
      changed = true;
    }
  }

  return changed;
}

export function useTopologyActivity(index: TopologySessionIndex): TopologyActivitySnapshot {
  const [version, setVersion] = useState(0);
  const indexRef = useRef(index);
  const storeRef = useRef<TopologyActivityStore>(sharedTopologyActivityStore);
  indexRef.current = index;

  const bump = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeTopologyEvents((event) => {
      const parsed = parseTopologyActivityEvent(event);
      if (!parsed) return;

      const nowMs = Date.now();
      const store = storeRef.current;
      const currentIndex = indexRef.current;
      let changed = false;

      for (const item of parsed.sessions) {
        const resolved = resolveTopologySession(currentIndex, item.session);
        if (!resolved) {
          store.unresolvedCount += 1;
          changed = true;
          continue;
        }
        recordNodeActivity(store, resolved.nodeId, item.state, nowMs, item.flash ?? null);
        if (resolved.rigId) store.rigActivity.set(resolved.rigId, nowMs);
        changed = true;
      }

      if (parsed.packet) {
        const source = resolveTopologySession(currentIndex, parsed.packet.sourceSession);
        const target = resolveTopologySession(currentIndex, parsed.packet.targetSession);
        if (source && target) {
          store.sequence += 1;
          store.packets.push(makeHotPotatoPacket({
            eventType: parsed.type,
            qitemId: parsed.qitemId,
            sourceSession: source,
            targetSession: target,
            createdAt: nowMs,
            sequence: store.sequence,
          }));
          recordNodeActivity(store, source.nodeId, "active", nowMs, "source");
          recordNodeActivity(store, target.nodeId, "active", nowMs, "target");
          if (source.rigId) store.rigActivity.set(source.rigId, nowMs);
          if (target.rigId) store.rigActivity.set(target.rigId, nowMs);
          changed = true;
        } else {
          store.unresolvedCount += 1;
          changed = true;
        }
      }

      changed ||= pruneStore(store, nowMs);
      if (changed) bump();
    });
    return unsubscribe;
  }, [bump]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const nowMs = Date.now();
      const store = storeRef.current;
      if (pruneStore(store, nowMs)) {
        bump();
      }
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [bump]);

  return useMemo(() => {
    const store = storeRef.current;
    const nowMs = Date.now();
    return {
      version,
      unresolvedCount: store.unresolvedCount,
      packets: [...store.packets],
      getNodeActivity(nodeId, baseline) {
        return computeActivityVisual({
          baseline,
          recent: store.nodeActivity.get(nodeId) ?? null,
          nowMs,
        });
      },
      isRigRecentlyActive(rigId) {
        if (!rigId) return false;
        return isRigRecentlyActive(store.rigActivity.get(rigId), nowMs);
      },
    };
  }, [version]);
}
