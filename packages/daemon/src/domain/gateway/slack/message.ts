// Complete, bounded human messages. No content is silently clipped.
// Slack contracts checked 2026-09-10:
// https://docs.slack.dev/reference/methods/chat.postMessage/ (4,000 recommended;
// 40,000 truncation; top-level text is the screen-reader/notification fallback)
// https://docs.slack.dev/reference/block-kit/blocks/section-block/ (3,000)
// https://docs.slack.dev/reference/block-kit/blocks/ (50 blocks)
import { createHash } from "node:crypto";
import { MAX_OPTION_LABEL, type HumanQuestion } from "../../human-questions.js";

export const SLACK_TEXT_CAP = 3900; // Our conservative complete-fallback budget, not Slack’s hard limit.
export const SLACK_SECTION_CAP = 3000;
/** @deprecated Complete rendering ignores excerpt requests. */
export const DEFAULT_BODY_EXCERPT = SLACK_SECTION_CAP;

export interface QitemLike {
  qitemId: string;
  ownerNotificationKind?: string | null;
  summary?: string | null;
  body?: string | null;
  destinationSession?: string | null;
  /** #193 — structured questions, rendered as one button row per question. */
  humanQuestions?: readonly HumanQuestion[] | null;
  /** #1013 — row state + tags, so a workflow gate PARKED on a human seat can be
   *  re-rendered for the person instead of posting the seat's agent packet. */
  state?: string | null;
  tags?: readonly string[] | null;
  /** #1013 — the structured evidenceRef: for a parked gate it rides the evidence link/media
   *  path when it is an https ref, else it renders as one Evidence line (never the packet). */
  evidenceRef?: string | null;
}

/** #1013 — a workflow gate row parked on a human seat (the projector parks it
 * `state=blocked, blocked_on=<human seat>` and tags it `gate`; every workflow gate also
 * carries the `workflow` tag — the projector and the runtime both set it). Agents also
 * put `gate` on rows they write by hand, so requiring both keeps a hand-tagged row's
 * own body intact. A gate's body is the agent packet — instance/step/Continuation lines
 * for the seat that resumes after sign-off — while the person needs only the headline
 * (`gate.summary`, plain language per C6) and the evidence link. The row itself is
 * untouched; this gates the OUTBOUND render only. */
export function isHumanGatePacket(q: Pick<QitemLike, "state" | "tags">): boolean {
  const tags = q.tags ?? [];
  return q.state === "blocked" && tags.includes("gate") && tags.includes("workflow");
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
  /** @deprecated Ignored: complete briefs are rendered or explicitly refused. */
  bodyExcerpt?: number;
  /** @deprecated Refused without an accessible projection; use mediaRefs. */
  extraBlocks?: unknown[];
  /** M1 A5b: outbound image attachments, rendered as Block Kit `image` blocks (the wired seam). */
  mediaRefs?: SlackMediaRef[];
  /** #47 — an https evidenceRef that is NOT an image (GitLab issue link, PROOF.md URL, …),
   *  rendered as a plain link in the message text + a context block. NEVER a Block Kit
   *  `image` block: Slack rejects the ENTIRE message with `invalid_blocks` when an image
   *  block's URL is not a real image, silently and permanently breaking delivery. */
  evidenceLink?: string | null;
  /** S10 / A1.2 — the structured seat-attribution header (rig/host/seat/session), rendered as
   *  one sender context line in ONE honest bot identity. Authorship lives in OUR record;
   *  Slack's transport actor stays the app. NEVER a per-message username/icon override. */
  attribution?: SeatAttribution;
  /** The machine this post comes from, shown after the sender ("from lead@my-rig on vps04") when
   *  the sender's session doesn't already name a host. Absent: the sender line is unchanged. */
  machine?: string;
  /** S10 interim loudness rule: an escalation MENTIONS its human (`<@Uxxx>`); everything else
   *  stays quiet-threaded. The value is the Slack USER ID (mention semantics require the id,
   *  never a display name). */
  mentionUserId?: string;
  /** Stable decision/part identity. Included in the complete fallback budget. */
  reconcileMarker?: string;
  /** A retry that couldn't confirm whether an earlier attempt landed says so in one context line, left out when it
   *  doesn't fit. */
  possibleRepeat?: boolean;
}

const POSSIBLE_REPEAT_NOTE = "Delivery may repeat after an earlier unconfirmed attempt.";

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
 *  redacted and validated without clipping. Returns only the well-formed, secret-free image blocks. */
export function buildImageBlocks(mediaRefs: readonly SlackMediaRef[] | undefined): unknown[] {
  if (!mediaRefs?.length) return [];
  const blocks: unknown[] = [];
  for (const m of mediaRefs) {
    const url = String(m.imageUrl || "");
    // Only forward a clean https URL that carries no secret (defense-in-depth, item 7).
    if (!isSafeHttpsUrl(url)) continue;
    blocks.push({
      type: "image",
      image_url: url,
      // R2 B1: alt text is row-carried → the same inert pipeline (redact + neutralize).
      alt_text: bounded(inert(String(m.altText || "attachment")), SLACK_ALT_TEXT_CAP, "image description"),
    });
  }
  return blocks;
}

/** #193 — the block_id / action_id prefixes a click carries back. The inbound path parses
 *  exactly these (one producer, one parser: see parseQuestionAction). */
export const QUESTION_BLOCK_PREFIX = "or-q:";
export const OPTION_ACTION_PREFIX = "or-opt:";
const TYPED_REPLY_HINT = "Or reply in this thread with your own answer.";

/** Parse a clicked button back into its question and option ids; null if it is not ours. */
export function parseQuestionAction(blockId: unknown, actionId: unknown): { questionId: string; optionId: string } | null {
  if (typeof blockId !== "string" || typeof actionId !== "string") return null;
  if (!blockId.startsWith(QUESTION_BLOCK_PREFIX) || !actionId.startsWith(OPTION_ACTION_PREFIX)) return null;
  const questionId = blockId.slice(QUESTION_BLOCK_PREFIX.length);
  const optionId = actionId.slice(OPTION_ACTION_PREFIX.length);
  return questionId && optionId ? { questionId, optionId } : null;
}

/** #193 — the questions as blocks (a section, then a button row, per question) plus the
 *  complete text they must also appear as in the accessible fallback. */
function buildQuestionBlocks(questions: readonly HumanQuestion[]): { blocks: unknown[]; text: string } {
  const blocks: unknown[] = [];
  const lines: string[] = [];
  for (const q of questions) {
    const question = bounded(`*${inert(q.question)}*`, SLACK_SECTION_CAP, "question");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: question } });
    blocks.push({
      type: "actions",
      block_id: `${QUESTION_BLOCK_PREFIX}${q.id}`,
      elements: q.options.map((o) => ({
        type: "button",
        action_id: `${OPTION_ACTION_PREFIX}${o.id}`,
        value: o.id,
        ...(o.recommended ? { style: "primary" } : {}),
        text: { type: "plain_text", text: bounded(inert(o.label), MAX_OPTION_LABEL, "option label") },
      })),
    });
    lines.push(question, ...q.options.map((o) => `• ${inert(o.label)}${o.recommended ? " (recommended)" : ""}`));
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: TYPED_REPLY_HINT }] });
  lines.push(TYPED_REPLY_HINT);
  return { blocks, text: lines.join("\n") };
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

const REDACTED_SECRET = "[redacted-secret]";

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, REDACTED_SECRET);
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

function isSafeHttpsUrl(url: string): boolean {
  if (!/^https:\/\/\S+$/.test(url) || containsSecret(url)) return false;
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** #47 — render a non-image https evidenceRef as a plain link instead of a Block Kit
 *  `image` block. The URL arrives pre-validated as `^https://\S+$` from the delivery
 *  layer; item-7 hygiene still applies (a secret-bearing URL is refused, never
 *  forwarded), and a URL carrying mrkdwn-breaking `<`, `>`, `|` degrades to escaped
 *  plain text rather than a link. Returns null when there is nothing safe to render. */
function buildEvidenceLink(url: string | null | undefined): { text: string; block: unknown } | null {
  const ref = typeof url === "string" ? url.trim() : "";
  if (!ref || !isSafeHttpsUrl(ref)) return null;
  const escapedRef = inert(ref);
  const text = `Evidence: ${escapedRef}`;
  const context = bounded(/[<>|]/.test(ref) ? text : `Evidence: <${escapedRef}|evidence>`, SLACK_SECTION_CAP, "evidence context");
  const block = { type: "context", elements: [{ type: "mrkdwn", text: context }] };
  return { text, block };
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

export class HumanMessageShapeError extends Error {
  readonly code = "human_message_unrenderable";
}

/** #897 — split text into pieces that each fit `budgetFor(index)` once escaped, so a brief
 *  over one message's limit is posted as several messages instead of refused. Secrets are
 *  redacted before any cut, so a cut can never separate a secret from the pattern that finds
 *  it. A cut prefers a blank line, then a line end, then a space, in the second half of the
 *  room; it never falls inside a surrogate pair. The pieces join back to the redacted text
 *  without its trailing whitespace. */
export function splitForSlack(text: string, budgetFor: (index: number) => number): string[] {
  const pieces: string[] = [];
  let rest = redactSecrets(text).trimEnd();
  while (rest) {
    const budget = budgetFor(pieces.length);
    let end = 0;
    let width = 0;
    while (end < rest.length) {
      const code = rest.charCodeAt(end);
      const step = code >= 0xd800 && code <= 0xdbff && end + 1 < rest.length ? 2 : 1;
      const add = escapeSlackText(rest.slice(end, end + step)).length;
      if (width + add > budget) break;
      width += add;
      end += step;
    }
    if (end === rest.length) {
      pieces.push(rest);
      break;
    }
    if (end === 0) throw new HumanMessageShapeError(`Message part ${pieces.length + 1} has no room for brief text. Shorten the subject.`);
    const room = rest.slice(0, end);
    const boundaries = [room.lastIndexOf("\n\n") + 2, room.lastIndexOf("\n") + 1, room.lastIndexOf(" ") + 1];
    const cut = boundaries.find((at) => at > end / 2) ?? end;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return pieces;
}

function bounded(text: string, max: number, field: string): string {
  // Count the escaped wire string in UTF-16 units, conservatively. Never slice
  // an entity or surrogate pair; reject the whole request before any post.
  if (text.length > max) {
    throw new HumanMessageShapeError(`${field} is ${text.length} units after escaping (maximum ${max}). Shorten the human brief; put only supplemental context in --human-detail-file. Keep the action and options in the primary body.`);
  }
  return text;
}

/** Longest tag value the gate context line shows, in characters, ellipsis included. */
export const GATE_CONTEXT_VALUE_CAP = 80;

/** Shorten a redacted tag value to GATE_CONTEXT_VALUE_CAP characters: its start and end around
 * `…`, then the first 12 hex characters of the SHA-256 of the whole value. Labels that differ at
 * the start or end stay visibly distinct; for labels that differ only in the cut middle, the
 * digest makes a collision unlikely but doesn't rule it out. Counts code points, so no surrogate
 * pair is split, and keeps a redaction marker whole or leaves it out, never cut. */
function shortenGateValue(value: string): string {
  const tokens: string[] = [];
  value.split(REDACTED_SECRET).forEach((part, index) => {
    if (index > 0) tokens.push(REDACTED_SECRET);
    tokens.push(...Array.from(part));
  });
  const width = (token: string) => (token === REDACTED_SECRET ? REDACTED_SECRET.length : 1);
  if (tokens.reduce((sum, token) => sum + width(token), 0) <= GATE_CONTEXT_VALUE_CAP) return value;
  const hash = ` #${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
  const room = GATE_CONTEXT_VALUE_CAP - hash.length - 1;
  const take = (from: string[], budget: number): string[] => {
    const kept: string[] = [];
    let used = 0;
    for (const token of from) {
      if (used + width(token) > budget) break;
      kept.push(token);
      used += width(token);
    }
    return kept;
  };
  const head = take(tokens, Math.floor(room / 2));
  const tail = take([...tokens.slice(head.length)].reverse(), room - Math.floor(room / 2)).reverse();
  return `${head.join("")}…${tail.join("")}${hash}`;
}

/** PR #1143 review — the one-line workflow/instance context for a rendered human gate,
 * built from the row's own `workflow:` / `instance:` / `step:` tags. The step rides along
 * only when tagged. Missing tags render as `?` so the line never names the wrong workflow.
 * A hand-made row can carry a tag of any length, so each value is redacted, then shortened
 * (shortenGateValue), and only then is the line escaped, so no escape is split.
 * `instanceOnly` gives the shorter line that still tells two instances apart. */
export function buildGateContextLine(tags: readonly string[], instanceOnly = false): string {
  const tagValue = (prefix: string): string => {
    const raw = tags.find((t) => t.startsWith(`${prefix}:`))?.slice(prefix.length + 1);
    return raw ? shortenGateValue(redactSecrets(raw)) : "?";
  };
  if (instanceOnly) return escapeSlackText(`instance ${tagValue("instance")}`);
  const parts = [`Workflow ${tagValue("workflow")}`, `instance ${tagValue("instance")}`];
  const step = tagValue("step");
  if (step !== "?") parts.push(`step ${step}`);
  return escapeSlackText(parts.join(" · "));
}

/** Pure, deterministic rendering. Queue metadata stays in the durable request;
 * the human sees one subject, complete body and one sender attribution. */
export function buildOutboundMessage(q: QitemLike, opts: OutboundMessageOpts): SlackMessagePayload {
  const summary = inert(String(q.summary || "(no summary)"));
  // #1013 — a gate parked on a human renders from the structured fields: the headline IS
  // the ask (gate.summary) and the evidenceRef rides the evidence link/media path. When
  // that path won't carry it (a local path, not an https ref), the body falls to a single
  // Evidence line — the raw agent packet (instance/step/Continuation lines for the seat
  // that resumes after sign-off) never does. Without a plain-language summary there is
  // nothing to show the person instead, so the packet stays as the fallback.
  const humanGate = isHumanGatePacket(q) && String(q.summary ?? "").trim() !== "";
  // PR #1143 review — two instances of the same workflow parked at the same gate otherwise
  // render byte-identical messages. One short line from the row's own tags tells the person
  // which workflow instance is asking (never the agent packet).
  const gateContext = humanGate ? buildGateContextLine(q.tags ?? []) : null;
  const gateEvidence = String(q.evidenceRef ?? "").trim();
  // The Evidence path drops out only when the render already carries that same reference —
  // an https ref riding as the evidence link, or a media attachment whose URL IS the ref.
  // An image of a DIFFERENT artifact (the common screenshot case) keeps the Evidence line:
  // without it the human cannot find the referenced document.
  const gateEvidenceCarried = Boolean(opts.evidenceLink)
    || (opts.mediaRefs ?? []).some((m) => m.imageUrl === gateEvidence);
  const body = humanGate
    ? (!gateEvidence || gateEvidenceCarried
      ? ""
      : bounded(`Evidence: ${inert(gateEvidence)}`, SLACK_SECTION_CAP, "body"))
    : bounded(inert(String(q.body || "")), SLACK_SECTION_CAP, "body");
  const mention = opts.mentionUserId ? `<@${opts.mentionUserId}> :rotating_light: ` : "";
  const headline = bounded(`${mention}*${summary}*`, SLACK_SECTION_CAP, "subject");
  const machine = opts.attribution && !opts.attribution.host && opts.machine ? ` on ${inert(opts.machine)}` : "";
  const attr = bounded(`from ${inert(opts.attribution?.session || opts.sourceLabel)}${machine}`, 2000, "sender");
  const imageBlocks = buildImageBlocks(opts.mediaRefs);
  const attachmentText = imageBlocks.map((b) => `Image: ${(b as { alt_text: string }).alt_text}`).join("\n");
  const evidence = buildEvidenceLink(opts.evidenceLink);
  const questionParts = q.humanQuestions?.length ? buildQuestionBlocks(q.humanQuestions) : null;
  if (opts.extraBlocks?.length) {
    throw new HumanMessageShapeError("Extra blocks have no complete accessible fallback. Use mediaRefs for images or author supplemental human detail.");
  }
  const replyHint = q.ownerNotificationKind === "human-required"
    ? "Reply in this thread after this question to answer it. Earlier and extra messages still reach the agent as conversation." : null;
  const fallback = (context: string | null, repeat: string | null = null) => [headline, repeat, context, body, questionParts?.text, replyHint, attr, evidence ? evidence.text : null, attachmentText, opts.reconcileMarker].filter(Boolean).join("\n");
  // The gate context line is supplementary: when it alone would push the complete fallback over
  // budget, the instance part alone is tried, and the line is left out only when even that
  // doesn't fit, rather than refusing the gate.
  let shownContext = gateContext;
  if (gateContext && fallback(gateContext).length > SLACK_TEXT_CAP && fallback(null).length <= SLACK_TEXT_CAP) {
    const instanceLine = buildGateContextLine(q.tags ?? [], true);
    shownContext = fallback(instanceLine).length <= SLACK_TEXT_CAP ? instanceLine : null;
  }
  // The repeat note is supplementary too: left out rather than refusing a message it would push over a limit.
  const shownRepeat = opts.possibleRepeat && fallback(shownContext, POSSIBLE_REPEAT_NOTE).length <= SLACK_TEXT_CAP ? POSSIBLE_REPEAT_NOTE : null;
  const text = bounded(fallback(shownContext, shownRepeat), SLACK_TEXT_CAP, "complete fallback");
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: headline } }];
  if (shownRepeat) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: shownRepeat }] });
  if (shownContext) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: shownContext }] });
  if (body.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: body } });
  if (questionParts) blocks.push(...questionParts.blocks);
  if (replyHint) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: replyHint }] });
  blocks.push(...imageBlocks);
  if (evidence) blocks.push(evidence.block);
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: attr }] });
  if (shownRepeat && blocks.length > 50) blocks.splice(1, 1);
  if (blocks.length > 50) throw new HumanMessageShapeError("Message exceeds 50 Slack blocks. Reduce attachments before sending.");
  return { text, blocks };
}
