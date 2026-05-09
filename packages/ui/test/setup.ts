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
