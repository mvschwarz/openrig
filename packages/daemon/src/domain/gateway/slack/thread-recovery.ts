// Replies in one tracked thread, oldest first (conversations.replies). Seen records only dedupe;
// coverage is an interval actually scanned, starting at the thread root.
import { callWebApi, type FetchImpl } from "./slack-api.js";
import { ingestDecision, type InboundRouter, type SlackEvent } from "./inbound.js";
import { slackMicros, slackTimestamp, type ThreadCoverage, type ThreadCoverageStore } from "./state-store.js";
import { budgetLeft, REPLIES, type MethodBackoff, type RecoveryBudget, type RecoverySource } from "./recovery-budget.js";
/** Slack's page cap for apps distributed outside the Marketplace. */
const PAGE = 15;

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
  private coverage: ThreadCoverage;
  /** Slack can't find the thread. This source stays incomplete, without a call, until the coordinator replaces it because its
   *  mapping or the configuration changed. Not proof of deletion, and never set by a transient error. */
  private missing = false;

  constructor(private readonly opts: ThreadRecoveryOptions) {
    this.coverage = opts.stored ?? { coverageStart: opts.threadTs, coveredThrough: opts.threadTs };
  }

  get key(): string { return `thread:${threadKey(this.opts.channel, this.opts.threadTs)}`; }
  get coveredThrough(): string { return this.coverage.coveredThrough; }

  async step(budget: RecoveryBudget, backoff: MethodBackoff): Promise<"more" | "done"> {
    if (this.opts.stopped()) return "done";
    try {
      return await this.page(budget, backoff);
    } catch {
      if (!this.opts.stopped()) { this.state = "incomplete"; this.reason = "storage-or-routing-failed"; }
      return "done";
    }
  }

  private save(next: ThreadCoverage): void {
    if (this.opts.stopped()) return;
    this.opts.store.save(threadKey(this.opts.channel, this.opts.threadTs), next);
    this.coverage = next; // publish only after the atomic write succeeds
  }

  private async page(budget: RecoveryBudget, backoff: MethodBackoff): Promise<"more" | "done"> {
    const now = this.opts.now();
    if (this.missing) { this.state = "incomplete"; this.reason = "thread_not_found"; return "done"; }
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
      const known = ["missing_scope", "not_in_channel", "channel_not_found", "thread_not_found", "invalid_auth", "token_revoked"];
      if (r.error === "thread_not_found") { this.missing = true; this.state = "incomplete"; this.reason = "thread_not_found"; return "done"; }
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
      this.state = "incomplete"; this.reason = "invalid-replies-page"; return "done";
    }
    const ordered = [...replies].sort((a, b) => slackMicros(a.ts)! < slackMicros(b.ts)! ? -1 : 1);
    const more = r.json.has_more === true || (typeof cursor === "string" && cursor.length > 0);
    if (more && !ordered.length) { this.state = "incomplete"; this.reason = "replies-page-no-progress"; return "done"; }
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
        this.state = "incomplete"; this.reason = "landing-in-progress"; return "done";
      }
      if (landed.disposition === "accepted") this.accepted++;
      if (landed.disposition === "dead-lettered") this.deadLettered++;
    }
    // Replies arrive oldest first, so everything through the last one handled is covered: landed, duplicate, dead-lettered,
    // refused by sender policy or skipped as not ingestible.
    const through = more ? slackMicros(ordered.at(-1)!.ts)! + 1n : upper;
    if (through >= upper) {
      this.save({ ...c, coveredThrough: c.pending!.upper, pending: undefined, nextRetryAt: undefined, rateLimited: undefined });
      this.state = "scanned"; return "done";
    }
    this.save({ ...c, coveredThrough: slackTimestamp(through), nextRetryAt: undefined, rateLimited: undefined });
    this.state = "incomplete"; this.reason = "pass-budget";
    return "more";
  }
}
