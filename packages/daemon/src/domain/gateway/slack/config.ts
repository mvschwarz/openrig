// Slice-11 slack-connector — first-class connector config (item 5 + T1075).
//
// Config is a first-class JSON file (NOT env-only): inbound destination,
// watched channel, OWNER thresholds, source label, required scopes, and POINTERS to
// secrets (never secret VALUES — those live in the 0600 env file / env vars).
// An unset/partial config yields an HONEST unconfigured state (no throw, no
// silent nothing) so `rig slack status` can tell the operator exactly what's left.
import fs from "node:fs";
import path from "node:path";
import { getOpenRigHome } from "../../../openrig-compat.js";
import { OWNER_NOTIFICATION_LEVELS, type OwnerNotificationLevel } from "../../queue-transition-log.js";
import { BASELINE_REQUIRED_SCOPES } from "./capabilities.js";
import { unsupportedChannelMapFields, validateChannelMap, type ChannelMapEntry } from "./channel-map.js";
import { botInboxProblems, type BotInboxConfig } from "./bot-inbox.js";
import { forwardChannelProblems, type ForwardChannel } from "./forwarding.js";

export interface SlackConnectorConfig {
  enabled: boolean;
  /** Inbound: human Slack messages land here. First-class + overridable (T1075). */
  inboundDestination: string;
  /** Optional explicit human-seat allow-list for outbound (empty = any human-seat/human-gate). */
  outboundDestinations: string[];
  /** Where the queue lives, shown in the posted message footer (never hardcoded). */
  sourceLabel: string;
  /** Slack channel the connector app must be a member of (verified live, item 5). */
  channel: string | null;
  /** Bot scopes the connector requires; verified against GRANTED header, not config (item 5). */
  requiredScopes: string[];
  /** Path to the 0600 env file holding secrets (webhook URL, bot/app tokens). */
  secretsEnvFile: string | null;
  /**
   * S10: VESTIGIAL — the relay's remote-queue targeting (OPENRIG_URL for a connector host
   * that differed from the queue host). The in-daemon subsystem reads its own QueueRepository
   * directly, so this is never consulted; the field stays so existing config files load
   * unchanged. Remove at the next config-schema rev.
   */
  queueUrl: string | null;
  minimumLevelThatPosts: OwnerNotificationLevel;
  minimumLevelThatInterrupts: OwnerNotificationLevel;
  /**
   * #192: optional per-rig / per-seat outbound channels (channel-map.ts). Absent or empty = every
   * item posts to `channel`, as before. Deliberately not in DEFAULT_CONFIG, so a config without
   * it saves and digests unchanged.
   */
  channelMap?: ChannelMapEntry[];
  /**
   * Optional named-bot delivery (bot-inbox.ts): posts by the named bots in one channel reach one seat,
   * marked as a bot. Absent = every bot post is dropped, as before. Not in DEFAULT_CONFIG, like
   * `channelMap`. An invalid block leaves the bot inbox off and is named by staticReadiness.
   */
  botInbox?: BotInboxConfig;
  /**
   * One shared app across machines: on the hub (the machine with the app-level token), the
   * channels another machine owns, each relayed to that machine's daemon (forwarding.ts). Absent =
   * every channel is handled here, as before. Not in DEFAULT_CONFIG, like `channelMap`.
   */
  forwardChannels?: ForwardChannel[];
  /**
   * What a person's emoji reaction on an OpenRig post does. Absent or "route" = a row for the seat that asked, as before.
   * "off" = reactions are ignored, so an acknowledging emoji costs no agent turn. Not in DEFAULT_CONFIG, like `channelMap`.
   */
  reactions?: SlackReactionsMode;
}

export const SLACK_REACTIONS_MODES = ["route", "off"] as const;
export type SlackReactionsMode = typeof SLACK_REACTIONS_MODES[number];

export const DEFAULT_CONFIG: SlackConnectorConfig = {
  enabled: false,
  inboundDestination: "operator-agent@kernel",
  outboundDestinations: [],
  sourceLabel: "openrig",
  channel: null,
  requiredScopes: [...BASELINE_REQUIRED_SCOPES],
  secretsEnvFile: null,
  queueUrl: null,
  minimumLevelThatPosts: "NOTICE",
  minimumLevelThatInterrupts: "ALERT",
};

function validateLevel(field: string, value: unknown): asserts value is OwnerNotificationLevel {
  if (!OWNER_NOTIFICATION_LEVELS.includes(value as OwnerNotificationLevel)) {
    throw new Error(`${field} must be one of ${OWNER_NOTIFICATION_LEVELS.join(", ")} (got ${String(value)})`);
  }
}

/** `reading`: a channel-map entry field written by a newer OpenRig is ignored (and reported by
 *  staticReadiness and the gateway log) rather than failing the connector after a downgrade. */
function validateConfig(cfg: SlackConnectorConfig, opts: { reading?: boolean } = {}): void {
  validateLevel("minimumLevelThatPosts", cfg.minimumLevelThatPosts);
  validateLevel("minimumLevelThatInterrupts", cfg.minimumLevelThatInterrupts);
  validateChannelMap(cfg, { allowUnknownFields: opts.reading });
  // A value a newer OpenRig wrote is read as the default rather than failing the connector.
  if (!opts.reading && cfg.reactions !== undefined && !SLACK_REACTIONS_MODES.includes(cfg.reactions)) {
    throw new Error(`reactions must be one of ${SLACK_REACTIONS_MODES.join(", ")} (got ${String(cfg.reactions)})`);
  }
}

export function configPathFor(home?: string): string {
  return path.join(home ?? getOpenRigHome(), "slack-connector.json");
}

export function loadConfig(home?: string): SlackConnectorConfig {
  const p = configPathFor(home);
  let raw: Partial<SlackConnectorConfig> & { alertTag?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SlackConnectorConfig> & { alertTag?: unknown };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  const { alertTag: _retiredAlertTag, ...supported } = raw;
  const cfg = { ...DEFAULT_CONFIG, ...supported };
  validateConfig(cfg, { reading: true });
  return cfg;
}

export function saveConfig(cfg: SlackConnectorConfig, home?: string): string {
  validateConfig(cfg);
  const p = configPathFor(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  return p;
}

export function configFileExists(home?: string): boolean {
  return fs.existsSync(configPathFor(home));
}

export interface ReadinessItem {
  ok: boolean;
  label: string;
  detail: string;
}

/**
 * HONEST unconfigured state (item 5): a static (no-network) readiness checklist
 * from config + secret RESOLVABILITY (not values). Live scope/membership checks
 * are `rig slack verify`. Never throws; reports what's missing.
 *
 * S10: outbound posts via the Web API (`chat.postMessage`) on the in-daemon subsystem — the
 * bot token + channel are the outbound gate now; the incoming webhook retired with the relay.
 */
export function staticReadiness(cfg: SlackConnectorConfig, hasBotToken: boolean, hasAppToken: boolean): ReadinessItem[] {
  return [
    { ok: cfg.secretsEnvFile !== null || hasBotToken, label: "secrets-source", detail: cfg.secretsEnvFile ? `env file ${cfg.secretsEnvFile}` : "env vars only" },
    { ok: hasBotToken, label: "bot-token", detail: hasBotToken ? "resolved" : "unset (outbound cannot post; scope/membership verify unavailable)" },
    { ok: hasAppToken, label: "app-token (Socket Mode)", detail: hasAppToken ? "resolved" : "unset (inbound cannot connect)" },
    { ok: cfg.channel !== null, label: "channel", detail: cfg.channel ?? "unset (outbound cannot post)" },
    { ok: Boolean(cfg.inboundDestination), label: "inbound-destination", detail: cfg.inboundDestination },
    { ok: cfg.enabled, label: "enabled", detail: cfg.enabled ? "yes" : "no (run `rig slack enable`)" },
    ...channelMapReadiness(cfg),
    ...botInboxReadiness(cfg),
    ...forwardReadiness(cfg),
  ];
}

/** One row only when a bot inbox is set: what it delivers, or why it is off. */
function botInboxReadiness(cfg: SlackConnectorConfig): ReadinessItem[] {
  if (cfg.botInbox === undefined) return [];
  const problems = botInboxProblems(cfg);
  if (problems.length) return [{ ok: false, label: "bot-inbox", detail: `OFF: ${problems.join("; ")}` }];
  const { channel, destination, bots } = cfg.botInbox;
  return [{
    ok: true,
    label: "bot-inbox",
    detail: `${bots.length} named bot(s) in ${channel}, delivered to ${destination}; needs users:read and the app in that channel (\`rig slack verify\` only warns on a missing users:read, and doesn't check this channel)`,
  }];
}

/** One row only when channels are forwarded: where they go, or why forwarding is off. */
function forwardReadiness(cfg: SlackConnectorConfig): ReadinessItem[] {
  if (cfg.forwardChannels === undefined) return [];
  const problems = forwardChannelProblems(cfg);
  if (problems.length) return [{ ok: false, label: "forward-channels", detail: `OFF: ${problems.join("; ")}` }];
  const hosts = [...new Set(cfg.forwardChannels.map((f) => f.host))];
  return [{ ok: true, label: "forward-channels", detail: `${cfg.forwardChannels.length} channel(s) relayed to ${hosts.join(", ")}; each host needs an http entry (rig host list) and the app token here` }];
}

/** #192: one row only when a channel map is set. Fields this version does not support make the
 *  row fail loudly: they are ignored, and saving the config refuses them. */
function channelMapReadiness(cfg: SlackConnectorConfig): ReadinessItem[] {
  if (!cfg.channelMap?.length) return [];
  const channels = new Set(cfg.channelMap.map((e) => e.channel)).size;
  const summary = `${cfg.channelMap.length} entr${cfg.channelMap.length === 1 ? "y" : "ies"} over ${channels} channel(s); \`rig slack verify\` checks membership in each`;
  const unsupported = unsupportedChannelMapFields(cfg);
  return [unsupported.length
    ? { ok: false, label: "channel-map", detail: `${summary}; IGNORED unsupported field(s) ${unsupported.join(", ")} (written by a newer OpenRig?); remove them before saving the config` }
    : { ok: true, label: "channel-map", detail: summary }];
}
