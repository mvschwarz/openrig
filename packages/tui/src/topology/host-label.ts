import { stripVTControlCharacters } from "node:util";
import type { HostNode } from "../types.js";

export function sanitizeHostDisplayName(value: string): string {
  // Node 22's VT stripper does not consume every OSC payload (for example a
  // window title with spaces). Remove the entire string before stripping CSI.
  const plain = value.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "");
  return stripVTControlCharacters(plain).replace(/[\x00-\x1f\x7f-\x9f\p{Bidi_Control}]/gu, "").trim();
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

/** Keep the command identity first, with room for the existing reachability suffix. */
export function hostExplorerLabel(host: HostNode, width: number): string {
  const suffix = host.reachable ? "" : " (unreachable)";
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
