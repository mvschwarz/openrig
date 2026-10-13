// Slice 01 (OPR.0.7.0.1) — usage windows for the provider view, shared by every provider's native
// reader. Holds each provider's last reading in memory, refreshes it only on request (one bounded read;
// matching overlapping requests share it), and projects rows keyed by allowance identity with freshness
// kept separate from level. A failed refresh never replaces a reading: the reading stays, with its own
// time, marked old beside the failure. A row a later read superseded ages to stale. A daemon restart
// starts empty.

import { NEARING_THRESHOLD_PERCENT } from "./host-usage-rollup.js";
import type {
  ProviderKind,
  ProviderUsageAllowance,
  UsageRefreshOutcome,
  UsageWindowRow,
} from "./provider-types.js";

/** A reading is too old to claim current capacity after this (Ops' openrig.subscription-usage.v1 rule). */
export const USAGE_FRESH_FOR_MS = 15 * 60_000;
/** An observation up to this far in the future is clock skew within tolerance (same rule). */
export const USAGE_CLOCK_TOLERANCE_MS = 60_000;

/** Unresolved observations can't be matched to earlier ones, so each read adds its own rows. Keep those
 *  from the most recent few reads: enough to compare the latest with the two before it, and bounded
 *  because nothing else ever removes them. */
export const UNRESOLVED_READS_KEPT = 3;

export interface UsageReadWindow {
  /** The provider-native window name. */
  window: string;
  durationMins: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface UsageReading<I> {
  identity: I;
  windows: UsageReadWindow[];
  limitEvidence: string | null;
  observedAt: string;
}

/** A reader's outcome: the raw answers on success (normalizing is the provider spec's job), or a named failure. */
export type UsageReadOutcome<R> =
  | ({ ok: true; observedAt: string } & R)
  | { ok: false; at: string; reason: string; detail: string };

export interface UsageWindowsSpec<I extends { source: string }, R> {
  provider: ProviderKind;
  sourceKind: ProviderUsageAllowance["source"]["kind"];
  read: () => Promise<UsageReadOutcome<R>>;
  normalize: (answer: R & { observedAt: string }) => { ok: true; readings: Array<UsageReading<I>> } | { ok: false; detail: string };
  /** The replacement key of a resolved identity; null when unresolved (never matched or replaced). */
  key: (identity: I) => string | null;
  now?: () => string;
}

export interface UsageRefreshResult {
  refresh: UsageRefreshOutcome & { coalesced: boolean };
}

/** Freshness is aged from the window's own observation, never from the time of the request. A row a later
 *  read superseded is stale whatever its age. */
export function usageFreshness(observedAt: string, now: string, failedAfter: { at: string } | null, superseded = false):
  Pick<UsageWindowRow, "freshness" | "freshnessReason"> {
  const observedMs = Date.parse(observedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) {
    return { freshness: "unavailable", freshnessReason: "observation time unreadable" };
  }
  if (observedMs - nowMs > USAGE_CLOCK_TOLERANCE_MS) {
    return { freshness: "unavailable", freshnessReason: "observed in the future beyond the 60 s clock tolerance" };
  }
  if (superseded) return { freshness: "stale", freshnessReason: "a later read exists" };
  if (failedAfter) return { freshness: "stale", freshnessReason: `refresh failed at ${failedAfter.at}; this reading is older` };
  if (nowMs - observedMs > USAGE_FRESH_FOR_MS) {
    return { freshness: "stale", freshnessReason: `observed ${Math.round((nowMs - observedMs) / 60_000)} min ago (fresh for 15 min)` };
  }
  return { freshness: "fresh" };
}

/** Level of one window as of its observation. Absent data is never nearing or exhausted. */
export function usageLevel(window: UsageReadWindow, limitEvidence: string | null, now: string):
  Pick<UsageWindowRow, "level" | "levelReason"> {
  if (window.usedPercent === null) return { level: "unknown", levelReason: "no usage reported for this window" };
  const resetMs = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
  const nowMs = Date.parse(now);
  if (Number.isFinite(resetMs) && Number.isFinite(nowMs) && nowMs >= resetMs) {
    return { level: "unknown", levelReason: `reset passed at ${window.resetsAt}; a new reading is needed` };
  }
  if (window.usedPercent >= 100) return { level: "exhausted", levelReason: "at the limit" };
  if (limitEvidence !== null) return { level: "exhausted", levelReason: `provider limit evidence: ${limitEvidence}` };
  if (window.usedPercent >= NEARING_THRESHOLD_PERCENT) return { level: "nearing", levelReason: `${NEARING_THRESHOLD_PERCENT}% or more used` };
  return { level: "ok" };
}

export const UNRESOLVED_NOTE = "identity unresolved: not matched to, merged with or replacing any other row";
export const UNRESOLVED_EARLIER_NOTE = "identity unresolved: from an earlier read, possibly this same login; not matched to, merged with or replacing any other row";

type Held<I> = UsageReading<I> & { latest: boolean };

export class UsageWindows<I extends { source: string }, R> {
  private readonly now: () => string;
  private readonly startedAt: string;
  private readonly readings = new Map<string, Held<I>>();
  /** Unresolved observations, grouped by read, newest last; at most UNRESOLVED_READS_KEPT reads. */
  private unresolved: Array<Array<Held<I>>> = [];
  private unresolvedDropped = 0;
  private lastRefresh: UsageRefreshOutcome | null = null;
  private inflight: Promise<UsageRefreshOutcome> | null = null;

  constructor(private readonly spec: UsageWindowsSpec<I, R>) {
    this.now = spec.now ?? (() => new Date().toISOString());
    this.startedAt = this.now();
  }

  /** One bounded read. A refresh asked for while one runs joins it; one asked for after it ends reads again. */
  async refresh(): Promise<UsageRefreshResult> {
    if (this.inflight) return { refresh: { ...(await this.inflight), coalesced: true } };
    const run = this.runRead();
    this.inflight = run;
    try {
      return { refresh: { ...(await run), coalesced: false } };
    } finally {
      if (this.inflight === run) this.inflight = null;
    }
  }

  private async runRead(): Promise<UsageRefreshOutcome> {
    let outcome: UsageReadOutcome<R>;
    try {
      outcome = await this.spec.read();
    } catch (error) {
      outcome = { ok: false, at: this.now(), reason: "spawn_failed", detail: `the reader failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!outcome.ok) return this.recordFailure(outcome.at, outcome.reason, outcome.detail);
    const normalized = this.spec.normalize(outcome);
    if (!normalized.ok) return this.recordFailure(outcome.observedAt, "unrecognized_shape", normalized.detail);
    for (const reading of [...this.readings.values(), ...this.unresolved.flat()]) reading.latest = false;
    const unresolvedNow: Array<Held<I>> = [];
    for (const reading of normalized.readings) {
      const key = this.spec.key(reading.identity);
      if (key === null) unresolvedNow.push({ ...reading, latest: true });
      else this.readings.set(key, { ...reading, latest: true });
    }
    if (unresolvedNow.length > 0) {
      this.unresolved.push(unresolvedNow);
      while (this.unresolved.length > UNRESOLVED_READS_KEPT) {
        this.unresolved.shift();
        this.unresolvedDropped += 1;
      }
    }
    this.lastRefresh = { at: outcome.observedAt, outcome: "ok" };
    return this.lastRefresh;
  }

  private recordFailure(at: string, reason: string, detail: string): UsageRefreshOutcome {
    this.lastRefresh = { at, outcome: "failed", reason, detail };
    return this.lastRefresh;
  }

  /** The served rows. Reads memory only: it never starts a native read. */
  project(now: string): ProviderUsageAllowance[] {
    const provider = this.spec.provider;
    const source = { kind: this.spec.sourceKind, host: "local" } as const;
    const failure = this.lastRefresh?.outcome === "failed" ? this.lastRefresh : null;
    if (this.readings.size === 0 && this.unresolved.length === 0) {
      return [{
        provider,
        identity: null,
        source,
        observedAt: null,
        seats: "unknown",
        windows: [],
        limitEvidence: null,
        latestFromSource: false,
        lastRefresh: this.lastRefresh,
        currentAvailability: "unknown",
        unavailableReason: failure
          ? `refresh failed at ${failure.at}: ${failure.reason}; no earlier reading since the daemon started at ${this.startedAt}`
          : `no reading since the daemon started at ${this.startedAt}; refresh with rig provider status --refresh`,
      }];
    }
    const rows: ProviderUsageAllowance[] = [];
    const resolved = [...this.readings.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, reading]) => reading);
    for (const reading of [...resolved, ...this.unresolved.flat()]) {
      const failedAfter = failure && Date.parse(failure.at) >= Date.parse(reading.observedAt) ? failure : null;
      const windows: UsageWindowRow[] = reading.windows.map((w) => ({
        window: w.window,
        durationMins: w.durationMins,
        usedPercent: w.usedPercent,
        remainingPercent: w.usedPercent === null ? null : Math.max(0, 100 - w.usedPercent),
        resetsAt: w.resetsAt,
        observedAt: reading.observedAt,
        ...usageLevel(w, reading.limitEvidence, now),
        ...usageFreshness(reading.observedAt, now, failedAfter, !reading.latest),
      }));
      const known = reading.latest && failedAfter === null && windows.length > 0
        && windows.every((w) => w.freshness === "fresh" && w.level !== "unknown");
      rows.push({
        provider,
        identity: reading.identity as unknown as ProviderUsageAllowance["identity"],
        source,
        observedAt: reading.observedAt,
        seats: "unknown",
        windows,
        limitEvidence: reading.limitEvidence,
        latestFromSource: reading.latest,
        lastRefresh: this.lastRefresh,
        currentAvailability: known ? "known" : "unknown",
        ...(reading.identity.source === "unresolved" ? {
          unresolved: {
            note: reading.latest ? UNRESOLVED_NOTE : UNRESOLVED_EARLIER_NOTE,
            keptReads: UNRESOLVED_READS_KEPT,
            droppedReads: this.unresolvedDropped,
          },
        } : {}),
      });
    }
    return rows;
  }
}
