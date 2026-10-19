// Missed-message recovery for the channels this machine owns and the threads it tracks in them.
// A pass shares one budget, taken alternately by channels and threads (each kind in rotation), so
// neither kind starves the other.
import path from "node:path";
import type { FetchImpl } from "./slack-api.js";
import type { InboundRouter } from "./inbound.js";
import { ChannelRecovery } from "./channel-recovery.js";
import { ThreadRecovery, threadKey } from "./thread-recovery.js";
import { ChannelCoverageStore, ThreadCoverageStore, slackMicros, slackTimestamp, type ThreadCoverage } from "./state-store.js";
import { budgetLeft, HISTORY, MethodBackoff, newRecoveryBudget, REPLIES, type RecoverySource } from "./recovery-budget.js";

/** A thread is tracked while its root was posted, or it closed, within this window. */
export const THREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface TrackedThread { channel: string; threadTs: string; state?: string; closedAt?: string | null }

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
  /** The machine's default channel first. "adoption" for a channel recovery newly covers. */
  channels: Array<{ channel: string; seed?: "adoption" }>;
  token: string | null;
  stateDir: string;
  router: InboundRouter;
  /** Tracked thread roots in these channels posted, or closed, at or after `since` (ISO). */
  trackedThreads?: (channels: string[], since: string) => TrackedThread[];
  fetchImpl?: FetchImpl;
  now?: () => number;
  channelStore?: ChannelCoverageStore;
  threadStore?: ThreadCoverageStore;
  /** This machine has no connection of its own; the hub relays its channels' events. A configured channel is recovered
   *  only once the hub has relayed it here (adoptRelayed), from that moment, and across restarts. A machine nothing is
   *  relayed to never reads history. */
  relayed?: boolean;
}

interface TrackedSource { source: ThreadRecovery; mapping: string }

export class SlackRecovery {
  private readonly channels: ChannelRecovery[];
  private readonly channelStore: ChannelCoverageStore;
  private readonly threadStore: ThreadCoverageStore;
  private threads = new Map<string, TrackedSource>();
  private readonly backoff = new MethodBackoff();
  private readonly now: () => number;
  private pass?: Promise<void>;
  private stopped = false;
  private lastChannel: string | undefined;
  private lastThread: string | undefined;
  private threadsUnavailable: string | undefined;
  private initialized = false;
  private readonly adoptedHere = new Set<string>();
  // Thread recoveries since the connector started, kept when a thread leaves the window.
  private readonly threadTotals = { accepted: 0, deadLettered: 0 };

  constructor(private readonly opts: SlackRecoveryOptions) {
    this.now = opts.now ?? Date.now;
    this.channelStore = opts.channelStore ?? new ChannelCoverageStore(path.join(opts.stateDir, "slack-channel-coverage.json"));
    const channels: Array<{ channel: string | null; seed?: "adoption" }> = opts.channels.length ? opts.channels : [{ channel: null }];
    this.channels = channels.map((c) => new ChannelRecovery({ channel: c.channel, token: opts.token, stateDir: opts.stateDir,
      router: opts.router, fetchImpl: opts.fetchImpl, store: this.channelStore, now: this.now, ...(c.seed ? { seed: c.seed } : {}) }));
    this.threadStore = opts.threadStore ?? new ThreadCoverageStore(path.join(opts.stateDir, "slack-thread-coverage.json"));
  }

  initialize(): void {
    this.initialized = true;
    for (const channel of this.activeChannels()) {
      channel.initialize();
      if (channel.channel) this.adoptedHere.add(channel.channel);
    }
  }

  /** The hub relayed an event for `channel` here, received at `atMs`. A configured channel is adopted the first time, with
   *  its coverage starting at that receipt; a channel this machine isn't configured for is never adopted. */
  adoptRelayed(channel: string | undefined, atMs: number): void {
    if (!this.opts.relayed || !channel || this.stopped || this.adoptedHere.has(channel)) return;
    const source = this.channels.find((c) => c.channel === channel);
    if (!source) return;
    try {
      this.channelStore.adoptRelayed(channel, slackTimestamp(BigInt(atMs) * 1000n));
      source.initialize();
      this.adoptedHere.add(channel);
    } catch { /* an unreadable checkpoint file is never replaced; the channel keeps waiting */ }
  }

  stop(): void {
    this.stopped = true;
    for (const channel of this.channels) channel.stop();
  }

  run(): Promise<void> {
    if (this.pass) return this.pass;
    if (this.stopped || !this.opts.token) return Promise.resolve();
    if (!this.initialized) this.initialize();
    const pass = this.scan();
    this.pass = pass;
    void pass.finally(() => { if (this.pass === pass) this.pass = undefined; });
    return pass;
  }

  /** On a relayed machine, the configured channels the hub has relayed here (saved, so a restart keeps them). */
  private relayAdopted(): Set<string> | null {
    if (!this.opts.relayed) return null;
    try {
      return new Set(Object.entries(this.channelStore.all()).flatMap(([channel, c]) => (c.relayAdoptedAt ? [channel] : [])));
    } catch {
      return new Set();
    }
  }

  private activeChannels(): ChannelRecovery[] {
    const adopted = this.relayAdopted();
    return adopted ? this.channels.filter((c) => c.channel !== null && adopted.has(c.channel)) : this.channels;
  }

  /** Slack's rate limit holds a method for the whole workspace. Before any source is admitted, restore each method's hold
   *  from every saved rate-limit deadline, including one on a thread no longer tracked. A deadline saved without the
   *  marker, as an older daemon saved every backoff, may be a rate limit, so it holds the method too. */
  private restoreMethodHolds(): void {
    const now = this.now();
    try {
      for (const c of Object.values(this.channelStore.all())) {
        if (c.rateLimited !== false && c.nextRetryAt && c.nextRetryAt > now) this.backoff.hold(HISTORY, c.nextRetryAt);
      }
    } catch { /* an unreadable channel file leaves its channels unavailable */ }
    try {
      for (const t of Object.values(this.threadStore.read())) {
        if (t.rateLimited !== false && t.nextRetryAt && t.nextRetryAt > now) this.backoff.hold(REPLIES, t.nextRetryAt);
      }
    } catch { /* reported when threads are listed */ }
  }

  private async scan(): Promise<void> {
    this.restoreMethodHolds();
    // Channels and threads take turns one step at a time, each kind in its own rotation. A source with
    // more to scan rejoins the back of its kind's queue; a kind with nothing left gives its turns away.
    const queues: RecoverySource[][] = [rotate(this.activeChannels(), this.lastChannel), rotate(this.trackedThreadSources(), this.lastThread)];
    const budget = newRecoveryBudget(this.now());
    let kind = 0;
    while (!this.stopped && budgetLeft(budget, this.now()) && (queues[0]!.length || queues[1]!.length)) {
      if (!queues[kind]!.length) kind = 1 - kind;
      const source = queues[kind]!.shift()!;
      if (source instanceof ThreadRecovery) {
        this.lastThread = source.key;
        const before = { accepted: source.accepted, deadLettered: source.deadLettered };
        const more = await source.step(budget, this.backoff);
        this.threadTotals.accepted += source.accepted - before.accepted;
        this.threadTotals.deadLettered += source.deadLettered - before.deadLettered;
        if (more === "more") queues[kind]!.push(source);
      } else {
        this.lastChannel = source.key;
        if (await source.step(budget, this.backoff) === "more") queues[kind]!.push(source);
      }
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
    const owned = this.activeChannels().flatMap((c) => (c.channel ? [c.channel] : []));
    const since = new Date(this.now() - THREAD_WINDOW_MS).toISOString();
    const next = new Map<string, TrackedSource>();
    for (const t of this.opts.trackedThreads(owned, since)) {
      if (!owned.includes(t.channel) || slackMicros(t.threadTs) === null) continue;
      const key = threadKey(t.channel, t.threadTs);
      const mapping = `${t.state ?? ""}|${t.closedAt ?? ""}`;
      const prior = this.threads.get(key);
      // A changed mapping gets a fresh source (so a thread Slack couldn't find is asked again); saved coverage carries over.
      next.set(key, prior && prior.mapping === mapping ? prior : { mapping, source: new ThreadRecovery({ channel: t.channel,
        threadTs: t.threadTs, token: this.opts.token, store: this.threadStore, stored: stored[key], router: this.opts.router,
        fetchImpl: this.opts.fetchImpl, now: this.now, stopped: () => this.stopped }) });
    }
    this.threads = next;
    return [...next.values()].map((t) => t.source).sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  status() {
    const adopted = this.relayAdopted();
    const channels = this.channels.map((c) => {
      const s = c.status();
      return adopted && c.channel && !adopted.has(c.channel) ? { ...s, state: "waiting", reason: "no-relayed-event-yet" } : s;
    });
    const [primary, ...others] = channels;
    const threads = [...this.threads.values()].map((t) => t.source);
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
      // Every channel and thread recovered since the connector started, the default channel's included.
      acceptedThisProcess: sum(channels.map((c) => c.acceptedThisProcess)) + this.threadTotals.accepted,
      deadLetteredThisProcess: sum(channels.map((c) => c.deadLetteredThisProcess)) + this.threadTotals.deadLettered,
      limits: [
        "older history unknown",
        "counts reset on connector rewire/restart",
        "history of the channels this machine owns, including broadcast replies, and replies in tracked threads whose root was posted or which closed within seven days",
        "missed replies in older open threads aren't recovered; live delivery is unchanged",
        "a recovered thread reply, or a broadcast reply recovered in a newly covered channel, lands as a late reply row and never answers a decision",
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
