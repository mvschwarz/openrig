// Missed-message recovery for the channels this machine owns and the threads it tracks in them.
// A pass shares one budget, taken alternately by channels and threads (each kind in rotation), so
// neither kind starves the other.
import path from "node:path";
import type { FetchImpl } from "./slack-api.js";
import type { InboundRouter } from "./inbound.js";
import { ChannelRecovery } from "./channel-recovery.js";
import { ThreadRecovery, threadKey } from "./thread-recovery.js";
import { ChannelCoverageStore, ThreadCoverageStore, slackMicros, type ThreadCoverage } from "./state-store.js";
import { budgetLeft, MethodBackoff, newRecoveryBudget, type RecoverySource } from "./recovery-budget.js";

/** Replies are recovered in open tracked threads and in threads closed within this window. */
export const CLOSED_THREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface TrackedThread { channel: string; threadTs: string }

/** The channels this machine recovers: its default channel and its channel map's, except a channel
 *  its configuration relays to the machine that owns it (that machine recovers it). */
export function ownedRecoveryChannels(cfg: { channel: string | null; channelMap?: Array<{ channel: string }>; forwardChannels?: unknown }): string[] {
  const relayed = new Set(Array.isArray(cfg.forwardChannels)
    ? cfg.forwardChannels.flatMap((f) => (f && typeof f.channel === "string" ? [f.channel] : []))
    : []);
  const out: string[] = [];
  for (const channel of [cfg.channel, ...(cfg.channelMap ?? []).map((e) => e.channel)]) {
    if (channel && !relayed.has(channel) && !out.includes(channel)) out.push(channel);
  }
  return out;
}

interface SlackRecoveryOptions {
  /** The machine's default channel first. "adoption" for a channel recovery newly adopts. */
  channels: Array<{ channel: string; seed?: "adoption" }>;
  token: string | null;
  stateDir: string;
  router: InboundRouter;
  /** Tracked thread roots in these channels that are open, or closed at or after `closedSince`. */
  trackedThreads?: (channels: string[], closedSince: string) => TrackedThread[];
  fetchImpl?: FetchImpl;
  now?: () => number;
  channelStore?: ChannelCoverageStore;
  threadStore?: ThreadCoverageStore;
  /** A machine without its own connection recovers only once the hub has relayed it an event, so a
   *  machine nobody relays to never reads its channels' history; its coverage starts then. */
  relayed?: () => boolean;
}

export class SlackRecovery {
  private readonly channels: ChannelRecovery[];
  private readonly threadStore: ThreadCoverageStore;
  private threads = new Map<string, ThreadRecovery>();
  private readonly backoff = new MethodBackoff();
  private readonly now: () => number;
  private pass?: Promise<void>;
  private stopped = false;
  private lastChannel: string | undefined;
  private lastThread: string | undefined;
  private threadsUnavailable: string | undefined;
  private initialized = false;

  constructor(private readonly opts: SlackRecoveryOptions) {
    this.now = opts.now ?? Date.now;
    const store = opts.channelStore ?? new ChannelCoverageStore(path.join(opts.stateDir, "slack-channel-coverage.json"));
    const channels: Array<{ channel: string | null; seed?: "adoption" }> = opts.channels.length ? opts.channels : [{ channel: null }];
    this.channels = channels.map((c) => new ChannelRecovery({ channel: c.channel, token: opts.token, stateDir: opts.stateDir,
      router: opts.router, fetchImpl: opts.fetchImpl, store, now: this.now, ...(c.seed ? { seed: c.seed } : {}) }));
    this.threadStore = opts.threadStore ?? new ThreadCoverageStore(path.join(opts.stateDir, "slack-thread-coverage.json"));
  }

  initialize(): void {
    this.initialized = true;
    for (const channel of this.channels) channel.initialize();
  }

  private awaitingRelay(): boolean {
    return !!this.opts.relayed && !this.opts.relayed();
  }

  stop(): void {
    this.stopped = true;
    for (const channel of this.channels) channel.stop();
  }

  run(): Promise<void> {
    if (this.pass) return this.pass;
    if (this.stopped || !this.opts.token || this.awaitingRelay()) return Promise.resolve();
    if (!this.initialized) this.initialize();
    const pass = this.scan();
    this.pass = pass;
    void pass.finally(() => { if (this.pass === pass) this.pass = undefined; });
    return pass;
  }

  private async scan(): Promise<void> {
    // Channels and threads take turns one step at a time, each kind in its own rotation. A source with
    // more to scan rejoins the back of its kind's queue; a kind with nothing left gives its turns away.
    const queues: RecoverySource[][] = [rotate(this.channels, this.lastChannel), rotate(this.trackedThreadSources(), this.lastThread)];
    const budget = newRecoveryBudget(this.now());
    let kind = 0;
    while (!this.stopped && budgetLeft(budget, this.now()) && (queues[0]!.length || queues[1]!.length)) {
      if (!queues[kind]!.length) kind = 1 - kind;
      const source = queues[kind]!.shift()!;
      if (source instanceof ThreadRecovery) this.lastThread = source.key; else this.lastChannel = source.key;
      if (await source.step(budget, this.backoff) === "more") queues[kind]!.push(source);
      kind = 1 - kind;
    }
  }

  private trackedThreadSources(): ThreadRecovery[] {
    if (!this.opts.trackedThreads || !this.opts.token) return [];
    let stored: Record<string, ThreadCoverage>;
    try {
      stored = this.threadStore.read();
      this.threadsUnavailable = undefined;
    } catch {
      // Never replace an unreadable checkpoint file with fresh floors.
      this.threadsUnavailable = "checkpoint-unreadable-or-unwritable";
      return [];
    }
    const owned = this.channels.flatMap((c) => (c.channel ? [c.channel] : []));
    const closedSince = new Date(this.now() - CLOSED_THREAD_WINDOW_MS).toISOString();
    const next = new Map<string, ThreadRecovery>();
    for (const t of this.opts.trackedThreads(owned, closedSince)) {
      if (!owned.includes(t.channel) || slackMicros(t.threadTs) === null) continue;
      const key = threadKey(t.channel, t.threadTs);
      next.set(key, this.threads.get(key) ?? new ThreadRecovery({ channel: t.channel, threadTs: t.threadTs, token: this.opts.token,
        store: this.threadStore, stored: stored[key], router: this.opts.router, fetchImpl: this.opts.fetchImpl,
        now: this.now, stopped: () => this.stopped }));
    }
    this.threads = next;
    return [...next.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  status() {
    const channels = this.channels.map((c) => c.status());
    const [primary, ...others] = channels;
    const threads = [...this.threads.values()];
    const count = (state: string) => threads.filter((t) => t.state === state).length;
    const byReason = (states: string[]) => threads.reduce<Record<string, number>>((acc, t) => {
      if (states.includes(t.state)) acc[t.reason ?? "unknown"] = (acc[t.reason ?? "unknown"] ?? 0) + 1;
      return acc;
    }, {});
    const now = this.now();
    const behind = (t: ThreadRecovery) => Math.max(0, Math.floor(now / 1000 - Number(slackMicros(t.coveredThrough)! / 1_000_000n)));
    const pending = threads.filter((t) => t.state === "pending");
    const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);
    return {
      ...primary!,
      ...(this.awaitingRelay() ? { state: "waiting", reason: "no-relayed-event-yet" } : {}),
      // Every channel and thread this process recovered, the default channel's included.
      acceptedThisProcess: sum([...channels.map((c) => c.acceptedThisProcess), ...threads.map((t) => t.accepted)]),
      deadLetteredThisProcess: sum([...channels.map((c) => c.deadLetteredThisProcess), ...threads.map((t) => t.deadLettered)]),
      limits: [
        "older history unknown",
        "counts reset on connector rewire/restart",
        "history of the channels this machine owns, including broadcast replies, and replies in tracked threads that are open or closed within seven days",
        "a recovered thread reply lands as a late reply row and never answers a decision",
        ...(channels.some((c) => c.coverage?.historyLimited) ? ["Slack plan limit excludes older history; only available messages were scanned"] : []),
        "coverage means scanned available history; dead letters are custody, not delivery",
        "five-second settle margin; larger clock skew or history visibility lag remains unverified",
        "four calls / 100 entries / 15 seconds per pass, taken in turn by channels and threads; no global chronological ordering",
      ],
      channels: others.map(({ limits: _limits, ...rest }) => rest),
      threads: {
        state: !this.opts.trackedThreads ? "not-configured" : this.threadsUnavailable ? "unavailable" : "available",
        ...(this.threadsUnavailable ? { reason: this.threadsUnavailable } : {}),
        tracked: threads.length,
        scanned: count("scanned"),
        pending: pending.length,
        oldestPendingSeconds: pending.length ? Math.max(...pending.map(behind)) : null,
        backoff: byReason(["backoff"]),
        incomplete: byReason(["incomplete"]),
      },
    };
  }
}

function rotate<T extends { key: string }>(sources: T[], last: string | undefined): T[] {
  const start = last === undefined ? 0 : sources.findIndex((s) => s.key === last) + 1;
  return [...sources.slice(start), ...sources.slice(0, start)];
}
