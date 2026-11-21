import { terminalSafeText } from "../terminal-safe-text.js";
import type { HostNode } from "../types.js";

export function sanitizeHostDisplayName(value: string): string {
  // A configured display name is a label, so it is trimmed, keeps no bidi marks, and closes the gap a
  // removed control byte leaves: a name that never meant to contain one should read as the name it was.
  // The bidi removal is asked for here because the shared helper keeps them by default.
  return terminalSafeText(value, { trim: true, control: "remove", keepBidi: false });
}

function displayName(host: HostNode): string | undefined {
  const name = host.displayName === undefined ? undefined : sanitizeHostDisplayName(host.displayName);
  return name && name !== host.name ? name : undefined;
}

/** Display the configured name beside the identity accepted by host commands. */
export function hostLabel(host: HostNode): string {
  const name = displayName(host);
  return name ? `${name} (${host.name})` : host.name;
}

export function hostReachabilityLabel(host: HostNode): "reachable" | "unreachable" | "unknown" {
  return host.reachable === true ? "reachable" : host.reachable === false ? "unreachable" : "unknown";
}

export function hostReachabilitySuffix(host: HostNode): string {
  return host.reachable === true ? "" : ` (${hostReachabilityLabel(host)})`;
}

/** Keep the command identity first, with room for the existing reachability suffix. */
export function hostExplorerLabel(host: HostNode, width: number): string {
  const suffix = hostReachabilitySuffix(host);
  const name = displayName(host);
  const room = width - host.name.length - suffix.length - 3; // " · "
  if (!name || room < 1) return host.name + suffix;
  if (name.length <= room) return `${host.name} · ${name}${suffix}`;
  let clipped = "";
  for (const char of name) {
    if (clipped.length + char.length > room - 1) break;
    clipped += char;
  }
  return `${host.name} · ${clipped}…${suffix}`;
}
