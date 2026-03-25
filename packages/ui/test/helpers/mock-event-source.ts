import { vi } from "vitest";

export interface MockEventSourceInstance {
  url: string;
  listeners: Record<string, ((event: unknown) => void)[]>;
  readyState: number;
  close: ReturnType<typeof vi.fn>;
  addEventListener(type: string, cb: (event: unknown) => void): void;
  removeEventListener(type: string, cb: (event: unknown) => void): void;
  // Test helpers
  simulateMessage(data: string): void;
  simulateError(): void;
  simulateOpen(): void;
}

export const instances: MockEventSourceInstance[] = [];

export function createMockEventSourceClass() {
  instances.length = 0;

  return class MockEventSource {
    url: string;
    readyState = 0; // CONNECTING
    listeners: Record<string, ((event: unknown) => void)[]> = {};
    close = vi.fn(() => { this.readyState = 2; });

    constructor(url: string) {
      this.url = url;
      instances.push(this as unknown as MockEventSourceInstance);

      // Auto-fire open after microtask (simulates connection)
      // But do NOT call onEvent — that's only for reconnect after error
      queueMicrotask(() => {
        this.readyState = 1; // OPEN
        this.fireEvent("open", {});
      });
    }

    addEventListener(type: string, cb: (event: unknown) => void) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type]!.push(cb);
    }

    removeEventListener(type: string, cb: (event: unknown) => void) {
      const list = this.listeners[type];
      if (list) {
        const idx = list.indexOf(cb);
        if (idx >= 0) list.splice(idx, 1);
      }
    }

    private fireEvent(type: string, event: unknown) {
      const list = this.listeners[type];
      if (list) {
        for (const cb of [...list]) {
          cb(event);
        }
      }
    }

    simulateMessage(data: string) {
      this.fireEvent("message", { data });
    }

    simulateError() {
      this.readyState = 2; // CLOSED
      this.fireEvent("error", {});
    }

    simulateOpen() {
      this.readyState = 1; // OPEN
      this.fireEvent("open", {});
    }
  };
}
