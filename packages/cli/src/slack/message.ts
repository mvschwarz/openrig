// Slice-11 slack-connector — outbound message construction.
//
// Locked item 7 (content hygiene): a posted message carries summary + qitem id
// + source + a BOUNDED body excerpt, and NEVER a token/secret/secret-bearing
// path. We never add our own credentials (we only render qitem fields), and as
// defense-in-depth we redact anything that looks like a Slack/bearer secret
// leaking through a qitem body before it goes out.
//
// T1076 (don't preclude Slice-12): construction is BLOCKS/ATTACHMENTS-capable —
// we always emit Block Kit `blocks` PLUS a plain-text fallback, and accept
// optional extra blocks / media refs so image relay can extend this later
// WITHOUT redefining the shape here. v1 ships text only.

export const SLACK_TEXT_CAP = 3900; // Slack hard-limits ~4000; stay under.
export const DEFAULT_BODY_EXCERPT = 800;

export interface QitemLike {
  qitemId: string;
  summary?: string | null;
  body?: string | null;
  destinationSession?: string | null;
}

export interface OutboundMessageOpts {
  sourceLabel: string; // where the queue lives (host/box/rig), from config — never hardcoded
  bodyExcerpt?: number;
  /** T1076 extension point: extra Block Kit blocks (e.g. future media). v1 unused. */
  extraBlocks?: unknown[];
}

// Secret-looking patterns we refuse to forward (item 7 defense-in-depth).
const SECRET_PATTERNS: RegExp[] = [
  /xox[baprs]-[A-Za-z0-9-]+/g, // Slack bot/user/app/refresh tokens
  /xapp-[A-Za-z0-9-]+/g, // Slack app-level (Socket Mode) token
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, // incoming webhook URL
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi, // bearer tokens
  /xoxe\.xox[bp]-[A-Za-z0-9-]+/g, // rotation tokens
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, "[redacted-secret]");
  }
  return out;
}

export interface SlackMessagePayload {
  text: string; // notification fallback (always set)
  blocks: unknown[]; // Block Kit (T1076-extensible)
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Build the Slack payload for a human-destined qitem. Pure + deterministic
 * (no clock, no io) so it is trivially testable and safe to snapshot.
 */
export function buildOutboundMessage(q: QitemLike, opts: OutboundMessageOpts): SlackMessagePayload {
  const summary = redactSecrets(String(q.summary || "(no summary)"));
  const bodyRaw = redactSecrets(String(q.body || ""));
  const body = clamp(bodyRaw, opts.bodyExcerpt ?? DEFAULT_BODY_EXCERPT);
  const dest = q.destinationSession || "(unknown destination)";
  const footer = `qitem ${q.qitemId} → ${dest} on ${opts.sourceLabel}`;

  const text = clamp(`:rotating_light: *${summary}*\n${body}\n_${footer}_`, SLACK_TEXT_CAP);

  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: clamp(`:rotating_light: *${summary}*`, 3000) } },
  ];
  if (body.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: clamp(body, 3000) } });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] });
  if (opts.extraBlocks?.length) blocks.push(...opts.extraBlocks);

  return { text, blocks };
}
