// S10 — the SLACK gateway wiring: composes the in-process wire (shipped dispatcher + durable
// buffer), the chat.postMessage delivery path, the outbound queue-poll driver, and the Socket
// Mode inbound service into ONE GatewayWire the subsystem activates at daemon boot.
//
// Configuration honesty: an unconfigured/disabled connector yields an INERT wire — delivery
// refuses with a named class, no ops advertised, no drivers started — never a throw (boot
// proceeds; `rig slack status` names what is missing) and never a silent pretend-active
// delivery path.
//
// Durable-state continuity through the cutover: the SAME slice-11 state files carry over
// (slack-outbound-seen.jsonl, slack-inbound-seen.jsonl, slack-inbound-deadletter.jsonl), so
// the relay's history IS the subsystem's history — enabling the subsystem replays nothing the
// relay already delivered (the enable-time backlog rule survives the cutover by construction).

import { ChannelRecovery } from "./channel-recovery.js";
import { channelStateDigest } from "../channel-operations.js";
import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { buildInProcessWire, type GatewayWire, type SubsystemDeliverFn } from "../gateway-subsystem.js";
import { downloadPrivateFile, postChatMessage } from "./slack-api.js";
import { loadConfig } from "./config.js";
import { resolveSecret } from "./secrets.js";
import { SeenStore, DeadLetterStore, InboundReceiptStore } from "./state-store.js";
import { makeQueuePorts } from "./queue-access.js";
import { SlackOutboundDriver, OUTBOUND_OP, type OutboundPostPayload } from "./outbound-driver.js";
import { subsystemSlackDeliver } from "./slack-delivery.js";
import { InboundRouter, type SlackEvent, type SlackBlockActions, type InboundFilePort, type InboundFileResult, type StoredInboundFile, type FailedInboundFile } from "./inbound.js";
import { makeInboundSenderResolver, type RegistrySurface } from "./inbound-admission.js";
import { ThreadSeatMap, formatPostedStamp } from "./thread-seat-map.js";
import { makeThreadRouteResolver } from "./thread-routing.js";
import { resolveOutboundChannel, unsupportedChannelMapFields } from "./channel-map.js";
import { startSocketInbound, type SocketInboundHandle, type WsLike } from "./socket-inbound.js";
import { loadHumanRegistry, resolveSlackHandle } from "../human-registry.js";
import { hasLiveHumanGate, type QueueRepository } from "../../queue-repository.js";
import { formatReplyToChoice, REPLY_TO_CHOICE_ACTOR, type ReplyToChoice } from "../../reply-to-choice.js";
import { parseSessionName } from "../../session-name.js";
import type { FetchImpl } from "./slack-api.js";
import { ownerNotificationLevelAtLeast } from "../../queue-transition-log.js";
// OPR.0.5.6.1 — the delivery rules engine: ONE decision per message replaces
// the two dial-reads (the S14 default-decision stub). The legacy dial path
// survives ONLY as the stated degrade when the destination is not a
// registered human (no prefs -> no engine input).
import {
  decideDelivery,
  resolveAvailability,
  isEscalationClass,
  formatDeliveryTermination,
  DELIVERY_TERMINATION_PREFIX,
  type DeliveryDecision,
} from "../delivery-rules-engine.js";
import { armDeliveryDeferral } from "../../policies/delivery-deferral.js";
import { WatchdogJobsRepository } from "../../watchdog-jobs-repository.js";

const SECRET_BOT = "SLACK_BOT_TOKEN";
const SECRET_APP = "SLACK_APP_TOKEN";

export interface SlackWireOpts {
  home: string;
  queueRepo: QueueRepository;
  log?: (msg: string) => void;
  /** Injectable seams (tests): fetch, websocket factory, sweep cadence, registry surface. */
  fetchImpl?: FetchImpl;
  wsFactory?: (url: string) => WsLike;
  outboundIntervalMs?: number;
  inboundRetryIntervalMs?: number;
  inboundMaxConnects?: number;
  registry?: RegistrySurface;
  resolveHumanReply?: (input: { qitemId: string; actorSession: string; decision: string }) => Promise<"resolved" | "already-resolved" | "not-applicable">;
}

interface HumanReplyActionPort {
  act(input: { verb: "resolve"; qitemId: string; actorSession: string; decision: string }): Promise<unknown>;
}

/** Compose an inbound reply with Mission Control's existing human-park resolver.
 * A replay after the durable resolve but before inbound seen-mark is absorbed by
 * the typed transition, so the waiting owner is resumed exactly once. */
export function makeHumanReplyResolver(
  queueRepo: QueueRepository,
  contract: HumanReplyActionPort | undefined,
): NonNullable<SlackWireOpts["resolveHumanReply"]> {
  return async (input) => {
    if (queueRepo.getById(input.qitemId)?.humanIntent === "update") return "not-applicable";
    if (!contract) return "not-applicable";
    try {
      await contract.act({ verb: "resolve", ...input });
      return "resolved";
    } catch (error) {
      if ((error as { code?: string }).code !== "qitem_not_leg1_parked") throw error;
      const alreadyResolved = queueRepo.transitionLog.listForQitem(input.qitemId)
        .some((transition) => transition.ownerNotificationKind === "human-decision-resolved");
      if (alreadyResolved) return "already-resolved";

      // A direct human request is the inverse of the older park shape: the
      // human owns the pending row and the originating agent receives the
      // correlated inbound row. Closing the request here records the durable
      // disposition; the inbound create is already the one wake back to the
      // source, so a second nudge here would duplicate attention.
      const direct = queueRepo.getById(input.qitemId);
      if (
        direct?.state !== "pending" ||
        direct.destinationSession !== input.actorSession ||
        parseSessionName(direct.destinationSession).kind !== "external"
      ) {
        return "not-applicable";
      }
      queueRepo.update({
        qitemId: input.qitemId,
        actorSession: input.actorSession,
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: "direct human reply received",
        ownerNotificationKind: "human-decision-resolved",
      });
      return "resolved";
    }
  };
}

/**
 * OPR.0.5.6.2 — the inbound file port: Slack `url_private` → authenticated
 * download → workspace-local media file → LOCAL path for the reply row.
 * Slack owns nothing (design §2): the stored file is OUR copy of the human's
 * contribution to OUR work record; no Slack URL and no token ever leaves this
 * function toward a row. Failure is per-file and NAMED — a failed transfer
 * yields `{ name, error }`, never an exception that could cost the message.
 *
 * Safe-path discipline: filenames sanitize to a bounded [A-Za-z0-9._-] basename
 * prefixed with the event ts, a channel/message/file identity digest, and index,
 * so messages sharing a timestamp across channels cannot overwrite each other. The resolved path
 * is verified to stay inside `mediaDir` before any write.
 */
/** R1 F1 — the anchored Slack-host verdict: https + URL-parsed hostname that is
 *  exactly `slack.com` or ends with `.slack.com`. Never a substring match. */
function isSlackHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "slack.com" || u.hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

export function makeInboundFilePort(opts: {
  token: string;
  mediaDir: string;
  fetchImpl?: FetchImpl;
  mkdirp?: (dir: string) => void;
  writeFile?: (p: string, bytes: Uint8Array) => void;
  log?: (msg: string) => void;
  maxBytes?: number;
}): InboundFilePort {
  const log = opts.log ?? (() => {});
  const mkdirp = opts.mkdirp ?? ((dir: string) => { fs.mkdirSync(dir, { recursive: true }); });
  const writeFile = opts.writeFile ?? ((p: string, bytes: Uint8Array) => { fs.writeFileSync(p, bytes); });
  return {
    async transfer(files: unknown[], eventTs: string, eventChannel?: string): Promise<InboundFileResult> {
      const stored: StoredInboundFile[] = [];
      const failed: FailedInboundFile[] = [];
      mkdirp(opts.mediaDir);
      for (let i = 0; i < files.length; i++) {
        const meta = (files[i] ?? {}) as { id?: string; name?: string; mimetype?: string; url_private?: string };
        const name = String(meta.name ?? meta.id ?? `file-${i + 1}`);
        const url = meta.url_private;
        // R1 F1: ANCHORED host check — URL-parsed hostname, exact `slack.com`
        // or a dot-suffix subdomain. A substring/regex match admits lookalike
        // domains (evilslack.com) and would send the Bearer token to them.
        if (!url || !isSlackHost(url)) {
          failed.push({ name, error: "missing or non-Slack url_private" });
          continue;
        }
        const dl = await downloadPrivateFile(url, opts.token, opts.fetchImpl ?? fetch, 30_000, opts.maxBytes);
        if (!dl.ok) {
          log(`inbound file transfer FAILED name=${name} ts=${eventTs}: ${dl.error}`);
          failed.push({ name, error: dl.error });
          continue;
        }
        const safeBase = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || `file-${i + 1}`;
        const identity = createHash("sha256").update(JSON.stringify([eventChannel ?? "-", eventTs, meta.id ?? null])).digest("hex").slice(0, 20);
        const localPath = path.join(opts.mediaDir, `${eventTs.replace(/[^0-9.]/g, "")}-${identity}-${i + 1}-${safeBase}`);
        if (!path.resolve(localPath).startsWith(path.resolve(opts.mediaDir) + path.sep)) {
          failed.push({ name, error: "unsafe path refused" });
          continue;
        }
        try {
          writeFile(localPath, dl.bytes);
        } catch (e) {
          failed.push({ name, error: `local write failed: ${(e as Error).message}` });
          continue;
        }
        stored.push({ name, localPath, mimetype: meta.mimetype, bytes: dl.bytes.byteLength });
      }
      return { stored, failed };
    },
  };
}

function stateDir(home: string): string {
  return path.join(home, "state");
}

/** Build the production Slack gateway wire from config + secrets. Never throws on a missing
 *  configuration — that is an honest inert wire, not a boot failure. */
export function buildSlackGatewayWire(opts: SlackWireOpts): GatewayWire {
  const log = opts.log ?? (() => {});
  const cfg = loadConfig(opts.home);
  const ignored = unsupportedChannelMapFields(cfg);
  if (ignored.length) log(`slack channel map: IGNORING unsupported field(s) ${ignored.join(", ")} (written by a newer OpenRig?); \`rig slack status\` names them`);
  const envFile = cfg.secretsEnvFile ?? undefined;
  const bot = resolveSecret(SECRET_BOT, { envFile });
  const app = resolveSecret(SECRET_APP, { envFile });

  const outboundReady = cfg.enabled && bot !== null && cfg.channel !== null;
  const inboundReady = cfg.enabled && app !== null;

  if (!outboundReady && !inboundReady) {
    const missing = !cfg.enabled ? "connector disabled (rig slack enable)" : !bot ? "SLACK_BOT_TOKEN unresolved" : "channel unconfigured";
    log(`slack delivery not configured (${missing}) — wire is inert; dispatches would be refused honestly`);
    const inert = buildInProcessWire({
      home: opts.home,
      ops: [],
      deliver: async () => ({ ok: false, class: "slack-not-configured", detail: missing }),
      log,
    });
    return { ...inert, status: () => ({ platform: "slack", configurationDigest: channelStateDigest(cfg), outboundReady: false, inboundReady: false, recovery: { state: "unavailable", reason: "inbound-not-configured" }, inbound: { state: "not-configured" } }) };
  }

  const registrySurface: RegistrySurface = opts.registry ?? { loadHumanRegistry, resolveSlackHandle };
  const ports = makeQueuePorts(opts.queueRepo, {
    loadHumanRegistry: () => registrySurface.loadHumanRegistry(opts.home),
  });
  // OPR.0.5.6.1 — the one engine consult (AM-F5: the gateway consults the
  // engine BEFORE dispatch). Null = destination is not a registered human;
  // the caller keeps the pre-engine dial behavior (stated degrade).
  const decideForPayload = (p: OutboundPostPayload): DeliveryDecision | null => {
    const local = (p.destinationSession ?? "").split("@")[0] ?? "";
    if (!local) return null;
    const reg = registrySurface.loadHumanRegistry(opts.home);
    if (!reg.ok) return null;
    const human = reg.entities.find((e) => e.entityId === local);
    if (!human) return null;
    return decideDelivery({
      level: p.ownerNotificationLevel ?? null,
      escalation: p.humanIntent !== "update" && isEscalationClass(p.tags),
      human: {
        entityId: human.entityId,
        deliveryClass: human.prefs.deliveryClass,
        availability: resolveAvailability(human.prefs),
      },
      dials: {
        minimumLevelThatPosts: cfg.minimumLevelThatPosts,
        minimumLevelThatInterrupts: cfg.minimumLevelThatInterrupts,
      },
    });
  };
  const outboundSeen = new SeenStore(path.join(stateDir(opts.home), "slack-outbound-seen.jsonl"));
  const delivered = new SeenStore(path.join(stateDir(opts.home), "slack-delivered-decisions.jsonl"));
  const attempted = new SeenStore(path.join(stateDir(opts.home), "slack-attempted-decisions.jsonl"));

  // S10 thread routing — the map shares the daemon DB (queue rows carry the rebuild stamps).
  const threadMap = new ThreadSeatMap(opts.queueRepo.db);
  // #192 — the channel a payload posts to: its seat's (or rig's) mapped channel, else the
  // default. The seat is the row's agent side (queue-access projects it into sourceSession for
  // requests, blocked items and resolved decisions alike); an aggregate digest has none and
  // posts to the default. Only called when outbound is ready, so the default is set.
  const channelFor = (p: OutboundPostPayload): string => resolveOutboundChannel(cfg, p.sourceSession) ?? cfg.channel!;

  // OPR.0.5.6.14 — a failed post writes the transport-failed ledger transition so the
  // undelivered surface (and --verify) can name the gateway's error instead of guessing
  // from nudge telemetry. One receipt per episode.
  // #897 — an ask that can't be rendered fails the same way on every retry, so the person never
  // sees it. Tell the seat that asked, once: the notice's id derives from the ask's, so a replay
  // returns the same row instead of a second one.
  // A retry that can't post the rest of an ask some of which may already be in Slack says so.
  const notifySourceUndeliverable = (p: OutboundPostPayload, detail: string, partlyPosted = false): void => {
    const seat = p.sourceSession;
    if (!p.qitemId || !seat) return;
    const human = p.destinationSession ?? "the person";
    opts.queueRepo.create({
      qitemId: `${p.qitemId}-undeliverable`,
      sourceSession: seat,
      destinationSession: seat,
      summary: `Not delivered to ${human}: ${p.summary ?? p.qitemId}`,
      body: [
        partlyPosted
          ? `Part of your ask ${p.qitemId} may already be in Slack, but OpenRig could not post the rest, so ${human} has not seen all of it.`
          : `OpenRig could not post your ask ${p.qitemId} to Slack, so ${human} has not seen it.`,
        "",
        `Reason: ${detail}`,
        "",
        partlyPosted
          ? "Check the thread in Slack and send what's missing as a new ask. The original row stays open until you close it."
          : "Shorten it and send it as a new ask. The original row stays open until you close it.",
      ].join("\n"),
      evidenceRef: `rig queue show ${p.qitemId}`,
      tags: ["slack-undeliverable"],
    }).catch((e) => log(`undeliverable notice FAILED for ${p.qitemId}: ${(e as Error).message}`));
  };

  const recordTransportFailed = (p: OutboundPostPayload, failureClass: string, detail: string, partlyPosted?: boolean): void => {
    if (!p.qitemId) return;
    if (failureClass === "human-message-unrenderable") notifySourceUndeliverable(p, detail, partlyPosted);
    const key = p.notificationKey ?? p.qitemId;
    const alreadyRecorded = opts.queueRepo.transitionLog.listForQitem(p.qitemId).some((transition) =>
      transition.transitionNote?.startsWith("slack-owner-notification-transport-failed ")
        && transition.transitionNote.split(/\s+/).includes(`notification_key=${key}`));
    if (alreadyRecorded) return;
    opts.queueRepo.update({
      qitemId: p.qitemId,
      actorSession: "daemon@kernel",
      transitionNote: [
        "slack-owner-notification-transport-failed",
        `notification_key=${key}`,
        `class=${failureClass}`,
        `error=${detail}`,
      ].join(" "),
    });
  };

  // #96 — where a replyTo update posts. Walks back through earlier threaded updates (which
  // open no root of their own) to the item that owns the root.
  const MAX_REPLY_TO_CHAIN = 32;
  const deriveReplyToChoice = (p: OutboundPostPayload, channel: string): ReplyToChoice => {
    let item = p.replyTo ? opts.queueRepo.getById(p.replyTo) : null;
    for (let depth = 0; item && depth < MAX_REPLY_TO_CHAIN; depth++) {
      if (hasLiveHumanGate(item)) return { kind: "fallback", reason: "reference-has-live-gate", qitemId: item.qitemId };
      const root = threadMap.resolveByConversation(item.qitemId);
      if (root) {
        if (root.state === "closed") return { kind: "fallback", reason: "root-closed", threadTs: root.threadTs };
        if (root.channel !== channel) return { kind: "fallback", reason: "root-other-channel", threadTs: root.threadTs };
        if (root.human !== (p.destinationSession ?? "")) return { kind: "fallback", reason: "root-other-human", threadTs: root.threadTs };
        if (root.seat !== (p.sourceSession ?? "")) return { kind: "fallback", reason: "root-other-seat", threadTs: root.threadTs };
        return { kind: "thread", threadTs: root.threadTs };
      }
      if (!item.replyTo) return { kind: "fallback", reason: "root-missing", qitemId: item.qitemId };
      item = opts.queueRepo.getById(item.replyTo);
    }
    return item
      ? { kind: "fallback", reason: "chain-too-long", qitemId: item.qitemId }
      : { kind: "fallback", reason: "root-missing", qitemId: p.replyTo ?? "" };
  };
  // Decided ONCE and recorded on the row before the first post. Every later attempt reuses
  // the record, so a reconcile scan searches where the message actually went and --verify
  // reports what happened. If the record cannot be written, nothing posts: the delivery is
  // retained for replay and a transport-failed receipt names why, so --verify does not just
  // time out.
  // #192: with a channel map the record also names the channel the choice was made for, and every
  // retry posts there (resolveChannel below), so a remap never pairs a new channel with an old root.
  const chooseReplyToThread = (p: OutboundPostPayload, channel: string): ReplyToChoice => {
    const recorded = opts.queueRepo.replyToChoiceFor(p.qitemId);
    if (recorded) return recorded;
    const derived = deriveReplyToChoice(p, channel);
    const choice: ReplyToChoice = cfg.channelMap?.length ? { ...derived, channel } : derived;
    try {
      opts.queueRepo.update({ qitemId: p.qitemId, actorSession: REPLY_TO_CHOICE_ACTOR, transitionNote: formatReplyToChoice(choice) });
    } catch (e) {
      const detail = `reply-to thread choice could not be recorded: ${(e as Error).message}`;
      try { recordTransportFailed(p, "reply-to-choice-unrecorded", detail); }
      catch (receiptError) { log(`transport-failed receipt write FAILED for ${p.qitemId}: ${(receiptError as Error).message}`); }
      throw new Error(detail);
    }
    return choice;
  };

  // Late-bound so deliver can release the driver's in-flight guard (built after the wire).
  let releaseRef: (qitemId: string) => void = () => {};

  const deliver = outboundReady
    ? subsystemSlackDeliver({
        botToken: bot!,
        channel: cfg.channel!,
        // #192: a reply-to update whose choice is already recorded posts in that choice's channel:
        // the one it names, or, for a choice recorded without one (before any map existed), the
        // default channel it was made for. Otherwise the map. (The delivery layer first reuses the
        // channel of this post's first attempt.) With no map every branch is the default channel.
        resolveChannel: (p) => {
          const recorded = p.replyTo ? opts.queueRepo.replyToChoiceFor(p.qitemId) : null;
          return recorded ? recorded.channel ?? cfg.channel! : channelFor(p);
        },
        pinChannel: Boolean(cfg.channelMap?.length),
        sourceLabel: cfg.sourceLabel,
        fetchImpl: opts.fetchImpl,
        delivered,
        attempted,
        outboundSeen,
        release: (q) => releaseRef(q),
        // Thread reuse is durable-conversation scoped, not merely human+seat scoped.
        // Slack replies identify only the root thread. Giving two qitems the same root
        // would make an inbound reply ambiguous and could resume the wrong human gate.
        // Re-delivery/new notification episodes for one qitem still reuse its exact root.
        // #96: an update may name an earlier qitem's root; the guard lives in deriveReplyToChoice.
        resolveThreadTs: (p, channel) => {
          if (p.replyTo) {
            const choice = chooseReplyToThread(p, channel);
            if (choice.kind === "thread") return choice.threadTs;
          }
          const own = threadMap.resolveOpenForConversation(
            p.destinationSession ?? "",
            p.sourceSession ?? "",
            p.qitemId,
          );
          // #96: once an update shares this root, a new decision from its owner starts a fresh
          // root instead, so the decision never lands in a thread a reader took as FYI-only.
          if (own && !p.replyTo && opts.queueRepo.isReplyToThread(own.threadTs)) return undefined;
          // #192: with a channel map, a root in another channel than this attempt's (the seat was
          // remapped since this item's root was posted) cannot carry this post, so a fresh root
          // opens in this attempt's channel. Without a map the root is reused as it always was,
          // whatever channel it was posted in.
          if (own && cfg.channelMap?.length && own.channel !== channel) return undefined;
          return own?.threadTs;
        },
        // S14: posting and interruption are separate threshold dials over one vocabulary.
        resolveMentionUserId: (p) => {
          if (p.humanIntent === "update") return undefined;
          // OPR.0.5.6.1: the engine's decided loudness is the mention rule for
          // registered humans; the dial pair remains only for the null degrade.
          if ((p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return undefined; // notify-class aggregate, never a mention
          const fire = (p as { deliveryDeferralFire?: boolean }).deliveryDeferralFire === true;
          const decision = fire ? null : decideForPayload(p);
          const eligible = fire
            ? true // the deferred interrupt mentions at fire time — that IS the deferral's promise
            : decision
              ? decision.mention
              : Boolean(p.ownerNotificationLevel && ownerNotificationLevelAtLeast(p.ownerNotificationLevel, cfg.minimumLevelThatInterrupts));
          if (!eligible) return undefined;
          const local = (p.destinationSession ?? "").split("@")[0] ?? "";
          if (!local) return undefined;
          const reg = registrySurface.loadHumanRegistry(opts.home);
          if (!reg.ok) return undefined;
          for (const e of reg.entities) {
            if (e.entityId !== local) continue;
            for (const b of e.connectorBindings) {
              if (b.kind === "slack" && b.handle) return b.handle;
            }
          }
          return undefined;
        },
        onPostedRoot: (p, ts, channel) => {
          const human = p.destinationSession ?? "";
          const seat = p.sourceSession ?? "";
          threadMap.open({ threadTs: ts, channel, human, seat, conversationId: p.qitemId });
          // The REBUILD stamp: the queue row is the durable source the map re-derives from.
          try {
            opts.queueRepo.update({
              qitemId: p.qitemId,
              actorSession: "daemon@kernel",
              transitionNote: formatPostedStamp({ threadTs: ts, messageTs: ts, channel, human, seat, conversationId: p.qitemId }),
            });
          } catch (e) {
            // Stamp failure degrades REBUILDABILITY, not routing — loud, never fatal to delivery.
            log(`thread stamp failed for ${p.qitemId}: ${(e as Error).message}`);
          }
        },
        // #899 — a message posted into a thread for an ask maps to that ask and its seat (the thread's root
        // may be another ask's), so a reaction on it reaches the seat that asked. A digest speaks for many
        // rows and has no single asking seat, so it isn't mapped.
        // #192: a part is recorded in the channel it was posted to, so a reaction on it in a mapped
        // channel finds its ask (thread_part_map is keyed by channel and message).
        onPostedPart: (p, messageTs, threadTs, channel) => {
          const seat = p.sourceSession ?? "";
          if (!p.qitemId || !seat || (p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return;
          const human = p.destinationSession ?? "";
          threadMap.recordPart({ messageTs, channel, threadTs, seat, conversationId: p.qitemId });
          try {
            opts.queueRepo.update({
              qitemId: p.qitemId,
              actorSession: "daemon@kernel",
              transitionNote: formatPostedStamp({ threadTs, messageTs, channel, human, seat, conversationId: p.qitemId }),
            });
          } catch (e) {
            log(`reply stamp failed for ${p.qitemId}: ${(e as Error).message}`);
          }
        },
        onTransportFailed: recordTransportFailed,
        onPosted: (p, messageTs, threadTs) => {
          // v3 digest branch: transport truth first — every member receipt is
          // stamped HERE, after the real post, digest-tokened and episode-keyed.
          const digest = (p as unknown as { deliveryDigestPost?: boolean; digestId?: string; memberReceipts?: Array<{ qitemId: string; notificationKey: string; level: string; kind: string }> });
          if (digest.deliveryDigestPost && Array.isArray(digest.memberReceipts)) {
            for (const m of digest.memberReceipts) {
              if (opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(m.qitemId, m.notificationKey)) continue;
              opts.queueRepo.update({
                qitemId: m.qitemId,
                actorSession: "daemon@kernel",
                transitionNote: [
                  "slack-owner-notification-posted",
                  `notification_key=${m.notificationKey}`,
                  `level=${m.level}`,
                  `kind=${m.kind}`,
                  `message_ts=${messageTs}`,
                  `thread_ts=${threadTs ?? messageTs}`,
                  `digest=${digest.digestId ?? "unknown"}`,
                ].join(" "),
              });
            }
            return;
          }
          const key = p.notificationKey ?? p.qitemId;
          if (opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, key)) return;
          // One atomic queue transition records complete delivery and closes ONLY
          // an informational delivery obligation. This is never a human decision.
          opts.queueRepo.update({
            qitemId: p.qitemId,
            actorSession: "daemon@kernel",
            ...(p.humanIntent === "update" ? { state: "done" as const, closureReason: "no-follow-on" } : {}),
            transitionNote: [
              "slack-owner-notification-posted",
              `notification_key=${key}`,
              `level=${p.ownerNotificationLevel ?? "RECORD"}`,
              `kind=${p.ownerNotificationKind ?? "unclassified"}`,
              `message_ts=${messageTs}`,
              `thread_ts=${threadTs ?? messageTs}`,
            ].join(" "),
          });
        },
        log,
      })
    : async () => ({ ok: false as const, class: "slack-outbound-not-configured", detail: "bot token or channel missing" });

  // OPR.0.5.6.1 — decision containment ahead of the transport: log-class and
  // digest-class produce ZERO post attempts (AM-F5 tooth); an away-escalation
  // deferral arms the watchdog substrate and posts nothing now (AM-F1); an
  // away/off escalation records the single-human termination exactly once per
  // episode (A1.1, F-7). interrupt/notify fall through to the S14 delivery
  // path unchanged.
  const recordTerminationOnce = (p: OutboundPostPayload, decision: DeliveryDecision): void => {
    if (!decision.termination || !p.qitemId) return;
    const key = p.notificationKey ?? p.qitemId;
    const already = opts.queueRepo.transitionLog.listForQitem(p.qitemId).some((t) =>
      t.transitionNote?.startsWith(DELIVERY_TERMINATION_PREFIX)
        && t.transitionNote.split(/\s+/).includes(`notification_key=${key}`));
    if (already) return;
    opts.queueRepo.update({
      qitemId: p.qitemId,
      actorSession: "daemon@kernel",
      transitionNote: formatDeliveryTermination(decision.termination, key),
    });
  };
  const engineDeliver: SubsystemDeliverFn = async (decision) => {
    const p = ((decision as { payload?: unknown }).payload ?? {}) as OutboundPostPayload & { deliveryDeferralFire?: boolean };
    // The T+30 deferral FIRE executes an already-made decision — never re-consult
    // (a re-consult would re-defer: the immediate-plus-deferred shape AM-F3 forbids).
    // R2 B-3 belt: an episode that already carries its posted receipt (a replayed
    // decision, or any second mint) posts NOTHING — exactly-once by the receipt.
    // A digest post is an already-decided aggregate — never re-consulted
    // (member decisions were recorded at containment; receipts land in onPosted).
    if ((p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return deliver(decision);
    if (p.deliveryDeferralFire) {
      const fireKey = p.notificationKey ?? p.qitemId;
      if (p.qitemId && opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, fireKey)) {
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      return deliver(decision);
    }
    const ruled = p.qitemId ? decideForPayload(p) : null;
    if (ruled) {
      recordTerminationOnce(p, ruled);
      const episodeKey = p.notificationKey ?? p.qitemId;
      if (ruled.outcome === "log") {
        outboundSeen.mark(episodeKey, "log-class-contained");
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      if (ruled.outcome === "digest") {
        // R1 B-4: the MESSAGE-TIME decision is recorded on the row (with the
        // live dials already applied by the consult above); the flush consumes
        // this record and never re-decides from later registry state.
        const already = opts.queueRepo.listTransitions(p.qitemId).some((t) =>
          t.transitionNote?.startsWith("delivery-decision: digest")
            && t.transitionNote.includes(`notification_key=${episodeKey}`));
        if (!already) {
          opts.queueRepo.update({
            qitemId: p.qitemId,
            actorSession: "daemon@kernel",
            transitionNote: `delivery-decision: digest window=${ruled.digestWindow ?? "4h"} notification_key=${episodeKey}`,
          });
        }
        outboundSeen.mark(episodeKey, `digest-deferred-${ruled.digestWindow ?? "4h"}`);
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      if (ruled.deferMinutes !== undefined) {
        try {
          armDeliveryDeferral({
            jobsRepo: new WatchdogJobsRepository(opts.queueRepo.db),
            queueRepo: opts.queueRepo,
            qitemId: p.qitemId,
            entityId: (p.destinationSession ?? "").split("@")[0] ?? "unknown",
            minutes: ruled.deferMinutes,
            notificationKey: episodeKey,
          });
        } catch (e) {
          log(`deferral arm failed for ${p.qitemId}: ${(e as Error).message} — falling through to immediate notify-class delivery (fail-loud beats silent loss)`);
          return deliver(decision);
        }
        outboundSeen.mark(episodeKey, "interrupt-deferred");
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
    }
    return deliver(decision);
  };

  const wire = buildInProcessWire({
    home: opts.home,
    ops: outboundReady ? [OUTBOUND_OP] : [],
    deliver: outboundReady ? engineDeliver : deliver,
    log,
  });

  // Services are CONSTRUCTED here but started only via startServices() (post-bind, index.ts):
  // composing a daemon must never dial Slack or start pollers — the createDaemon-in-tests
  // hermeticity rule, same as every monitor in the supervision tree.
  const stops: Array<() => void> = [];
  const starts: Array<() => void> = [];
  let inboundHandle: SocketInboundHandle | undefined;
  let recovery: ChannelRecovery | undefined;

  if (outboundReady) {
    const driver = new SlackOutboundDriver({
      home: opts.home,
      queue: ports,
      seen: outboundSeen,
      filter: { minimumLevel: cfg.minimumLevelThatPosts },
      dispatch: (op, ref, payload) => wire.dispatcher.dispatch(op, ref, payload),
      intervalMs: opts.outboundIntervalMs,
      log,
    });
    releaseRef = (q) => driver.release(q);
    starts.push(() => {
      driver.start();
      log("slack outbound driver started (subsystem path)");
    });
    stops.push(() => driver.stop());
  }

  if (inboundReady) {
    const inboundSeen = new SeenStore(path.join(stateDir(opts.home), "slack-inbound-seen.jsonl"));
    const dead = new DeadLetterStore<SlackEvent>(path.join(stateDir(opts.home), "slack-inbound-deadletter.jsonl"));
    const receipts = new InboundReceiptStore(path.join(stateDir(opts.home), "slack-inbound-receipts.jsonl"));
    const registry: RegistrySurface = registrySurface;
    const router = new InboundRouter({
      queue: ports,
      seen: inboundSeen,
      deadLetter: dead,
      destination: cfg.inboundDestination,
      resolveSender: makeInboundSenderResolver(registry, opts.home),
      // S10 — deterministic thread routing: mapped thread → exactly the mapped seat; unmapped
      // or human-initiated → the configured orchestrator slot as an unrouted-signal row.
      resolveRoute: makeThreadRouteResolver({ map: threadMap, unroutedDestination: cfg.inboundDestination, log }),
      resolveHumanReply: opts.resolveHumanReply,
      // #193 — a button click records its answer on the decision the clicked root belongs to;
      // a failed hand-back is retried with the event dead-letters, and each click is confirmed
      // in the decision's thread (a bot post, so inbound never ingests it).
      recordHumanAnswer: (input) => opts.queueRepo.recordHumanAnswer(input),
      actionDeadLetter: new DeadLetterStore<SlackBlockActions>(path.join(stateDir(opts.home), "slack-inbound-action-deadletter.jsonl")),
      ...(bot ? {
        acknowledgeAnswer: async ({ channel, threadTs, text }: { channel?: string; threadTs: string; text: string }) => {
          const target = channel ?? cfg.channel;
          if (!target) return;
          const r = await postChatMessage(bot, { channel: target, thread_ts: threadTs, text }, opts.fetchImpl);
          if (!r.ok) log(`answer acknowledgement not posted thread=${threadTs}: ${r.error}`);
        },
      } : {}),
      // OPR.0.5.6.2 — inbound file transfer: wired only when the bot token exists
      // (downloads need `files:read`); absent → the router's own named-failure
      // arm keeps failure honest. Media lives beside the gateway's other durable
      // state, under the same home convention.
      ...(bot ? {
        files: makeInboundFilePort({
          token: bot,
          mediaDir: path.join(stateDir(opts.home), "slack-inbound-media"),
          fetchImpl: opts.fetchImpl,
          log,
        }),
      } : {}),
      log,
    });
    recovery = new ChannelRecovery({ channel: cfg.channel, token: bot, stateDir: stateDir(opts.home), router, fetchImpl: opts.fetchImpl });
    starts.push(() => {
      recovery!.initialize(); // persist the once-only floor before any live events
      inboundHandle = startSocketInbound(app!, router, {
        fetchImpl: opts.fetchImpl,
        wsFactory: opts.wsFactory,
        retryIntervalMs: opts.inboundRetryIntervalMs,
        inboundMaxConnects: opts.inboundMaxConnects,
        receipts,
        recovery,
        log,
      });
      log("slack socket-mode inbound started (subsystem path)");
    });
    stops.push(() => inboundHandle?.stop());
  }

  const baseStop = wire.stop;
  const baseStartServices = wire.startServices;
  let servicesLive = false;
  return {
    dispatcher: wire.dispatcher,
    startServices: () => {
      if (servicesLive) return; // idempotent — a double post-bind start must not double-poll
      servicesLive = true;
      baseStartServices?.(); // replay un-Acked decisions through delivery (restart no-loss)
      for (const s of starts) s();
    },
    stop: () => {
      for (const s of stops) { try { s(); } catch { /* best-effort */ } }
      baseStop();
    },
    status: () => ({
      platform: "slack", configurationDigest: channelStateDigest(cfg),
      outboundReady,
      inboundReady,
      recovery: recovery?.status() ?? { state: "unavailable", reason: "inbound-not-configured" },
      inbound: inboundHandle?.status() ?? { state: inboundReady ? "not-started" : "not-configured", generation: 0, reconnects: 0 },
    }),
  };
}
