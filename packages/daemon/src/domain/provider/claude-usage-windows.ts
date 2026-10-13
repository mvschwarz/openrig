// Slice 01 (OPR.0.7.0.1) — Claude usage windows for the provider view: the `/usage` screen normalized
// over the shared usage-windows core. Identity is the organisation AND the email `claude auth status`
// reports, with the screen's model group as the bucket. Unlike Codex, Claude reports no per-account id,
// and members of one Team or Enterprise organisation each have their own limits: the organisation alone
// would let one member's numbers replace another's. So two people in one organisation are two rows, and
// one email in two organisations is still two rows. Without either, the read is unresolved (its own row,
// never merged). The organisation name and subscription type are labels only.

import type { ClaudeUsageAnswer, ClaudeUsageReader } from "./claude-usage-screen-reader.js";
import { parseClaudeUsageScreen } from "./claude-usage-screen.js";
import type { ClaudeUsageIdentity } from "./provider-types.js";
import { UsageWindows, type UsageReading } from "./usage-windows.js";

export function normalizeClaudeUsage(answer: ClaudeUsageAnswer & { observedAt: string }):
  { ok: true; readings: Array<UsageReading<ClaudeUsageIdentity>> } | { ok: false; detail: string } {
  const parsed = parseClaudeUsageScreen(answer.screen, answer.observedAt);
  if (!parsed.ok) return parsed;
  const { orgId, email } = answer.auth;
  return {
    ok: true,
    readings: parsed.buckets.map((b) => ({
      identity: {
        orgId,
        limitId: b.bucket,
        email,
        orgName: answer.auth.orgName,
        subscriptionType: answer.auth.subscriptionType,
        source: orgId !== null && email !== null ? "claude auth status orgId and email" : "unresolved",
      },
      windows: b.windows.map((w) => ({ window: w.window, durationMins: w.durationMins, usedPercent: w.usedPercent, resetsAt: w.resetsAt })),
      limitEvidence: null,
      observedAt: answer.observedAt,
    })),
  };
}

const identityKey = (i: ClaudeUsageIdentity): string | null =>
  (i.orgId !== null && i.email !== null ? `claude:org:${i.orgId}:email:${i.email}:${i.limitId}` : null);

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
