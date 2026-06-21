// OPR.0.4.0.1 — global live-terminal cap registry.
//
// PM-locked architecture (concurrence qitem-20260621004748-63ec48b1):
//   - the cap is GLOBAL: total simultaneously-live terminals across graph +
//     table + topology surfaces must be <= MAX_LIVE_TERMINALS;
//   - opening a live terminal past the cap EVICTS THE OLDEST live one, which
//     REVERTS TO STATIC (its revert callback closes the WS + renders the static
//     preview — no WS leak). It is reverted, not removed.
//
// This is the framework-free core (a pure class). The React context
// (LiveTerminalProvider) wraps a single instance and is mounted above all three
// surfaces so the cap is truly global. Kept pure so the cap/eviction logic is
// unit-testable without rendering xterm/WebSocket.

/** OPR.0.4.0.1 — the single named default cap (PM decision: 2; revisit -> 3 on
 *  perf data). This is the ONE place the default lives; the config key
 *  `ui.terminal.max_live_terminals` (daemon-backed) overrides it at runtime, so
 *  the 2 -> 3 change is a one-place / one-config edit, not a code rewrite. */
export const MAX_LIVE_TERMINALS = 2;

export class LiveTerminalRegistry {
  /** Live keys in insertion order — index 0 is the OLDEST (evicted first). */
  private order: string[] = [];
  /** key -> its revert-to-static callback (run on eviction). */
  private reverts = new Map<string, () => void>();
  private readonly cap: number;

  constructor(cap: number) {
    // A bad/zero cap must never mean "no terminal can ever be live"; floor at 1.
    this.cap = Math.max(1, Math.floor(cap));
  }

  /** Mark `key` live. If it is already live, refresh its recency (it becomes
   *  the newest, so it is evicted last). Otherwise evict the oldest live
   *  terminal(s) until there is room, then admit `key`. Evicted terminals have
   *  their `revertToStatic` callback invoked. */
  requestLive(key: string, revertToStatic: () => void): void {
    if (this.reverts.has(key)) {
      this.touch(key);
      this.reverts.set(key, revertToStatic);
      return;
    }
    while (this.order.length >= this.cap) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      const revert = this.reverts.get(oldest);
      this.reverts.delete(oldest);
      revert?.();
    }
    this.order.push(key);
    this.reverts.set(key, revertToStatic);
  }

  /** Free `key`'s slot WITHOUT evicting (e.g. on unmount or a manual revert).
   *  Does not run the revert callback — the caller is already going static.
   *  Idempotent. */
  release(key: string): void {
    if (!this.reverts.has(key)) return;
    this.reverts.delete(key);
    this.order = this.order.filter((k) => k !== key);
  }

  isLive(key: string): boolean {
    return this.reverts.has(key);
  }

  get size(): number {
    return this.order.length;
  }

  private touch(key: string): void {
    this.order = this.order.filter((k) => k !== key);
    this.order.push(key);
  }
}
