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
import { resolveSenderSession, SENDER_FALLBACK } from "../sender-identity.js";
import type {
  loadConfig as LoadConfigFn,
  saveConfig as SaveConfigFn,
  staticReadiness as StaticReadinessFn,
  resolveSecret as ResolveSecretFn,
  checkEnvFilePermissions as CheckEnvFn,
  verifyScopes as VerifyScopesFn,
  verifyChannelMembership as VerifyMembershipFn,
  buildSlackAppManifest as BuildManifestFn,
  mappedChannels as MappedChannelsFn,
  validateChannelMap as ValidateChannelMapFn,
  setChannelMapEntry as SetChannelMapEntryFn,
  removeChannelMapEntry as RemoveChannelMapEntryFn,
  FEATURE_SCOPES as FeatureScopes,
  BASELINE_REQUIRED_SCOPES as BaselineScopes,
  SlackConnectorConfig,
  FetchImpl,
} from "@openrig/daemon/gateway-slack";

// S10: the incoming-webhook secret retired with the relay — outbound posts via the Web API
// (bot token) on the in-daemon subsystem.
const SECRET_BOT = "SLACK_BOT_TOKEN";
const SECRET_APP = "SLACK_APP_TOKEN";

/** The socket's delivery health, as the daemon reports it beside the socket state. */
export interface InboundDeliveryStatus {
  delivery?: string; eventsMissingSince?: string; lastServerPingAt?: string; unechoedPosts?: number;
  numConnections?: number; otherConnections?: number; otherConnectionsMayBeOurs?: boolean;
  lastAutoReconnect?: { at?: string; reason?: string }; autoReconnectSuppressedUntil?: string;
}

/** Lines that keep "connected" from being the only word about inbound delivery. */
export function socketDeliveryLines(inbound: InboundDeliveryStatus | undefined): string[] {
  const lines: string[] = [];
  if (!inbound) return lines;
  if (inbound.delivery) {
    const unechoed = inbound.unechoedPosts ?? 0;
    const delivery = inbound.delivery === "events-missing" ? `events missing since ${inbound.eventsMissingSince ?? "unknown"} (${unechoed} of our posts not echoed)`
      : inbound.delivery === "no-server-pings" ? `no server pings since ${inbound.lastServerPingAt ?? "unknown"}`
      : inbound.delivery === "socket-mode-disabled" ? "Socket Mode is disabled in the Slack app settings; not reconnecting"
      : inbound.delivery === "delivering" ? (unechoed > 0
        ? `delivering, but ${unechoed} later post(s) of ours have not come back yet`
        : "delivering (our last post came back as an event)")
      : "not yet confirmed (no post of ours has come back since this connection opened)";
    lines.push(`Delivery: ${delivery}${inbound.lastServerPingAt ? `; last server ping ${inbound.lastServerPingAt}` : ""}`);
  }
  if (inbound.lastAutoReconnect?.at) lines.push(`Last automatic reconnect: ${inbound.lastAutoReconnect.at} (${inbound.lastAutoReconnect.reason ?? "unknown"})`);
  if (inbound.autoReconnectSuppressedUntil) {
    lines.push(`Automatic reconnect held back until ${inbound.autoReconnectSuppressedUntil} (at most one every 5 minutes).`);
  }
  if ((inbound.otherConnections ?? 0) > 0) {
    lines.push(inbound.otherConnectionsMayBeOurs
      ? `Slack reports ${inbound.numConnections ?? "several"} open connections for this app, ${inbound.otherConnections} more than we have open: possibly one we closed moments before Slack counted (Slack may not have dropped it yet), or another consumer taking events.`
      : `Slack reports ${inbound.numConnections ?? "several"} open connections for this app, ${inbound.otherConnections} not ours: another consumer may be taking events.`);
  }
  return lines;
}

function slackTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,12}\.\d{1,6}$/.test(value)) return "unknown";
  return new Date(Number(value) * 1000).toISOString();
}

interface SlackSurface {
  loadConfig: typeof LoadConfigFn;
  saveConfig: typeof SaveConfigFn;
  staticReadiness: typeof StaticReadinessFn;
  resolveSecret: typeof ResolveSecretFn;
  checkEnvFilePermissions: typeof CheckEnvFn;
  verifyScopes: typeof VerifyScopesFn;
  verifyChannelMembership: typeof VerifyMembershipFn;
  buildSlackAppManifest: typeof BuildManifestFn;
  mappedChannels: typeof MappedChannelsFn;
  validateChannelMap: typeof ValidateChannelMapFn;
  setChannelMapEntry: typeof SetChannelMapEntryFn;
  removeChannelMapEntry: typeof RemoveChannelMapEntryFn;
  FEATURE_SCOPES: typeof FeatureScopes;
  BASELINE_REQUIRED_SCOPES: typeof BaselineScopes;
}

export interface SlackDeps {
  home?: string;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
  /** Injectable daemon-surface loader (tests). Default: lazy import of the narrow subpath. */
  surface?: () => Promise<SlackSurface>;
  clientFactory?: () => Pick<DaemonClient, "post"> & Partial<Pick<DaemonClient, "get">>;
}

const RETIRED_TEACHING =
  "retired (S10 cutover): the gateway runs IN-DAEMON now — the subsystem polls the queue, posts to Slack, " +
  "and consumes Socket Mode inbound itself; there is no relay runner to invoke. " +
  "Check `rig slack status` for configuration, `curl /api/health-summary/gateway` for subsystem health, " +
  "and `rig slack enable` to activate delivery.";

const MANIFEST_FIRST_STEP =
  "`rig slack manifest --url` prints a link that creates your own Slack app from OpenRig's manifest (see `rig slack manifest --help`)";

// #192: a saved config change reaches the running connector when it next rewires.
const CHANNEL_MAP_APPLY =
  "Invite the app to every mapped channel, then `rig slack verify`. A running connector picks up the change " +
  "when it next rewires (`rig slack disable` then `rig slack enable`, or a daemon restart).";

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
    .option("--minimum-level-that-posts <level>", "minimum OWNER level posted to Slack: RECORD|NOTICE|ALERT")
    .option("--minimum-level-that-interrupts <level>", "minimum OWNER level that mentions/interrupts: RECORD|NOTICE|ALERT")
    .option("--source-label <label>", "label shown in the posted message footer (where the queue lives)")
    .option("--secrets-env-file <path>", "path to the 0600 env file with SLACK_BOT_TOKEN / SLACK_APP_TOKEN")
    .option("--required-scopes <csv>", "comma-separated bot scopes to require at verify time")
    .option("--reason <reason>", "Reason recorded with the configuration change", "configure human delivery")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cur = surface.loadConfig(deps.home);
      const next: SlackConnectorConfig = {
        ...cur,
        channel: opts.channel ?? cur.channel,
        inboundDestination: opts.inboundDestination ?? cur.inboundDestination,
        minimumLevelThatPosts: opts.minimumLevelThatPosts ?? cur.minimumLevelThatPosts,
        minimumLevelThatInterrupts: opts.minimumLevelThatInterrupts ?? cur.minimumLevelThatInterrupts,
        sourceLabel: opts.sourceLabel ?? cur.sourceLabel,
        secretsEnvFile: opts.secretsEnvFile ?? cur.secretsEnvFile,
        requiredScopes: opts.requiredScopes ? String(opts.requiredScopes).split(",").map((s: string) => s.trim()).filter(Boolean) : cur.requiredScopes,
      };
      const { runChannelOperation, channelStateDigest } = await import("@openrig/daemon/gateway-slack");
      const result = await runChannelOperation({
        actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK, provenance: "claimed:v1",
        reason: opts.reason, action: "configure", subject: "slack", before: { digest: channelStateDigest(cur) },
        run: async () => ({ value: surface.saveConfig(next, deps.home), after: { digest: channelStateDigest(next) },
          effect: channelStateDigest(cur) === channelStateDigest(next) ? "no-op" : "applied" }),
      }, deps.home);
      log(`wrote ${result.value}; receipt ${result.receipt.id} (${result.receipt.effect})`);
      log(`Next: if you have no Slack app yet, start with ${MANIFEST_FIRST_STEP}. Then put SLACK_BOT_TOKEN / SLACK_APP_TOKEN in ${next.secretsEnvFile ?? "<--secrets-env-file> (0600)"}, then \`rig slack verify\`, then \`rig slack enable\`.`);
    });

  // ---- status (local configuration + bounded daemon snapshot; no Slack calls) ----
  cmd
    .command("status")
    .description("Show local configuration and bounded daemon socket/recovery observations (no Slack calls)")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cfg = surface.loadConfig(deps.home);
      const s = resolveSecrets(surface, cfg);
      const readiness = surface.staticReadiness(cfg, s.bot !== null, s.app !== null);
      const permWarn = cfg.secretsEnvFile ? surface.checkEnvFilePermissions(cfg.secretsEnvFile) : null;
      // A channel-map warning (#192) is not missing setup: it must not send the operator to the manifest.
      const unconfigured = readiness.some((r) => !r.ok && r.label !== "channel-map");
      const next = unconfigured ? `First step: ${MANIFEST_FIRST_STEP}.` : null;
      let observation: Record<string, unknown> = { state: "unknown", reason: "daemon-unavailable" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Default client's identity lookup and request each have a <=900ms bound.
        // The outer deadline also bounds injected/old clients; this read starts no work.
        const client = deps.clientFactory?.() ?? new DaemonClient(undefined, { timeoutMs: 900 });
        const response = await Promise.race([
          client.get?.<Record<string, unknown>>("/api/gateway/slack/status", { timeoutMs: 900 }),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 2000); }),
        ]);
        if (response?.status === 200 && response.data && typeof response.data.state === "string") {
          observation = response.data;
        }
      } catch { /* Local config remains useful when daemon observation is unavailable. */ }
      finally { if (timer) clearTimeout(timer); }
      if (opts.json) {
        log(JSON.stringify({ config: { ...cfg }, readiness, permWarning: permWarn, next, observation }));
      } else {
        log(`slack-connector configuration checks (config: ${cfg.enabled ? "enabled" : "disabled"}; delivery runs IN-DAEMON — S10 subsystem)`);
        for (const r of readiness) log(`  ${r.ok ? "✓" : "✗"} ${r.label}: ${r.detail}`);
        log(`Daemon: ${observation.state}${observation.reason ? ` (${observation.reason})` : ""}`);
        const connector = observation.connector as { configurationDigest?: string;
          deadLetterBacklog?: number | null; deadLetterBacklogState?: string; deadLetterBacklogReason?: string;
          inbound?: InboundDeliveryStatus & { state?: string; generation?: number; lastEventAt?: string };
          recovery?: { state?: string; reason?: string; lastScanAt?: string; acceptedThisProcess?: number; deadLetteredThisProcess?: number;
            coverage?: { coverageStart: string; coveredThrough: string; pending?: { upper: string; nextLatest: string }; nextRetryAt?: number } | null;
            limits?: string[] } } | undefined;
        if (connector) {
          log(`  Socket: ${connector.inbound?.state ?? "unknown"}; generation ${connector.inbound?.generation ?? "unknown"}; last event ${connector.inbound?.lastEventAt ?? "unknown"}`);
          for (const line of socketDeliveryLines(connector.inbound)) log(`  ${line}`);
          const recovery = connector.recovery;
          log(`  Recovery: ${recovery?.state ?? "unknown"}${recovery?.reason ? ` (${recovery.reason})` : ""}; last scan ${recovery?.lastScanAt ?? "unknown"}`);
          const coverage = recovery?.coverage;
          if (coverage) {
            log(`  Available history scanned: [${slackTime(coverage.coverageStart)}, ${slackTime(coverage.coveredThrough)}); older history unknown`);
            if (coverage.pending) log(`  Pending interval to ${slackTime(coverage.pending.upper)}; next page before ${slackTime(coverage.pending.nextLatest)}`);
            if (coverage.nextRetryAt) log(`  Retry after: ${new Date(coverage.nextRetryAt).toISOString()}`);
          }
          log(`  Recovery counts since connector start: accepted ${recovery?.acceptedThisProcess ?? "unknown"}; dead-lettered ${recovery?.deadLetteredThisProcess ?? "unknown"} (custody, not delivery)`);
          if (connector.deadLetterBacklogState !== undefined) {
            const scope = "inbound messages, reactions and click answers";
            if (connector.deadLetterBacklogState === "unknown") {
              // The daemon publishes null rather than a number when a dead-letter file could
              // not be read, so the line must not read as an empty backlog.
              log(`  Inbound dead-letter backlog: unknown (could not read the ${scope} dead-letter records: ${connector.deadLetterBacklogReason ?? "unreadable"})`);
            } else {
              log(`  Inbound dead-letter backlog: ${connector.deadLetterBacklog ?? 0} retained record(s) awaiting retry (${scope}; durable, kept across restarts)`);
            }
          }
          if (connector.configurationDigest) log(`  Observed configuration digest: ${connector.configurationDigest} (local configuration above)`);
          for (const limit of recovery?.limits ?? []) log(`  Limit: ${limit}`);
        }
        log("Connected/configured alone is not proof of delivery. Recovery covers available top-level channel history only.");
        if (permWarn) log(`  ⚠ ${permWarn}`);
        if (next) log(`  ${next}`);
      }
    });

  // ---- manifest (offline: no daemon, no tokens, no network) ----
  cmd
    .command("manifest")
    .description("Print the Slack app manifest for creating your own OpenRig Slack app (offline)")
    .option("--url", "print Slack's create-app link with the manifest prefilled (URL-encoded)")
    .option("--json", "JSON output: the manifest plus its bot scopes and bot events")
    .addHelpText("after", [
      "",
      "Creates nothing: open the --url link yourself in a browser signed in to your Slack workspace.",
      "The app is private to that workspace (Socket Mode; OpenRig hosts nothing and publishes nothing).",
      "--json lists every requested scope and why. `rig slack verify` checks only the baseline scopes,",
      "so a READY there does not prove attachments or mentions have their grants.",
      "Steps after creating the app: docs/reference/slack-app-setup.md",
      "(installed: $OPENRIG_HOME/reference/slack-app-setup.md).",
    ].join("\n"))
    .action(async (opts) => {
      const surface = await loadSurface();
      const bundle = surface.buildSlackAppManifest();
      if (opts.json) {
        const reasons: Record<string, string> = {};
        for (const scope of surface.BASELINE_REQUIRED_SCOPES) reasons[scope] = "baseline: checked by `rig slack verify`";
        for (const f of surface.FEATURE_SCOPES) reasons[f.scope] = `feature, not checked by verify: ${f.usedBy}`;
        log(JSON.stringify({
          manifest: bundle.manifest, url: bundle.url, scopes: bundle.scopes, events: bundle.events,
          why: Object.fromEntries(bundle.scopes.map((scope) => [scope, reasons[scope] ?? "unexplained"])),
        }));
      }
      else if (opts.url) log(bundle.url);
      else log(bundle.yaml.trimEnd());
    });

  // ---- verify (live: GRANTED scopes from headers + channel membership) ----
  cmd
    .command("verify")
    .description("Live-verify GRANTED Slack scopes (from response headers) + channel membership")
    .option("--json", "JSON output")
    .option("--reason <reason>", "Reason recorded with the verification", "verify human delivery")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cfg = surface.loadConfig(deps.home);
      const s = resolveSecrets(surface, cfg);
      const { runChannelOperation, channelStateDigest } = await import("@openrig/daemon/gateway-slack");
      const verification = await runChannelOperation({
        actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK, provenance: "claimed:v1",
        reason: opts.reason, action: "verify", subject: "slack", before: { digest: channelStateDigest(cfg) },
        run: async () => {
          const scope = s.bot ? await surface.verifyScopes(s.bot, cfg.requiredScopes, deps.fetchImpl) : null;
          // #192: membership in every channel the connector uses — the default and each mapped one.
          const channels = [];
          for (const c of s.bot ? surface.mappedChannels(cfg) : []) {
            channels.push({ ...c, member: await surface.verifyChannelMembership(s.bot!, c.channel, deps.fetchImpl) });
          }
          const member = channels.find((c) => c.isDefault)?.member ?? null;
          const ready = scope === null || scope.error || channels.some((c) => c.member.error) ? null
            : scope.ok && member !== null && channels.every((c) => c.member.isMember);
          return { value: { scope, member, channels }, after: { ready }, effect: "observed" };
        },
      }, deps.home);
      if (!s.bot) {
        log("✗ bot token unresolved — set SLACK_BOT_TOKEN (env or secrets env file). Cannot verify.");
        process.exitCode = 1;
        return;
      }
      const scope = verification.value.scope!;
      const member = verification.value.member;
      const channels = verification.value.channels;
      const ready = scope.ok && member !== null && channels.every((c) => c.member.isMember);
      // Failed scope requests or an absent/empty grant header cannot prove
      // which optional features are available. Baseline readiness is unchanged.
      const missingFeatures = scope.error || scope.granted.length === 0 ? null
        : surface.FEATURE_SCOPES.filter((feature) => !scope.granted.includes(feature.scope));
      if (opts.json) {
        log(JSON.stringify({ scope, member, ...(cfg.channelMap?.length ? { channels } : {}), ready, missingFeatures, receipt: verification.receipt }));
      } else {
        log(`granted scopes: ${scope.granted.join(", ") || "(none)"}`);
        if (!scope.ok) log(`✗ MISSING scopes (configured != granted — reinstall the app): ${scope.missing.join(", ")}${scope.error ? ` [${scope.error}]` : ""}`);
        else log("✓ all required scopes granted");
        if (member) log(member.isMember ? `✓ channel member (${member.name ?? cfg.channel})` : `✗ NOT a member of channel ${cfg.channel} — invite the app`);
        else log("… channel not configured — set --channel to verify membership");
        for (const c of channels.filter((x) => !x.isDefault)) {
          const forWhom = `for ${c.matches.join(", ")}`;
          log(c.member.isMember ? `✓ channel member (${c.member.name ?? c.channel}) ${forWhom}` : `✗ NOT a member of channel ${c.channel} ${forWhom} — invite the app`);
        }
        for (const feature of missingFeatures ?? []) {
          log(`⚠ ${feature.scope} missing: ${feature.usedBy}. Reinstall the app with this scope to use the feature.`);
        }
        log(ready ? "READY" : "NOT ready");
      }
      if (!ready) process.exitCode = 1;
    });

  // ---- channel-map (#192: per-rig / per-seat channels; local configuration, no Slack calls) ----
  const channelMap = cmd
    .command("channel-map")
    .description("Post a rig's or seat's human-bound items to its own channel (list | set | remove)")
    .addHelpText("after", [
      "",
      "A match is a rig name (my-rig) or a seat (lead@my-rig). The most specific match wins (seat, then",
      "rig); anything unmapped, and aggregate digests, use the default channel (`rig slack setup --channel`).",
      "Replies in a thread reach that thread's seat in every channel; other messages the human starts go to",
      "the inbound destination (`rig slack setup --inbound-destination`), whichever channel they are in.",
    ].join("\n"));

  // A config the connector cannot load (a hand-edited, invalid map) must fail loudly here too; on a
  // thrown error the shared CLI path stays silent in a human run.
  const loadForChannelMap = (surface: SlackSurface): SlackConnectorConfig | null => {
    try {
      return surface.loadConfig(deps.home);
    } catch (e) {
      log(`✗ ${(e as Error).message}`);
      process.exitCode = 1;
      return null;
    }
  };

  // One rule for every map write: the LOADED map must hold only fields this version knows, checked
  // before set/remove transform it. Otherwise a same-entry edit would rebuild that entry from known
  // fields and silently drop a newer version's field. Refused writes record no channel operation.
  const refuseUnsupported = (surface: SlackSurface, cur: SlackConnectorConfig): boolean => {
    try {
      surface.validateChannelMap(cur);
      return false;
    } catch (e) {
      log(`✗ channel map not changed: ${(e as Error).message}`);
      process.exitCode = 1;
      return true;
    }
  };

  // One write path for set/remove: the same load → merge → save inside a recorded channel operation as setup.
  const writeChannelMap = async (cur: SlackConnectorConfig, map: SlackConnectorConfig["channelMap"], opts: { reason: string; actor?: string }) => {
    const surface = await loadSurface();
    const { channelMap: _previous, ...rest } = cur;
    // An emptied map is removed, so the file returns to the shape it had before any entry.
    const next: SlackConnectorConfig = map && map.length ? { ...rest, channelMap: map } : rest;
    const { runChannelOperation, channelStateDigest } = await import("@openrig/daemon/gateway-slack");
    const result = await runChannelOperation({
      actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK, provenance: "claimed:v1",
      reason: opts.reason, action: "configure", subject: "slack", before: { digest: channelStateDigest(cur) },
      run: async () => ({ value: surface.saveConfig(next, deps.home), after: { digest: channelStateDigest(next) },
        effect: channelStateDigest(cur) === channelStateDigest(next) ? "no-op" : "applied" }),
    }, deps.home);
    log(`wrote ${result.value}; receipt ${result.receipt.id} (${result.receipt.effect})`);
  };

  channelMap
    .command("list")
    .description("Show the default channel and every mapped rig or seat with its channel")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const surface = await loadSurface();
      const cfg = loadForChannelMap(surface);
      if (!cfg) return;
      const entries = cfg.channelMap ?? [];
      if (opts.json) {
        log(JSON.stringify({ default: cfg.channel, entries }));
        return;
      }
      log(`default -> ${cfg.channel ?? "(unset: rig slack setup --channel)"}`);
      if (entries.length === 0) log("no channel map entries: every item uses the default channel");
      for (const e of entries) log(`${e.match} -> ${e.channel}`);
    });

  channelMap
    .command("set <match> <channel>")
    .description("Map a rig (my-rig) or seat (lead@my-rig) to a Slack channel id; replaces an existing entry")
    .option("--reason <reason>", "Reason recorded with the configuration change", "configure the slack channel map")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(async (match: string, channel: string, opts) => {
      const surface = await loadSurface();
      const cur = loadForChannelMap(surface);
      if (!cur) return;
      if (refuseUnsupported(surface, cur)) return;
      try {
        await writeChannelMap(cur, surface.setChannelMapEntry(cur.channelMap, { match, channel }), opts);
      } catch (e) {
        log(`✗ channel map not changed: ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }
      log(`Next: ${CHANNEL_MAP_APPLY}`);
    });

  channelMap
    .command("remove <match>")
    .description("Remove a rig's or seat's entry; it falls back to its rig's entry or the default channel")
    .option("--reason <reason>", "Reason recorded with the configuration change", "configure the slack channel map")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(async (match: string, opts) => {
      const surface = await loadSurface();
      const cur = loadForChannelMap(surface);
      if (!cur) return;
      if (refuseUnsupported(surface, cur)) return;
      const { map, removed } = surface.removeChannelMapEntry(cur.channelMap, match);
      if (!removed) {
        log(`✗ no channel map entry for '${match}' (rig slack channel-map list shows the entries)`);
        process.exitCode = 1;
        return;
      }
      try {
        await writeChannelMap(cur, map, opts);
      } catch (e) {
        log(`✗ channel map not changed: ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }
      log(`Next: ${CHANNEL_MAP_APPLY}`);
    });

  // ---- enable / disable (daemon admin: seeding + subsystem restart happen daemon-side) ----
  cmd
    .command("enable")
    .description("Enable the connector (daemon seeds the current backlog as history — no replay storm — then rewires)")
    .option("--reason <reason>", "Reason recorded with the change", "enable human delivery")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(async (opts) => {
      try {
        const res = await clientFactory().post<{ ok: boolean; seeded: number; onlineStatus: string }>("/api/gateway/slack/enable", { reason: opts.reason, actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK });
        if (res.status !== 200 || res.data.ok !== true) throw new Error(`daemon refused enable (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
        log(res.data.onlineStatus);
      } catch (e) {
        log(`✗ enable failed: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  cmd
    .command("disable")
    .description("Disable the connector (the daemon rewires to an inert delivery path)")
    .requiredOption("--reason <reason>", "Why human delivery is being shut down (recorded in the lifecycle receipt)")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(async (opts) => {
      try {
        const res = await clientFactory().post<{ ok: boolean }>("/api/gateway/slack/disable", { reason: opts.reason, actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK });
        if (res.status !== 200 || res.data.ok !== true) throw new Error(`daemon refused disable (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
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
