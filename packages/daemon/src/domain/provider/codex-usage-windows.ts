// Slice 01 (OPR.0.7.0.1) — Codex usage windows for the provider view. Holds the last reading of
// this daemon's Codex login in memory, refreshes it only on request (one bounded read; matching
// overlapping requests share it), and projects rows keyed by allowance identity with freshness
// kept separate from level. A failed refresh never replaces a reading: the reading stays, with its
// own time, marked old beside the failure. A daemon restart starts empty.

import { NEARING_THRESHOLD_PERCENT } from "./host-usage-rollup.js";
import type { CodexUsageFailureReason, CodexUsageReader } from "./codex-usage-reader.js";
import type {
  ProviderUsageAllowance,
  UsageAllowanceIdentity,
  UsageRefreshOutcome,
  UsageWindowRow,
} from "./provider-types.js";

/** A reading is too old to claim current capacity after this (Ops' openrig.subscription-usage.v1 rule). */
export const USAGE_FRESH_FOR_MS = 15 * 60_000;
/** An observation up to this far in the future is clock skew within tolerance (same rule). */
export const USAGE_CLOCK_TOLERANCE_MS = 60_000;

interface ReadWindow {
  window: "primary" | "secondary";
  durationMins: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

interface Reading {
  identity: UsageAllowanceIdentity;
  windows: ReadWindow[];
  limitEvidence: string | null;
  observedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function readWindow(window: "primary" | "secondary", raw: unknown): ReadWindow | null | "bad" {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || typeof raw.usedPercent !== "number" || !Number.isFinite(raw.usedPercent)) return "bad";
  const resetsAt = typeof raw.resetsAt === "number" && Number.isFinite(raw.resetsAt)
    ? new Date(raw.resetsAt * 1000).toISOString()
    : null;
  const durationMins = typeof raw.windowDurationMins === "number" && Number.isFinite(raw.windowDurationMins)
    ? raw.windowDurationMins
    : null;
  return { window, durationMins, usedPercent: raw.usedPercent, resetsAt };
}

/**
 * Normalize the two app-server answers (shapes from Codex 0.153.4's protocol: `GetAccountResponse`,
 * `GetAccountRateLimitsResponse`). One reading per metered bucket (`rateLimitsByLimitId`, else the
 * single-bucket `rateLimits`). Identity is (provider, accountId, limitId); email and plan are labels.
 */
export function normalizeCodexUsage(account: unknown, rateLimits: unknown, observedAt: string):
  { ok: true; readings: Reading[] } | { ok: false; detail: string } {
  if (!isRecord(rateLimits)) return { ok: false, detail: "account/rateLimits/read returned an unrecognized shape" };
  const accountInfo = isRecord(account) && isRecord(account.account) ? account.account : null;
  const email = accountInfo ? stringOrNull(accountInfo.email) : null;
  const accountPlan = accountInfo ? stringOrNull(accountInfo.planType) : null;
  const accountId = stringOrNull(rateLimits.accountId);
  const buckets: Array<[string, unknown]> = isRecord(rateLimits.rateLimitsByLimitId)
    ? Object.entries(rateLimits.rateLimitsByLimitId)
    : isRecord(rateLimits.rateLimits)
      ? [[stringOrNull(rateLimits.rateLimits.limitId) ?? "codex", rateLimits.rateLimits]]
      : [];
  if (buckets.length === 0) return { ok: false, detail: "account/rateLimits/read returned no rate-limit buckets" };
  const readings: Reading[] = [];
  for (const [limitId, snapshot] of buckets) {
    if (!isRecord(snapshot)) return { ok: false, detail: `bucket ${limitId} has an unrecognized shape` };
    const windows: ReadWindow[] = [];
    for (const key of ["primary", "secondary"] as const) {
      const w = readWindow(key, snapshot[key]);
      if (w === "bad") return { ok: false, detail: `bucket ${limitId} ${key} window has an unrecognized shape` };
      if (w) windows.push(w);
    }
    readings.push({
      identity: {
        accountId,
        limitId,
        email,
        planType: stringOrNull(snapshot.planType) ?? accountPlan,
        ...(accountId === null ? { partial: "no backend account id" } : {}),
      },
      windows,
      limitEvidence: stringOrNull(snapshot.rateLimitReachedType),
      observedAt,
    });
  }
  return { ok: true, readings };
}

/** Freshness is aged from the window's own observation, never from the time of the request. */
export function usageFreshness(observedAt: string, now: string, failedAfter: { at: string } | null):
  Pick<UsageWindowRow, "freshness" | "freshnessReason"> {
  const observedMs = Date.parse(observedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) {
    return { freshness: "unavailable", freshnessReason: "observation time unreadable" };
  }
  if (observedMs - nowMs > USAGE_CLOCK_TOLERANCE_MS) {
    return { freshness: "unavailable", freshnessReason: "observed in the future beyond the 60 s clock tolerance" };
  }
  if (failedAfter) return { freshness: "stale", freshnessReason: `refresh failed at ${failedAfter.at}; this reading is older` };
  if (nowMs - observedMs > USAGE_FRESH_FOR_MS) {
    return { freshness: "stale", freshnessReason: `observed ${Math.round((nowMs - observedMs) / 60_000)} min ago (fresh for 15 min)` };
  }
  return { freshness: "fresh" };
}

/** Level of one window as of its observation. Absent data is never nearing or exhausted. */
export function usageLevel(window: ReadWindow, limitEvidence: string | null, now: string):
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

const identityKey = (i: UsageAllowanceIdentity): string =>
  i.accountId !== null ? `codex:${i.accountId}:${i.limitId}` : `codex:local-login:${i.email ?? "?"}:${i.limitId}`;

export interface CodexUsageWindowsDeps {
  read: CodexUsageReader;
  now?: () => string;
}

export interface UsageRefreshResult {
  refresh: UsageRefreshOutcome & { coalesced: boolean };
}

export class CodexUsageWindows {
  private readonly now: () => string;
  private readonly startedAt: string;
  private readonly readings = new Map<string, Reading & { latest: boolean }>();
  private lastRefresh: UsageRefreshOutcome | null = null;
  private inflight: Promise<UsageRefreshOutcome> | null = null;

  constructor(private readonly deps: CodexUsageWindowsDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
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
    let outcome: Awaited<ReturnType<CodexUsageReader>>;
    try {
      outcome = await this.deps.read();
    } catch (error) {
      outcome = { ok: false, at: this.now(), reason: "spawn_failed", detail: `the reader failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!outcome.ok) return this.recordFailure(outcome.at, outcome.reason, outcome.detail);
    const normalized = normalizeCodexUsage(outcome.account, outcome.rateLimits, outcome.observedAt);
    if (!normalized.ok) return this.recordFailure(outcome.observedAt, "unrecognized_shape", normalized.detail);
    for (const reading of this.readings.values()) reading.latest = false;
    for (const reading of normalized.readings) this.readings.set(identityKey(reading.identity), { ...reading, latest: true });
    this.lastRefresh = { at: outcome.observedAt, outcome: "ok" };
    return this.lastRefresh;
  }

  private recordFailure(at: string, reason: CodexUsageFailureReason, detail: string): UsageRefreshOutcome {
    this.lastRefresh = { at, outcome: "failed", reason, detail };
    return this.lastRefresh;
  }

  /** The served rows. Reads memory only: it never starts a native read. */
  project(now: string): ProviderUsageAllowance[] {
    const source = { kind: "codex_app_server", host: "local" } as const;
    const failure = this.lastRefresh?.outcome === "failed" ? this.lastRefresh : null;
    if (this.readings.size === 0) {
      return [{
        provider: "codex",
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
    for (const reading of [...this.readings.values()].sort((a, b) => identityKey(a.identity).localeCompare(identityKey(b.identity)))) {
      const failedAfter = failure && Date.parse(failure.at) >= Date.parse(reading.observedAt) ? failure : null;
      const windows: UsageWindowRow[] = reading.windows.map((w) => ({
        window: w.window,
        durationMins: w.durationMins,
        usedPercent: w.usedPercent,
        remainingPercent: w.usedPercent === null ? null : Math.max(0, 100 - w.usedPercent),
        resetsAt: w.resetsAt,
        observedAt: reading.observedAt,
        ...usageLevel(w, reading.limitEvidence, now),
        ...usageFreshness(reading.observedAt, now, failedAfter),
      }));
      const known = reading.latest && failedAfter === null && windows.length > 0
        && windows.every((w) => w.freshness === "fresh" && w.level !== "unknown");
      rows.push({
        provider: "codex",
        identity: reading.identity,
        source,
        observedAt: reading.observedAt,
        seats: "unknown",
        windows,
        limitEvidence: reading.limitEvidence,
        latestFromSource: reading.latest,
        lastRefresh: this.lastRefresh,
        currentAvailability: known ? "known" : "unknown",
      });
    }
    return rows;
  }
}
