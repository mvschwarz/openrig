/**
 * Issue #425, #493: wrap bare IPv6 literals in brackets for URL hosts.
 * `::1` must render as `[::1]` — `http://::1:7433` is rejected by URL parsers.
 * Hostnames, IPv4, and already-bracketed literals pass through unchanged.
 */
export function formatDaemonHostForUrl(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}
