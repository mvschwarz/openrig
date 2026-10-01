import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import { hostname as osHostname } from "node:os";
import type { Context, MiddlewareHandler } from "hono";
import { constantTimeEqual, detectTailscaleInterface } from "./auth-bearer-token.js";

/**
 * Browser boundary for /api/* (0.6.4). Runs once per request, before the remote
 * read-through and every route, WebSocket upgrades included:
 *
 * 1. Target name (Host). Accepted: `localhost`, IP literals, this machine's own
 *    names (OS hostname, and its exact Tailscale MagicDNS name found by a reverse
 *    lookup of its own tailnet IP at Tailscale's resolver) and OPENRIG_ALLOWED_HOSTS.
 *    A valid configured bearer token in Authorization waives only this check.
 * 2. Browser origin (Origin), when present. Accepted: the daemon's own UI origin
 *    while `ui.enabled` is on, or an entry in OPENRIG_ALLOWED_ORIGINS. Nothing
 *    waives this check.
 *
 * Requests without Origin (CLI, TUI, MCP, daemon-to-daemon) meet only rule 1.
 * This is not complete browser isolation: a cross-site GET/HEAD that carries no
 * Origin and is addressed to an accepted name still reaches its handler.
 */

export interface BrowserBoundaryOptions {
  webUiEnabled: boolean;
  /** Configured bearer tokens; a matching Authorization header waives only the target-name check. */
  bearerTokens: Array<string | null | undefined>;
  /** OPENRIG_ALLOWED_ORIGINS: browser origins only. */
  allowedOrigins?: string;
  /** OPENRIG_ALLOWED_HOSTS: target names only. */
  allowedHosts?: string;
  /** Returns this machine's own extra names (Tailscale MagicDNS). Absent: no discovery. */
  discoverSelfNames?: () => Promise<string[]>;
  discoveryTimeoutMs?: number;
  /** Minimum gap between lookups triggered by unrecognized names. */
  rediscoverAfterMs?: number;
  hostName?: () => string;
  warn?: (line: string) => void;
  now?: () => number;
  /** Test hook: one call per guarded request. */
  onDecision?: (decision: { outcome: "allow" | "refuse"; code?: BoundaryCode }) => void;
}

export type BoundaryCode = "untrusted_host" | "browser_origin_refused";

export type ParsedHost =
  | { kind: "absent" }
  | { kind: "malformed" }
  | { kind: "ok"; hostname: string; port: string };

export type ParsedOrigin =
  | { kind: "opaque" }
  | { kind: "malformed" }
  | { kind: "ok"; scheme: string; hostname: string; port: string };

const HOST_HEADER = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/;
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TAILSCALE_RESOLVER = "100.100.100.100";
const MAX_LOGGED_REFUSALS = 20;

/** Lowercase, drop IPv6 brackets and one trailing dot. */
export function normalizeName(name: string): string {
  let out = name.trim().toLowerCase();
  if (out.startsWith("[") && out.endsWith("]")) out = out.slice(1, -1);
  if (out.endsWith(".")) out = out.slice(0, -1);
  return out;
}

export function parseHostHeader(value: string | undefined): ParsedHost {
  if (value === undefined) return { kind: "absent" };
  const match = HOST_HEADER.exec(value);
  if (!match) return { kind: "malformed" };
  const rawName = match[1]!;
  if (rawName.startsWith("[") && isIP(rawName.slice(1, -1)) !== 6) return { kind: "malformed" };
  const port = match[2] ?? "80";
  if (Number(port) < 1 || Number(port) > 65535) return { kind: "malformed" };
  const hostname = normalizeName(rawName);
  if (!hostname) return { kind: "malformed" };
  return { kind: "ok", hostname, port: String(Number(port)) };
}

export function parseOrigin(value: string): ParsedOrigin {
  if (value === "null") return { kind: "opaque" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "malformed" };
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return { kind: "malformed" };
  }
  // An origin is scheme://host[:port]; anything after the authority is not one.
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/?$/i.test(value)) return { kind: "malformed" };
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const port = url.port || (scheme === "https" ? "443" : scheme === "http" ? "80" : "");
  return { kind: "ok", scheme, hostname: normalizeName(url.hostname), port };
}

function isLoopbackOrIp(hostname: string): boolean {
  return hostname === "localhost" || isIP(hostname) !== 0;
}

/** The OS hostname, its first label, and `<label>.local`. */
export function osOwnNames(hostName: () => string = osHostname): string[] {
  const full = normalizeName(hostName() || "");
  if (!full) return [];
  const label = full.split(".")[0]!;
  return [...new Set([full, label, `${label}.local`])];
}

function namesWithShortForm(names: string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const name = normalizeName(raw);
    if (!DNS_NAME.test(name)) continue;
    out.add(name);
    out.add(name.split(".")[0]!);
  }
  return [...out];
}

/**
 * This machine's exact Tailscale MagicDNS name: a reverse lookup of its own tailnet IP
 * (found from local interfaces), asked of Tailscale's resolver only. One query, bounded
 * by `timeoutMs`; no subprocess, no peer list. Returns [] when no tailnet IP is active.
 */
export async function discoverTailscaleSelfNames(opts: {
  timeoutMs: number;
  tailscaleIp?: () => string | null;
  reverse?: (ip: string, timeoutMs: number) => Promise<string[]>;
}): Promise<string[]> {
  const ip = (opts.tailscaleIp ?? detectTailscaleInterface)();
  if (!ip) return [];
  const reverse = opts.reverse ?? (async (address: string, timeoutMs: number) => {
    const resolver = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 });
    resolver.setServers([TAILSCALE_RESOLVER]);
    return resolver.reverse(address);
  });
  return namesWithShortForm(await reverse(ip, opts.timeoutMs));
}

function parseAllowedHosts(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of (raw ?? "").split(",")) {
    const name = normalizeName(item);
    if (name && (DNS_NAME.test(name) || isIP(name) !== 0)) out.add(name);
  }
  return out;
}

/** OPENRIG_ALLOWED_ORIGINS: a full `http(s)://…` entry matches that exact origin;
 *  any other `scheme://…` entry matches the identical string; a bare hostname matches
 *  that hostname on any scheme and port. */
function parseAllowedOrigins(raw: string | undefined): { origins: Set<string>; hostnames: Set<string>; exact: Set<string> } {
  const origins = new Set<string>();
  const hostnames = new Set<string>();
  const exact = new Set<string>();
  for (const item of (raw ?? "").split(",")) {
    const entry = item.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("http://") || entry.startsWith("https://")) {
      const parsed = parseOrigin(entry.replace(/\/$/, ""));
      if (parsed.kind === "ok") origins.add(`${parsed.scheme}://${parsed.hostname}:${parsed.port}`);
    } else if (entry.includes("://")) {
      exact.add(entry);
    } else {
      hostnames.add(normalizeName(entry));
    }
  }
  return { origins, hostnames, exact };
}

function shown(value: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "?");
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

export function browserBoundary(options: BrowserBoundaryOptions): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const timeoutMs = options.discoveryTimeoutMs ?? 1500;
  const rediscoverAfterMs = options.rediscoverAfterMs ?? 10_000;
  const tokens = options.bearerTokens.filter((t): t is string => typeof t === "string" && t.length > 0);
  const allowedHosts = parseAllowedHosts(options.allowedHosts);
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins);
  const ownNames = new Set(osOwnNames(options.hostName));

  let discovered = new Set<string>();
  let lastDiscoveryAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  const discover = (): Promise<void> => {
    const source = options.discoverSelfNames;
    if (!source) return Promise.resolve();
    if (inflight) return inflight;
    inflight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const names = await Promise.race([
          source(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs + 250); }),
        ]);
        // A completed lookup replaces the set; a failed one keeps the previous names.
        discovered = new Set(namesWithShortForm(names));
      } catch {
        // Unavailable, malformed or slow discovery never blocks loopback/IP use.
      } finally {
        if (timer) clearTimeout(timer);
        lastDiscoveryAt = now();
        inflight = null;
      }
    })();
    return inflight;
  };
  if (options.discoverSelfNames) void discover();

  const knownTarget = (hostname: string): boolean =>
    isLoopbackOrIp(hostname) || ownNames.has(hostname) || discovered.has(hostname) || allowedHosts.has(hostname);

  const acceptedTarget = async (hostname: string): Promise<boolean> => {
    if (knownTarget(hostname)) return true;
    if (options.discoverSelfNames && (inflight || now() - lastDiscoveryAt >= rediscoverAfterMs)) {
      await discover();
      return knownTarget(hostname);
    }
    return false;
  };

  const explicitlyAllowedOrigin = (raw: string, origin: ParsedOrigin): boolean => {
    if (allowedOrigins.exact.has(raw.trim().toLowerCase())) return true;
    if (origin.kind !== "ok") return false;
    if (allowedOrigins.hostnames.has(origin.hostname)) return true;
    return allowedOrigins.origins.has(`${origin.scheme}://${origin.hostname}:${origin.port}`);
  };

  const logged = new Set<string>();
  let suppressionLogged = false;
  const logRefusal = (c: Context, code: BoundaryCode, value: string): void => {
    const key = `${code}|${value}`;
    if (logged.has(key)) return;
    if (logged.size >= MAX_LOGGED_REFUSALS) {
      if (!suppressionLogged) {
        suppressionLogged = true;
        warn("[openrig] browser boundary: further distinct refusals are not logged");
      }
      return;
    }
    logged.add(key);
    warn(`[openrig] browser boundary refused ${code}: ${value} (${c.req.method} ${c.req.path})`);
  };

  const refuse = (c: Context, code: BoundaryCode, value: string, error: string) => {
    logRefusal(c, code, value);
    options.onDecision?.({ outcome: "refuse", code });
    return c.json({ error, code }, 403);
  };

  return async (c, next) => {
    const hostHeader = c.req.header("Host");
    const host = parseHostHeader(hostHeader);
    let hostAccepted = false;
    if (host.kind === "malformed") {
      const value = shown(hostHeader ?? "");
      return refuse(c, "untrusted_host", value,
        `This OpenRig daemon refused a request with an unusable Host header ("${value}"). Address the daemon by localhost, an IP address or this machine's own name.`);
    }
    if (host.kind === "ok") {
      hostAccepted = await acceptedTarget(host.hostname);
      if (!hostAccepted) {
        const presented = bearerFrom(c.req.header("Authorization"));
        const tokenValid = presented !== null && tokens.some((token) => constantTimeEqual(presented, token));
        if (!tokenValid) {
          const value = shown(host.hostname);
          return refuse(c, "untrusted_host", value,
            `This OpenRig daemon does not accept requests addressed to "${value}". Use localhost, an IP address or this machine's own name, or add this name to OPENRIG_ALLOWED_HOSTS in the daemon's environment and restart the daemon.`);
        }
      }
    }

    const originHeader = c.req.header("Origin");
    if (originHeader !== undefined) {
      const origin = parseOrigin(originHeader);
      const ownUi = options.webUiEnabled && origin.kind === "ok" && origin.scheme === "http"
        && host.kind === "ok" && hostAccepted
        && origin.hostname === host.hostname && origin.port === host.port;
      if (!ownUi && !explicitlyAllowedOrigin(originHeader, origin)) {
        const value = shown(originHeader);
        return refuse(c, "browser_origin_refused", value,
          `This OpenRig daemon refuses browser requests from origin "${value}". Open the OpenRig UI from the daemon's own address with the web UI enabled (rig config set ui.enabled true, then restart the daemon), or add this exact origin to OPENRIG_ALLOWED_ORIGINS in the daemon's environment and restart. Web pages on other origins cannot read this response.`);
      }
    }

    options.onDecision?.({ outcome: "allow" });
    await next();
  };
}
