// Slice-04 (OPR.0.5.0.4) seam C3 — the Claude statusline provider_usage cache LANE.
// A statusline sidecar writes a per-seat provider_usage cache with an atomic tmp+rename (so a
// concurrent daemon read never sees a torn file); the daemon reads it here and normalizes it into
// provider_statusline signal rows via the existing claudeStatuslineSignals. Absent cache
// (pre-first-response) and empty/malformed readings each become an EXPLICIT
// unknown row with an unknownReason — never a missing row and never a fabricated zero. Never throws.
//
// SCOPE: this atom is the cache producer/reader + collectSignals wiring ONLY. It does not touch the
// C4 reactive tap, C2 Codex app-server, activity-accurate precheck, D switch execution, or BR-1.

import fs from "node:fs";
import nodePath from "node:path";
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
  seatSession: string;
  /** Present only when the statusline carried valid Pro/Max rate_limits. */
  accountKind?: "subscription";
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

export interface ClaudeSeatRef {
  seatSession: string;
}

export interface ClaudeUsageReaderDeps {
  /** The live Claude seats to read provider_usage for. */
  listClaudeSeats: () => ClaudeSeatRef[];
  /** Raw cache JSON for a seat, or null if the cache file is absent (pre-first-response). Never throws. */
  readCacheRaw: (seatSession: string) => string | null;
  now: () => string;
}

/**
 * Read each Claude seat's provider_usage cache → provider_statusline rows via
 * claudeStatuslineSignals. Explicit unknown rows for absent cache (no_statusline_cache_yet) and
 * cache-present-but-no/-malformed windows (empty_reading).
 * Never throws — a malformed cache is treated as present-with-no-windows, not a crash.
 */
export function collectClaudeStatuslineSignals(deps: ClaudeUsageReaderDeps): ProviderSignal[] {
  const now = deps.now();
  const out: ProviderSignal[] = [];
  for (const seat of deps.listClaudeSeats()) {
    let cachePresent = false;
    let reading: ClaudeStatuslineReading | undefined;
    let staleAfter: string | undefined;
    let capturedAsOf: string | undefined;
    const raw = deps.readCacheRaw(seat.seatSession);
    if (raw !== null) {
      cachePresent = true;
      try {
        const parsed = JSON.parse(raw) as Partial<ProviderUsageCache>;
        if (parsed.seatSession === seat.seatSession && parsed.accountKind === "subscription") {
          reading = validRateLimits(parsed.rateLimits);
        }
        staleAfter = parsed.staleAfter;
        capturedAsOf = typeof parsed.asOf === "string" ? parsed.asOf : undefined;
      } catch {
        // Malformed cache → present-with-no-windows (empty_reading unknown), never a throw.
        reading = undefined;
      }
    }
    out.push(
      ...claudeStatuslineSignals({
        seatSession: seat.seatSession,
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

/** Read the seat-keyed cache directory using the same path consumed by daemon startup. */
export function collectClaudeSignalsFromProviderUsageDirectory(
  directory: string,
  now: () => string = () => new Date().toISOString(),
): ProviderSignal[] {
  const seats = new Map<string, ClaudeSeatRef>();
  try {
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(nodePath.join(directory, file), "utf-8")) as { seatSession?: unknown };
        if (typeof parsed.seatSession === "string") {
          seats.set(parsed.seatSession, { seatSession: parsed.seatSession });
        }
      } catch { /* malformed cache cannot create a usable cache signal */ }
    }
  } catch { /* absent cache directory */ }

  return collectClaudeStatuslineSignals({
    listClaudeSeats: () => [...seats.values()],
    readCacheRaw: (seatSession) => {
      const safe = seatSession.replace(/[^a-zA-Z0-9@._-]/g, "_");
      try { return fs.readFileSync(nodePath.join(directory, `${safe}.json`), "utf-8"); } catch { return null; }
    },
    now,
  });
}

function validRateLimits(value: unknown): ClaudeStatuslineReading | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const reading: ClaudeStatuslineReading = {};
  for (const key of ["five_hour", "seven_day"] as const) {
    const raw = source[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const window = raw as Record<string, unknown>;
    if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
      && typeof window.resetsAt === "string") {
      reading[key] = { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
    }
  }
  return reading.five_hour || reading.seven_day ? reading : undefined;
}
