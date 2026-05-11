// PL-005 Phase B: bearer-token middleware for /api/mission-control/*.
//
// Per slice IMPL § Write Set + audit hard-gates 8 + 9:
//   - Constant-time bearer comparison via Node `crypto.timingSafeEqual`.
//     No early-return on byte mismatch.
//   - 401 with three-part error body on missing or mismatched token
//     (what failed + why it matters + what to do).
//   - Daemon refuses to start with a non-loopback bind interface AND
//     empty bearer config — startup-side check (see startup.ts).
//
// MVP context (single-developer, single-user, single-host): one static
// bearer token sourced from a config field. NO OAuth / SSO / per-user
// routing / role-based permissions / token rotation. Token holder is
// fully privileged.
//
// Mounted on /api/mission-control/* write verbs at minimum (POST
// /action, POST /notifications/test). Reads (GET /views, /audit, etc.)
// MAY be gated under the same token at operator option (Phase B
// driver default: gate writes only; reads remain open behind tailnet
// bind for the headed-browser-from-phone case where the operator
// hasn't typed the token into mobile yet — the bearer is for write
// integrity, not view confidentiality).

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { MiddlewareHandler } from "hono";

/**
 * Constant-time string equality using Node's timingSafeEqual.
 * Returns false when lengths differ (timingSafeEqual throws on
 * length mismatch; we pad-compare to keep a constant-ish branch
 * profile while still returning the honest false).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  // Length check is unavoidable for timingSafeEqual to work, but the
  // compare is still constant-time within the equal-length case. For
  // unequal lengths we still run a fixed-size compare against a buffer
  // of zeros so an attacker cannot infer "wrong length vs wrong byte"
  // from response timing.
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Compare against a same-length zero buffer to keep the call site
    // cost similar across mismatch paths. Result is always false here.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Three-part error body shape per OpenRig honest-error-reporting
 * convention. Renders inside the route's c.json call.
 */
function unauthorizedBody(reason: string): {
  error: "unauthorized";
  message: string;
  what_failed: string;
  why_it_matters: string;
  what_to_do: string;
} {
  return {
    error: "unauthorized",
    message: `Mission Control auth failed: ${reason}`,
    what_failed: reason,
    why_it_matters:
      "Mission Control write verbs require a bearer token because the daemon may be bound on a non-loopback interface (tailnet) where unauthenticated mutation would be unsafe.",
    what_to_do:
      "Set the auth.bearerToken field in daemon config (or OPENRIG_AUTH_BEARER_TOKEN env), restart the daemon, and resend the request with `Authorization: Bearer <token>`.",
  };
}

export interface AuthBearerTokenOpts {
  /**
   * The expected bearer token. When this is null, the middleware
   * lets all requests through (the daemon-level startup check
   * elsewhere ensures this only happens when bound on loopback).
   */
  expectedToken: string | null;
}

/**
 * Hono middleware that enforces bearer-token auth on the routes it
 * is mounted on. Returns 401 with a three-part error body for missing
 * or mismatched tokens.
 *
 * When `expectedToken` is null, the middleware passes through. The
 * startup check in `startup.ts` ensures null is only valid when the
 * bind interface is loopback.
 */
export function authBearerTokenMiddleware(
  opts: AuthBearerTokenOpts,
): MiddlewareHandler {
  const { expectedToken } = opts;
  return async (c, next) => {
    if (expectedToken === null) {
      // Loopback-only mode (no bearer configured). Pass through.
      await next();
      return;
    }
    const header = c.req.header("Authorization") ?? c.req.header("authorization");
    if (!header) {
      return c.json(unauthorizedBody("missing Authorization header"), 401);
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return c.json(
        unauthorizedBody("Authorization header must be 'Bearer <token>'"),
        401,
      );
    }
    const provided = match[1]!.trim();
    if (!constantTimeEqual(provided, expectedToken)) {
      return c.json(unauthorizedBody("bearer token does not match"), 401);
    }
    await next();
  };
}

/**
 * Detect whether a host bind value is loopback-only (safe to skip
 * bearer requirement) vs non-loopback (tailnet / public; requires
 * bearer). Loopback set: `127.x.x.x`, `::1`, `localhost`. Anything
 * else (including `0.0.0.0`, `::`, named hostnames, tailnet IPs) is
 * treated as non-loopback.
 */
export function isLoopbackBind(host: string | undefined | null): boolean {
  if (!host || host.length === 0) {
    // Default Hono / @hono/node-server bind is 0.0.0.0 — treat as
    // non-loopback for safety (force operator to either bind explicitly
    // to 127.0.0.1 or set the bearer token).
    return false;
  }
  const trimmed = host.trim().toLowerCase();
  if (trimmed === "localhost" || trimmed === "::1" || trimmed === "[::1]") return true;
  if (trimmed.startsWith("127.")) return true;
  return false;
}

/**
 * Detect tailscale CGNAT IPv4 (100.64.0.0/10) and ULA IPv6 prefix
 * (fd7a:115c:a1e0::/48). Returns true for tailnet-literal IP addresses
 * only; hostname callers must first resolve via {@link resolveToIpOrNull}.
 *
 * Rationale: tailscale's WireGuard mesh + ACLs ARE the auth boundary, so
 * a tailnet-bound daemon does not need an additional bearer token. The
 * CGNAT IPv4 range and ULA IPv6 prefix are reserved by tailscale and
 * documented; collisions on real-world networks are essentially zero.
 *
 * Boundary semantics for HG-3: CGNAT is 100.64.0.0/10 → first octet
 * exactly 100, second octet 64..127 inclusive. 100.63.x.x and
 * 100.128.x.x are NOT tailnet.
 */
export function isTailscaleBind(host: string | undefined | null): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  const ipv4Match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (ipv4Match) {
    const first = parseInt(ipv4Match[1]!, 10);
    const second = parseInt(ipv4Match[2]!, 10);
    if (first === 100 && second >= 64 && second <= 127) return true;
    return false;
  }
  const cleaned = trimmed.replace(/^\[|\]$/g, "");
  if (cleaned.startsWith("fd7a:115c:a1e0:")) return true;
  return false;
}

/**
 * Pure helper for {@link detectTailscaleInterface}: takes a NetworkInterfaces
 * dictionary (the shape returned by os.networkInterfaces()) and returns the
 * first non-internal address that matches the tailnet IP ranges, or null.
 * Factored out so tests can supply synthetic interface fixtures without
 * mocking node:os.
 */
export function findTailscaleIpInInterfaces(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string | null {
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      if (isTailscaleBind(addr.address)) return addr.address;
    }
  }
  return null;
}

/**
 * Probe the host's network interfaces and return the first tailscale-IP
 * address found (CGNAT IPv4 or tailnet ULA IPv6), or null when no tailnet
 * interface is currently active. Used at daemon startup to decide whether
 * to multi-bind (loopback + tailnet) or loopback-only. Detection is
 * IP-based, not interface-name-based, so it survives platform differences
 * in how tailscale names its tun device.
 */
export function detectTailscaleInterface(): string | null {
  return findTailscaleIpInInterfaces(networkInterfaces());
}

/**
 * Resolve a hostname to its first IP via node:dns/promises lookup.
 * Returns null on resolution failure (DNS error, timeout, no such host).
 * Wrapped with a 5s race-timeout per Risk 9.2 in the slice IMPL-PRD so an
 * unresponsive resolver does not stall daemon startup indefinitely.
 */
export async function resolveToIpOrNull(host: string): Promise<string | null> {
  try {
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 5000).unref();
    });
    const lookup = dns
      .lookup(host, { all: false })
      .then((r) => r.address)
      .catch(() => null);
    return await Promise.race([lookup, timeout]);
  } catch {
    return null;
  }
}

export class AuthBearerTokenStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthBearerTokenStartupError";
  }
}

/**
 * Startup-side check (HARD-GATE audit row 8). Throws an explicit
 * AuthBearerTokenStartupError when the bind interface is genuinely
 * public/LAN AND the bearer token is empty. Loopback or tailscale-IP
 * binds short-circuit (the tailnet is the auth boundary). Hostname
 * binds resolve via DNS first; if resolution yields a loopback or
 * tailnet IP, the same short-circuit applies. Public/LAN binds without
 * a bearer throw and the daemon refuses to start.
 */
export async function assertBindAuthInvariant(opts: {
  host: string;
  bearerToken: string | null;
}): Promise<void> {
  if (isLoopbackBind(opts.host)) return;
  if (isTailscaleBind(opts.host)) return;

  let resolvedIp: string | null = null;
  // Hostname (non-IP literal) — resolve and re-check.
  if (!/^[\d.]+$/.test(opts.host) && !opts.host.includes(":")) {
    resolvedIp = await resolveToIpOrNull(opts.host);
    if (resolvedIp) {
      if (isLoopbackBind(resolvedIp)) return;
      if (isTailscaleBind(resolvedIp)) return;
    }
  }

  if (opts.bearerToken && opts.bearerToken.length > 0) return;
  throw new AuthBearerTokenStartupError(
    `daemon refusing to start: bind host '${opts.host}'${resolvedIp ? ` (resolves to ${resolvedIp})` : ""} is not loopback or tailscale, ` +
      `and auth.bearerToken (env OPENRIG_AUTH_BEARER_TOKEN) is empty. ` +
      `Either: (a) bind to 127.0.0.1 / localhost, (b) bind to a tailscale interface (100.64.0.0/10 IPv4 or fd7a:115c:a1e0::/48 IPv6), ` +
      `or (c) set OPENRIG_AUTH_BEARER_TOKEN to a non-empty value before starting the daemon.`,
  );
}
