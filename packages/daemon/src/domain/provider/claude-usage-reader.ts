// Slice-04 (OPR.0.5.0.4) seam C3 — the Claude statusline provider_usage cache LANE.
// A statusline sidecar writes a per-account provider_usage cache with an atomic tmp+rename (so a
// concurrent daemon read never sees a torn file); the daemon reads it here and normalizes it into
// provider_statusline signal rows via the existing claudeStatuslineSignals. Absent cache
// (pre-first-response), api_key accounts, and empty/malformed readings each become an EXPLICIT
// unknown row with an unknownReason — never a missing row and never a fabricated zero. Never throws.
//
// SCOPE: this atom is the cache producer/reader + collectSignals wiring ONLY. It does not touch the
// C4 reactive tap, C2 Codex app-server, activity-accurate precheck, D switch execution, or BR-1.

import { claudeStatuslineSignals, type ClaudeStatuslineReading } from "./provider-signals.js";
import type { ProviderSignal } from "./provider-types.js";

export interface ProviderUsageCacheFs {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  rename(from: string, to: string): void;
  exists(path: string): boolean;
}

/** The on-disk provider_usage cache shape (authored by the Claude statusline sidecar). */
export interface ProviderUsageCache {
  accountRef: string;
  accountKind: "subscription" | "api_key";
  asOf: string;
  /** Present only when the statusline carried a rate_limits object. */
  rateLimits?: ClaudeStatuslineReading;
  staleAfter?: string;
}

/**
 * Atomic write: serialize to a tmp sibling, then rename over the target. rename(2) is atomic on the
 * same filesystem, so a concurrent reader sees EITHER the old file OR the fully-written new one —
 * never a half-written (torn) read. The sidecar uses this so the daemon never parses a partial cache.
 */
export function writeProviderUsageCacheAtomic(
  fs: ProviderUsageCacheFs,
  path: string,
  cache: ProviderUsageCache,
): void {
  const tmp = `${path}.tmp-${cache.asOf.replace(/[^0-9]/g, "")}`;
  fs.writeFile(tmp, JSON.stringify(cache));
  fs.rename(tmp, path);
}

export interface ClaudeAccountRef {
  accountRef: string;
  accountKind: "subscription" | "api_key";
}

export interface ClaudeUsageReaderDeps {
  /** The Claude accounts to read provider_usage for. */
  listClaudeAccounts: () => ClaudeAccountRef[];
  /** Raw cache JSON for an account, or null if the cache file is absent (pre-first-response). Never throws. */
  readCacheRaw: (accountRef: string) => string | null;
  now: () => string;
}

/**
 * Read each Claude account's provider_usage cache → provider_statusline rows via
 * claudeStatuslineSignals. Explicit unknown rows for: api_key (no subscription windows), absent
 * cache (no_statusline_cache_yet), and cache-present-but-no/-malformed windows (empty_reading).
 * Never throws — a malformed cache is treated as present-with-no-windows, not a crash.
 */
export function collectClaudeStatuslineSignals(deps: ClaudeUsageReaderDeps): ProviderSignal[] {
  const now = deps.now();
  const out: ProviderSignal[] = [];
  for (const acct of deps.listClaudeAccounts()) {
    let cachePresent = false;
    let reading: ClaudeStatuslineReading | undefined;
    let staleAfter: string | undefined;
    let capturedAsOf: string | undefined;
    const raw = deps.readCacheRaw(acct.accountRef);
    if (raw !== null) {
      cachePresent = true;
      try {
        const parsed = JSON.parse(raw) as Partial<ProviderUsageCache>;
        reading = parsed.rateLimits;
        staleAfter = parsed.staleAfter;
        capturedAsOf = typeof parsed.asOf === "string" ? parsed.asOf : undefined;
      } catch {
        // Malformed cache → present-with-no-windows (empty_reading unknown), never a throw.
        reading = undefined;
      }
    }
    out.push(
      ...claudeStatuslineSignals({
        accountRef: acct.accountRef,
        accountKind: acct.accountKind,
        cachePresent,
        reading,
        // Signal asOf = when the reading was captured (the cache's asOf) when present+valid; else now.
        asOf: cachePresent && capturedAsOf ? capturedAsOf : now,
        staleAfter,
      }),
    );
  }
  return out;
}
