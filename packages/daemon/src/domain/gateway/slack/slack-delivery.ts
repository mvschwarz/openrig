// S10 — the subsystem's Slack DELIVERY path (successor to the retired connector-server's
// slackDeliverFn; the proof-1 semantics carry over unchanged): render the OutboundDecision to a
// hygienic payload (slice-11 item 7 redaction + Block Kit via message.ts) and post it. A 2xx →
// ok (the in-process ack drains the durable buffer); any failure → a bounded failure class (the
// wire retains + replays — fail-visible, never a silent drop).
//
// Changes from the retired path, each contract-driven:
//   - postWebhook → postChatMessage: the R2 thread shape needs thread_ts, which a webhook
//     cannot carry. The webhook retires with the relay.
//   - decisionId idempotent redelivery moved HERE from the connector: an already-delivered
//     decisionId is re-acked WITHOUT re-posting (the delivered-store is the same SeenStore
//     pattern, keyed by decisionId — distinct from the qitemId outbound seen-state).
//   - delivered-ok additionally marks the qitemId seen (slice-11: seen ONLY after success) and
//     releases the driver's in-flight guard.

import fs from "node:fs";
import path from "node:path";
import { postChatMessage, getUploadURLExternal, uploadBytesExternal, completeUploadExternal, fetchRecentMessageTexts, type FetchImpl } from "./slack-api.js";
import {
  buildOutboundMessage, attributionFromSession, reconcileToken, redactSecrets, splitForSlack,
  HumanMessageShapeError, SLACK_SECTION_CAP, SLACK_TEXT_CAP, type SlackMediaRef,
} from "./message.js";
import type { SeenStore } from "./state-store.js";
import type { OutboundDecision } from "../protocol.js";
import type { SubsystemDeliverFn, SubsystemDeliveryOutcome } from "../gateway-subsystem.js";
import type { OutboundPostPayload } from "./outbound-driver.js";

export interface SubsystemSlackDeliveryOpts {
  botToken: string;
  /** The default channel: every post goes here unless resolveChannel names another. */
  channel: string;
  /** #192: the channel for this payload (the channel map). Absent = `channel` for every post.
   *  Post, reconcile scan and upload all use the one resolved channel. */
  resolveChannel?: (payload: OutboundPostPayload) => string;
  /** #192: decide a post's channel ONCE, at its first attempt, and record it in `attempted`;
   *  every retry or replay of that post reuses it, so the channel/thread pair always names one
   *  conversation and reconciliation scans where the first attempt went. A recorded channel is
   *  honoured whenever present. A post already attempted without a record (its first attempt ran
   *  before any map existed) retries in the default `channel`, where it went. With pinChannel off
   *  (no map) nothing is recorded and the channel is resolved as before. */
  pinChannel?: boolean;
  sourceLabel: string; // host/box/rig — from config, never hardcoded (item 7)
  bodyExcerpt?: number;
  fetchImpl?: FetchImpl;
  /** decisionId-keyed delivered-store (idempotent redelivery: replay re-acks, never re-posts). */
  delivered: SeenStore;
  /** H — decisionId-keyed ATTEMPTED-store, marked BEFORE the HTTP post. A retry of an attempted
   *  decision has an AMBIGUOUS prior outcome (a timeout may have landed), so it RECONCILES by
   *  marker before any resend — never a blind repost. Distinct from `delivered` (proven 2xx). */
  attempted: SeenStore;
  /** Episode-keyed outbound seen-state (marked ONLY after a successful post). */
  outboundSeen: SeenStore;
  /** Release the outbound driver's in-flight guard once an episode is durably seen. */
  release?: (notificationKey: string) => void;
  /** E (thread routing): resolve the thread anchor for this payload; undefined = new root.
   *  Wired by the thread-seat map; absent in the pre-routing composition. `channel` is the
   *  channel this attempt posts to, so a thread is only ever chosen within it. */
  resolveThreadTs?: (payload: OutboundPostPayload, channel: string) => string | undefined;
  /** E: record a NEW root's ts (and the channel it was posted in) so the conversation threads
   *  from here on. */
  onPostedRoot?: (payload: OutboundPostPayload, ts: string, channel: string) => void;
  /** Receipt hook for every successful post, root or threaded. */
  onPosted?: (payload: OutboundPostPayload, messageTs: string, threadTs?: string) => void;
  /** #899 — receipt hook for every message posted (or reconciled) into a thread: a long ask's reply
   *  parts, a later notification in an ask's own thread, an ask posted into another thread. The payload
   *  names the ask and its seat, and `channel` the channel the message was posted to (#192), so a
   *  reaction on that message can reach them. A throw retains the
   *  delivery like any receipt failure; the replay reconciles the message by marker and records it again. */
  onPostedPart?: (payload: OutboundPostPayload, messageTs: string, threadTs: string, channel: string) => void;
  /** OPR.0.5.6.14 — the transport-failure receipt hook: a failed post writes
   *  the row's transport-failed ledger transition (class + API error), so a
   *  delivery failure is as legible on the row as a success. `partlyPosted` marks an ask whose
   *  remaining parts can't be posted although part of it may already be in Slack (#897). */
  onTransportFailed?: (payload: OutboundPostPayload, failureClass: string, detail: string, partlyPosted?: boolean) => void;
  /** F (interim loudness rule): return the Slack USER ID to mention for an ESCALATION payload,
   *  undefined for everything else (quiet-threaded). The composition wires the registry lookup
   *  + the escalation predicate; delivery just renders what it is told. */
  resolveMentionUserId?: (payload: OutboundPostPayload) => string | undefined;
  /** G — read a LOCAL file the evidenceRef points at (the founder screenshot class: a seat's
   *  file has no public URL, so it rides the EXTERNAL-UPLOAD flow into the thread). Injectable
   *  for hermetic tests; default reads the filesystem (LOCAL_ATTACHMENT_EXT, at most
   *  LOCAL_ATTACHMENT_MAX_BYTES). Return null = not a local attachment; { skipped } = an
   *  attachment that can't be sent (logged, the text still delivers). */
  readLocalImage?: (refPath: string) => LocalAttachment | null;
  log?: (msg: string) => void;
}

const LOCAL_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
/** Local evidence files uploaded into the thread: images, video (Slack plays mp4/webm/mov inline)
 *  and PDF. Wider than LOCAL_IMAGE_EXT, which gates https Block Kit image blocks. */
const LOCAL_ATTACHMENT_EXT = new Set([...LOCAL_IMAGE_EXT, ".mp4", ".webm", ".mov", ".pdf"]);
/** Well under Slack's 1 GB per-file limit, and bounded for a daemon that holds the bytes in memory. */
export const LOCAL_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export type LocalAttachment = { bytes: Uint8Array; filename: string } | { skipped: string };
const TRANSPORT_FAILURE_RECEIPT_PREFIX = "::transport-failure-receipt::";
/** #192: `<decisionId>::channel::<channel>` in the attempted store = the channel this post's first
 *  attempt was decided for (see pinChannel). Keyed like the transport-failure receipt. */
const CHANNEL_DECIDED_PREFIX = "::channel::";

function decidedChannel(attempted: Set<string>, decisionId: string): string | undefined {
  const prefix = `${decisionId}${CHANNEL_DECIDED_PREFIX}`;
  for (const key of attempted.keys()) if (key.startsWith(prefix)) return key.slice(prefix.length) || undefined;
  return undefined;
}

/** The channel this post's first attempt went to, if it has had one: its recorded channel, or, with
 *  a map now configured (pinChannel) but no record, the default channel. A post attempted before the
 *  map existed went where unmapped posts go, so its retries stay there. Undefined = not attempted yet
 *  (or no map): resolve as usual. */
function firstAttemptChannel(opts: SubsystemSlackDeliveryOpts, attempted: Set<string>, decisionId: string): string | undefined {
  return decidedChannel(attempted, decisionId) ?? (opts.pinChannel && attempted.has(decisionId) ? opts.channel : undefined);
}
const TRANSPORT_FAILURE_RECEIPT_REPAIRED = "::repaired";

function transportFailureReceiptKey(decisionId: string, failureClass: string, detail: string): string {
  const encoded = Buffer.from(JSON.stringify([failureClass, detail]), "utf8").toString("base64url");
  return `${decisionId}${TRANSPORT_FAILURE_RECEIPT_PREFIX}${encoded}`;
}

function pendingTransportFailureReceipt(
  attempted: Set<string>,
  decisionId: string,
): { key: string; failureClass: string; detail: string } | { key: string; error: string } | null {
  const prefix = `${decisionId}${TRANSPORT_FAILURE_RECEIPT_PREFIX}`;
  const key = [...attempted.keys()].find((candidate) =>
    candidate.startsWith(prefix)
      && !candidate.endsWith(TRANSPORT_FAILURE_RECEIPT_REPAIRED)
      && !attempted.has(`${candidate}${TRANSPORT_FAILURE_RECEIPT_REPAIRED}`));
  if (!key) return null;
  try {
    const parsed = JSON.parse(Buffer.from(key.slice(prefix.length), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
      return { key, error: "pending transport-failure receipt is malformed" };
    }
    return { key, failureClass: parsed[0], detail: parsed[1] };
  } catch (e) {
    return { key, error: `pending transport-failure receipt is unreadable: ${(e as Error).message}` };
  }
}

/** Default local-attachment reader: an absolute path with an attachment extension, a regular file
 *  of at most LOCAL_ATTACHMENT_MAX_BYTES, readable — else null (not an attachment), or { skipped }
 *  when it is an attachment that can't be sent (too large, missing, unreadable), so the miss is
 *  logged rather than silent. */
export function defaultReadLocalImage(refPath: string): LocalAttachment | null {
  if (!path.isAbsolute(refPath)) return null;
  if (!LOCAL_ATTACHMENT_EXT.has(path.extname(refPath).toLowerCase())) return null;
  // The path is resolved ONCE: open it, then stat and read that same descriptor, so the file checked is the file
  // sent. O_NONBLOCK keeps the open from waiting on a FIFO (refused below as not a regular file), and the read is
  // bounded by the size just checked.
  let fd: number | null = null;
  try {
    fd = fs.openSync(refPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { skipped: "not a regular file" };
    if (st.size > LOCAL_ATTACHMENT_MAX_BYTES) {
      return { skipped: `${st.size} bytes is over the ${LOCAL_ATTACHMENT_MAX_BYTES}-byte attachment cap` };
    }
    const bytes = new Uint8Array(st.size);
    let read = 0;
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return { bytes: read === bytes.length ? bytes : bytes.subarray(0, read), filename: path.basename(refPath) };
  } catch (e) {
    return { skipped: `unreadable (${(e as NodeJS.ErrnoException).code ?? "error"})` };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** #47 — only an https evidenceRef with an image-like extension may ride as a Block Kit
 *  `image` block (extension set mirrors LOCAL_IMAGE_EXT). Slack rejects the ENTIRE
 *  message with `invalid_blocks` when an image block's URL is not a real image (e.g. a
 *  GitLab issue link or a PROOF.md URL — both explicitly documented evidenceRef uses),
 *  so a non-image https ref must never become an image block. Query strings and
 *  fragments are stripped before the extension check. */
export function isHttpsImageRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  const url = ref.trim();
  if (!/^https:\/\/\S+$/.test(url)) return false;
  try {
    return LOCAL_IMAGE_EXT.has(path.extname(new URL(url).pathname).toLowerCase());
  } catch {
    return false;
  }
}

/** #47 — split an evidenceRef into an image attachment vs. a plain link. An explicit
 *  `media` array stays fully caller-controlled; otherwise an image-looking https
 *  evidenceRef becomes a Block Kit image and a non-image https evidenceRef becomes a
 *  plain link (rendered by buildEvidenceLink, never an image block). Local refs keep
 *  their existing handling (image upload flow / clean skip). */
export function evidenceAttachment(
  media: unknown,
  evidenceRef: unknown,
  summary: string | null | undefined,
): { mediaRefs: SlackMediaRef[] | undefined; evidenceLink: string | undefined } {
  if (Array.isArray(media)) return { mediaRefs: media as SlackMediaRef[], evidenceLink: undefined };
  if (typeof evidenceRef !== "string") return { mediaRefs: undefined, evidenceLink: undefined };
  const ref = evidenceRef.trim();
  if (isHttpsImageRef(ref)) {
    return { mediaRefs: [{ imageUrl: ref, altText: summary ?? "attachment" }], evidenceLink: undefined };
  }
  if (/^https:\/\/\S+$/.test(ref)) return { mediaRefs: undefined, evidenceLink: ref };
  return { mediaRefs: undefined, evidenceLink: undefined };
}

/** Build the subsystem DeliverFn. Contract mirrors the retired connector handleDecision. */
function deliverSinglePart(opts: SubsystemSlackDeliveryOpts, markEpisode = true): SubsystemDeliverFn {
  const log = opts.log ?? (() => {});
  return async (decision: OutboundDecision): Promise<SubsystemDeliveryOutcome> => {
    // Idempotent redelivery: an already-delivered decisionId is re-acked without re-posting.
    if (opts.delivered.load().has(decision.decisionId)) {
      log(`delivery: decision ${decision.decisionId} already delivered — re-ack, no re-post`);
      return { ok: true };
    }
    const q = (decision.payload ?? {}) as OutboundPostPayload & { media?: SlackMediaRef[] };
    // #192: the channel first, from this post's record when it has one, so the thread below is
    // chosen inside the channel the post actually goes to (and went to, on a retry).
    const pinned = firstAttemptChannel(opts, opts.attempted.load(), decision.decisionId);
    const channel = pinned ?? opts.resolveChannel?.(q) ?? opts.channel;
    if (!pinned && opts.pinChannel) {
      try {
        opts.attempted.mark(`${decision.decisionId}${CHANNEL_DECIDED_PREFIX}${channel}`, "channel-decided");
      } catch (e) {
        log(`channel record FAILED for ${q.qitemId ?? decision.decisionId}: ${(e as Error).message} — retained, nothing posted`);
        return { ok: false, class: "channel-unrecorded", detail: (e as Error).message };
      }
    }
    const threadTs = opts.resolveThreadTs?.(q, channel);

    // A failed HTTP outcome whose row-receipt write failed is held in the
    // existing restart-surviving attempted store. Repair that authoritative
    // transition before reconciliation can progress to a later post.
    const attempted = opts.attempted.load();
    const pendingFailure = pendingTransportFailureReceipt(attempted, decision.decisionId);
    if (pendingFailure) {
      if ("error" in pendingFailure) {
        log(`${pendingFailure.error} for ${decision.decisionId} — retained, no resend`);
        return { ok: false, class: "receipt-failed", detail: pendingFailure.error };
      }
      try {
        if (!opts.onTransportFailed) throw new Error("transport-failure receipt hook is unavailable");
        opts.onTransportFailed(q, pendingFailure.failureClass, pendingFailure.detail);
        opts.attempted.mark(
          `${pendingFailure.key}${TRANSPORT_FAILURE_RECEIPT_REPAIRED}`,
          "transport-failure-receipt-repaired",
        );
      } catch (e) {
        log(`transport-failed receipt repair FAILED for ${q.qitemId ?? decision.decisionId}: ${(e as Error).message} — retained, no resend`);
        return { ok: false, class: "receipt-failed", detail: (e as Error).message };
      }
    }

    // H — RECONCILE-BY-MARKER before any RESEND: if this decision was attempted before, the
    // prior outcome is ambiguous (a timeout may have posted). Search where the message would
    // live (the thread, else channel history) for the message's STRUCTURAL identity; FOUND →
    // already delivered, record + ack, never repost. An initial unreadable request
    // retains the decision. A partial scan warns and keeps main's at-least-once
    // retry trade-off rather than indefinitely stranding a human notification.
    // fix-r3 (R2 exactly-once): the identity is reconcileToken(decisionId) — a bounded,
    // decision-scoped token the renderer reserves OUTSIDE the clamp budget, so it is
    // GUARANTEED present in the scanned top-level text at any ordinary length, and ordinary
    // prose quoting a qitem id can never reproduce it (it embeds the daemon-minted
    // decisionId in a delimited form). Producer and scanner call the same function: one
    // identity, same bytes, both sides.
    const marker = reconcileToken(decision.decisionId);
    if (attempted.has(decision.decisionId)) {
      const scan = await fetchRecentMessageTexts(opts.botToken, channel, threadTs, opts.fetchImpl, undefined, undefined, marker);
      if (!scan.ok) {
        log(`reconcile scan failed for ${decision.decisionId} (${scan.error}) — retained, no blind repost`);
        return { ok: false, class: "reconcile-unreadable", detail: scan.error };
      }
      const matched = scan.messages.find((m) => m.text.includes(marker));
      if (matched) {
        log(`reconcile: marker "${marker}" FOUND at ts=${matched.ts || "(missing)"} — prior ambiguous post landed; ack without repost`);
        // S14 repair (R2 HOLD): the matched message's REAL Slack ts is the thread
        // anchor. Mirror the normal-post order exactly — root-open (ThreadSeatMap +
        // rebuild stamp) first, then the same-row receipt, only then durable
        // delivered/seen/release — so a reply to the REAL root routes to the row
        // owner instead of generically. A synthetic ts here was the defect.
        if (matched.ts) {
          // OPR.0.5.6.14 — same retain-and-repair contract as the normal-post
          // receipt: a throwing receipt write retains the decision for the next
          // replay (the marker stays findable; no repost can occur).
          try {
            if (threadTs === undefined) opts.onPostedRoot?.(q, matched.ts, channel);
            else opts.onPostedPart?.(q, matched.ts, threadTs, channel);
            opts.onPosted?.(q, matched.ts, threadTs);
          } catch (e) {
            log(`receipt write FAILED on reconcile for ${q.qitemId ?? decision.decisionId}: ${(e as Error).message} — retained for the next replay`);
            return { ok: false, class: "receipt-failed", detail: (e as Error).message };
          }
        } else {
          // Degraded, stated: a matched message without ts cannot anchor a thread;
          // keep the ack (never repost) but say loudly that routing stays generic.
          log(`reconcile: matched message carries NO ts — receipt degraded to synthetic; thread routing unavailable for ${q.qitemId ?? decision.decisionId}`);
          opts.onPosted?.(q, "reconciled", threadTs);
        }
        opts.delivered.mark(decision.decisionId, "reconciled-delivered");
        if (markEpisode && q.qitemId) {
          const key = q.notificationKey ?? q.qitemId;
          opts.outboundSeen.mark(key, "posted");
          opts.release?.(key);
        }
        return { ok: true };
      }
      if (scan.incomplete) {
        log(`reconcile WARNING: incomplete scan for ${decision.decisionId}: ${scan.incomplete} — marker not located; attempting one post`);
      } else {
        log(`reconcile: marker "${marker}" absent — safe to send`);
      }
    }

    // Rendered only when a post is about to happen: a message already found by its marker above is
    // acknowledged even if it would no longer render (#899: a changed sender label after it landed).
    // M1 A5b (carried over from the retired sweep): an alert's evidenceRef IS the artifact the
    // human judges. #47 — it rides as a Block Kit image ONLY when it looks like an image;
    // a non-image https ref rides as a plain link instead (Slack's invalid_blocks rejects
    // the whole message when an image block's URL is not a real image).
    const { mediaRefs, evidenceLink } = evidenceAttachment(q.media, q.evidenceRef, q.summary);
    const payload = buildOutboundMessage(
      {
        qitemId: q.qitemId ?? decision.decisionId,
        summary: q.summary,
        body: q.body,
        humanQuestions: q.humanQuestions,
        destinationSession: q.destinationSession ?? decision.entityBindingRef,
      },
      {
        sourceLabel: opts.sourceLabel,
        bodyExcerpt: opts.bodyExcerpt,
        mediaRefs,
        evidenceLink,
        // A1.2 — attribution rides every post; identity stays the app's own (postChatMessage
        // structurally cannot carry username/icon overrides — the customize-absence rail).
        attribution: attributionFromSession(q.sourceSession),
        mentionUserId: opts.resolveMentionUserId?.(q),
        // fix-r3 — the reconcile identity, reserved outside the clamp budget (same function
        // the scan above matches: one identity, same bytes, both sides).
        reconcileMarker: reconcileToken(decision.decisionId),
      },
    );

    // Marked ATTEMPTED durably BEFORE the post: from here any outcome is ambiguous until 2xx.
    opts.attempted.mark(decision.decisionId, "attempted");
    const res = await postChatMessage(
      opts.botToken,
      { channel, text: payload.text, blocks: payload.blocks, thread_ts: threadTs },
      opts.fetchImpl,
    );
    if (!res.ok) {
      const failureClass = res.status === 0 ? "transport" : `http-${res.status}`;
      // Persist the receipt input before the row write. A throwing row write
      // stays repairable across restart and blocks any later resend until the
      // authoritative transition lands.
      if (opts.onTransportFailed) {
        const receiptKey = transportFailureReceiptKey(decision.decisionId, failureClass, res.error ?? "");
        let receiptRetained = false;
        let retentionError: string | undefined;
        try {
          opts.attempted.mark(receiptKey, "transport-failure-receipt-pending");
          receiptRetained = true;
        } catch (e) {
          retentionError = (e as Error).message;
          log(`transport-failed receipt backup FAILED for ${q.qitemId ?? decision.decisionId}: ${retentionError} — authoritative row write still attempted`);
        }
        try {
          opts.onTransportFailed(q, failureClass, res.error ?? "");
        } catch (e) {
          const disposition = receiptRetained
            ? "retained for repair before resend"
            : `NOT retained; backup failed first: ${retentionError}`;
          log(`transport-failed receipt write FAILED for ${q.qitemId ?? decision.decisionId}: ${(e as Error).message} — ${disposition}`);
          return { ok: false, class: "receipt-failed", detail: (e as Error).message };
        }
        if (receiptRetained) {
          try {
            opts.attempted.mark(
              `${receiptKey}${TRANSPORT_FAILURE_RECEIPT_REPAIRED}`,
              "transport-failure-receipt-repaired",
            );
          } catch (e) {
            log(`transport-failed receipt repair marker FAILED for ${q.qitemId ?? decision.decisionId}: ${(e as Error).message} — authoritative receipt landed; pending marker retained for idempotent repair`);
            return { ok: false, class: "receipt-failed", detail: (e as Error).message };
          }
        }
      }
      return { ok: false, class: failureClass, detail: res.error };
    }
    // OPR.0.5.6.14 — the 8f291c37 shape dies by RETAIN-AND-REPAIR: a receipt
    // write that throws after a successful post is a clean retained outcome
    // (never an escaped throw); the replay reconciles by marker — the message
    // IS in the channel — and retries the idempotent receipt without reposting.
    try {
      if (threadTs === undefined) opts.onPostedRoot?.(q, res.ts, channel);
      else opts.onPostedPart?.(q, res.ts, threadTs, channel);
      opts.onPosted?.(q, res.ts, threadTs);
    } catch (e) {
      log(`receipt write FAILED after successful post for ${q.qitemId ?? decision.decisionId}: ${(e as Error).message} — retained; replay reconciles by marker and retries the idempotent receipt`);
      return { ok: false, class: "receipt-failed", detail: (e as Error).message };
    }
    // Delivered is complete only after the authoritative row receipt succeeds. A receipt
    // failure retains the decision; replay reconciles by marker and retries the idempotent receipt.
    opts.delivered.mark(decision.decisionId, "delivered");
    if (markEpisode && q.qitemId) {
      const key = q.notificationKey ?? q.qitemId;
      opts.outboundSeen.mark(key, "posted");
      opts.release?.(key);
    }

    // G — a LOCAL image evidenceRef (the founder screenshot) rides the EXTERNAL-UPLOAD flow
    // into the conversation thread (files.upload is sunset). Upload failure is fail-VISIBLE
    // but does NOT fail the decision: the text delivered; failing here would replay the whole
    // post and duplicate the human notification (the H red). https refs already rode as Block
    // Kit image blocks above; refs that are not attachments (e.g. a PROOF.md path) are a clean
    // skip, and an attachment that can't be sent is logged.
    const local = q.evidenceRef && !/^https:\/\//.test(String(q.evidenceRef))
      ? (opts.readLocalImage ?? defaultReadLocalImage)(String(q.evidenceRef))
      : null;
    if (local && "skipped" in local) {
      log(`ATTACHMENT skipped for ${q.qitemId ?? decision.decisionId}: ${path.basename(String(q.evidenceRef))} ${local.skipped} (text delivered; attachment missing)`);
    } else if (local) {
      const intoThread = threadTs ?? res.ts;
      const up = await getUploadURLExternal(opts.botToken, local.filename, local.bytes.length, opts.fetchImpl);
      if (up.ok && up.uploadUrl && up.fileId) {
        const put = await uploadBytesExternal(up.uploadUrl, local.bytes, opts.fetchImpl);
        if (put.ok) {
          const done = await completeUploadExternal(
            opts.botToken,
            // #300: the title is shown in Slack like the text, so it gets the same secret redaction.
            { files: [{ id: up.fileId, title: redactSecrets(q.summary ?? local.filename) }], channelId: channel, threadTs: intoThread },
            opts.fetchImpl,
          );
          if (done.ok) log(`uploaded ${local.filename} into thread ${intoThread ?? "(root)"} for ${q.qitemId ?? decision.decisionId}`);
          else log(`ATTACHMENT upload complete FAILED for ${q.qitemId ?? decision.decisionId}: ${done.error} (text delivered; attachment missing)`);
        } else {
          log(`ATTACHMENT byte upload FAILED for ${q.qitemId ?? decision.decisionId}: ${put.error} (text delivered; attachment missing)`);
        }
      } else {
        log(`ATTACHMENT upload-url FAILED for ${q.qitemId ?? decision.decisionId}: ${up.error} (text delivered; attachment missing)`);
      }
    }

    log(`delivered ${decision.decisionId}${q.qitemId ? ` (qitem ${q.qitemId})` : ""}`);
    return { ok: true };
  };
}

type DeliveryPart = OutboundPostPayload & { media?: SlackMediaRef[] };

/** #897 — the most Slack messages one ask may post: the primary plus its thread replies. */
export const MAX_HUMAN_MESSAGE_PARTS = 20;
const CONTINUES_NOTE = "The rest of this brief follows in this thread.";
const DETAIL_NOTE = "Supplemental detail follows in this thread.";

/** #897 — what an ask's first attempt chose: the mention it rendered and, for a split, the length of
 *  each piece. It is kept with the attempt, so a retry posts the same parts under the same ids even
 *  if the mention has changed since. */
interface DeliveryPlan { mention?: string; body?: number[]; detail?: number[] }

const DELIVERY_PLAN = "::delivery-plan::";

function recordedPlan(attempted: Set<string>, decisionId: string): DeliveryPlan | undefined {
  const prefix = `${decisionId}${DELIVERY_PLAN}`;
  // The newest plan wins: a retry that had to plan again keeps its new plan after the first.
  const key = [...attempted.keys()].filter((candidate) => candidate.startsWith(prefix)).at(-1);
  return key ? JSON.parse(Buffer.from(key.slice(prefix.length), "base64url").toString("utf8")) as DeliveryPlan : undefined;
}

/** Whether an ask's first message can already be in Slack; later parts post only after it lands. It can be if
 *  it was delivered or its receipt was kept, or if it was attempted and a scan finds its marker or reads only
 *  part of the history. An unreadable scan is reported, so the caller retains the ask instead of guessing. */
async function firstMessageMayHaveLanded(
  opts: SubsystemSlackDeliveryOpts, q: DeliveryPart, decisionId: string, firstId: string,
): Promise<"found" | "maybe" | "absent" | { unreadable: string }> {
  if (opts.delivered.load().has(firstId)) return "found";
  const attempted = opts.attempted.load();
  if ([...attempted.keys()].some((key) => key.startsWith(`${decisionId}::primary-receipt::`))) return "found";
  if (!attempted.has(firstId)) return "absent";
  const marker = reconcileToken(firstId);
  // #192: look where the first message went: its first attempt's channel, with the same precedence
  // a supplemental part uses (recorded, else this ask's channel, else the default), and that
  // channel's thread. With no map this is the default channel, as before.
  const channel = firstAttemptChannel(opts, attempted, firstId) ?? opts.resolveChannel?.(q) ?? opts.channel;
  const scan = await fetchRecentMessageTexts(opts.botToken, channel, opts.resolveThreadTs?.(q, channel), opts.fetchImpl, undefined, undefined, marker);
  if (!scan.ok) return { unreadable: scan.error ?? "reconcile scan failed" };
  if (scan.messages.some((m) => m.text.includes(marker))) return "found";
  return scan.incomplete ? "maybe" : "absent";
}

/** The pieces splitForSlack cut, replayed from their recorded lengths; undefined if they no longer add up. */
function replayPieces(text: string, lengths: number[] | undefined): string[] | undefined {
  const rest = redactSecrets(text).trimEnd();
  if (!lengths || lengths.reduce((sum, n) => sum + n, 0) !== rest.length) return undefined;
  let at = 0;
  return lengths.map((n) => rest.slice(at, (at += n)));
}

function partIdFor(decisionId: string, count: number, index: number): string {
  return count === 1 ? decisionId : `${decisionId}:part:${index + 1}`;
}

/** Render one part exactly as deliverSinglePart will, throwing HumanMessageShapeError if it can't. */
function renderPart(opts: SubsystemSlackDeliveryOpts, q: DeliveryPart, part: DeliveryPart, index: number, partId: string) {
  // #47 — preflight must mirror deliverSinglePart exactly: the same evidenceRef
  // split (image attachment vs. plain link) so the shape check sees the true payload.
  const partEvidence = evidenceAttachment(part.media, part.evidenceRef, part.summary);
  return buildOutboundMessage(part, {
    sourceLabel: opts.sourceLabel,
    attribution: attributionFromSession(part.sourceSession),
    mentionUserId: index === 0 ? opts.resolveMentionUserId?.(q) : undefined,
    reconcileMarker: reconcileToken(partId),
    mediaRefs: partEvidence.mediaRefs,
    evidenceLink: partEvidence.evidenceLink,
  });
}

/** #897 — a brief or supplemental detail too long for one message: the primary keeps the
 *  subject, the start of the brief, any options and the evidence; the rest follows as
 *  numbered replies in its thread, each sized to its own message limits. */
function splitIntoParts(opts: SubsystemSlackDeliveryOpts, q: DeliveryPart, decisionId: string, recorded?: DeliveryPlan): { parts: DeliveryPart[]; plan: DeliveryPlan } {
  const reply = (summary: string): DeliveryPart => ({ ...q, humanDetail: undefined, humanQuestions: undefined, summary, media: [], evidenceRef: null });
  const widest = `${MAX_HUMAN_MESSAGE_PARTS} of ${MAX_HUMAN_MESSAGE_PARTS}`;
  // A part's room is what its subject, options, evidence, sender and marker leave of both limits.
  const roomFor = (part: DeliveryPart, index: number, reserve = 0): number => {
    const frame = renderPart(opts, q, { ...part, body: "" }, index, partIdFor(decisionId, 2, index));
    return Math.min(SLACK_SECTION_CAP, SLACK_TEXT_CAP - frame.text.length - 1) - reserve;
  };
  const primary: DeliveryPart = { ...q, humanDetail: undefined };
  // A retry replays its first attempt's cuts, so no piece moves between the parts already posted and the rest.
  const body = replayPieces(q.body ?? "", recorded?.body) ?? splitForSlack(q.body ?? "", (i) => i === 0
    ? roomFor(primary, 0, Math.max(CONTINUES_NOTE.length, DETAIL_NOTE.length) + 2)
    : roomFor(reply(`Continued (${widest})`), i));
  const first = Math.max(body.length, 1);
  const detail = q.humanDetail
    ? replayPieces(q.humanDetail, recorded?.detail) ?? splitForSlack(q.humanDetail, (j) => roomFor(reply(`Supplemental detail (${widest})`), first + j))
    : [];
  // A brief that fits keeps the usual note; only a brief that continues says so.
  const note = body.length > 1 ? CONTINUES_NOTE : DETAIL_NOTE;
  const parts: DeliveryPart[] = [{ ...primary, body: body[0] ? `${body[0]}\n\n${note}` : note }];
  for (let k = 1; k < body.length; k++) parts.push({ ...reply(`Continued (${k + 1} of ${body.length})`), body: body[k] });
  detail.forEach((piece, j) => parts.push({ ...reply(`Supplemental detail (${j + 1} of ${detail.length})`), body: piece }));
  if (parts.length > MAX_HUMAN_MESSAGE_PARTS) {
    throw new HumanMessageShapeError(`This brief needs ${parts.length} Slack messages (maximum ${MAX_HUMAN_MESSAGE_PARTS}). Shorten it, or put the long part in a file and link it.`);
  }
  return { parts, plan: { body: body.map((piece) => piece.length), detail: detail.map((piece) => piece.length) } };
}

/** One authored primary and, optionally, one coherent supplemental reply; a brief or
 * detail too long for that is posted as more numbered thread replies (#897). The
 * existing attempted/delivered stores and marker reconciler own each stable part.
 * Preflight ALL parts before posting; the episode receipt is written only after
 * every required part. A restart retries missing parts and the final receipt. */
export function subsystemSlackDeliver(opts: SubsystemSlackDeliveryOpts): SubsystemDeliverFn {
  return async (decision) => {
    if (opts.delivered.load().has(decision.decisionId)) return { ok: true };
    const q = (decision.payload ?? {}) as DeliveryPart;
    let parts: DeliveryPart[] = q.humanDetail
      ? [
          { ...q, humanDetail: undefined, body: `${q.body ?? ""}\n\n${DETAIL_NOTE}` },
          { ...q, humanDetail: undefined, humanQuestions: undefined, summary: `Supplemental detail: ${q.summary ?? ""}`, body: q.humanDetail, media: [], evidenceRef: null },
        ]
      : [q];
    // #897 — the first attempt decides the shape from the real render and records it; a retry renders
    // with the recorded mention and cuts, so it can't switch between one message and a split or move a cut.
    let recorded: DeliveryPlan | undefined;
    try { recorded = recordedPlan(opts.attempted.load(), decision.decisionId); }
    catch (error) { return { ok: false, class: "receipt-failed", detail: `delivery plan is unreadable: ${(error as Error).message}` }; }
    const authored = parts;
    /** The parts a plan renders to, preflighted; with no plan, decide one from the real render. */
    const choose = (kept?: DeliveryPlan) => {
      const mention = kept ? kept.mention : opts.resolveMentionUserId?.(q);
      const planned: SubsystemSlackDeliveryOpts = { ...opts, resolveMentionUserId: () => mention };
      // A kept plan checks only the parts still to post: delivered parts are acknowledged, never rendered again.
      const delivered = kept ? opts.delivered.load() : new Set<string>();
      const preflight = (candidate: DeliveryPart[]) => {
        for (const [index, part] of candidate.entries()) {
          const id = partIdFor(decision.decisionId, candidate.length, index);
          if (!delivered.has(id)) renderPart(planned, q, part, index, id);
        }
      };
      if (kept?.body) {
        const split = splitIntoParts(planned, q, decision.decisionId, kept).parts;
        preflight(split);
        return { parts: split, planned, plan: kept };
      }
      try {
        preflight(authored);
        return { parts: authored, planned, plan: { mention } };
      } catch (error) {
        if (kept || !(error instanceof HumanMessageShapeError)) throw error;
        // #897 — too long for the authored parts: split, and refuse only if that can't fit.
        const split = splitIntoParts(planned, q, decision.decisionId);
        if (split.parts.length < 2) throw error;
        preflight(split.parts);
        return { parts: split.parts, planned, plan: { mention, ...split.plan } };
      }
    };
    let chosen: ReturnType<typeof choose>;
    let replanned = false;
    let partlyPosted = false;
    try {
      try {
        chosen = choose(recorded);
      } catch (error) {
        if (!recorded || !(error instanceof HumanMessageShapeError)) throw error;
        // A recorded plan that no longer renders (the sender label or the rendering changed between
        // attempts) is planned afresh, as before #897, only if none of it can be in Slack yet: new cuts or
        // ids could otherwise repeat or lose text. If some may be, the rest is refused, loudly, unless the
        // whole ask was one message that is found in Slack, which is simply delivered.
        const firstId = partIdFor(decision.decisionId, recorded.body ? 2 : authored.length, 0);
        const landed = await firstMessageMayHaveLanded(opts, q, decision.decisionId, firstId);
        if (typeof landed === "object") return { ok: false, class: "reconcile-unreadable", detail: landed.unreadable };
        if (landed !== "absent") partlyPosted = true;
        if (landed === "found" && !recorded.body && authored.length === 1) {
          // #899 — the one message is the whole ask, and it is in Slack: acknowledge it through the
          // reconcile receipt, which finds it by marker before rendering, instead of refusing it.
          const keptMention = recorded.mention;
          return await deliverSinglePart({ ...opts, resolveMentionUserId: () => keptMention })(decision);
        }
        if (partlyPosted) throw error;
        chosen = choose();
        replanned = true;
      }
    } catch (error) {
      const detail = (error as Error).message;
      try { opts.onTransportFailed?.(q, "human-message-unrenderable", detail, partlyPosted); }
      catch (receiptError) { return { ok: false, class: "receipt-failed", detail: (receiptError as Error).message }; }
      return { ok: false, class: "human-message-unrenderable", detail };
    }
    parts = chosen.parts;
    const { planned } = chosen;
    if (!recorded || replanned) {
      try { opts.attempted.mark(`${decision.decisionId}${DELIVERY_PLAN}${Buffer.from(JSON.stringify(chosen.plan)).toString("base64url")}`, "delivery-plan"); }
      catch (error) { return { ok: false, class: "receipt-failed", detail: `delivery plan not kept: ${(error as Error).message}` }; }
    }
    const partId = (index: number) => partIdFor(decision.decisionId, parts.length, index);
    if (parts.length === 1) return deliverSinglePart(planned)(decision);

    const rootPrefix = `${decision.decisionId}::primary-receipt::`;
    const retained = [...opts.attempted.load()].find((key) => key.startsWith(rootPrefix));
    let primary: { messageTs: string; threadTs?: string } | undefined = retained
      ? JSON.parse(Buffer.from(retained.slice(rootPrefix.length), "base64url").toString("utf8"))
      : undefined;
    for (const [index, part] of parts.entries()) {
      if (index > 0 && (!primary || primary.messageTs === "reconciled")) {
        return { ok: false, class: "receipt-failed", detail: "Supplemental delivery requires the actual primary Slack timestamp; retain for reconciliation." };
      }
      const outcome = await deliverSinglePart({
        ...planned,
        resolveMentionUserId: index === 0 ? planned.resolveMentionUserId : undefined,
        resolveThreadTs: index === 0 ? opts.resolveThreadTs : () => primary!.threadTs ?? primary!.messageTs,
        // #192: a supplemental part goes where the primary went (its recorded channel), never to a
        // channel re-resolved after a remap; without a record, resolution as before.
        resolveChannel: index === 0
          ? opts.resolveChannel
          : (part) => firstAttemptChannel(opts, opts.attempted.load(), partId(0)) ?? opts.resolveChannel?.(part) ?? opts.channel,
        onPostedRoot: index === 0 ? opts.onPostedRoot : undefined,
        onPosted: (_part, messageTs, threadTs) => {
          if (index !== 0) return;
          if (messageTs === "reconciled") throw new Error("Primary reconciliation has no Slack timestamp; multipart delivery remains incomplete.");
          primary = { messageTs, threadTs };
          opts.attempted.mark(rootPrefix + Buffer.from(JSON.stringify(primary)).toString("base64url"), "primary-receipt");
        },
      }, false)({ ...decision, decisionId: partId(index), payload: part });
      if (!outcome.ok) return outcome;
    }
    try {
      if (!primary) throw new Error("Primary receipt unavailable; retain multipart delivery.");
      opts.onPosted?.(q, primary.messageTs, primary.threadTs);
      opts.delivered.mark(decision.decisionId, "all-parts-delivered");
      if (q.qitemId) {
        const key = q.notificationKey ?? q.qitemId;
        opts.outboundSeen.mark(key, "posted");
        opts.release?.(key);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, class: "receipt-failed", detail: (error as Error).message };
    }
  };
}
