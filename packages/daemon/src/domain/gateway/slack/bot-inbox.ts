// Named-bot delivery: a bot the operator names in `slack-connector.json` reaches one seat through
// one channel (the bot inbox), marked as a bot. Every other bot post stays dropped, and OpenRig's
// own posts are never delivered, whatever the config names.
//
// The sender is identified by the event's own `bot_id`, resolved to its app with `bots.info`. The
// envelope's outer `api_app_id` names the app RECEIVING the event (ours), so it is the own-app
// check, never the allowlist key.

/** One bot the operator names. */
export interface NamedBot {
  /** The sending bot's Slack app ID (starts with A), as `bots.info` reports it for the bot's posts. */
  appId: string;
  /** What the delivered rows call the bot. */
  name: string;
  /** Posts delivered in any rolling hour before the bot is cut off. Default 20. */
  maxPerHour?: number;
  /** How long a cut-off bot stays cut off at least, in minutes. Default 60. */
  cooldownMinutes?: number;
}

export interface BotInboxConfig {
  /** The one channel ID where named bots are heard. */
  channel: string;
  /** The one seat that reads it. */
  destination: string;
  bots: NamedBot[];
}

export const DEFAULT_MAX_PER_HOUR = 20;
export const DEFAULT_COOLDOWN_MINUTES = 60;
const HOUR_MS = 60 * 60_000;

/** What is wrong with a `botInbox` block, in plain words; empty when it is usable. An invalid block
 *  never fails the connector: the bot inbox stays off and `rig slack status` names the problems. */
export function botInboxProblems(cfg: { botInbox?: unknown }): string[] {
  const inbox = cfg.botInbox as Partial<BotInboxConfig> | undefined;
  if (inbox === undefined) return [];
  if (!inbox || typeof inbox !== "object" || Array.isArray(inbox)) return ["botInbox must be an object"];
  const problems: string[] = [];
  if (typeof inbox.channel !== "string" || !inbox.channel.trim()) problems.push("botInbox.channel must be a channel ID");
  if (typeof inbox.destination !== "string" || !/^[^@\s]+@[^@\s]+$/.test(inbox.destination)) {
    problems.push("botInbox.destination must be a seat address (seat@rig)");
  }
  if (!Array.isArray(inbox.bots)) return [...problems, "botInbox.bots must be a list"];
  const seen = new Set<string>();
  inbox.bots.forEach((b: Partial<NamedBot> | null, i) => {
    const at = `botInbox.bots[${i}]`;
    if (!b || typeof b !== "object") { problems.push(`${at} must be an object`); return; }
    if (typeof b.appId !== "string" || !/^A[A-Z0-9]+$/.test(b.appId)) {
      problems.push(`${at}.appId must be a Slack app ID (starts with A); a bot ID (B…) or user ID (U…) never matches`);
    } else if (seen.has(b.appId)) {
      problems.push(`${at}.appId ${b.appId} is listed twice`);
    } else {
      seen.add(b.appId);
    }
    if (typeof b.name !== "string" || !b.name.trim()) problems.push(`${at}.name must be set`);
    if (b.maxPerHour !== undefined && !(Number.isInteger(b.maxPerHour) && b.maxPerHour > 0)) problems.push(`${at}.maxPerHour must be a whole number above 0`);
    if (b.cooldownMinutes !== undefined && !(typeof b.cooldownMinutes === "number" && b.cooldownMinutes > 0)) problems.push(`${at}.cooldownMinutes must be above 0`);
  });
  return problems;
}

/** The sending bot's app, from `bots.info`. `retryable` separates a transport, rate-limit or server
 *  failure (kept and retried) from Slack's answer that it can't say (refused and logged). */
export type BotLookup = (botId: string) => Promise<{ ok: true; appId: string } | { ok: false; retryable: boolean; error: string }>;

/** Per-bot limits, in memory: up to `maxPerHour` posts in any rolling hour. The next one cuts the bot off
 *  for `cooldownMinutes`, and at least until the rolling hour has room again, so the hourly maximum holds
 *  across a cutoff. A post counts once by its identity (`channel:ts`): another copy of a post already
 *  admitted this hour (a retry, or Slack's `message` and `app_mention` pair for one post) is admitted
 *  without counting again. Each router builds its own limiter, so a daemon restart or a rewire clears all of it. */
export class BotLimiter {
  private readonly admitted = new Map<string, Array<{ at: number; post: string }>>();
  private readonly cutoffUntil = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  check(bot: NamedBot, post: string): { admit: true } | { admit: false; until: number; tripped: boolean } {
    const now = this.now();
    const recent = (this.admitted.get(bot.appId) ?? []).filter((p) => now - p.at < HOUR_MS);
    this.admitted.set(bot.appId, recent);
    if (recent.some((p) => p.post === post)) return { admit: true };
    const until = this.cutoffUntil.get(bot.appId);
    if (until !== undefined) {
      if (now < until) return { admit: false, until, tripped: false };
      this.cutoffUntil.delete(bot.appId);
    }
    if (recent.length >= (bot.maxPerHour ?? DEFAULT_MAX_PER_HOUR)) {
      // recent[0] is the oldest post in the hour; the hour has room once it leaves.
      const next = Math.max(now + (bot.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60_000, recent[0]!.at + HOUR_MS);
      this.cutoffUntil.set(bot.appId, next);
      return { admit: false, until: next, tripped: true };
    }
    recent.push({ at: now, post });
    return { admit: true };
  }
}
