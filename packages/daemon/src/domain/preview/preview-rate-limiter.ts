// Preview Terminal v0 (PL-018) — per-session rate limiter for /preview.
//
// Live preview polling could hammer tmux if every operator + every
// pinned pane fires an unthrottled `tmux capture-pane`. This in-memory
// cache returns the last captured payload for any subsequent request
// inside the rate-limit window.
//
// Default window: 1 second per session. UI poll defaults to 3 seconds
// (`ui.preview.refresh_interval_seconds`), so collisions only happen
// when multiple panes pin the same seat or the operator manually
// refreshes faster — which is exactly when caching is the right move.
//
// MVP single-host context: one daemon process; no shared state across
// hosts. Map is per-process.

export interface CachedCapture<T> {
  payload: T;
  capturedAt: number; // epoch ms
}

export class PreviewRateLimiter<T> {
  private readonly cache = new Map<string, CachedCapture<T>>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Returns the cached payload for `sessionName` if it was captured
   * within the rate-limit window; otherwise null. Caller is expected
   * to take a fresh capture and write back via `set` on null.
   */
  get(sessionName: string): CachedCapture<T> | null {
    const cached = this.cache.get(sessionName);
    if (!cached) return null;
    if (this.now() - cached.capturedAt > this.windowMs) return null;
    return cached;
  }

  set(sessionName: string, payload: T): CachedCapture<T> {
    const entry: CachedCapture<T> = { payload, capturedAt: this.now() };
    this.cache.set(sessionName, entry);
    return entry;
  }

  /** Clear cache entry for a session (e.g., on session teardown). */
  clear(sessionName: string): void {
    this.cache.delete(sessionName);
  }
}
