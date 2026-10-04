// Available top-level channel history only. A seen event is not scanned coverage.
import path from "node:path";
import { callWebApi, type FetchImpl } from "./slack-api.js";
import { ingestDecision, type InboundRouter, type SlackEvent } from "./inbound.js";
import { ChannelCoverageStore, slackMicros, slackTimestamp, type ChannelCoverage } from "./state-store.js";

interface RecoveryOptions {
  channel: string | null;
  token: string | null;
  stateDir: string;
  router: InboundRouter;
  fetchImpl?: FetchImpl;
  store?: ChannelCoverageStore;
  now?: () => number;
}

/** One owner across socket generations. Stop fences admission and checkpoint writes;
 * already admitted I/O remains owned until it settles (no timeout/unlock race). */
export class ChannelRecovery {
  private readonly store: ChannelCoverageStore;
  private readonly now: () => number;
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

  initialize(): void {
    if (!this.opts.channel) { this.state = "unavailable"; this.reason = "channel-not-configured"; return; }
    try {
      this.coverage = this.store.initialize(this.opts.channel, slackTimestamp(BigInt(this.now()) * 1000n),
        path.join(this.opts.stateDir, "slack-inbound-seen.jsonl"), path.join(this.opts.stateDir, "slack-inbound-receipts.jsonl"));
      this.state = this.opts.token ? "pending" : "unavailable";
      this.reason = this.opts.token ? undefined : "bot-token-unresolved";
    } catch { this.state = "unavailable"; this.reason = "checkpoint-unreadable-or-unwritable"; }
  }

  status() {
    return { state: this.state, reason: this.reason, channel: this.opts.channel, lastScanAt: this.lastScanAt,
      coverage: this.coverage ? structuredClone(this.coverage) : null,
      acceptedThisProcess: this.accepted, deadLetteredThisProcess: this.deadLettered,
      limits: ["older history unknown", "top-level configured-channel messages only; thread recovery deferred",
        "coverage means scanned available history; dead letters are custody, not delivery",
        "four pages / 100 entries / 15 seconds admission per pass; no global chronological ordering"] };
  }

  stop(): void { this.stopped = true; this.state = "stopped"; }

  run(): Promise<void> {
    if (this.pass) return this.pass;
    if (this.stopped || !this.coverage || !this.opts.token || !this.opts.channel) return Promise.resolve();
    const pass = this.scan().catch(() => {
      if (!this.stopped) { this.state = "incomplete"; this.reason = "storage-or-routing-failed"; }
    });
    this.pass = pass;
    void pass.finally(() => { if (this.pass === pass) this.pass = undefined; });
    return pass;
  }

  private save(next: ChannelCoverage): void {
    if (this.stopped) return;
    this.store.save(this.opts.channel!, next);
    this.coverage = next; // publish only after the atomic write succeeds
  }

  private async scan(): Promise<void> {
    if (this.coverage!.nextRetryAt && this.coverage!.nextRetryAt > this.now()) { this.state = "backoff"; return; }
    const deadline = this.now() + 15_000;
    this.lastScanAt = new Date(this.now()).toISOString();
    this.state = "scanning"; this.reason = undefined;
    if (!this.coverage!.pending) {
      const upper = slackTimestamp(BigInt(this.now()) * 1000n);
      if (slackMicros(upper)! <= slackMicros(this.coverage!.coveredThrough)!) { this.state = "pending"; return; }
      this.save({ ...this.coverage!, nextRetryAt: undefined, pending: { upper, nextLatest: upper } });
    }
    let entries = 0;
    for (let pages = 0; pages < 4 && !this.stopped && this.now() < deadline; pages++) {
      const c = this.coverage!;
      const lower = slackMicros(c.coveredThrough)!;
      const latest = slackMicros(c.pending!.nextLatest)!;
      const r = await callWebApi("conversations.history", this.opts.token!, {
        channel: this.opts.channel, oldest: slackTimestamp(lower > 0n ? lower - 1n : 0n),
        latest: c.pending!.nextLatest, inclusive: false, limit: Math.min(25, 100 - entries),
      }, this.opts.fetchImpl, Math.min(5000, deadline - this.now()), "get-query");
      if (this.stopped) return;
      if (!r.ok) {
        const known = ["missing_scope", "not_in_channel", "channel_not_found", "invalid_auth", "token_revoked"];
        this.reason = r.status === 429 ? "rate-limited" : known.includes(r.error ?? "") ? r.error : "history-api-unavailable";
        this.save({ ...c, nextRetryAt: this.now() + (r.retryAfterSeconds ?? 300) * 1000 });
        this.state = "backoff"; return;
      }
      if (r.json.is_limited === true) { this.state = "incomplete"; this.reason = "history-retention-limited"; return; }
      const messages = r.json.messages;
      const cursor = (r.json.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
      if (!Array.isArray(messages) || typeof r.json.has_more !== "boolean" ||
          (cursor !== undefined && typeof cursor !== "string") || messages.length > 25 ||
          messages.some(m => !m || typeof m !== "object" || slackMicros(m.ts) === null ||
            slackMicros(m.ts)! < lower || slackMicros(m.ts)! >= latest)) {
        this.state = "incomplete"; this.reason = "invalid-history-page"; return;
      }
      const more = r.json.has_more || (typeof cursor === "string" && cursor.length > 0);
      if (more && (!messages.length || slackMicros(messages.at(-1)?.ts)! <= lower)) {
        this.state = "incomplete"; this.reason = "history-page-no-progress"; return;
      }
      const ordered = [...messages].sort((a, b) => slackMicros(a.ts)! < slackMicros(b.ts)! ? -1 : 1);
      for (const message of ordered) {
        if (this.stopped) return;
        if (this.now() >= deadline || entries >= 100) { this.state = "incomplete"; this.reason = "pass-budget"; return; }
        entries++;
        const ev: SlackEvent = { ...message, channel: this.opts.channel!, recoveredAfterGap: true };
        if (ev.thread_ts && ev.thread_ts !== ev.ts) continue;
        if (!ingestDecision(ev).ingest) continue;
        const landed = await this.opts.router.route(ev, 0, () => !this.stopped);
        if (this.stopped) return;
        if (landed.reason === "inflight" || landed.reason === "inactive") {
          this.state = "incomplete"; this.reason = "landing-in-progress"; return;
        }
        if (landed.disposition === "accepted") this.accepted++;
        if (landed.disposition === "dead-lettered") this.deadLettered++;
      }
      if (!more) {
        this.save({ ...c, coveredThrough: c.pending!.upper, pending: undefined, nextRetryAt: undefined });
        this.state = "scanned"; return;
      }
      this.save({ ...c, pending: { upper: c.pending!.upper, nextLatest: ordered[0]!.ts }, nextRetryAt: undefined });
      if (entries >= 100) break;
    }
    if (!this.stopped) { this.state = "incomplete"; this.reason = "pass-budget"; }
  }
}
