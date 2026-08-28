// Slice-11 slack-connector — first-class connector config (item 5 + T1075).
//
// Config is a first-class JSON file (NOT env-only): inbound destination,
// watched channel, alert tag, source label, required scopes, and POINTERS to
// secrets (never secret VALUES — those live in the 0600 env file / env vars).
// An unset/partial config yields an HONEST unconfigured state (no throw, no
// silent nothing) so `rig slack status` can tell the operator exactly what's left.
import fs from "node:fs";
import path from "node:path";
import { getOpenRigHome } from "../../../openrig-compat.js";
import { OWNER_NOTIFICATION_LEVELS, type OwnerNotificationLevel } from "../../queue-transition-log.js";

export interface SlackConnectorConfig {
  enabled: boolean;
  /** Inbound: human Slack messages land here. First-class + overridable (T1075). */
  inboundDestination: string;
  /** Outbound: qitems with this tag destined to a human seat alert to Slack. */
  alertTag: string;
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
}

export const DEFAULT_CONFIG: SlackConnectorConfig = {
  enabled: false,
  inboundDestination: "operator-agent@kernel",
  alertTag: "founder-alert",
  outboundDestinations: [],
  sourceLabel: "openrig",
  channel: null,
  requiredScopes: ["chat:write", "channels:history", "channels:read"],
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

function validateConfig(cfg: SlackConnectorConfig): void {
  validateLevel("minimumLevelThatPosts", cfg.minimumLevelThatPosts);
  validateLevel("minimumLevelThatInterrupts", cfg.minimumLevelThatInterrupts);
}

export function configPathFor(home?: string): string {
  return path.join(home ?? getOpenRigHome(), "slack-connector.json");
}

export function loadConfig(home?: string): SlackConnectorConfig {
  const p = configPathFor(home);
  let raw: Partial<SlackConnectorConfig>;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SlackConnectorConfig>;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  validateConfig(cfg);
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
  ];
}
