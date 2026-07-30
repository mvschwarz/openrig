// `rig slack` — Slice-11 slack-connector-human-queue (OPR.0.4.7.11).
//
// Agent-assisted setup/config + the two trusted-host connector runners. The
// connector accesses the fleet ONLY through `rig queue` (transport-agnostic;
// connector-host may differ from the queue/alert host — item 10). Secrets load
// from a 0600 env file / OPENRIG_SLACK_* env at call time, never from config,
// never from the repo. WebUI setup is OUT of v1.
import { Command } from "commander";
import path from "node:path";
import { getOpenRigHome } from "../openrig-compat.js";
import {
  loadConfig,
  saveConfig,
  staticReadiness,
  type SlackConnectorConfig,
} from "../slack/config.js";
import { resolveSecret, checkEnvFilePermissions } from "../slack/secrets.js";
import { SeenStore, DeadLetterStore } from "../slack/state-store.js";
import { makeExecRunner, type QueueRunner } from "../slack/queue-bridge.js";
import { runOutboundOnce, seedBacklogOnEnable } from "../slack/outbound.js";
import { InboundRouter, handleEnvelope, type SlackEvent, type SocketEnvelope } from "../slack/inbound.js";
import { verifyScopes, verifyChannelMembership, openSocketConnection, type FetchImpl } from "../slack/slack-api.js";

const SECRET_WEBHOOK = "SLACK_WEBHOOK_URL";
const SECRET_BOT = "SLACK_BOT_TOKEN";
const SECRET_APP = "SLACK_APP_TOKEN";

export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: ((this: unknown, ev?: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => void) | null;
  onclose: ((this: unknown, ev?: unknown) => void) | null;
  onerror: ((this: unknown, ev?: unknown) => void) | null;
}

export interface SlackDeps {
  home?: string;
  fetchImpl?: FetchImpl;
  /** Build the rig-queue runner from config (injectable for tests). */
  makeRunner?: (cfg: SlackConnectorConfig) => QueueRunner;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Open a Socket Mode WebSocket (default: global WebSocket). Injectable for tests. */
  wsFactory?: (url: string) => WsLike;
  /** Test seam: run inbound N reconnect cycles then stop (default: forever). */
  inboundMaxConnects?: number;
  /** Dead-letter retry cadence WHILE the socket stays connected (default 5min). */
  retryIntervalMs?: number;
}

function stateDir(home: string): string {
  return path.join(home, "state");
}
function defaultRunner(cfg: SlackConnectorConfig): QueueRunner {
  // Remote queue targeting (item 10, connector-host != queue-host) via OPENRIG_URL
  // — supported by ALL queue verbs, unlike `--host` which `queue list`/`show`
  // reject. queueUrl (when set) overrides the ambient OPENRIG_URL for rig calls.
  const env = cfg.queueUrl ? { ...process.env, OPENRIG_URL: cfg.queueUrl } : process.env;
  return makeExecRunner({ rigBin: process.env.OPENRIG_RIG_BIN || "rig", baseArgs: [], env });
}

function resolveSecrets(cfg: SlackConnectorConfig): { webhook: string | null; bot: string | null; app: string | null } {
  const envFile = cfg.secretsEnvFile ?? undefined;
  return {
    webhook: resolveSecret(SECRET_WEBHOOK, { envFile }),
    bot: resolveSecret(SECRET_BOT, { envFile }),
    app: resolveSecret(SECRET_APP, { envFile }),
  };
}

export function slackCommand(deps: SlackDeps = {}): Command {
  const home = deps.home ?? getOpenRigHome();
  const log = deps.log ?? ((m: string) => console.log(m));
  const makeRunner = deps.makeRunner ?? defaultRunner;
  const now = deps.now ?? (() => new Date());

  const cmd = new Command("slack").description("Slice-11 — Slack human-queue connector (outbound alerts + inbound messages)");

  // ---- setup ----
  cmd
    .command("setup")
    .description("Configure the connector (first-class config; secrets stay in the env file, never here)")
    .option("--channel <id>", "Slack channel id the connector app must be a member of")
    .option("--inbound-destination <session>", "where inbound human messages land (default operator-agent@kernel)")
    .option("--alert-tag <tag>", "outbound: qitem tag that alerts a human (default founder-alert)")
    .option("--source-label <label>", "label shown in the posted message footer (where the queue lives)")
    .option("--secrets-env-file <path>", "path to the 0600 env file with SLACK_WEBHOOK_URL / SLACK_BOT_TOKEN / SLACK_APP_TOKEN")
    .option("--queue-url <url>", "OPENRIG_URL of a REMOTE queue daemon (connector-host != queue-host); targets all queue verbs")
    .option("--required-scopes <csv>", "comma-separated bot scopes to require at verify time")
    .action((opts) => {
      const cur = loadConfig(home);
      const next: SlackConnectorConfig = {
        ...cur,
        channel: opts.channel ?? cur.channel,
        inboundDestination: opts.inboundDestination ?? cur.inboundDestination,
        alertTag: opts.alertTag ?? cur.alertTag,
        sourceLabel: opts.sourceLabel ?? cur.sourceLabel,
        secretsEnvFile: opts.secretsEnvFile ?? cur.secretsEnvFile,
        queueUrl: opts.queueUrl ?? cur.queueUrl,
        requiredScopes: opts.requiredScopes ? String(opts.requiredScopes).split(",").map((s: string) => s.trim()).filter(Boolean) : cur.requiredScopes,
      };
      const p = saveConfig(next, home);
      log(`wrote ${p}`);
      log(`Next: put SLACK_WEBHOOK_URL / SLACK_BOT_TOKEN / SLACK_APP_TOKEN in ${next.secretsEnvFile ?? "<--secrets-env-file> (0600)"}, then \`rig slack verify\`, then \`rig slack enable\`.`);
    });

  // ---- status (honest unconfigured, no network) ----
  cmd
    .command("status")
    .description("Show the connector's configured + resolvable state (honest; no network)")
    .option("--json", "JSON output")
    .action((opts) => {
      const cfg = loadConfig(home);
      const s = resolveSecrets(cfg);
      const readiness = staticReadiness(cfg, s.webhook !== null, s.bot !== null, s.app !== null);
      const permWarn = cfg.secretsEnvFile ? checkEnvFilePermissions(cfg.secretsEnvFile) : null;
      if (opts.json) {
        log(JSON.stringify({ config: { ...cfg }, readiness, permWarning: permWarn }));
      } else {
        log(`slack-connector (config: ${cfg.enabled ? "enabled" : "disabled"})`);
        for (const r of readiness) log(`  ${r.ok ? "✓" : "✗"} ${r.label}: ${r.detail}`);
        if (permWarn) log(`  ⚠ ${permWarn}`);
      }
    });

  // ---- verify (live: GRANTED scopes from headers + channel membership) ----
  cmd
    .command("verify")
    .description("Live-verify GRANTED Slack scopes (from response headers) + channel membership (item 5)")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const cfg = loadConfig(home);
      const s = resolveSecrets(cfg);
      if (!s.bot) {
        log("✗ bot token unresolved — set SLACK_BOT_TOKEN (env or secrets env file). Cannot verify.");
        process.exitCode = 1;
        return;
      }
      const scope = await verifyScopes(s.bot, cfg.requiredScopes, deps.fetchImpl);
      let member: { ok: boolean; isMember: boolean; name?: string; error?: string } | null = null;
      if (cfg.channel) member = await verifyChannelMembership(s.bot, cfg.channel, deps.fetchImpl);
      const ready = scope.ok && (member ? member.isMember : false);
      if (opts.json) {
        log(JSON.stringify({ scope, member, ready }));
      } else {
        log(`granted scopes: ${scope.granted.join(", ") || "(none)"}`);
        if (!scope.ok) log(`✗ MISSING scopes (configured != granted — reinstall the app): ${scope.missing.join(", ")}${scope.error ? ` [${scope.error}]` : ""}`);
        else log("✓ all required scopes granted");
        if (member) log(member.isMember ? `✓ channel member (${member.name ?? cfg.channel})` : `✗ NOT a member of channel ${cfg.channel} — invite the app`);
        else log("… channel not configured — set --channel to verify membership");
        log(ready ? "READY for inbound" : "NOT ready");
      }
      if (!ready) process.exitCode = 1;
    });

  // ---- enable (seeds backlog as history, item 9) ----
  cmd
    .command("enable")
    .description("Enable the connector; seeds the current alert backlog as history (no replay storm)")
    .action(async () => {
      const cfg = loadConfig(home);
      const s = resolveSecrets(cfg);
      if (!s.webhook) {
        log("✗ refusing to enable: SLACK_WEBHOOK_URL unresolved (outbound could not post). Configure secrets first.");
        process.exitCode = 1;
        return;
      }
      const runner = makeRunner(cfg);
      const seen = new SeenStore(path.join(stateDir(home), "slack-outbound-seen.jsonl"), undefined, now);
      const res = await seedBacklogOnEnable({ runner, seen, filter: { alertTag: cfg.alertTag, destinations: cfg.outboundDestinations }, log });
      saveConfig({ ...cfg, enabled: true }, home);
      log(res.onlineStatus);
    });

  cmd
    .command("disable")
    .description("Disable the connector")
    .action(() => {
      saveConfig({ ...loadConfig(home), enabled: false }, home);
      log("slack connector disabled");
    });

  // ---- outbound (one-shot sweep; for cron/launchd) ----
  cmd
    .command("outbound")
    .description("One outbound sweep: post fresh human alerts to Slack (fail-visible)")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const cfg = loadConfig(home);
      if (!cfg.enabled) {
        log("slack connector disabled — `rig slack enable` first");
        process.exitCode = 1;
        return;
      }
      const s = resolveSecrets(cfg);
      if (!s.webhook) {
        log("✗ SLACK_WEBHOOK_URL unresolved — cannot post");
        process.exitCode = 1;
        return;
      }
      const runner = makeRunner(cfg);
      const seen = new SeenStore(path.join(stateDir(home), "slack-outbound-seen.jsonl"), undefined, now);
      const res = await runOutboundOnce({
        runner,
        seen,
        webhookUrl: s.webhook,
        fetchImpl: deps.fetchImpl,
        sourceLabel: cfg.sourceLabel,
        filter: { alertTag: cfg.alertTag, destinations: cfg.outboundDestinations },
        log,
      });
      if (opts.json) log(JSON.stringify(res));
      if (res.failed.length > 0) process.exitCode = 1; // fail-visible
    });

  // ---- inbound (persistent Socket Mode) ----
  cmd
    .command("inbound")
    .description("Run the inbound Socket Mode consumer (persistent; human messages → queue)")
    .action(async () => {
      const cfg = loadConfig(home);
      const s = resolveSecrets(cfg);
      if (!s.app) {
        log("✗ SLACK_APP_TOKEN unresolved — inbound cannot connect");
        process.exitCode = 1;
        return;
      }
      const runner = makeRunner(cfg);
      const seen = new SeenStore(path.join(stateDir(home), "slack-inbound-seen.jsonl"), undefined, now);
      const dead = new DeadLetterStore<SlackEvent>(path.join(stateDir(home), "slack-inbound-deadletter.jsonl"), undefined, now);
      const router = new InboundRouter({ runner, seen, deadLetter: dead, destination: cfg.inboundDestination, log });
      await runInboundLoop(s.app, router, deps, log);
    });

  return cmd;
}

/**
 * Socket Mode loop: open the ws, FAST-ACK every envelope, route human messages,
 * drain the dead-letter on connect + periodically, reconnect with backoff.
 * `deps.inboundMaxConnects` bounds it for tests; unset = forever.
 */
export async function runInboundLoop(appToken: string, router: InboundRouter, deps: SlackDeps, log: (m: string) => void): Promise<void> {
  const wsFactory = deps.wsFactory ?? ((url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => WsLike }).WebSocket(url));
  const retryIntervalMs = deps.retryIntervalMs ?? 5 * 60 * 1000;
  let connects = 0;
  let backoff = 1000;

  await new Promise<void>((resolve) => {
    const connect = async () => {
      connects++;
      const open = await openSocketConnection(appToken, deps.fetchImpl);
      if (!open.ok || !open.url) {
        log(`connect failed: ${open.error}`);
        if (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects) return resolve();
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
        return;
      }
      const ws = wsFactory(open.url);
      let retryTimer: ReturnType<typeof setInterval> | undefined;
      ws.onopen = () => {
        backoff = 1000;
        log("socket connected");
        void router.retryDeadLetters(); // drain on connect…
        // …AND periodically WHILE connected (B1: recovery after a queue outage
        // must not wait for the next Slack reconnect). Cleared on close.
        retryTimer = setInterval(() => void router.retryDeadLetters(), retryIntervalMs);
        if (typeof (retryTimer as unknown as { unref?: () => void }).unref === "function") {
          (retryTimer as unknown as { unref: () => void }).unref();
        }
      };
      ws.onmessage = (m) => {
        let env: SocketEnvelope;
        try {
          env = JSON.parse(String(m.data)) as SocketEnvelope;
        } catch {
          return;
        }
        void handleEnvelope(env, () => env.envelope_id && ws.send(JSON.stringify({ envelope_id: env.envelope_id })), router, log);
      };
      ws.onclose = () => {
        if (retryTimer) clearInterval(retryTimer);
        log(`socket closed; reconnect in ${backoff}ms`);
        if (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects) return resolve();
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };
    void connect();
  });
}
