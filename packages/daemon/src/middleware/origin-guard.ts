import type { MiddlewareHandler } from "hono";

export interface OriginGuardOptions {
  allowedOrigins?: string[];
}

/**
 * Origin Guard Middleware for REST API routes (/api/*).
 * Protects local daemon endpoints from Cross-Site Request Forgery (CSRF) and
 * unauthorized cross-origin requests from malicious web pages loaded in the operator's browser.
 *
 * Enforcement logic:
 * 1. If no Origin header is present (terminal CLI, curl, local background jobs), allow.
 * 2. If an Origin header is present:
 *    - Must parse as a valid URL.
 *    - Hostname matches local loopback ("localhost", "127.0.0.1", "::1", "[::1]"), OR
 *    - Hostname matches the request's Host header (same-origin), OR
 *    - Origin or hostname matches an entry in options.allowedOrigins or OPENRIG_ALLOWED_ORIGINS.
 * 3. Otherwise, reject with HTTP 403 Forbidden.
 */
export function apiOriginProtection(options?: OriginGuardOptions): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (!origin) {
      await next();
      return;
    }

    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return c.json(
        {
          error: "origin_rejected",
          hint: "Malformed Origin header",
        },
        403,
      );
    }

    const originHost = originUrl.hostname.toLowerCase();
    const rawHostHeader = c.req.header("Host");
    // Strip port if present
    const requestHost = rawHostHeader ? rawHostHeader.split(":")[0]?.toLowerCase() : "";

    const configuredAllowed = [
      ...(options?.allowedOrigins ?? []),
      ...(process.env.OPENRIG_ALLOWED_ORIGINS
        ? process.env.OPENRIG_ALLOWED_ORIGINS.split(",").map((s) => s.trim().toLowerCase())
        : []),
    ];

    const isLocal =
      originHost === "localhost" ||
      originHost === "127.0.0.1" ||
      originHost === "::1" ||
      originHost === "[::1]";

    const isSameHost = Boolean(requestHost && originHost === requestHost);

    const isExplicitlyAllowed = configuredAllowed.some((allowed) => {
      if (!allowed) return false;
      try {
        if (allowed.startsWith("http://") || allowed.startsWith("https://")) {
          const u = new URL(allowed);
          return u.origin.toLowerCase() === origin.toLowerCase();
        }
        return allowed.toLowerCase() === originHost;
      } catch {
        return false;
      }
    });

    if (isLocal || isSameHost || isExplicitlyAllowed) {
      await next();
      return;
    }

    return c.json(
      {
        error: "origin_rejected",
        hint: `Origin ${origin} is not allowed to access OpenRig daemon API`,
      },
      403,
    );
  };
}
