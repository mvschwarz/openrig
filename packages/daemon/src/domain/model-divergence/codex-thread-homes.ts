import type { CodexThreadIdResolver } from "../codex-thread-id.js";

/** One Codex home's thread lookup: a {@link CodexThreadIdResolver} bound to that home. */
export type CodexHomeThreadReader = Pick<CodexThreadIdResolver, "resolve" | "resolveUngatedLegacy">;

/**
 * The thread a Codex process logged, read from each Codex home in the order given (the daemon's own home first, then each
 * declared seat home); the first home that answers wins, and later homes aren't read. A home's read is synchronous (it
 * reads that home's Codex databases with better-sqlite3), so one event-loop turn (setImmediate, not a microtask) comes
 * before each home after the first: queued requests and timers run between homes instead of waiting behind the whole
 * scan, as the watchdog tick does between jobs. Each home's own read is still one uninterrupted step.
 */
export async function readThreadIdAcrossHomes(homes: readonly CodexHomeThreadReader[], pid: number,
  identity: string | undefined): Promise<string | undefined> {
  let index = 0;
  for (const home of homes) {
    if (index++ > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const threadId = identity === undefined ? await home.resolveUngatedLegacy(pid) : await home.resolve(pid, identity);
    if (threadId) return threadId;
  }
  return undefined;
}
