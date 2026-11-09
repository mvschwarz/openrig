// Replies in one tracked thread, oldest first (conversations.replies). Seen records only dedupe;
// coverage is an interval actually scanned, starting at the thread root.
import { callWebApi, type FetchImpl } from "./slack-api.js";
import { ingestDecision, type InboundRouter, type SlackEvent } from "./inbound.js";
import { slackMicros, slackTimestamp, type ThreadCoverage, type ThreadCoverageStore } from "./state-store.js";
import { budgetLeft, REPLIES, type MethodBackoff, type RecoveryBudget, type RecoverySource } from "./recovery-budget.js";
/** Slack's page cap for apps distributed outside the Marketplace. */
const PAGE = 15;
/** How long a thread Slack couldn't find, or a settled thread already scanned since live events began, waits before it's
 *  asked again. */
export const QUIET_RESCAN_MS = 24 * 60 * 60 * 1000;
/** The same for a thread whose ask still waits on the person: a shorter backstop, should Slack drop a live event without
 *  the connection showing a gap. */
export const WAITING_RESCAN_MS = 60 * 60 * 1000;
/** A settled thread's backstop on a machine the hub relays to: it has no connection of its own, so it can't see a gap in
 *  relayed events, and checks about as often as a full rotation of tracked threads used to. */
export const RELAYED_QUIET_RESCAN_MS = 3 * 60 * 60 * 1000;

export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

interface ThreadRecoveryOptions {
  channel: string;
  threadTs: string;
  token: string;
  store: ThreadCoverageStore;
  /** The thread's saved checkpoint; absent, coverage starts at the root. */
  stored?: ThreadCoverage;
  router: InboundRouter;
  fetchImpl?: FetchImpl;
  now: () => number;
  stopped: () => boolean;
}

export class ThreadRecovery implements RecoverySource {
  state = "pending";
  reason: string | undefined;
  lastScanAt: string | undefined;
  accepted = 0;
  deadLettered = 0;
  /** When a call for the thread's replies last got nowhere (ms): an error, a page that couldn't be trusted, or a landing
   *  that couldn't finish. Orders retries fairly. A call that made progress, or stopped short at the settle margin or the
   *  pass budget, never sets it, so that thread keeps its first-attempt priority. In memory only. */
  lastStalledAt: number | undefined;
  private coverage: ThreadCoverage;

  constructor(private readonly opts: ThreadRecoveryOptions) {
    this.coverage = opts.stored ?? { coverageStart: opts.threadTs, coveredThrough: opts.threadTs };
  }

  get key(): string { return `thread:${threadKey(this.opts.channel, this.opts.threadTs)}`; }
  get coveredThrough(): string { return this.coverage.coveredThrough; }
  get threadTs(): string { return this.opts.threadTs; }

  /** Whether this thread has anything for a pass to do. Partway through an interval: always. Slack couldn't find it: once
   *  a day (not proof of deletion, and never set by a transient error). Scanned through `listeningSince` (ms, when live
   *  events last began arriving without a gap): nothing, since replies after that arrive live, until a backstop rescan
   *  an hour on for an ask still waiting on the person, a day on for any other thread. Coverage must reach
   *  `listeningSince` itself: a scan in the first seconds after connecting stops at the settle margin, short of it. */
  due(now: number, waiting: boolean, listeningSince: number, quietRescanMs = QUIET_RESCAN_MS): boolean {
    if (this.coverage.notFoundAt !== undefined && now - this.coverage.notFoundAt < QUIET_RESCAN_MS) {
      this.state = "incomplete"; this.reason = "thread_not_found"; return false;
    }
    if (this.coverage.pending) return true;
    const through = Number(slackMicros(this.coverage.coveredThrough)! / 1000n);
    if (through >= listeningSince && now - through < (waiting ? Math.min(WAITING_RESCAN_MS, quietRescanMs) : quietRescanMs)) {
      // A waiting ask stays "scanned" in status; only a thread nobody waits on counts as settled.
      if (!waiting && (this.state === "pending" || this.state === "scanned")) { this.state = "settled"; this.reason = undefined; }
      if (waiting && this.state === "settled") this.state = "scanned"; // its ask was reopened
      return false;
    }
    if (this.state === "settled") this.state = "pending";
    return true;
  }

  async step(budget: RecoveryBudget, backoff: MethodBackoff): Promise<"more" | "done"> {
    if (this.opts.stopped()) return "done";
    try {
      return await this.page(budget, backoff);
    } catch {
      if (!this.opts.stopped()) { this.state = "incomplete"; this.reason = "storage-or-routing-failed"; this.lastStalledAt = this.opts.now(); }
      return "done";
    }
  }

  private save(next: ThreadCoverage): void {
    if (this.opts.stopped()) return;
    this.opts.store.save(threadKey(this.opts.channel, this.opts.threadTs), next);
    this.coverage = next; // publish only after the atomic write succeeds
  }

  /** One conversations.replies call over the pending interval (opening one up to five seconds ago if none is open), routing
   *  each reply it returns. "more" when the interval has replies left past this page; "done" when it is covered, or the
   *  thread is backing off, out of budget, not found or the page couldn't be trusted (each recorded in state and reason). */
  private async page(budget: RecoveryBudget, backoff: MethodBackoff): Promise<"more" | "done"> {
    const now = this.opts.now();
    if (backoff.blocked(REPLIES, now)) { this.state = "backoff"; this.reason = "rate-limited"; return "done"; }
    if (this.coverage.nextRetryAt && this.coverage.nextRetryAt > now) { this.state = "backoff"; return "done"; }
    if (!this.coverage.pending) {
      // The same five-second settle margin as channel history.
      const upper = slackTimestamp(BigInt(Math.max(0, now - 5000)) * 1000n);
      if (slackMicros(upper)! <= slackMicros(this.coverage.coveredThrough)!) return "done";
      if (!budgetLeft(budget, now)) { this.state = "pending"; return "done"; }
      this.save({ ...this.coverage, nextRetryAt: undefined, rateLimited: undefined, pending: { upper } });
    } else if (!budgetLeft(budget, now)) { this.state = "pending"; return "done"; }
    this.lastScanAt = new Date(now).toISOString();
    this.state = "scanning"; this.reason = undefined;
    const c = { ...this.coverage };
    const lower = slackMicros(c.coveredThrough)!;
    const upper = slackMicros(c.pending!.upper)!;
    const limit = Math.min(PAGE, 100 - budget.entries);
    budget.calls++;
    const r = await callWebApi(REPLIES, this.opts.token, {
      channel: this.opts.channel, ts: this.opts.threadTs, oldest: slackTimestamp(lower > 0n ? lower - 1n : 0n),
      latest: c.pending!.upper, inclusive: false, limit,
    }, this.opts.fetchImpl, Math.min(5000, budget.deadline - this.opts.now()), "get-query");
    if (this.opts.stopped()) return "done";
    if (!r.ok) {
      this.lastStalledAt = now;
      const known = ["missing_scope", "not_in_channel", "channel_not_found", "thread_not_found", "invalid_auth", "token_revoked"];
      if (r.error === "thread_not_found") {
        this.save({ ...c, notFoundAt: this.opts.now() });
        this.state = "incomplete"; this.reason = "thread_not_found"; return "done";
      }
      this.reason = r.status === 429 ? "rate-limited" : known.includes(r.error ?? "") ? r.error : "replies-api-unavailable";
      const retrySeconds = r.retryAfterSeconds ?? (r.status === 0 || r.status >= 500 ? 5 : 300);
      if (r.status === 429) backoff.hold(REPLIES, this.opts.now() + retrySeconds * 1000);
      this.save({ ...c, nextRetryAt: this.opts.now() + retrySeconds * 1000, rateLimited: r.status === 429 });
      this.state = "backoff"; return "done";
    }
    const messages = r.json.messages;
    const cursor = (r.json.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    // The root comes back with its replies whenever it falls in the range; it is never a reply.
    const replies = Array.isArray(messages) ? messages.filter(m => m?.ts !== this.opts.threadTs) : [];
    if (!Array.isArray(messages) || (r.json.has_more !== undefined && typeof r.json.has_more !== "boolean") ||
        (r.json.has_more === undefined && cursor === undefined) ||
        (cursor !== undefined && typeof cursor !== "string") || replies.length > limit ||
        replies.some(m => !m || typeof m !== "object" || m.thread_ts !== this.opts.threadTs || slackMicros(m.ts) === null ||
          slackMicros(m.ts)! < lower || slackMicros(m.ts)! >= upper)) {
      this.state = "incomplete"; this.reason = "invalid-replies-page"; this.lastStalledAt = now; return "done";
    }
    const ordered = [...replies].sort((a, b) => slackMicros(a.ts)! < slackMicros(b.ts)! ? -1 : 1);
    const more = r.json.has_more === true || (typeof cursor === "string" && cursor.length > 0);
    if (more && !ordered.length) { this.state = "incomplete"; this.reason = "replies-page-no-progress"; this.lastStalledAt = now; return "done"; }
    for (const message of ordered) {
      if (this.opts.stopped()) return "done";
      if (this.opts.now() >= budget.deadline || budget.entries >= 100) { this.state = "incomplete"; this.reason = "pass-budget"; return "done"; }
      budget.entries++;
      if (message.subtype === "thread_broadcast") continue; // channel history recovers it
      // A recovered reply is a late reply row: it keeps its thread and time and never answers a decision.
      const ev: SlackEvent = { ...message, channel: this.opts.channel, thread_ts: this.opts.threadTs,
        recoveredAfterGap: true, recoveredThreadReply: true };
      if (!ingestDecision(ev).ingest) continue;
      const landed = await this.opts.router.route(ev, 0, () => !this.opts.stopped());
      if (this.opts.stopped()) return "done";
      if (landed.reason === "inflight" || landed.reason === "inactive") {
        this.state = "incomplete"; this.reason = "landing-in-progress"; this.lastStalledAt = now; return "done";
      }
      if (landed.disposition === "accepted") this.accepted++;
      if (landed.disposition === "dead-lettered") this.deadLettered++;
    }
    // Replies arrive oldest first, so everything through the last one handled is covered: landed, duplicate, dead-lettered,
    // refused by sender policy or skipped as not ingestible.
    const through = more ? slackMicros(ordered.at(-1)!.ts)! + 1n : upper;
    if (through >= upper) {
      this.save({ ...c, coveredThrough: c.pending!.upper, pending: undefined, nextRetryAt: undefined, rateLimited: undefined, notFoundAt: undefined });
      this.state = "scanned"; return "done";
    }
    this.save({ ...c, coveredThrough: slackTimestamp(through), nextRetryAt: undefined, rateLimited: undefined });
    this.state = "incomplete"; this.reason = "pass-budget";
    return "more";
  }
}
