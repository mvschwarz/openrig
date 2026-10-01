export interface OutboundUrlValidationResult {
  valid: boolean;
  reason?: string;
  parsedUrl?: URL;
}

/**
 * Validates notification target URLs (webhook and ntfy endpoints).
 *
 * Refuses:
 * - Non-HTTP/HTTPS protocols (e.g. file:, ftp:, gopher:, data:, javascript:)
 * - Malformed URLs or URLs without a hostname
 *
 * URLs with embedded credentials (e.g. https://user:pass@host) are permitted;
 * adapters strip credentials from the URL and transmit them via Authorization headers.
 * Self-hosted notifiers on localhost or the local network are standard OpenRig
 * configurations and are explicitly permitted without restriction.
 */
export function validateOutboundUrl(rawUrl: string): OutboundUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "invalid_url_format" };
  }

  // 1. Protocol check: strict http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, reason: `unsupported_protocol_${parsed.protocol.replace(":", "")}` };
  }

  // 2. Ensure hostname is present
  const hostname = parsed.hostname.toLowerCase().trim();
  if (!hostname) {
    return { valid: false, reason: "missing_hostname" };
  }

  return { valid: true, parsedUrl: parsed };
}

/**
 * Safely redacts credentials from a raw URL string for safe inclusion in logs and error messages.
 */
export function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
      return parsed.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl.replace(/:\/\/([^:]+):([^@]+)@/, "://***:***@");
  }
}
