// Slice 01 (OPR.0.7.0.1) — Claude usage windows for the provider view, built on what exists: the seats'
// status-line rate_limits samples (usage_samples, lane provider_window, migration 062: the context monitor
// appends each seat's reading when it advances) joined with the identity `claude auth status` reports on an
// explicit refresh (claude-auth-status-reader.ts).
//
// - Windows: for the 5-hour and weekly windows, the freshest sample across seats, observed at the sample's own
//   time (the status line's asOf), naming its seat. An idle seat stops advancing, so its windows age to stale.
//   Another seat's still-fresh sample with a different reset makes the window's level unknown: the seats may be on
//   different logins, and nothing is merged.
// - Identity: the daemon's Claude login as of the last refresh, held in memory only. The status line carries no
//   account identity, so nothing is written to the samples or any table (062's Option-A bar); every row says the
//   join is not proven to be the same login. Key: (orgId, email) plus the bucket; either missing is unresolved.
// - A refresh that reports another login freezes the earlier row as it was at its own last refresh; that row reads
//   stale (a later read exists). Nothing is merged or relabelled. A daemon restart starts with no identity.
// - Account availability stays unknown. A sample records a seat and a time, and the identity is the daemon's login as of
//   a refresh: nothing links a seat's sample to the login that seat used when it sampled, so a seat on another login, or
//   a seat still on the previous login, can't be told apart (two hermetic source cases: the same reset on another login, and a seat still on an earlier login). The windows stay visible
//   as each seat's own readings; until a sample-time seat-to-account binding exists, the row never reads "known".

import type Database from "better-sqlite3";
import type { ClaudeAuthAnswer, ClaudeAuthReader } from "./claude-auth-status-reader.js";
import type { ClaudeUsageIdentity, ProviderUsageAllowance, UsageRefreshOutcome, UsageWindowRow } from "./provider-types.js";
import {
  UNRESOLVED_EARLIER_NOTE,
  UNRESOLVED_NOTE,
  UNRESOLVED_READS_KEPT,
  sameReset,
  usageFreshness,
  usageLevel,
  type UsageReadOutcome,
  type UsageRefreshResult,
} from "./usage-windows.js";

/** The status line's only bucket: its session and weekly windows cover all models. */
export const CLAUDE_STATUSLINE_BUCKET = "all models";
const WINDOWS = [
  { window: "five_hour", durationMins: 300 },
  { window: "weekly", durationMins: 10080 },
] as const;

export interface ClaudeWindowSample {
  seatSession: string;
  window: "five_hour" | "weekly";
  usedPercent: number;
  resetsAt: string | null;
  /** The status line's own time for this reading. */
  sampledAt: string;
}

/** Each seat's latest provider-window sample per window (lane provider_window). This runs on every read-model
 *  call while the switch is on, so it never walks the series: it steps from one seat to the next on 094's partial
 *  index (seat_session, window, id), then takes each window's latest id with one index seek (about 0.1 ms with
 *  200k samples across 20 seats, where a per-row MAX subquery took about 150 ms). */
export function latestClaudeWindowSamples(db: Database.Database): ClaudeWindowSample[] {
  const rows = db.prepare(
    `WITH RECURSIVE seats(s) AS (
       SELECT MIN(seat_session) FROM usage_samples WHERE lane = 'provider_window'
       UNION ALL
       SELECT (SELECT MIN(seat_session) FROM usage_samples WHERE lane = 'provider_window' AND seat_session > s)
       FROM seats WHERE s IS NOT NULL
     ),
     latest(id) AS (
       SELECT (SELECT MAX(id) FROM usage_samples WHERE lane = 'provider_window' AND seat_session = seats.s AND window = w.window)
       FROM seats, (SELECT 'five_hour' AS window UNION ALL SELECT 'weekly') w
       WHERE seats.s IS NOT NULL
     )
     SELECT seat_session, window, window_used_percent, resets_at, sampled_at
     FROM usage_samples
     WHERE id IN (SELECT id FROM latest WHERE id IS NOT NULL)`,
  ).all() as Array<{ seat_session: string; window: string; window_used_percent: number | null; resets_at: string | null; sampled_at: string | null }>;
  const out: ClaudeWindowSample[] = [];
  for (const r of rows) {
    if ((r.window !== "five_hour" && r.window !== "weekly") || r.window_used_percent === null || r.sampled_at === null) continue;
    out.push({ seatSession: r.seat_session, window: r.window, usedPercent: r.window_used_percent, resetsAt: r.resets_at, sampledAt: r.sampled_at });
  }
  return out;
}

/** Another seat's fresh reading of the same window that disagrees with the one shown (its own numbers). */
export interface DisagreeingSeat {
  seatSession: string;
  usedPercent: number;
  resetsAt: string | null;
  observedAt: string;
}

/** One window as shown: the freshest sample, plus the other seats whose fresh samples disagree with it. */
interface Pick {
  window: string;
  durationMins: number;
  usedPercent: number;
  resetsAt: string | null;
  observedAt: string;
  seatSession: string;
  disagreeing: DisagreeingSeat[];
}

export function pickClaudeWindows(samples: ClaudeWindowSample[], now: string): Pick[] {
  const picks: Pick[] = [];
  for (const { window, durationMins } of WINDOWS) {
    const forWindow = samples.filter((s) => s.window === window)
      .sort((a, b) => Date.parse(b.sampledAt) - Date.parse(a.sampledAt) || a.seatSession.localeCompare(b.seatSession));
    const freshest = forWindow[0];
    if (!freshest) continue;
    const disagreeing = forWindow.slice(1)
      .filter((s) => usageFreshness(s.sampledAt, now, null).freshness === "fresh" && !sameReset(s.resetsAt, freshest.resetsAt))
      .map((s) => ({ seatSession: s.seatSession, usedPercent: s.usedPercent, resetsAt: s.resetsAt, observedAt: s.sampledAt }));
    picks.push({ window, durationMins, usedPercent: freshest.usedPercent, resetsAt: freshest.resetsAt, observedAt: freshest.sampledAt, seatSession: freshest.seatSession, disagreeing });
  }
  return picks;
}

function windowRow(p: Pick, now: string, superseded: boolean): UsageWindowRow {
  const level = p.disagreeing.length > 0
    ? { level: "unknown" as const, levelReason: `Claude seats report different windows (possibly different logins): ${[p.seatSession, ...p.disagreeing.map((d) => d.seatSession)].join(", ")}` }
    : usageLevel({ window: p.window, durationMins: p.durationMins, usedPercent: p.usedPercent, resetsAt: p.resetsAt }, null, now);
  return {
    window: p.window,
    durationMins: p.durationMins,
    usedPercent: p.usedPercent,
    remainingPercent: Math.max(0, 100 - p.usedPercent),
    resetsAt: p.resetsAt,
    observedAt: p.observedAt,
    seatSession: p.seatSession,
    ...(p.disagreeing.length > 0 ? { disagreeingSeats: p.disagreeing } : {}),
    ...level,
    ...usageFreshness(p.observedAt, now, null, superseded),
  };
}

/** Why a joined Claude row's account availability is unknown, whatever its windows show. */
export const CLAUDE_NO_SAMPLE_BINDING =
  "no sample-time link between these seats' readings and this login: a seat on another login, or still on an earlier one, reads the same, so this account's availability isn't known from them";

export const claudeUsageIdentityKey = (i: ClaudeUsageIdentity): string | null =>
  (i.orgId !== null && i.email !== null ? `claude:org:${i.orgId}:email:${i.email}:${i.limitId}` : null);

export function claudeIdentityFromAuth(auth: ClaudeAuthAnswer["auth"]): ClaudeUsageIdentity {
  return {
    orgId: auth.orgId,
    limitId: CLAUDE_STATUSLINE_BUCKET,
    email: auth.email,
    orgName: auth.orgName,
    subscriptionType: auth.subscriptionType,
    source: auth.orgId !== null && auth.email !== null ? "claude auth status orgId and email" : "unresolved",
  };
}

const NOT_READ_IDENTITY: ClaudeUsageIdentity = {
  orgId: null, limitId: CLAUDE_STATUSLINE_BUCKET, email: null, orgName: null, subscriptionType: null, source: "unresolved",
};
const NO_SEAT = "no Claude seat has reported status-line rate limits yet";

/** The identity as of one refresh, with the windows as they were then (kept if a later refresh supersedes it). */
interface Snapshot {
  identity: ClaudeUsageIdentity;
  key: string | null;
  at: string;
  picks: Pick[];
}

export class ClaudeUsageWindows {
  private readonly now: () => string;
  private current: Snapshot | null = null;
  private readonly frozen = new Map<string, Snapshot & { supersededAt: string }>();
  private frozenUnresolved: Array<Snapshot & { supersededAt: string }> = [];
  private unresolvedDropped = 0;
  private lastRefresh: UsageRefreshOutcome | null = null;
  private inflight: Promise<UsageRefreshOutcome> | null = null;
  private lastSamples: ClaudeWindowSample[] | null = null;

  constructor(private readonly deps: { readIdentity: ClaudeAuthReader; listSamples: () => ClaudeWindowSample[]; now?: () => string }) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** One bounded identity read. A refresh asked for while one runs joins it. Windows always come from samples. */
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
    let outcome: UsageReadOutcome<ClaudeAuthAnswer>;
    try {
      outcome = await this.deps.readIdentity();
    } catch (error) {
      outcome = { ok: false, at: this.now(), reason: "auth_status_failed", detail: `the reader failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!outcome.ok) {
      this.lastRefresh = { at: outcome.at, outcome: "failed", reason: outcome.reason, detail: outcome.detail };
      return this.lastRefresh;
    }
    const identity = claudeIdentityFromAuth(outcome.auth);
    const key = claudeUsageIdentityKey(identity);
    let picks: Pick[] = [];
    try {
      picks = pickClaudeWindows(this.deps.listSamples(), outcome.observedAt);
    } catch { /* unreadable samples: the identity still lands; the view says the samples couldn't be read */ }
    const prev = this.current;
    // The same resolved login: the row continues. Anything else (another login, or an unresolved one, which can
    // never be matched) freezes the earlier row as it was at its own last refresh.
    if (prev && !(prev.key !== null && prev.key === key)) {
      const done = { ...prev, supersededAt: outcome.observedAt };
      if (prev.key !== null) this.frozen.set(prev.key, done);
      else {
        this.frozenUnresolved.push(done);
        while (this.frozenUnresolved.length > UNRESOLVED_READS_KEPT - 1) {
          this.frozenUnresolved.shift();
          this.unresolvedDropped += 1;
        }
      }
    }
    if (key !== null) this.frozen.delete(key);
    this.current = { identity, key, at: outcome.observedAt, picks };
    this.lastRefresh = { at: outcome.observedAt, outcome: "ok" };
    return this.lastRefresh;
  }

  /** Each seat's own latest samples as the last project() read them, from memory (no query of its own); null
   *  before any project() or when the samples couldn't be read. Unlike the served windows, which keep one sample
   *  per window, every seat that reported is here. */
  seatSamples(): ClaudeWindowSample[] | null {
    return this.lastSamples;
  }

  /** The served rows: samples and the identity in memory. It never starts a native read. */
  project(now: string): ProviderUsageAllowance[] {
    const source = { kind: "claude_statusline_samples", host: "local" } as const;
    let samples: ClaudeWindowSample[];
    let unreadable: string | null = null;
    try {
      samples = this.deps.listSamples();
    } catch (error) {
      samples = [];
      unreadable = `the status-line samples could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.lastSamples = unreadable ? null : samples;
    const live = pickClaudeWindows(samples, now);
    const rows: ProviderUsageAllowance[] = [];
    const seatsOf = (picks: Pick[]) => [...new Set(picks.map((p) => p.seatSession))].join(", ");
    const current = this.current;
    const identity = current?.identity ?? NOT_READ_IDENTITY;

    if (live.length === 0) {
      rows.push({
        provider: "claude",
        identity: current ? identity : null,
        source,
        observedAt: null,
        seats: "unknown",
        windows: [],
        limitEvidence: null,
        latestFromSource: true,
        lastRefresh: this.lastRefresh,
        currentAvailability: "unknown",
        unavailableReason: unreadable ?? NO_SEAT,
      });
    } else {
      const windows = live.map((p) => windowRow(p, now, false));
      const resolved = identity.source !== "unresolved";
      rows.push({
        provider: "claude",
        identity,
        source,
        observedAt: live.map((p) => p.observedAt).sort().at(-1)!,
        seats: "unknown",
        windows,
        limitEvidence: null,
        latestFromSource: true,
        lastRefresh: this.lastRefresh,
        // Never "known" from this join: see CLAUDE_NO_SAMPLE_BINDING. The windows below are each seat's own readings.
        currentAvailability: "unknown",
        unavailableReason: CLAUDE_NO_SAMPLE_BINDING,
        identityNote: current
          ? `identity: the daemon's Claude login (claude auth status) as of the refresh at ${current.at}; windows: status-line readings from ${seatsOf(live)} at their own times; not proven to be the same login`
          : `identity not read yet (rig provider status --refresh); windows: status-line readings from ${seatsOf(live)} at their own times`,
        ...(!resolved ? {
          unresolved: {
            note: current ? UNRESOLVED_NOTE : "identity not read yet: not matched to, merged with or replacing any other row",
            keptReads: UNRESOLVED_READS_KEPT,
            droppedReads: this.unresolvedDropped,
          },
        } : {}),
      });
    }

    const earlier = [...[...this.frozen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => s), ...this.frozenUnresolved];
    for (const s of earlier) {
      const windows = s.picks.map((p) => windowRow(p, now, true));
      rows.push({
        provider: "claude",
        identity: s.identity,
        source,
        observedAt: s.picks.map((p) => p.observedAt).sort().at(-1) ?? null,
        seats: "unknown",
        windows,
        limitEvidence: null,
        latestFromSource: false,
        lastRefresh: this.lastRefresh,
        currentAvailability: "unknown",
        identityNote: `identity: the daemon's Claude login as of the refresh at ${s.at}; a refresh at ${s.supersededAt} reported another login; windows as they were at ${s.at}${s.picks.length > 0 ? ` (from ${seatsOf(s.picks)})` : " (none reported then)"}`,
        ...(s.identity.source === "unresolved" ? {
          unresolved: { note: UNRESOLVED_EARLIER_NOTE, keptReads: UNRESOLVED_READS_KEPT, droppedReads: this.unresolvedDropped },
        } : {}),
      });
    }
    return rows;
  }
}
