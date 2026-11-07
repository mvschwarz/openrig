// V1 Phase 4 P4-4 helpers — config-driven Advisor / Operator click resolution.
// Moved verbatim from components/AppShell.tsx (C05); behavior byte-for-byte identical.

import { parseSessionName } from "./session-name.js";

export function readSettingString(
  data: { settings?: Record<string, { value?: unknown }> } | undefined,
  key: string,
): string {
  if (!data || !data.settings) return "";
  const v = data.settings[key]?.value;
  return typeof v === "string" ? v : "";
}

/** Map a ConfigStore session-string ("logicalId@rigId") to a navigation
 *  target. When configured: `/topology/seat/$rigId/$logicalId`. When
 *  unset: `/settings#agents-{role}-session`. Per universal-shell.md L80
 *  (one-click navigation; not popup-then-CTA two-click). */
export function resolveChatTo(session: string, role: "advisor" | "operator"): string {
  if (!session) return `/settings#agents-${role}-session`;
  // OPR.0.4.6.MH1 FR-8: the shared parse contract; non-canonical
  // (malformed/legacy) falls back to /settings.
  const parsed = parseSessionName(session);
  if (parsed.kind !== "canonical") return `/settings#agents-${role}-session`;
  return `/topology/seat/${encodeURIComponent(parsed.rig)}/${encodeURIComponent(parsed.member)}`;
}
