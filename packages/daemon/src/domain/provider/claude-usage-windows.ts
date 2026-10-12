// Slice 01 (OPR.0.7.0.1) — Claude usage windows for the provider view: the `/usage` screen normalized
// over the shared usage-windows core. Identity is the organisation `claude auth status` reports, with
// the screen's model group as the bucket; email is a label only, so the same email under another
// organisation is another row. No organisation id means unresolved (its own row, never merged).

import type { ClaudeUsageAnswer, ClaudeUsageReader } from "./claude-usage-screen-reader.js";
import { parseClaudeUsageScreen } from "./claude-usage-screen.js";
import type { ClaudeUsageIdentity } from "./provider-types.js";
import { UsageWindows, type UsageReading } from "./usage-windows.js";

export function normalizeClaudeUsage(answer: ClaudeUsageAnswer & { observedAt: string }):
  { ok: true; readings: Array<UsageReading<ClaudeUsageIdentity>> } | { ok: false; detail: string } {
  const parsed = parseClaudeUsageScreen(answer.screen, answer.observedAt);
  if (!parsed.ok) return parsed;
  const orgId = answer.auth.orgId;
  return {
    ok: true,
    readings: parsed.buckets.map((b) => ({
      identity: {
        orgId,
        limitId: b.bucket,
        email: answer.auth.email,
        source: orgId !== null ? "claude auth status orgId" : "unresolved",
      },
      windows: b.windows.map((w) => ({ window: w.window, durationMins: w.durationMins, usedPercent: w.usedPercent, resetsAt: w.resetsAt })),
      limitEvidence: null,
      observedAt: answer.observedAt,
    })),
  };
}

const identityKey = (i: ClaudeUsageIdentity): string | null => (i.orgId !== null ? `claude:org:${i.orgId}:${i.limitId}` : null);

export class ClaudeUsageWindows extends UsageWindows<ClaudeUsageIdentity, ClaudeUsageAnswer> {
  constructor(deps: { read: ClaudeUsageReader; now?: () => string }) {
    super({
      provider: "claude",
      sourceKind: "claude_usage_screen",
      read: deps.read,
      normalize: normalizeClaudeUsage,
      key: identityKey,
      ...(deps.now ? { now: deps.now } : {}),
    });
  }
}
