// Slice-11 slack-connector — first-class connector config (item 5 + T1075).
//
// Config is a first-class JSON file (NOT env-only): inbound destination,
// watched channel, alert tag, source label, required scopes, and POINTERS to
// secrets (never secret VALUES — those live in the 0600 env file / env vars).
// An unset/partial config yields an HONEST unconfigured state (no throw, no
// silent nothing) so `rig slack status` can tell the operator exactly what's left.
import fs from "node:fs";
import path from "node:path";
import { getOpenRigHome } from "../openrig-compat.js";

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
   * Optional explicit queue-daemon URL (OPENRIG_URL) for a REMOTE queue when the
   * connector host differs from the queue/alert host (item 10). Unlike `--host`
   * (which `queue list`/`show` reject), OPENRIG_URL targets ALL queue verbs.
   * Null = use the connector's ambient OPENRIG_URL / local daemon.
   */
  queueUrl: string | null;
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
};

export function configPathFor(home?: string): string {
  return path.join(home ?? getOpenRigHome(), "slack-connector.json");
}

export function loadConfig(home?: string): SlackConnectorConfig {
  const p = configPathFor(home);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SlackConnectorConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: SlackConnectorConfig, home?: string): string {
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
 */
export function staticReadiness(cfg: SlackConnectorConfig, hasWebhook: boolean, hasBotToken: boolean, hasAppToken: boolean): ReadinessItem[] {
  return [
    { ok: cfg.secretsEnvFile !== null || hasWebhook || hasBotToken, label: "secrets-source", detail: cfg.secretsEnvFile ? `env file ${cfg.secretsEnvFile}` : "env vars only" },
    { ok: hasWebhook, label: "outbound-webhook", detail: hasWebhook ? "resolved" : "unset (outbound alerts cannot post)" },
    { ok: hasBotToken, label: "bot-token", detail: hasBotToken ? "resolved" : "unset (scope/membership verify unavailable)" },
    { ok: hasAppToken, label: "app-token (Socket Mode)", detail: hasAppToken ? "resolved" : "unset (inbound cannot connect)" },
    { ok: cfg.channel !== null, label: "channel", detail: cfg.channel ?? "unset" },
    { ok: Boolean(cfg.inboundDestination), label: "inbound-destination", detail: cfg.inboundDestination },
    { ok: cfg.enabled, label: "enabled", detail: cfg.enabled ? "yes" : "no (run `rig slack enable`)" },
  ];
}
