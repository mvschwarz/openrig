// `rig slack` — Slack connector configuration + subsystem admin.
//
// S10 (OPR.0.5.5.10) CUTOVER: the slice-11 relay runners (`rig slack outbound` sweep +
// `rig slack inbound` Socket Mode loop) are RETIRED — the gateway runs as an in-daemon
// subsystem (amended M1 §3) that owns Slack delivery and inbound directly. The retired verbs
// refuse with teaching (never silently do nothing); the config surfaces (setup/status/verify)
// stay, backed by the daemon-homed modules via the narrow @openrig/daemon/gateway-slack
// surface (dep rail: lazy import at invocation). enable/disable are daemon admin calls now —
// the daemon owns the queue and the durable seen-state, and the enable-time backlog-seeding
// rule (slice-11 item 9) executes daemon-side before the wire goes live.
//
// Secrets posture unchanged: 0600 env file / SLACK_* env at call time, never in config,
// never in the repo.
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import type {
  loadConfig as LoadConfigFn,
  saveConfig as SaveConfigFn,
  staticReadiness as StaticReadinessFn,
  resolveSecret as ResolveSecretFn,
  checkEnvFilePermissions as CheckEnvFn,
  verifyScopes as VerifyScopesFn,
  verifyChannelMembership as VerifyMembershipFn,
  SlackConnectorConfig,
  FetchImpl,
} from "@openrig/daemon/gateway-slack";

// S10: the incoming-webhook secret retired with the relay — outbound posts via the Web API
// (bot token) on the in-daemon subsystem.
const SECRET_BOT = "SLACK_BOT_TOKEN";
const SECRET_APP = "SLACK_APP_TOKEN";

interface SlackSurface {
  loadConfig: typeof LoadConfigFn;
  saveConfig: typeof SaveConfigFn;
  staticReadiness: typeof StaticReadinessFn;
  resolveSecret: typeof ResolveSecretFn;
  checkEnvFilePermissions: typeof CheckEnvFn;
  verifyScopes: typeof VerifyScopesFn;
  verifyChannelMembership: typeof VerifyMembershipFn;
}

export interface SlackDeps {
  home?: string;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
  /** Injectable daemon-surface loader (tests). Default: lazy import of the narrow subpath. */
  surface?: () => Promise<SlackSurface>;
  clientFactory?: () => Pick<DaemonClient, "post">;
}

const RETIRED_TEACHING =
  "retired (S10 cutover): the gateway runs IN-DAEMON now — the subsystem polls the queue, posts to Slack, " +
  "and consumes Socket Mode inbound itself; there is no relay runner to invoke. " +
  "Check `rig slack status` for configuration, `curl /api/health-summary/gateway` for subsystem health, " +
  "and `rig slack enable` to activate delivery.";

function resolveSecrets(surface: SlackSurface, cfg: SlackConnectorConfig): { bot: string | null; app: string | null } {
  const envFile = cfg.secretsEnvFile ?? undefined;
  return {
    bot: surface.resolveSecret(SECRET_BOT, { envFile }),
    app: surface.resolveSecret(SECRET_APP, { envFile }),
  };
}

export function slackCommand(deps: SlackDeps = {}): Command {
  const log = deps.log ?? ((m: string) => console.log(m));
  const loadSurface = deps.surface ?? (async () => (await import("@openrig/daemon/gateway-slack")) as SlackSurface);
  const clientFactory = deps.clientFactory ?? (() => new DaemonClient());

  const cmd = new Command("slack").description("Slack connector: configuration + in-daemon subsystem admin (S10)");

  // ---- setup ----
  cmd
    .command("setup")
    .description("Configure the connector (first-class config; secrets stay in the env file, never here)")
    .option("--channel <id>", "Slack channel id the connector app must be a member of")
    .option("--inbound-destination <session>", "where inbound human messages land (default operator-agent@kernel)")
    .option("--alert-tag <tag>", "outbound: qitem tag that alerts a human (default founder-alert)")
    .option("--minimum-level-that-posts <level>", "minimum OWNER level posted to Slack: RECORD|NOTICE|ALERT")
    .option("--minimum-level-that-interrupts <level>", "minimum OWNER level that mentions/interrupts: RECORD|NOTICE|ALERT")
    .option("--source-label <label>", "label shown in the posted message footer (where the queue lives)")
    .option("--secrets-env-file <path>", "path to the 0600 env file with SLACK_BOT_TOKEN / SLACK_APP_TOKEN")
    .option("--required-scopes <csv>", "comma-separated bot scopes to require at verify time")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cur = surface.loadConfig(deps.home);
      const next: SlackConnectorConfig = {
        ...cur,
        channel: opts.channel ?? cur.channel,
        inboundDestination: opts.inboundDestination ?? cur.inboundDestination,
        alertTag: opts.alertTag ?? cur.alertTag,
        minimumLevelThatPosts: opts.minimumLevelThatPosts ?? cur.minimumLevelThatPosts,
        minimumLevelThatInterrupts: opts.minimumLevelThatInterrupts ?? cur.minimumLevelThatInterrupts,
        sourceLabel: opts.sourceLabel ?? cur.sourceLabel,
        secretsEnvFile: opts.secretsEnvFile ?? cur.secretsEnvFile,
        requiredScopes: opts.requiredScopes ? String(opts.requiredScopes).split(",").map((s: string) => s.trim()).filter(Boolean) : cur.requiredScopes,
      };
      const p = surface.saveConfig(next, deps.home);
      log(`wrote ${p}`);
      log(`Next: put SLACK_BOT_TOKEN / SLACK_APP_TOKEN in ${next.secretsEnvFile ?? "<--secrets-env-file> (0600)"}, then \`rig slack verify\`, then \`rig slack enable\`.`);
    });

  // ---- status (honest unconfigured, no network) ----
  cmd
    .command("status")
    .description("Show the connector's configured + resolvable state (honest; no network)")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cfg = surface.loadConfig(deps.home);
      const s = resolveSecrets(surface, cfg);
      const readiness = surface.staticReadiness(cfg, s.bot !== null, s.app !== null);
      const permWarn = cfg.secretsEnvFile ? surface.checkEnvFilePermissions(cfg.secretsEnvFile) : null;
      if (opts.json) {
        log(JSON.stringify({ config: { ...cfg }, readiness, permWarning: permWarn }));
      } else {
        log(`slack-connector (config: ${cfg.enabled ? "enabled" : "disabled"}; delivery runs IN-DAEMON — S10 subsystem)`);
        for (const r of readiness) log(`  ${r.ok ? "✓" : "✗"} ${r.label}: ${r.detail}`);
        if (permWarn) log(`  ⚠ ${permWarn}`);
      }
    });

  // ---- verify (live: GRANTED scopes from headers + channel membership) ----
  cmd
    .command("verify")
    .description("Live-verify GRANTED Slack scopes (from response headers) + channel membership")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cfg = surface.loadConfig(deps.home);
      const s = resolveSecrets(surface, cfg);
      if (!s.bot) {
        log("✗ bot token unresolved — set SLACK_BOT_TOKEN (env or secrets env file). Cannot verify.");
        process.exitCode = 1;
        return;
      }
      const scope = await surface.verifyScopes(s.bot, cfg.requiredScopes, deps.fetchImpl);
      let member: { ok: boolean; isMember: boolean; name?: string; error?: string } | null = null;
      if (cfg.channel) member = await surface.verifyChannelMembership(s.bot, cfg.channel, deps.fetchImpl);
      const ready = scope.ok && (member ? member.isMember : false);
      if (opts.json) {
        log(JSON.stringify({ scope, member, ready }));
      } else {
        log(`granted scopes: ${scope.granted.join(", ") || "(none)"}`);
        if (!scope.ok) log(`✗ MISSING scopes (configured != granted — reinstall the app): ${scope.missing.join(", ")}${scope.error ? ` [${scope.error}]` : ""}`);
        else log("✓ all required scopes granted");
        if (member) log(member.isMember ? `✓ channel member (${member.name ?? cfg.channel})` : `✗ NOT a member of channel ${cfg.channel} — invite the app`);
        else log("… channel not configured — set --channel to verify membership");
        log(ready ? "READY" : "NOT ready");
      }
      if (!ready) process.exitCode = 1;
    });

  // ---- enable / disable (daemon admin: seeding + subsystem restart happen daemon-side) ----
  cmd
    .command("enable")
    .description("Enable the connector (daemon seeds the current backlog as history — no replay storm — then rewires)")
    .action(async () => {
      try {
        const res = await clientFactory().post<{ ok: boolean; seeded: number; onlineStatus: string }>("/api/gateway/slack/enable", {});
        log(res.data.onlineStatus);
      } catch (e) {
        log(`✗ enable failed: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  cmd
    .command("disable")
    .description("Disable the connector (the daemon rewires to an inert delivery path)")
    .action(async () => {
      try {
        await clientFactory().post<{ ok: boolean }>("/api/gateway/slack/disable", {});
        log("slack connector disabled");
      } catch (e) {
        log(`✗ disable failed: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  // ---- RETIRED relay runners (S10 cutover): refuse with teaching, never silently no-op ----
  cmd
    .command("outbound")
    .description("[RETIRED — S10] the in-daemon subsystem owns outbound delivery")
    .option("--json", "(ignored)")
    .action(() => {
      log(RETIRED_TEACHING);
      process.exitCode = 1;
    });

  cmd
    .command("inbound")
    .description("[RETIRED — S10] the in-daemon subsystem owns Socket Mode inbound")
    .action(() => {
      log(RETIRED_TEACHING);
      process.exitCode = 1;
    });

  return cmd;
}
