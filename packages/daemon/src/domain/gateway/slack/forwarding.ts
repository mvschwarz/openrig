// One shared Slack app across machines. Slack hands each event to one Socket Mode connection, so
// one daemon (the hub, the machine holding the app-level token) holds the connection. For a channel
// another machine owns (`forwardChannels` in slack-connector.json), the hub relays the event or
// click untouched to that machine's daemon, which runs it through its own inbound router: its own
// human registry, thread map, decisions and dedupe. Each machine posts its own replies with the
// app's bot token (the Web API is per request). Nothing here reads or writes another machine's
// queue.
import { loadHostRegistry, resolveHost, type HostRegistryLoadResult } from "../../hosts/hosts-registry-reader.js";
import { remoteJsonRequest } from "../../hosts/remote-daemon-http.js";
import type { SocketEnvelope } from "./inbound.js";

export interface ForwardChannel {
  /** A Slack channel ID another machine owns. */
  channel: string;
  /** That machine's id in the hub's host registry (`rig host list`); it needs an http entry. */
  host: string;
}

/** The receiving route on every daemon (routes/gateway.ts). */
export const FORWARD_PATH = "/api/gateway/slack/forwarded";
const FORWARD_TIMEOUT_MS = 10_000;

/** What is wrong with a `forwardChannels` block, in plain words; empty when it is usable. An
 *  invalid block never fails the connector: forwarding stays off and `rig slack status` says why. */
export function forwardChannelProblems(cfg: { forwardChannels?: unknown; channel?: string | null }): string[] {
  const list = cfg.forwardChannels as Array<Partial<ForwardChannel> | null> | undefined;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ["forwardChannels must be a list of { channel, host }"];
  const problems: string[] = [];
  const seen = new Set<string>();
  list.forEach((f, i) => {
    const at = `forwardChannels[${i}]`;
    if (!f || typeof f !== "object") { problems.push(`${at} must be an object { channel, host }`); return; }
    if (typeof f.channel !== "string" || !f.channel.trim() || /\s/.test(f.channel)) problems.push(`${at}.channel must be a Slack channel ID`);
    else if (f.channel === cfg.channel) problems.push(`${at}.channel ${f.channel} is this machine's own channel`);
    else if (seen.has(f.channel)) problems.push(`${at}.channel ${f.channel} is listed twice`);
    else seen.add(f.channel);
    if (typeof f.host !== "string" || !f.host.trim()) problems.push(`${at}.host must name a host from \`rig host list\``);
  });
  return problems;
}

/** The Slack channel an envelope belongs to: a message's or a reaction's channel, or a click's. */
export function envelopeChannel(env: SocketEnvelope): string | undefined {
  if (env.type === "events_api") {
    const ev = env.payload?.event;
    return ev?.channel ?? ev?.item?.channel;
  }
  if (env.type === "interactive") return env.payload?.channel?.id ?? env.payload?.container?.channel_id;
  return undefined;
}

export type EnvelopeForwarder = (host: string, env: SocketEnvelope) => Promise<{ ok: true } | { ok: false; error: string }>;

/** Relay one envelope to `host`'s daemon over its http registry entry. Every failure is kept for
 *  retry by the caller: a person's message is never dropped because a machine was unreachable or
 *  its registry entry was wrong at the time. */
export function makeEnvelopeForwarder(opts: { loadRegistry?: () => HostRegistryLoadResult; fetchImpl?: typeof fetch } = {}): EnvelopeForwarder {
  return async (hostId, env) => {
    const reg = (opts.loadRegistry ?? loadHostRegistry)();
    if (!reg.ok) return { ok: false, error: `host registry unavailable: ${reg.error}` };
    const resolved = resolveHost(reg.registry, hostId);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (resolved.host.transport !== "http") return { ok: false, error: `host '${hostId}' has no http registry entry (rig host pair)` };
    const res = await remoteJsonRequest(resolved.host, FORWARD_PATH, {
      method: "POST",
      body: { envelope: env },
      timeoutMs: FORWARD_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `${res.kind}${res.status ? ` ${res.status}` : ""}${res.detail ? `: ${res.detail}` : ""}` };
  };
}
