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

/** M1 A5b — an outbound image attachment. A media-bearing OutboundDecision carries these;
 *  the connector renders each as a Slack Block Kit `image` block on the SHIPPED outbound path.
 *  This is the T1076 seam finally wired (Slice-12's image relay), not a redesign. */
export interface SlackMediaRef {
  imageUrl: string; // a resolvable image URL (https). NEVER a secret-bearing URL (rejected below).
  altText: string;  // accessibility + notification fallback text
}

export interface OutboundMessageOpts {
  sourceLabel: string; // where the queue lives (host/box/rig), from config — never hardcoded
  bodyExcerpt?: number;
  /** T1076 extension point: extra Block Kit blocks (e.g. future media). v1 unused. */
  extraBlocks?: unknown[];
  /** M1 A5b: outbound image attachments, rendered as Block Kit `image` blocks (the wired seam). */
  mediaRefs?: SlackMediaRef[];
  /** S10 / A1.2 — the structured seat-attribution header (rig/host/seat/session), rendered as
   *  the LEADING context block in ONE honest bot identity. Authorship lives in OUR record;
   *  Slack's transport actor stays the app. NEVER a per-message username/icon override. */
  attribution?: SeatAttribution;
  /** S10 interim loudness rule: an escalation MENTIONS its human (`<@Uxxx>`); everything else
   *  stays quiet-threaded. The value is the Slack USER ID (mention semantics require the id,
   *  never a display name). */
  mentionUserId?: string;
  /** S10 fix-r3 — the reconciliation token (reconcileToken(decisionId)), reserved OUTSIDE the
   *  truncatable content budget: content clamps to CAP minus the token's exact reserve, then
   *  the token appends, so it survives in top-level fallback text at ANY ordinary message
   *  length — the exact surface the history scan reads. */
  reconcileMarker?: string;
}

/** A1.2 — the four attribution fields. */
export interface SeatAttribution {
  seat: string;
  rig?: string;
  host?: string;
  session: string;
}

/** Parse the stamped session triple (`member@rig[@host]`, the 51-09 stored form) into the
 *  attribution fields. A bare/unparseable ref degrades to seat=session (never a throw). */
export function attributionFromSession(sourceSession: string | null | undefined): SeatAttribution | undefined {
  if (!sourceSession) return undefined;
  const parts = sourceSession.split("@");
  if (parts.length >= 2) {
    const a: SeatAttribution = { seat: `${parts[0]}@${parts[1]}`, rig: parts[1], session: sourceSession };
    if (parts.length >= 3) a.host = parts.slice(2).join("@");
    return a;
  }
  return { seat: sourceSession, session: sourceSession };
}

const SLACK_ALT_TEXT_CAP = 2000; // Slack image alt_text hard limit.

/** M1 A5b — turn media refs into Block Kit `image` blocks. Item-7 hygiene: a secret-bearing
 *  image_url (e.g. a webhook URL smuggled as an image) is REFUSED, never forwarded. Alt text is
 *  redacted + clamped. Returns only the well-formed, secret-free image blocks. */
export function buildImageBlocks(mediaRefs: readonly SlackMediaRef[] | undefined): unknown[] {
  if (!mediaRefs?.length) return [];
  const blocks: unknown[] = [];
  for (const m of mediaRefs) {
    const url = String(m.imageUrl || "");
    // Only forward a clean https URL that carries no secret (defense-in-depth, item 7).
    if (!/^https:\/\/\S+$/.test(url) || containsSecret(url)) continue;
    blocks.push({
      type: "image",
      image_url: url,
      // R2 B1: alt text is row-carried → the same inert pipeline (redact + neutralize).
      alt_text: clamp(inert(String(m.altText || "attachment")), SLACK_ALT_TEXT_CAP),
    });
  }
  return blocks;
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

/** S10 fix-r1 (R2 B1) — STRUCTURAL neutralization of queue-controlled content. Slack's
 *  formatting contract parses control sequences (<@U…>, <!here>, <!channel>, <!subteam^…>,
 *  <url|label>) only from a literal "<"; its documented rule for displaying user-generated
 *  text is to escape exactly &, <, > (docs.slack.dev/messaging/formatting-message-text).
 *  Escaping these three makes EVERY control form inert BY CONSTRUCTION — present and past
 *  forms alike — never a blocklist of known spellings. Ordinary mrkdwn styling (*bold*,
 *  _italic_, bare URLs) uses none of the three and survives untouched. Order matters: "&"
 *  first, or the escapes themselves would be re-escaped. */
export function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The untrusted-field pipeline: secrets redacted, then Slack control syntax neutralized. */
function inert(text: string): string {
  return escapeSlackText(redactSecrets(text));
}

/** S10 fix-r3 (R2 exactly-once) — the STRUCTURAL reconciliation identity: a bounded,
 *  decision-scoped token. decisionId is daemon-minted per decision (never settable through
 *  queue rows) and stable across retries of the same decision, so ONLY the target posted
 *  message carries this exact delimited token — ordinary prose quoting a qitem id (or even a
 *  lookalike built from the qitem id) cannot reproduce it. ONE producer function; the
 *  reconcile scanner matches exactly this function's output — producer and scanner share
 *  identity bytes by construction. Parentheses/colon only: no &,<,> so the token is
 *  escape-stable and never parses as Slack control syntax. */
export function reconcileToken(decisionId: string): string {
  return `(or-mark:${escapeSlackText(String(decisionId))})`;
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
  // R2 B1 boundary rule, UNIFORM (fix-r2 / R1 F-B1r): EVERY queue-controlled field — the
  // qitemId included — goes through the structural neutralization BEFORE placement in text or
  // mrkdwn. No exemption, no minted-only premise: the create route accepts caller-supplied
  // ids without charset validation, so "no specials by construction" is not enforced anywhere.
  // Control syntax arriving through a row cannot survive, and content stays honestly readable
  // escaped. The H reconcile marker compares the SAME escaped bytes on both sides (the scan in
  // slack-delivery searches escapeSlackText(qitemId)); for minted ids escaped == raw.
  const summary = inert(String(q.summary || "(no summary)"));
  const bodyRaw = inert(String(q.body || ""));
  const body = clamp(bodyRaw, opts.bodyExcerpt ?? DEFAULT_BODY_EXCERPT);
  const dest = escapeSlackText(q.destinationSession || "(unknown destination)");
  const footer = `qitem ${escapeSlackText(String(q.qitemId))} → ${dest} on ${opts.sourceLabel}`;

  // S10 interim loudness rule: only an escalation carries a mention (the sole force-notify
  // lever Slack offers); everything else stays quiet-threaded. Composed HERE, AFTER the
  // untrusted fields were neutralized above — the renderer's mention is the only path to an
  // active control sequence, and its id comes from the registry's HANDLE_PATTERN-validated
  // binding, never from row content.
  const mention = opts.mentionUserId ? `<@${opts.mentionUserId}> ` : "";
  const loudness = opts.mentionUserId ? ":rotating_light: " : "";
  const headline = `${mention}${loudness}*${summary}*`;
  // A1.2 — the attribution header line (rig/host/seat/session), one honest bot identity.
  // Session strings are row-carried → same inert pipeline.
  const attr = opts.attribution
    ? [
        `from *${inert(opts.attribution.seat)}*`,
        opts.attribution.rig ? `rig ${inert(opts.attribution.rig)}` : null,
        opts.attribution.host ? `host ${inert(opts.attribution.host)}` : null,
        `session ${inert(opts.attribution.session)}`,
      ].filter(Boolean).join(" · ")
    : null;

  // fix-r3: the reconcile token is reserved OUTSIDE the clamp budget — ordinary content of any
  // length clamps first, the token appends after, so the scanned surface ALWAYS carries it.
  const tokenReserve = opts.reconcileMarker ? opts.reconcileMarker.length + 1 : 0;
  const assemble = (content: string): string => {
    const clamped = clamp(content, SLACK_TEXT_CAP - tokenReserve);
    return opts.reconcileMarker ? `${clamped}\n${opts.reconcileMarker}` : clamped;
  };
  const text = assemble(`${headline}${attr ? `\n_${attr}_` : ""}\n${body}\n_${footer}_`);

  const blocks: unknown[] = [];
  if (attr) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: clamp(attr, 2000) }] });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: clamp(headline, 3000) } });
  if (body.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: clamp(body, 3000) } });
  // M1 A5b — outbound image attachments (the wired T1076 seam). Secret-bearing URLs are dropped.
  const imageBlocks = buildImageBlocks(opts.mediaRefs);
  blocks.push(...imageBlocks);
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] });
  if (opts.extraBlocks?.length) blocks.push(...opts.extraBlocks);

  // Note the attachment count in the notification fallback so a text-only client still signals
  // it. Re-assembled through the same token-reserving path so the media note never evicts the
  // reconcile identity from the scanned surface.
  const textWithMedia = imageBlocks.length > 0
    ? assemble(`${headline}${attr ? `\n_${attr}_` : ""}\n${body}\n_${footer}_\n_(${imageBlocks.length} image attachment${imageBlocks.length === 1 ? "" : "s"})_`)
    : text;
  return { text: textWithMedia, blocks };
}
