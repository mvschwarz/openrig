import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";

const PREFIX = "openrig-native-v1-";
export const NATIVE_LOGICAL_SESSION_OPTION = "@openrig-logical-session-v1";
export function isEncodedNativeSessionName(name: string): boolean { return /^openrig-native-v1-[a-f0-9]{64}$/.test(name); }

/** A binding is metadata, never authority to operate on an existing session.
 * Callers must observe the marker on the exact physical session before reusing
 * it; a matching-looking name without that marker must not be adopted. */
export interface NativeSessionNameBinding {
  logical: string;
  physical: string;
  marker?: string;
}

function requiresEncoding(name: string): boolean {
  return name.startsWith(PREFIX) || /[<>:"/\\|?*\x01-\x1f]/.test(name)
    || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

/** Stable, bounded native filename; no lossy character replacement. */
export function bindNativeSessionName(logical: string): NativeSessionNameBinding {
  const bytes = Buffer.from(logical, "utf8");
  if (!logical || logical.includes("\0") || bytes.toString("utf8") !== logical) throw new Error("Invalid logical session name");
  if (!requiresEncoding(logical)) return { logical, physical: logical };
  return { logical, physical: PREFIX + createHash("sha256").update(bytes).digest("hex"), marker: bytes.toString("base64url") };
}

/** Decode only an observed canonical marker bound to this exact native name.
 * Names alone are insufficient: pre-existing sessions can resemble our prefix. */
export function logicalNameFromNativeBinding(physical: string, marker: string | undefined): string | undefined {
  if (marker === undefined || !marker || marker.length > 1024 * 1024 || !/^[A-Za-z0-9_-]+$/.test(marker)) return undefined;
  const bytes = Buffer.from(marker, "base64url");
  if (!isUtf8(bytes) || bytes.toString("base64url") !== marker) return undefined;
  const logical = bytes.toString("utf8");
  try {
    const binding = bindNativeSessionName(logical);
    return binding.marker === marker && binding.physical === physical ? logical : undefined;
  } catch { return undefined; }
}
