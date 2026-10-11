import { closeSync, fstatSync, openSync, readSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig, configPathFor, DEFAULT_CONFIG, type SlackConnectorConfig } from "./slack/config.js";
import { resolveSecret } from "./slack/secrets.js";
import { loadHumanRegistry } from "./human-registry.js";
import { channelStateDigest, type ChannelOperation } from "./channel-operations.js";
import type { SettingsStore } from "../user-settings/settings-store.js";

/** Shared passive read context. Raw values and the redactor stay inside the domain. */
export function readConnectionConfiguration(home: string) {
  let cfg: SlackConnectorConfig | null = null;
  const configPath = configPathFor(home);
  let configState = "unavailable";
  let sourceState: "available" | "missing" | "malformed" | "unavailable" = "unavailable";
  let fields: string[] = [];
  try {
    let bytes: string | null = null;
    try { bytes = readFileSync(configPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    sourceState = bytes === null ? "missing" : "malformed";
    if (bytes !== null) {
      const raw = JSON.parse(bytes);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid config");
      fields = Object.keys(DEFAULT_CONFIG).filter((key) => Object.hasOwn(raw, key));
    }
    cfg = loadConfig(home);
    if (typeof cfg.enabled !== "boolean" || (cfg.channel !== null && typeof cfg.channel !== "string")
      || typeof cfg.inboundDestination !== "string" || !Array.isArray(cfg.outboundDestinations)
      || !cfg.outboundDestinations.every((x) => typeof x === "string")
      || typeof cfg.sourceLabel !== "string" || !Array.isArray(cfg.requiredScopes)
      || !cfg.requiredScopes.every((x) => typeof x === "string")
      || (cfg.secretsEnvFile !== null && typeof cfg.secretsEnvFile !== "string")) throw new Error("invalid config");
    configState = bytes === null ? "default" : "file";
    sourceState = bytes === null ? "missing" : "available";
  } catch { cfg = null; }
  let bot: string | null = null;
  let app: string | null = null;
  let secretsAvailable = true;
  try {
    bot = resolveSecret("SLACK_BOT_TOKEN", { envFile: cfg?.secretsEnvFile ?? undefined });
    app = resolveSecret("SLACK_APP_TOKEN", { envFile: cfg?.secretsEnvFile ?? undefined });
  } catch { secretsAvailable = false; }
  const text = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    let result = v;
    for (const value of [bot, app]) if (value) result = result.split(value).join("[redacted]");
    return result.replace(/[\x00-\x1f\x7f]/g, " ");
  };
  return { cfg, configPath, configState, sourceState, fields, bot, app, secretsAvailable, text };
}

/** Passive evidence only. No provider client, queue writer, or service activation. */
export function connectionsProjection(home: string, gateway: Record<string, unknown> | null, settings?: SettingsStore,
  read = readConnectionConfiguration(home)) {
  const { cfg, configPath, configState, sourceState, bot, app, secretsAvailable, text } = read;
  const connector = gateway?.connector as Record<string, unknown> | undefined;
  const inbound = connector?.inbound as Record<string, unknown> | undefined;
  const configuration = cfg ? {
    enabled: cfg.enabled, channel: text(cfg.channel), inboundDestination: text(cfg.inboundDestination),
    outboundDestinations: cfg.outboundDestinations.map(text),
    // #192: the channel map, read-only.
    channelMap: (cfg.channelMap ?? []).map((e) => ({ match: text(e.match), channel: text(e.channel) })),
    postLevel: cfg.minimumLevelThatPosts, interruptLevel: cfg.minimumLevelThatInterrupts,
    botToken: secretsAvailable ? (bot ? "resolved" : "missing") : "unavailable",
    appToken: secretsAvailable ? (app ? "resolved" : "missing") : "unavailable",
  } : null;
  const digest = cfg ? channelStateDigest(cfg) : null;
  const applied = !digest || typeof connector?.configurationDigest !== "string" ? "unverified"
    : connector.configurationDigest === digest ? "matching" : "changed";
  const verification = latestVerification(home, digest);
  verification.actor = text(verification.actor);
  // Authored intent describes delivery only after the running wire confirms application.
  const state = !cfg || !secretsAvailable || !gateway ? "unavailable"
    : gateway.state === "failed" ? "failed" : gateway.state !== "active" ? "unavailable"
    : applied === "changed" ? "unapplied" : applied === "unverified" ? "unverified"
    : !cfg.enabled ? "disabled" : !bot || !cfg.channel ? "incomplete"
    : connector?.outboundReady !== true ? "unverified"
    : verification.state === "failed" ? "failed" : verification.state === "indeterminate" ? "indeterminate"
    : "unverified"; // Even a successful dated check is not current external reachability.
  // OPR.0.6.0.5: no Slack app yet (neither token resolves) → create one from the shipped manifest first.
  const noSlackApp = !!cfg && secretsAvailable && !bot && !app;
  const nextAction = state !== "unavailable" && state !== "failed" && noSlackApp ? "rig slack manifest --url"
    : state === "disabled" ? "rig slack enable" : state === "incomplete" || !cfg ? "rig slack setup --help"
    : state === "unavailable" || state === "unapplied" || applied === "unverified" || gateway?.state === "failed" ? "rig daemon logs"
    : "rig slack verify --json";
  let registry: ReturnType<typeof loadHumanRegistry>;
  try { registry = loadHumanRegistry(home, { readOnly: true }); } catch { registry = { ok: false, error: "registry unavailable" }; }
  const instance = ["host.name", "workspace.root", "workspace.operator_seat_name"] as const;
  const browserKey = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  return {
    observedAt: new Date().toISOString(), home: text(home), pid: process.pid,
    settingsSource: text(settings?.configPath),
    settings: instance.map((key) => {
      try {
        const r = settings?.resolveOne(key);
        return { key, value: text(r?.value), source: r?.source ?? "unavailable" };
      } catch { return { key, value: null, source: "unavailable" }; }
    }),
    configSource: { state: configState, path: text(configPath), sourceState }, configuration,
    running: { state: text(gateway?.state) ?? "unavailable", activatedAt: text(gateway?.activatedAt),
      outboundReady: typeof connector?.outboundReady === "boolean" ? connector.outboundReady : null,
      inboundReady: typeof connector?.inboundReady === "boolean" ? connector.inboundReady : null,
      inboundState: text(inbound?.state) ?? "unverified",
      // Delivery health beside the socket state: an open socket is not proof that events arrive.
      inboundDelivery: text(inbound?.delivery), inboundEventsMissingSince: text(inbound?.eventsMissingSince), applied },
    state, nextAction, verification,
    registry: { state: registry.ok ? "available" : "unavailable", path: text(join(home, "gateway", "humans")) },
    humans: registry.ok ? registry.entities.map((h) => ({
      browserKey: browserKey(h.entityId),
      entityId: text(h.entityId) ?? "[withheld]", address: text(h.address) ?? "[withheld]", displayName: text(h.displayName), class: h.class, away: h.prefs.away ?? null,
      deliveryClass: h.prefs.deliveryClass, availability: h.prefs.availability ?? (h.prefs.away ? "away" : "available"),
      excluded: cfg ? cfg.outboundDestinations.length > 0 && !cfg.outboundDestinations.includes(h.address) : null,
      bindings: h.connectorBindings.map((b) => ({ browserKey: browserKey(JSON.stringify([b.kind, b.connectorRef, b.role, b.handle ?? null])),
        kind: b.kind, ref: text(b.connectorRef), role: b.role, handle: text(b.handle), credentialReference: Boolean(b.secretsRef) })),
    })) : [],
  };
}

/** Bounded tail of the EXISTING audit log; no second cache or freshness policy. */
function latestVerification(home: string, digest: string | null) {
  const empty = { state: "unverified", at: null as string | null, actor: null as string | null };
  const file = join(home, "state", "human-channel-operations.jsonl");
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 64 * 1024);
    const bytes = Buffer.alloc(size - start);
    readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString("utf8").split("\n");
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as ChannelOperation;
      if (r.action !== "verify" || r.subject !== "slack") continue;
      if (!digest || r.before?.digest !== digest) return { ...empty, state: "changed" };
      if (typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))) return { ...empty, state: "indeterminate" };
      return { state: r.effect !== "observed" ? "indeterminate" : r.after?.ready === true ? "ready-at-check"
        : r.after?.ready === false ? "failed" : "indeterminate", at: r.at,
        // Actor is an identity; reason/connector responses are deliberately omitted.
        actor: typeof r.actor === "string" ? r.actor.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120) : null };
    }
    return empty;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? empty : { ...empty, state: "indeterminate" }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
