export type TopologyEvent = Record<string, unknown> & {
  type?: string;
  rigId?: string;
  seq?: number;
  createdAt?: string;
};

export interface TopologyEventStatus {
  connected: boolean;
  reconnecting: boolean;
}

type TopologyEventListener = (event: TopologyEvent, rawData: string) => void;
type TopologyStatusListener = (status: TopologyEventStatus) => void;

const GLOBAL_EVENTS_URL = "/api/events";

class TopologyEventHub {
  private eventSource: EventSource | null = null;
  private eventListeners = new Set<TopologyEventListener>();
  private statusListeners = new Set<TopologyStatusListener>();
  private connected = false;
  private reconnecting = false;

  subscribe(listener: TopologyEventListener): () => void {
    this.eventListeners.add(listener);
    this.ensureConnected();
    return () => {
      this.eventListeners.delete(listener);
      this.closeIfIdle();
    };
  }

  subscribeStatus(listener: TopologyStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.snapshot());
    this.ensureConnected();
    return () => {
      this.statusListeners.delete(listener);
      this.closeIfIdle();
    };
  }

  snapshot(): TopologyEventStatus {
    return {
      connected: this.connected,
      reconnecting: this.reconnecting,
    };
  }

  private ensureConnected(): void {
    if (this.eventSource || typeof EventSource === "undefined") return;

    const eventSource = new EventSource(GLOBAL_EVENTS_URL);
    this.eventSource = eventSource;

    eventSource.addEventListener("open", () => {
      this.connected = true;
      this.reconnecting = false;
      this.emitStatus();
    });

    eventSource.addEventListener("error", () => {
      this.connected = false;
      this.reconnecting = true;
      this.emitStatus();
    });

    eventSource.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      if (typeof data !== "string") return;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const topologyEvent = parsed as TopologyEvent;
      for (const listener of [...this.eventListeners]) {
        listener(topologyEvent, data);
      }
    });
  }

  private closeIfIdle(): void {
    if (this.eventListeners.size > 0 || this.statusListeners.size > 0) return;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connected = false;
    this.reconnecting = false;
  }

  private emitStatus(): void {
    const status = this.snapshot();
    for (const listener of [...this.statusListeners]) {
      listener(status);
    }
  }
}

const topologyEventHub = new TopologyEventHub();

export function subscribeTopologyEvents(listener: TopologyEventListener): () => void {
  return topologyEventHub.subscribe(listener);
}

export function subscribeTopologyEventStatus(listener: TopologyStatusListener): () => void {
  return topologyEventHub.subscribeStatus(listener);
}

export function getTopologyEventStatus(): TopologyEventStatus {
  return topologyEventHub.snapshot();
}

export const TOPOLOGY_EVENT_HUB_URL = GLOBAL_EVENTS_URL;

export const __test_internals = {
  TOPOLOGY_EVENT_HUB_URL,
  topologyEventHub,
};
