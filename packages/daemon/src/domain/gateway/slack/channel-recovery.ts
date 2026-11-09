// Available channel history, including broadcast replies. A seen event is not scanned coverage.
import path from "node:path";
import { callWebApi, type FetchImpl } from "./slack-api.js";
import { ingestDecision, type InboundRouter, type SlackEvent } from "./inbound.js";
import { ChannelCoverageStore, slackMicros, slackTimestamp, type ChannelCoverage } from "./state-store.js";
import { budgetLeft, HISTORY, MethodBackoff, newRecoveryBudget, type RecoveryBudget, type RecoverySource } from "./recovery-budget.js";

interface RecoveryOptions {
  channel: string | null;
  token: string | null;
  stateDir: string;
  router: InboundRouter;
  fetchImpl?: FetchImpl;
  store?: ChannelCoverageStore;
  now?: () => number;
  /** "adoption": a channel recovery newly adopts starts its coverage then. Absent: the configured
   *  channel's established seed, its newest retained accepted landing, else adoption. */
  seed?: "adoption";
}

/** One owner across socket generations. Stop fences admission and checkpoint writes;
 * already admitted I/O remains owned until it settles (no timeout/unlock race). */
export class ChannelRecovery implements RecoverySource {
  private readonly store: ChannelCoverageStore;
  private readonly now: () => number;
  private readonly backoff = new MethodBackoff();
  private coverage?: ChannelCoverage;
  private pass?: Promise<void>;
  private stopped = false;
  private state = "not-started";
  private reason: string | undefined;
  private lastScanAt: string | undefined;
  private accepted = 0;
  private deadLettered = 0;

  constructor(private readonly opts: RecoveryOptions) {
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? new ChannelCoverageStore(path.join(opts.stateDir, "slack-channel-coverage.json"));
  }

  get key(): string { return `channel:${this.opts.channel ?? "-"}`; }
  get channel(): string | null { return this.opts.channel; }

  initialize(): void {
    if (!this.opts.channel) { this.state = "unavailable"; this.reason = "channel-not-configured"; return; }
    try {
      const at = slackTimestamp(BigInt(this.now()) * 1000n);
      this.coverage = this.opts.seed === "adoption"
        ? this.store.initializeAtAdoption(this.opts.channel, at)
        : this.store.initialize(this.opts.channel, at,
          path.join(this.opts.stateDir, "slack-inbound-seen.jsonl"), path.join(this.opts.stateDir, "slack-inbound-receipts.jsonl"));
      this.state = this.opts.token ? "pending" : "unavailable";
      this.reason = this.opts.token ? undefined : "bot-token-unresolved";
    } catch { this.state = "unavailable"; this.reason = "checkpoint-unreadable-or-unwritable"; }
  }

  status() {
    return { state: this.state, reason: this.reason, channel: this.opts.channel, lastScanAt: this.lastScanAt,
      coverage: this.coverage ? structuredClone(this.coverage) : null,
      acceptedThisProcess: this.accepted, deadLetteredThisProcess: this.deadLettered,
      limits: ["older history unknown", "counts reset on connector rewire/restart", "this channel's history, including broadcast replies",
        ...(this.coverage?.historyLimited ? ["Slack plan limit excludes older history; only available messages were scanned"] : []),
        "coverage means scanned available history; dead letters are custody, not delivery",
        "five-second settle margin; larger clock skew or history visibility lag remains unverified",
        "four pages / 100 entries / 15 seconds admission per pass; no global chronological ordering"] };
  }

  stop(): void { this.stopped = true; this.state = "stopped"; }

  /** A pass of this channel alone, with its own budget. */
  run(): Promise<void> {
    if (this.pass) return this.pass;
    if (!this.ready()) return Promise.resolve();
    const budget = newRecoveryBudget(this.now());
    const pass = (async () => { while (await this.step(budget, this.backoff) === "more") { /* next page */ } })();
    this.pass = pass;
    void pass.finally(() => { if (this.pass === pass) this.pass = undefined; });
    return pass;
  }

  /** At most one history page within the pass's budget. "more": this channel has more history to
   *  scan now. "done": scanned, waiting, refused or backing off; its status says which. */
  async step(budget: RecoveryBudget, backoff: MethodBackoff): Promise<"more" | "done"> {
    if (!this.ready()) return "done";
    try {
      return await this.page(budget, backoff);
    } catch {
      if (!this.stopped) { this.state = "incomplete"; this.reason = "storage-or-routing-failed"; }
      return "done";
    }
  }

  private ready(): boolean {
    return !this.stopped && !!this.coverage && !!this.opts.token && !!this.opts.channel;
  }

  private save(next: ChannelCoverage): void {
    if (this.stopped) return;
    this.store.save(this.opts.channel!, next);
    this.coverage = next; // publish only after the atomic write succeeds
  }

  private async page(budget: RecoveryBudget, backoff: MethodBackoff): Promise<"more" | "done"> {
    if (backoff.blocked(HISTORY, this.now())) { this.state = "backoff"; this.reason = "rate-limited"; return "done"; }
    if (this.coverage!.nextRetryAt && this.coverage!.nextRetryAt > this.now()) { this.state = "backoff"; return "done"; }
    this.lastScanAt = new Date(this.now()).toISOString();
    this.state = "scanning"; this.reason = undefined;
    if (!this.coverage!.pending) {
      // Leave recent posts for the next interval so ordinary visibility lag/clock skew
      // does not mark their timestamps covered before history can expose them.
      const upper = slackTimestamp(BigInt(Math.max(0, this.now() - 5000)) * 1000n);
      if (slackMicros(upper)! <= slackMicros(this.coverage!.coveredThrough)!) { this.state = "pending"; return "done"; }
      if (!budgetLeft(budget, this.now())) { this.state = "incomplete"; this.reason = "pass-budget"; return "done"; }
      this.save({ ...this.coverage!, nextRetryAt: undefined, rateLimited: undefined, pending: { upper, nextLatest: upper } });
    } else if (!budgetLeft(budget, this.now())) { this.state = "incomplete"; this.reason = "pass-budget"; return "done"; }
    const c = { ...this.coverage! };
    const lower = slackMicros(c.coveredThrough)!;
    const latest = slackMicros(c.pending!.nextLatest)!;
    budget.calls++;
    const r = await callWebApi(HISTORY, this.opts.token!, {
      channel: this.opts.channel, oldest: slackTimestamp(lower > 0n ? lower - 1n : 0n),
      latest: c.pending!.nextLatest, inclusive: false, limit: Math.min(25, 100 - budget.entries),
    }, this.opts.fetchImpl, Math.min(5000, budget.deadline - this.now()), "get-query");
    if (this.stopped) return "done";
    if (!r.ok) {
      const known = ["missing_scope", "not_in_channel", "channel_not_found", "invalid_auth", "token_revoked"];
      this.reason = r.status === 429 ? "rate-limited" : known.includes(r.error ?? "") ? r.error : "history-api-unavailable";
      const retrySeconds = r.retryAfterSeconds ?? (r.status === 0 || r.status >= 500 ? 5 : 300);
      if (r.status === 429) backoff.hold(HISTORY, this.now() + retrySeconds * 1000);
      this.save({ ...c, nextRetryAt: this.now() + retrySeconds * 1000, rateLimited: r.status === 429 });
      this.state = "backoff"; return "done";
    }
    const messages = r.json.messages;
    const cursor = (r.json.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    if (!Array.isArray(messages) || (r.json.has_more !== undefined && typeof r.json.has_more !== "boolean") ||
        (r.json.has_more === undefined && cursor === undefined) ||
        (cursor !== undefined && typeof cursor !== "string") || messages.length > 25 ||
        messages.some(m => !m || typeof m !== "object" || slackMicros(m.ts) === null ||
          slackMicros(m.ts)! < lower || slackMicros(m.ts)! >= latest)) {
      this.state = "incomplete"; this.reason = "invalid-history-page"; return "done";
    }
    const ordered = [...messages].sort((a, b) => slackMicros(a.ts)! < slackMicros(b.ts)! ? -1 : 1);
    const more = r.json.has_more === true || (typeof cursor === "string" && cursor.length > 0);
    if (more && (!messages.length || slackMicros(ordered[0]?.ts)! <= lower)) {
      this.state = "incomplete"; this.reason = "history-page-no-progress"; return "done";
    }
    // The page is valid; the flag describes unreachable older history. Retain that
    // qualification with the next durable page boundary rather than stalling forever.
    if (r.json.is_limited === true) c.historyLimited = true;
    for (const message of ordered) {
      if (this.stopped) return "done";
      if (this.now() >= budget.deadline || budget.entries >= 100) { this.state = "incomplete"; this.reason = "pass-budget"; return "done"; }
      budget.entries++;
      const ev: SlackEvent = { ...message, channel: this.opts.channel!, recoveredAfterGap: true };
      // Broadcast replies are channel history too; preserve their thread routing.
      if (ev.thread_ts && ev.thread_ts !== ev.ts && ev.subtype !== "thread_broadcast") continue;
      // In a channel this recovery newly covers, a broadcast reply lands late and never answers a decision, like a thread
      // reply. The configured default channel keeps its established broadcast behaviour.
      if (this.opts.seed === "adoption" && ev.thread_ts && ev.thread_ts !== ev.ts) ev.recoveredThreadReply = true;
      if (!ingestDecision(ev).ingest) continue;
      const landed = await this.opts.router.route(ev, 0, () => !this.stopped);
      if (this.stopped) return "done";
      if (landed.reason === "inflight" || landed.reason === "inactive") {
        this.state = "incomplete"; this.reason = "landing-in-progress"; return "done";
      }
      if (landed.disposition === "accepted") this.accepted++;
      if (landed.disposition === "dead-lettered") this.deadLettered++;
    }
    if (!more) {
      this.save({ ...c, coveredThrough: c.pending!.upper, pending: undefined, nextRetryAt: undefined, rateLimited: undefined });
      this.state = "scanned"; return "done";
    }
    this.save({ ...c, pending: { upper: c.pending!.upper, nextLatest: ordered[0]!.ts }, nextRetryAt: undefined, rateLimited: undefined });
    // More history waits for this pass's next turn, or the next pass.
    this.state = "incomplete"; this.reason = "pass-budget";
    return "more";
  }
}
