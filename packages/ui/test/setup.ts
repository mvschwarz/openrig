// HARNESS TEARDOWN HYGIENE (desk-caught post-teardown ReferenceError, 2026-08-07):
// vitest.config.ts leaves `globals` at its default FALSE, so React Testing
// Library's automatic afterEach(cleanup) never registers — every test file that
// does not clean up itself leaves its React tree MOUNTED. A mounted tree can
// still have scheduled work; when that task lands after the environment is
// disposed it dereferences a `window` that no longer exists ("ReferenceError:
// window is not defined" at performWorkOnRootViaSchedulerTask), which vitest
// warns can produce FALSE POSITIVE tests and which flips the run's exit code
// while every test reports green. Registering cleanup here unmounts each tree —
// cancelling the components' own effect cleanups (rAF, listeners, observers) —
// so no work outlives its context. The cure is unmounting, never suppression.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// Polyfill ResizeObserver for jsdom (required by React Flow)
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
  }

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

function ensureStorage(target: typeof globalThis) {
  const storage = target.localStorage;
  if (storage && typeof storage.clear === "function" && typeof storage.setItem === "function") return;
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
}

ensureStorage(globalThis);

if (typeof window !== "undefined") {
  ensureStorage(window);
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: () => {},
  });
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
}

if (typeof HTMLCanvasElement !== "undefined" && !HTMLCanvasElement.prototype.getContext) {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
}

// React Flow also needs DOMMatrixReadOnly
if (!globalThis.DOMMatrixReadOnly) {
  globalThis.DOMMatrixReadOnly = class DOMMatrixReadOnly {
    m22: number;
    constructor() {
      this.m22 = 1;
    }
    inverse() {
      return new DOMMatrixReadOnly();
    }
  } as unknown as typeof DOMMatrixReadOnly;
}
