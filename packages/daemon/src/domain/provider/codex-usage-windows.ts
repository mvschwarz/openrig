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
 * The workspace `account/read` reports, when it reports one: `workspaceRouting.chatgptAccountId` at the top
 * level of the result (a sibling of `account`). Path and types from Codex 0.162.1's generated schema
 * (GetAccountResponse.json), relayed by Build's reviewer: `workspaceRouting` is optional and nullable, and
 * when present `chatgptAccountId` is a non-null string. Its siblings (backendOrigin, accountRoutingOverride)
 * are not identity. Codex 0.153.4's answer has no `workspaceRouting`, so it yields null there.
 */
export function accountReadWorkspaceId(account: unknown): string | null {
  if (!isRecord(account) || !isRecord(account.workspaceRouting)) return null;
  return stringOrNull(account.workspaceRouting.chatgptAccountId);
}

/**
 * Normalize the two app-server answers (shapes from Codex 0.153.4's protocol: `GetAccountResponse`,
 * `GetAccountRateLimitsResponse`). One reading per metered bucket (`rateLimitsByLimitId`, else the
 * single-bucket `rateLimits`). Identity is the usage answer's `accountId`, else the workspace
 * `account/read` reports, else unresolved; email and plan are labels and never part of identity.
 */
export function normalizeCodexUsage(account: unknown, rateLimits: unknown, observedAt: string):
  { ok: true; readings: Reading[] } | { ok: false; detail: string } {
  if (!isRecord(rateLimits)) return { ok: false, detail: "account/rateLimits/read returned an unrecognized shape" };
  const accountInfo = isRecord(account) && isRecord(account.account) ? account.account : null;
  const email = accountInfo ? stringOrNull(accountInfo.email) : null;
  const accountPlan = accountInfo ? stringOrNull(accountInfo.planType) : null;
  const accountId = stringOrNull(rateLimits.accountId);
  const workspaceId = accountId === null ? accountReadWorkspaceId(account) : null;
  const source: UsageAllowanceIdentity["source"] = accountId !== null
    ? "account/rateLimits/read accountId"
    : workspaceId !== null ? "account/read workspace routing" : "unresolved";
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
        workspaceId,
        limitId,
        email,
        planType: stringOrNull(snapshot.planType) ?? accountPlan,
        source,
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

/** The replacement key of a resolved identity. Email is never part of it; an unresolved identity has none. */
const identityKey = (i: UsageAllowanceIdentity): string | null =>
  i.accountId !== null ? `codex:account:${i.accountId}:${i.limitId}`
    : i.workspaceId !== null ? `codex:workspace:${i.workspaceId}:${i.limitId}`
      : null;

/** Unresolved observations can't be matched to earlier ones, so each read adds its own rows. Keep those
 *  from the most recent few reads: enough to compare the latest with the two before it, and bounded
 *  because nothing else ever removes them. */
export const UNRESOLVED_READS_KEPT = 3;

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
  /** Unresolved observations, grouped by read, newest last; at most UNRESOLVED_READS_KEPT reads. */
  private unresolved: Array<Array<Reading & { latest: boolean }>> = [];
  private unresolvedDropped = 0;
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
    for (const reading of [...this.readings.values(), ...this.unresolved.flat()]) reading.latest = false;
    const unresolvedNow: Array<Reading & { latest: boolean }> = [];
    for (const reading of normalized.readings) {
      const key = identityKey(reading.identity);
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

  private recordFailure(at: string, reason: CodexUsageFailureReason, detail: string): UsageRefreshOutcome {
    this.lastRefresh = { at, outcome: "failed", reason, detail };
    return this.lastRefresh;
  }

  /** The served rows. Reads memory only: it never starts a native read. */
  project(now: string): ProviderUsageAllowance[] {
    const source = { kind: "codex_app_server", host: "local" } as const;
    const failure = this.lastRefresh?.outcome === "failed" ? this.lastRefresh : null;
    if (this.readings.size === 0 && this.unresolved.length === 0) {
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
    const resolved = [...this.readings.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, reading]) => reading);
    const unresolvedRows = this.unresolved.flat();
    for (const reading of [...resolved, ...unresolvedRows]) {
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
        ...(reading.identity.source === "unresolved" ? {
          unresolved: {
            note: "identity unresolved: not matched to, merged with or replacing any other row",
            keptReads: UNRESOLVED_READS_KEPT,
            droppedReads: this.unresolvedDropped,
          },
        } : {}),
      });
    }
    return rows;
  }
}
