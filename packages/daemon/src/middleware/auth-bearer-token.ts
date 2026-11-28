// Bearer-token middleware for routes that explicitly mount it. The caller
// selects the operator or terminal token; this is not global authentication.
// A configured check returns 401 for a missing or mismatched bearer. A null
// token passes that check through; other route-specific checks still apply.
// Explicit binds outside loopback/tailnet require an operator token at startup,
// but that configuration check does not add middleware to other routes.

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
function unauthorizedBody(reason: string, diagnosticContext?: "terminal"): {
  error: "unauthorized";
  message: string;
  what_failed: string;
  why_it_matters: string;
  what_to_do: string;
} {
  return {
    error: "unauthorized",
    message: `${diagnosticContext === "terminal" ? "Terminal" : "Operator bearer"} auth failed: ${reason}`,
    what_failed: reason,
    why_it_matters: diagnosticContext === "terminal"
      ? "Terminal and transport requests require the configured terminal bearer token to protect terminal access and input."
      : "This route requires the daemon's configured operator bearer token.",
    what_to_do: diagnosticContext === "terminal"
      ? "Use the daemon's terminal bearer token with `Authorization: Bearer <token>`: OPENRIG_TERMINAL_BEARER_TOKEN, or OPENRIG_AUTH_BEARER_TOKEN when terminal auth falls back to it."
      : "Send the daemon's configured OPENRIG_AUTH_BEARER_TOKEN with `Authorization: Bearer <token>`. This token applies only to routes that check it.",
  };
}

export interface AuthBearerTokenOpts {
  /**
   * The expected bearer token. When this is null, this bearer check
   * passes requests through. Other route-specific checks still apply.
   */
  expectedToken: string | null;
  /** Diagnostic wording only; never selects or compares a token. */
  diagnosticContext?: "terminal";
}

/**
 * Hono middleware that enforces bearer-token auth on the routes it
 * is mounted on. Returns 401 with a three-part error body for missing
 * or mismatched tokens.
 *
 * When `expectedToken` is null, the middleware passes through. The
 * explicit-bind startup check requires an operator token outside loopback
 * and tailnet; it does not configure every route's bearer check.
 */
export function authBearerTokenMiddleware(
  opts: AuthBearerTokenOpts,
): MiddlewareHandler {
  const { expectedToken, diagnosticContext } = opts;
  return async (c, next) => {
    if (expectedToken === null) {
      // No token configured for this check. Pass through.
      await next();
      return;
    }
    const header = c.req.header("Authorization") ?? c.req.header("authorization");
    if (!header) {
      return c.json(unauthorizedBody("missing Authorization header", diagnosticContext), 401);
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return c.json(
        unauthorizedBody("Authorization header must be 'Bearer <token>'", diagnosticContext),
        401,
      );
    }
    const provided = match[1]!.trim();
    if (!constantTimeEqual(provided, expectedToken)) {
      return c.json(unauthorizedBody("bearer token does not match", diagnosticContext), 401);
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
 * Configuration check for an explicit bind outside loopback and tailnet:
 * require a non-empty operator bearer token. Hostnames are resolved and
 * checked the same way. This is not global request authentication: only
 * routes with an explicit bearer check require the selected token.
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
      `and OPENRIG_AUTH_BEARER_TOKEN is empty. ` +
      `Either: (a) bind to 127.0.0.1 / localhost, (b) bind to a tailscale interface (100.64.0.0/10 IPv4 or fd7a:115c:a1e0::/48 IPv6), ` +
      `or (c) set OPENRIG_AUTH_BEARER_TOKEN to a non-empty value before starting the daemon. ` +
      `This token applies only to routes with an explicit bearer check; it is not global authentication.`,
  );
}
