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
import { buildOutboundMessage, attributionFromSession, reconcileToken, type SlackMediaRef } from "./message.js";
import type { SeenStore } from "./state-store.js";
import type { OutboundDecision } from "../protocol.js";
import type { SubsystemDeliverFn, SubsystemDeliveryOutcome } from "../gateway-subsystem.js";
import type { OutboundPostPayload } from "./outbound-driver.js";

export interface SubsystemSlackDeliveryOpts {
  botToken: string;
  channel: string;
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
   *  Wired by the thread-seat map; absent in the pre-routing composition. */
  resolveThreadTs?: (payload: OutboundPostPayload) => string | undefined;
  /** E: record a NEW root's ts so the conversation threads from here on. */
  onPostedRoot?: (payload: OutboundPostPayload, ts: string) => void;
  /** Receipt hook for every successful post, root or threaded. */
  onPosted?: (payload: OutboundPostPayload, messageTs: string, threadTs?: string) => void;
  /** F (interim loudness rule): return the Slack USER ID to mention for an ESCALATION payload,
   *  undefined for everything else (quiet-threaded). The composition wires the registry lookup
   *  + the escalation predicate; delivery just renders what it is told. */
  resolveMentionUserId?: (payload: OutboundPostPayload) => string | undefined;
  /** G — read a LOCAL image the evidenceRef points at (the founder screenshot class: a seat's
   *  file has no public URL, so it rides the EXTERNAL-UPLOAD flow into the thread). Injectable
   *  for hermetic tests; default reads the filesystem, image extensions only. Return null =
   *  not an uploadable local image. */
  readLocalImage?: (refPath: string) => { bytes: Uint8Array; filename: string } | null;
  log?: (msg: string) => void;
}

const LOCAL_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Default local-image reader: absolute path, image extension, readable — else null. */
export function defaultReadLocalImage(refPath: string): { bytes: Uint8Array; filename: string } | null {
  try {
    if (!path.isAbsolute(refPath)) return null;
    if (!LOCAL_IMAGE_EXT.has(path.extname(refPath).toLowerCase())) return null;
    const bytes = fs.readFileSync(refPath);
    return { bytes: new Uint8Array(bytes), filename: path.basename(refPath) };
  } catch {
    return null;
  }
}

/** Build the subsystem DeliverFn. Contract mirrors the retired connector handleDecision. */
export function subsystemSlackDeliver(opts: SubsystemSlackDeliveryOpts): SubsystemDeliverFn {
  const log = opts.log ?? (() => {});
  return async (decision: OutboundDecision): Promise<SubsystemDeliveryOutcome> => {
    // Idempotent redelivery: an already-delivered decisionId is re-acked without re-posting.
    if (opts.delivered.load().has(decision.decisionId)) {
      log(`delivery: decision ${decision.decisionId} already delivered — re-ack, no re-post`);
      return { ok: true };
    }
    const q = (decision.payload ?? {}) as OutboundPostPayload & { media?: SlackMediaRef[] };
    // M1 A5b (carried over from the retired sweep): an alert's evidenceRef IS the artifact the
    // human judges — an https image URL rides as a Block Kit image. buildImageBlocks stays the
    // single hygiene gate (drops non-https / secret-bearing), so the predicate lives in ONE place.
    const mediaRefs: SlackMediaRef[] | undefined = Array.isArray(q.media)
      ? q.media
      : q.evidenceRef
        ? [{ imageUrl: String(q.evidenceRef), altText: q.summary ?? "attachment" }]
        : undefined;
    const payload = buildOutboundMessage(
      {
        qitemId: q.qitemId ?? decision.decisionId,
        summary: q.summary,
        body: q.body,
        destinationSession: q.destinationSession ?? decision.entityBindingRef,
      },
      {
        sourceLabel: opts.sourceLabel,
        bodyExcerpt: opts.bodyExcerpt,
        mediaRefs,
        // A1.2 — attribution rides every post; identity stays the app's own (postChatMessage
        // structurally cannot carry username/icon overrides — the customize-absence rail).
        attribution: attributionFromSession(q.sourceSession),
        mentionUserId: opts.resolveMentionUserId?.(q),
        // fix-r3 — the reconcile identity, reserved outside the clamp budget (same function
        // the scan below matches: one identity, same bytes, both sides).
        reconcileMarker: reconcileToken(decision.decisionId),
      },
    );
    const threadTs = opts.resolveThreadTs?.(q);

    // H — RECONCILE-BY-MARKER before any RESEND: if this decision was attempted before, the
    // prior outcome is ambiguous (a timeout may have posted). Search where the message would
    // live (the thread, else channel history) for the message's STRUCTURAL identity; FOUND →
    // already delivered, record + ack, never repost. Search failure = stay ambiguous = retain
    // for the next replay (never a blind repost on an unreadable channel — a duplicate human
    // notification is the red; a delay is not).
    // fix-r3 (R2 exactly-once): the identity is reconcileToken(decisionId) — a bounded,
    // decision-scoped token the renderer reserves OUTSIDE the clamp budget, so it is
    // GUARANTEED present in the scanned top-level text at any ordinary length, and ordinary
    // prose quoting a qitem id can never reproduce it (it embeds the daemon-minted
    // decisionId in a delimited form). Producer and scanner call the same function: one
    // identity, same bytes, both sides.
    const marker = reconcileToken(decision.decisionId);
    if (opts.attempted.load().has(decision.decisionId)) {
      const scan = await fetchRecentMessageTexts(opts.botToken, opts.channel, threadTs, opts.fetchImpl);
      if (!scan.ok) {
        log(`reconcile scan failed for ${decision.decisionId} (${scan.error}) — retained, no blind repost`);
        return { ok: false, class: "reconcile-unreadable", detail: scan.error };
      }
      if (scan.texts.some((t) => t.includes(marker))) {
        log(`reconcile: marker "${marker}" FOUND — prior ambiguous post landed; ack without repost`);
        opts.delivered.mark(decision.decisionId, "reconciled-delivered");
        if (q.qitemId) {
          const key = q.notificationKey ?? q.qitemId;
          opts.outboundSeen.mark(key, "posted");
          opts.release?.(key);
        }
        return { ok: true };
      }
      log(`reconcile: marker "${marker}" absent — safe to send`);
    }

    // Marked ATTEMPTED durably BEFORE the post: from here any outcome is ambiguous until 2xx.
    opts.attempted.mark(decision.decisionId, "attempted");
    const res = await postChatMessage(
      opts.botToken,
      { channel: opts.channel, text: payload.text, blocks: payload.blocks, thread_ts: threadTs },
      opts.fetchImpl,
    );
    if (!res.ok) {
      return { ok: false, class: res.status === 0 ? "transport" : `http-${res.status}`, detail: res.error };
    }
    // Delivered: record decisionId BEFORE returning ok (a crash after this point re-acks via
    // dedup — no double-post; before it, the wire retains + replays — at-least-once, never a drop).
    opts.delivered.mark(decision.decisionId, "delivered");
    if (q.qitemId) {
      const key = q.notificationKey ?? q.qitemId;
      opts.outboundSeen.mark(key, "posted");
      opts.release?.(key);
    }
    if (res.ts && threadTs === undefined) opts.onPostedRoot?.(q, res.ts);
    if (res.ts) opts.onPosted?.(q, res.ts, threadTs);

    // G — a LOCAL image evidenceRef (the founder screenshot) rides the EXTERNAL-UPLOAD flow
    // into the conversation thread (files.upload is sunset). Upload failure is fail-VISIBLE
    // but does NOT fail the decision: the text delivered; failing here would replay the whole
    // post and duplicate the human notification (the H red). https refs already rode as Block
    // Kit image blocks above; non-image/non-existent refs are a clean skip.
    const local = q.evidenceRef && !/^https:\/\//.test(String(q.evidenceRef))
      ? (opts.readLocalImage ?? defaultReadLocalImage)(String(q.evidenceRef))
      : null;
    if (local) {
      const intoThread = threadTs ?? res.ts;
      const up = await getUploadURLExternal(opts.botToken, local.filename, local.bytes.length, opts.fetchImpl);
      if (up.ok && up.uploadUrl && up.fileId) {
        const put = await uploadBytesExternal(up.uploadUrl, local.bytes, opts.fetchImpl);
        if (put.ok) {
          const done = await completeUploadExternal(
            opts.botToken,
            { files: [{ id: up.fileId, title: q.summary ?? local.filename }], channelId: opts.channel, threadTs: intoThread },
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
