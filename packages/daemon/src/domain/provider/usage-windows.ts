// Slice 01 (OPR.0.7.0.1) — usage windows for the provider view, shared by every provider's native
// reader. Holds each provider's last reading in memory, refreshes it only on request (one bounded read;
// matching overlapping requests share it), and projects rows keyed by allowance identity with freshness
// kept separate from level. A failed refresh never replaces a reading: the reading stays, with its own
// time, marked old beside the failure. A row a later read superseded ages to stale. With a store, each resolved
// reading is kept on disk, so a daemon restart starts from the last readings, marked as from before the restart.

import { NEARING_THRESHOLD_PERCENT } from "./host-usage-rollup.js";
import type {
  ProviderKind,
  ProviderUsageAllowance,
  SignInFact,
  UsageRefreshOutcome,
  UsageWindowRow,
} from "./provider-types.js";

/** A reading is too old to claim current capacity after this (Ops' openrig.subscription-usage.v1 rule). */
export const USAGE_FRESH_FOR_MS = 15 * 60_000;
/** An observation up to this far in the future is clock skew within tolerance (same rule). */
export const USAGE_CLOCK_TOLERANCE_MS = 60_000;

/** Whether two readings' reset times name the same window: equal, or within the clock tolerance. */
export function sameReset(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const am = Date.parse(a), bm = Date.parse(b);
  return Number.isFinite(am) && Number.isFinite(bm) ? Math.abs(am - bm) <= USAGE_CLOCK_TOLERANCE_MS : a === b;
}

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
  /** Durable readings, keyed by `key`. Absent: memory only (a restart starts empty). */
  store?: UsageReadingStore<I>;
}

/** The durable half: what a restart reloads, and each allowance's last observed exhaustion. */
export interface UsageReadingStore<I> {
  record(key: string, reading: UsageReading<I>): void;
  latestAll(): Array<{ key: string; reading: UsageReading<I> }>;
  lastExhaustion(key: string): { at: string; window: string | null; evidence: string } | null;
}

/** The planning fact for a window whose reset has passed. */
export const EXPECTED_FULL_NOTE =
  "planning, not a reading: expected to have been replenished at its reset; current remaining isn't observed, and use since the reset is unknown";

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

/** Whether a window's known reset has passed. No reset, no expectation: one is never invented. */
function resetPassed(resetsAt: string | null, now: string): boolean {
  if (resetsAt === null) return false;
  const reset = Date.parse(resetsAt), at = Date.parse(now);
  return Number.isFinite(reset) && Number.isFinite(at) && at >= reset;
}

function safeLastExhaustion<I>(store: UsageReadingStore<I>, key: string): { at: string; window: string | null; evidence: string } | null {
  try { return store.lastExhaustion(key); } catch { return null; }
}

export const UNRESOLVED_NOTE = "identity unresolved: not matched to, merged with or replacing any other row";
export const UNRESOLVED_EARLIER_NOTE = "identity unresolved: from an earlier read, possibly this same login; not matched to, merged with or replacing any other row";

type Held<I> = UsageReading<I> & { latest: boolean; retained?: true };

export class UsageWindows<I extends { source: string }, R> {
  private readonly now: () => string;
  private readonly startedAt: string;
  private readonly readings = new Map<string, Held<I>>();
  /** Each stored allowance's last observed exhaustion, set at load and on each record, so a projection reads no store. */
  private readonly exhaustion = new Map<string, { at: string; window: string | null; evidence: string } | null>();
  /** Unresolved observations, grouped by read, newest last; at most UNRESOLVED_READS_KEPT reads. */
  private unresolved: Array<Array<Held<I>>> = [];
  private unresolvedDropped = 0;
  private lastRefresh: UsageRefreshOutcome | null = null;
  private inflight: Promise<UsageRefreshOutcome> | null = null;

  constructor(private readonly spec: UsageWindowsSpec<I, R>) {
    this.now = spec.now ?? (() => new Date().toISOString());
    this.startedAt = this.now();
    // The last stored reading of each allowance, as history: never current until a fresh read.
    try {
      for (const { key, reading } of spec.store?.latestAll() ?? []) {
        this.readings.set(key, { ...reading, latest: false, retained: true });
        this.exhaustion.set(key, safeLastExhaustion(spec.store!, key));
      }
    } catch { /* an unreadable store starts empty, as before */ }
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
      else {
        this.readings.set(key, { ...reading, latest: true });
        // A storage failure never fails the read: the reading is still served from memory.
        if (this.spec.store) {
          try { this.spec.store.record(key, reading); } catch { /* kept in memory */ }
          this.exhaustion.set(key, safeLastExhaustion(this.spec.store, key));
        }
      }
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

  /** The sign-in fact for a row, from the last refresh only (never from its windows). Only the latest read's row is the
   *  login the refresh read. */
  private signIn(latest: boolean, unresolved = false, observedAt: string | null = null, retained = false): SignInFact {
    const last = this.lastRefresh;
    // A row kept from before the restart: there may have been no refresh since, so it was superseded by nothing.
    if (retained) {
      return { state: "unknown", at: null,
        evidence: `kept from before the daemon restarted at ${this.startedAt}; this login's sign-in hasn't been read since` };
    }
    if (!latest) {
      // An unresolved earlier read can't be matched, so it may be this same login: never call it another one.
      return { state: "unknown", at: null, evidence: unresolved
        ? "an earlier read not matched to the latest one (possibly this same login)"
        : "not the latest read: a later refresh didn't report this row (another login, one it couldn't identify, or this bucket no longer reported)" };
    }
    if (!last) return { state: "unknown", evidence: `no refresh since the daemon started at ${this.startedAt}`, at: null };
    if (last.outcome === "ok") {
      return { state: "usable", evidence: "the refresh's rate-limit read was answered for this login (the daemon's CODEX_HOME)", at: last.at };
    }
    // A failure after this row's reading identified no account, so it says nothing about this row's login. The
    // home it did read is reported on its own row (homeRow).
    if (observedAt !== null) {
      return { state: "unknown", at: last.at,
        evidence: `the last refresh at ${last.at} failed (${last.reason ?? "unknown reason"}) and didn't identify an account; this row's login was last read at ${observedAt}` };
    }
    if (last.reason === "not_signed_in") {
      return { state: "needs_sign_in", evidence: "the refresh's account/read reported no signed-in account", at: last.at };
    }
    return { state: "unknown", evidence: `the last refresh failed (${last.reason ?? "unknown reason"})`, at: last.at };
  }

  /** The daemon's current home when the last refresh found no signed-in account but earlier rows are kept: its own row,
   *  in the shape the projection already serves with no reading, so the fact isn't pinned on an earlier account. */
  private homeRow(provider: ProviderKind, source: ProviderUsageAllowance["source"]): ProviderUsageAllowance | null {
    const last = this.lastRefresh;
    if (last?.outcome !== "failed" || last.reason !== "not_signed_in") return null;
    return {
      provider, identity: null, source, observedAt: null, seats: "unknown", windows: [], limitEvidence: null,
      latestFromSource: true, lastRefresh: last, currentAvailability: "unknown",
      signIn: this.signIn(true),
      unavailableReason: `the refresh at ${last.at} found no signed-in account in the daemon's CODEX_HOME; the rows above keep their earlier reads`,
    };
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
        signIn: this.signIn(true),
        unavailableReason: failure
          ? `refresh failed at ${failure.at}: ${failure.reason}; no earlier reading since the daemon started at ${this.startedAt}`
          : `no reading since the daemon started at ${this.startedAt}; refresh with rig provider status --refresh`,
      }];
    }
    const rows: ProviderUsageAllowance[] = [];
    const resolved = [...this.readings.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, reading]) => reading);
    for (const reading of [...resolved, ...this.unresolved.flat()]) {
      const failedAfter = failure && Date.parse(failure.at) >= Date.parse(reading.observedAt) ? failure : null;
      const key = this.spec.key(reading.identity);
      // Every keyed reading is its allowance's latest known one; an unresolved earlier read may be a duplicate.
      const expects = key !== null || reading.latest;
      const windows: UsageWindowRow[] = reading.windows.map((w) => ({
        window: w.window,
        durationMins: w.durationMins,
        usedPercent: w.usedPercent,
        remainingPercent: w.usedPercent === null ? null : Math.max(0, 100 - w.usedPercent),
        resetsAt: w.resetsAt,
        observedAt: reading.observedAt,
        ...usageLevel(w, reading.limitEvidence, now),
        ...(reading.retained
          ? { freshness: "stale" as const, freshnessReason: `read at ${reading.observedAt}, before the daemon restarted at ${this.startedAt}; refresh with rig provider status --refresh` }
          : usageFreshness(reading.observedAt, now, failedAfter, !reading.latest)),
        ...(expects && resetPassed(w.resetsAt, now) ? { expectation: { expectedFullSince: w.resetsAt!, note: EXPECTED_FULL_NOTE } } : {}),
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
        ...(reading.retained ? { retained: "before_restart" as const } : {}),
        accountHistory: key !== null ? "linked" as const : "unknown" as const,
        ...(this.spec.store && key !== null ? { lastObservedExhausted: this.exhaustion.get(key) ?? null } : {}),
        ...(!reading.latest && key !== null ? { savedProfile: "not linked" as const } : {}),
        signIn: this.signIn(reading.latest, reading.identity.source === "unresolved", reading.observedAt, reading.retained === true),
        ...(reading.identity.source === "unresolved" ? {
          unresolved: {
            note: reading.latest ? UNRESOLVED_NOTE : UNRESOLVED_EARLIER_NOTE,
            keptReads: UNRESOLVED_READS_KEPT,
            droppedReads: this.unresolvedDropped,
          },
        } : {}),
      });
    }
    // Last, so the existing rows keep their order.
    const home = this.homeRow(provider, source);
    if (home) rows.push(home);
    return rows;
  }
}
