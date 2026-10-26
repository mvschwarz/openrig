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

import { SlackRecovery, ownedRecoveryChannels } from "./slack-recovery.js";
import { channelStateDigest } from "../channel-operations.js";
import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { buildInProcessWire, type GatewayWire, type SubsystemDeliverFn } from "../gateway-subsystem.js";
import { DispatchBuffer } from "../dispatch-buffer.js";
import { downloadPrivateFile, isSlackHost, lookupBotApp, postChatMessage } from "./slack-api.js";
import { botInboxProblems } from "./bot-inbox.js";
import { loadConfig } from "./config.js";
import { resolveSecret } from "./secrets.js";
import { SeenStore, DeadLetterStore, InboundReceiptStore, slackMicros } from "./state-store.js";
import { makeQueuePorts } from "./queue-access.js";
import { SlackOutboundDriver, OUTBOUND_OP, type OutboundPostPayload } from "./outbound-driver.js";
import { abortableSleep, subsystemSlackDeliver } from "./slack-delivery.js";
import { InboundRouter, SLACK_THREAD_ROOT_TAG, handleEnvelope, type SocketEnvelope, type SlackEvent, type SlackBlockActions, type InboundFilePort, type InboundFileResult, type StoredInboundFile, type FailedInboundFile } from "./inbound.js";
import { makeInboundSenderResolver, type RegistrySurface } from "./inbound-admission.js";
import { ThreadSeatMap, formatPostedStamp } from "./thread-seat-map.js";
import { makeThreadRouteResolver } from "./thread-routing.js";
import { resolveInboundChannelDestination, resolveOutboundChannel, unsupportedChannelMapFields } from "./channel-map.js";
import { resolveRigRepresentative } from "../../queue-owner.js";
import { recoveryTag } from "../../queue-recovery.js";
import { getSelfHostId } from "../../hosts/fanout-contract.js";
import { envelopeChannel, forwardChannelProblems, makeEnvelopeForwarder } from "./forwarding.js";
import type { HostRegistryLoadResult } from "../../hosts/hosts-registry-reader.js";
import { startSocketInbound, type SocketInboundHandle, type WsLike } from "./socket-inbound.js";
import { HUMAN_ALERT_TAG, loadHumanRegistry, resolveSlackHandle } from "../human-registry.js";
import { hasLiveHumanGate, isBlockerLive, type QueueRepository } from "../../queue-repository.js";
import { formatReplyToChoice, REPLY_TO_CHOICE_ACTOR, REPLY_TO_CHAIN_LIMIT, type ReplyToChoice } from "../../reply-to-choice.js";
import { parseSessionName } from "../../session-name.js";
import type { FetchImpl } from "./slack-api.js";
import { isHumanSeatSession } from "../../human-route-enforcer.js";
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
import { confirmReleaseAtPost, holdForQuiet } from "../../policies/quiet-release.js";
import { quietHoldFor } from "../human-quiet-windows.js";
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
  /** The host registry a hub forwards by (default: this home's hosts.yaml). */
  loadHostRegistry?: () => HostRegistryLoadResult;
  outboundIntervalMs?: number;
  inboundRetryIntervalMs?: number;
  inboundMaxConnects?: number;
  registry?: RegistrySurface;
  resolveHumanReply?: (input: { qitemId: string; actorSession: string; decision: string; messageTs?: string }) => Promise<"resolved" | "resolved-uncertain" | "already-resolved" | "not-applicable">;
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
  home?: string,
): NonNullable<SlackWireOpts["resolveHumanReply"]> {
  return async (input) => {
    const source = queueRepo.getById(input.qitemId);
    if (source?.humanIntent === "update") return "not-applicable";
    if (!contract) return "not-applicable";
    // A different person's reply to a question parked on someone else already reached the agent as their own message
    // (the inbound row, linked to the question). It doesn't resume the question, which stays parked on its person.
    if (source?.state === "blocked" && queueRepo.askedSomeoneElse(input.actorSession, source.blockedOn)) return "not-applicable";
    const uncertainDecision = `${input.decision}\n\n---\nOpenRig timing context (Slack reply ${JSON.stringify([input.actorSession, input.messageTs ?? null])}): This reply resumed the question, but its ordering against the posted question could not be confirmed. Resuming is not approval; read the person's words in context.`;
    // An acknowledgement retry must not resolve again. Match this reply's durable
    // context, not an older episode's generic resolved marker.
    if (slackMicros(input.messageTs) !== null && queueRepo.transitionLog.listForQitem(input.qitemId)
      .some((transition) => transition.ownerNotificationKind === "human-decision-resolved" && transition.transitionNote === uncertainDecision)) {
      return "resolved-uncertain";
    }
    let uncertain = false;
    if (source?.state === "blocked" && isHumanSeatSession(source.blockedOn)) {
      const episode = queueRepo.transitionLog.listForQitem(input.qitemId)
        .filter((transition) => transition.ownerNotificationKind === "human-required").at(-1);
      if (!episode) return "not-applicable";
      const key = `${input.qitemId}:${episode.transitionId}`;
      const receipt = queueRepo.transitionLog.getOwnerNotificationReceipt(input.qitemId, key);
      // A final receipt attests delivery even when reconciliation lost its timestamp.
      // Without one, ONLY a unique exact current-episode primary proves anything.
      const primary = !receipt && home ? pendingPrimaryReceipt(home, input.qitemId, key) : null;
      if (!receipt && !primary) return "not-applicable";
      const posted = slackMicros(receipt?.messageTs ?? primary?.messageTs);
      const replied = slackMicros(input.messageTs);
      if (posted !== null && replied !== null && replied <= posted) return "not-applicable";
      uncertain = Boolean(receipt?.digest) || posted === null || replied === null;
    }

    try {
      await contract.act({ verb: "resolve", ...input, decision: uncertain ? uncertainDecision : input.decision });
      return uncertain ? "resolved-uncertain" : "resolved";
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
      return queueRepo.resolveDirectHumanReply(input) ? "resolved" : "not-applicable";
    }
  };
}

/** Read positive multipart evidence without changing final receipt/ack ownership. */
function pendingPrimaryReceipt(home: string, qitemId: string, notificationKey: string): { messageTs: string } | null {
  const pending = new DispatchBuffer(home).pending().filter((decision) => {
    const p = decision.payload as Partial<OutboundPostPayload> | null;
    return decision.op === OUTBOUND_OP && p?.qitemId === qitemId
      && p.notificationKey === notificationKey && p.ownerNotificationKind === "human-required";
  });
  if (pending.length !== 1) return null;
  const prefix = `${pending[0]!.decisionId}::primary-receipt::`;
  const records = [...new SeenStore(path.join(stateDir(home), "slack-attempted-decisions.jsonl")).load()]
    .filter((id) => id.startsWith(prefix));
  if (records.length !== 1) return null;
  try {
    const receipt = JSON.parse(Buffer.from(records[0]!.slice(prefix.length), "base64url").toString("utf8"));
    return slackMicros(receipt?.messageTs) !== null ? { messageTs: receipt.messageTs } : null;
  } catch { return null; }
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
/** R1 F1 — the anchored Slack-host verdict now lives in slack-api.ts and is
 *  enforced inside `downloadPrivateFile`; the transfer-path check below keeps
 *  the per-file "missing or non-Slack url_private" failure honest before the
 *  download is even attempted. */
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

/** The status fields for the retry pass's durable custody. Counts RECORDS across the
 *  inbound-event, click and relay dead-letter files — the event file also carries reactions,
 *  and a message that left more than one record is counted once per record, so the
 *  retry pass owns exactly these records. When any file cannot be read the count is
 *  `null`, not 0: a number (or a zero) beside an unknown state still reads as "nothing
 *  stuck" to a consumer that only looks at the count, so the state and the reason tell
 *  the truth and the number says it does not know. An inert connector reports the same
 *  retained records without starting retries. */
function deadLetterBacklogFields(
  dead: DeadLetterStore<SlackEvent>,
  deadActions: DeadLetterStore<SlackBlockActions>,
  deadForwards: DeadLetterStore<unknown>,
): Record<string, unknown> {
  let records = 0;
  let reason: string | undefined;
  for (const store of [dead, deadActions, deadForwards]) {
    const result = store.readResult();
    if (result.ok) records += result.entries.length;
    else reason = reason ?? result.reason;
  }
  if (reason !== undefined) return { deadLetterBacklog: null, deadLetterBacklogState: "unknown", deadLetterBacklogReason: reason };
  return { deadLetterBacklog: records, deadLetterBacklogState: "ok" };
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
  const inboundRouting = { fallback: "local", destination: cfg.inboundDestination };
  const dead = new DeadLetterStore<SlackEvent>(path.join(stateDir(opts.home), "slack-inbound-deadletter.jsonl"));
  const deadActions = new DeadLetterStore<SlackBlockActions>(path.join(stateDir(opts.home), "slack-inbound-action-deadletter.jsonl"));
  // Retained relays belong to their original host, even after forwarding configuration changes.
  const deadForwards = new DeadLetterStore<{ host: string; envelope: SocketEnvelope }>(
    path.join(stateDir(opts.home), "slack-inbound-forward-deadletter.jsonl"));

  if (!outboundReady && !inboundReady) {
    const missing = !cfg.enabled ? "connector disabled (rig slack enable)" : !bot ? "SLACK_BOT_TOKEN unresolved" : "channel unconfigured";
    log(`slack delivery not configured (${missing}) — wire is inert; dispatches would be refused honestly`);
    const inert = buildInProcessWire({
      home: opts.home,
      ops: [],
      deliver: async () => ({ ok: false, class: "slack-not-configured", detail: missing }),
      log,
    });
    return { ...inert, status: () => ({ platform: "slack", configurationDigest: channelStateDigest(cfg), outboundReady: false, inboundReady: false, inboundRouting, recovery: { state: "unavailable", reason: "inbound-not-configured" }, inbound: { state: "not-configured" }, ...deadLetterBacklogFields(dead, deadActions, deadForwards) }) };
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
      alerted: p.humanIntent !== "update" && (p.tags ?? []).includes(HUMAN_ALERT_TAG),
      human: {
        entityId: human.entityId,
        deliveryClass: human.prefs.deliveryClass,
        availability: resolveAvailability(human.prefs),
      },
      dials: {
        minimumLevelThatPosts: cfg.minimumLevelThatPosts,
        minimumLevelThatInterrupts: cfg.minimumLevelThatInterrupts,
      },
      quiet: quietHoldFor(opts.queueRepo.db, human.entityId, new Date()),
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
  const notifySourceUndeliverable = (p: OutboundPostPayload, detail: string, partlyPosted = false, invalidBlocks = false): void => {
    const seat = p.sourceSession;
    if (!p.qitemId || !seat) return;
    const human = p.destinationSession ?? "the person";
    // A prior episode's notice must not hide this explicit Slack rejection.
    const noticeId = invalidBlocks
      ? `${p.notificationKey ?? p.qitemId}-invalid-blocks-undeliverable`
      : `${p.qitemId}-undeliverable`;
    opts.queueRepo.create({
      qitemId: noticeId,
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
        invalidBlocks
          ? "Slack rejected the message blocks. OpenRig will not retry this payload. Check its evidence links and message content, then send a corrected ask as a new queue item. The original row remains undelivered; close it when you have handled it."
          : partlyPosted
          ? "Check the thread in Slack and send what's missing as a new ask. The original row stays open until you close it."
          : "Shorten it and send it as a new ask. The original row stays open until you close it.",
      ].join("\n"),
      evidenceRef: `rig queue show ${p.qitemId}`,
      tags: ["slack-undeliverable", recoveryTag(p.qitemId)],
    }).catch((e) => log(`undeliverable notice FAILED for ${p.qitemId}: ${(e as Error).message}`));
  };

  const recordTransportFailed = (p: OutboundPostPayload, failureClass: string, detail: string, partlyPosted?: boolean): void => {
    if (!p.qitemId) return;
    if (failureClass === "human-message-unrenderable" || failureClass === "slack-invalid-blocks") {
      notifySourceUndeliverable(p, detail, partlyPosted, failureClass === "slack-invalid-blocks");
    }
    const key = p.notificationKey ?? p.qitemId;
    const previousFailure = opts.queueRepo.transitionLog.listForQitem(p.qitemId).filter((transition) =>
      transition.transitionNote?.startsWith("slack-owner-notification-transport-failed ")
        && transition.transitionNote.split(/\s+/).includes(`notification_key=${key}`)).at(-1);
    // A corrected attempt can fail transiently after a permanent rejection, and a
    // transient failure can be followed by a definite rejection. Preserve both changes.
    const alreadyRecorded = previousFailure &&
      previousFailure.transitionNote!.includes("class=slack-invalid-blocks ") === (failureClass === "slack-invalid-blocks");
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

  // #822: a person's inbound reply records the item it answers as replyTo. If its seat parks
  // that row on the person, the park is a decision and opens its own root, so only an update's
  // replyTo steers where a post goes.
  const threadReplyTo = (p: OutboundPostPayload): string | null => (p.humanIntent === "update" ? p.replyTo ?? null : null);

  // #96 — where a replyTo update posts. Walks back through earlier threaded updates (which
  // open no root of their own) to the item that owns the root.
  const MAX_REPLY_TO_CHAIN = REPLY_TO_CHAIN_LIMIT;
  const deriveReplyToChoice = (p: OutboundPostPayload, channel: string): ReplyToChoice => {
    let item = p.replyTo ? opts.queueRepo.getById(p.replyTo) : null;
    for (let depth = 0; item && depth < MAX_REPLY_TO_CHAIN; depth++) {
      if (hasLiveHumanGate(item)) return { kind: "fallback", reason: "reference-has-live-gate", qitemId: item.qitemId };
      const root = threadMap.resolveByConversation(item.qitemId);
      if (root) {
        if (root.state === "closed") return { kind: "fallback", reason: "root-closed", threadTs: root.threadTs };
        // Who the root belongs to is checked before where it is, so a reply that isn't the root's
        // says so even when it also posts in another channel.
        if (root.human !== (p.destinationSession ?? "")) return { kind: "fallback", reason: "root-other-human", threadTs: root.threadTs };
        if (root.seat !== (p.sourceSession ?? "")) return { kind: "fallback", reason: "root-other-seat", threadTs: root.threadTs };
        if (root.channel !== channel) return { kind: "fallback", reason: "root-other-channel", threadTs: root.threadTs };
        return { kind: "thread", threadTs: root.threadTs };
      }
      if (!item.replyTo) return { kind: "fallback", reason: "root-missing", qitemId: item.qitemId };
      item = opts.queueRepo.getById(item.replyTo);
    }
    return item
      ? { kind: "fallback", reason: "chain-too-long", qitemId: item.qitemId }
      : { kind: "fallback", reason: "root-missing", qitemId: p.replyTo ?? "" };
  };
  // A reply to a person's own message (a root minted from it, tagged SLACK_THREAD_ROOT_TAG) posts in
  // that message's channel, wherever the replying seat's items otherwise post: the answer goes back
  // where the person asked. Roots OpenRig posted keep #192's rule (the seat's current channel). Only a
  // reply that will thread there takes that channel: one that fails the root's checks (another seat, another
  // person, a closed root, a live gate) posts top-level in the replying seat's own channel, as before.
  const personRootChannel = (p: OutboundPostPayload): string | null => {
    let item = p.replyTo ? opts.queueRepo.getById(p.replyTo) : null;
    for (let depth = 0; item && depth < MAX_REPLY_TO_CHAIN; depth++) {
      const root = threadMap.resolveByConversation(item.qitemId);
      if (root) {
        if (!item.tags?.includes(SLACK_THREAD_ROOT_TAG)) return null;
        return deriveReplyToChoice(p, root.channel).kind === "thread" ? root.channel : null;
      }
      item = item.replyTo ? opts.queueRepo.getById(item.replyTo) : null;
    }
    return null;
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
    // The channel is recorded whenever it isn't the default, so a retry posts where the choice was made.
    const choice: ReplyToChoice = cfg.channelMap?.length || channel !== cfg.channel ? { ...derived, channel } : derived;
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

  // One run = one wire build. The abort controller lets stop() cancel anything this
  // run still has in flight — chiefly the inline rate-limit wait in postChatMessage,
  // whose stale retry must never post once a restart's replay owns the decision.
  const runCtl = new AbortController();

  // Late-bound so deliver can release the driver's in-flight guard (built after the wire).
  let releaseRef: (qitemId: string) => void = () => {};
  // The wire's own dispatcher, bound once the wire exists: a delivery step that must mint a new durable decision.
  let selfDispatch: (decisionId: string, payload: unknown) => { ok: boolean; error?: string } = () => ({ ok: false, error: "wire not built" });

  const deliver = outboundReady
    ? subsystemSlackDeliver({
        botToken: bot!,
        channel: cfg.channel!,
        // #192: a reply-to update whose choice is already recorded posts in that choice's channel:
        // the one it names, or, for a choice recorded without one (before any map existed), the
        // default channel it was made for. Otherwise the map. (The delivery layer first reuses the
        // channel of this post's first attempt.) With no map every branch is the default channel.
        resolveChannel: (p) => {
          const recorded = threadReplyTo(p) ? opts.queueRepo.replyToChoiceFor(p.qitemId) : null;
          if (recorded) return recorded.channel ?? cfg.channel!;
          return (threadReplyTo(p) ? personRootChannel(p) : null) ?? channelFor(p);
        },
        pinChannel: Boolean(cfg.channelMap?.length),
        sourceLabel: cfg.sourceLabel,
        // P6: each post names the machine it comes from, the daemon's own host id.
        machine: () => getSelfHostId(),
        fetchImpl: opts.fetchImpl,
        stopSignal: runCtl.signal,
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
          if (threadReplyTo(p)) {
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
          // A choice naming this root's channel shares it. One naming no channel shares it when its update
          // posted into this root, by channel and ts (the part the post recorded). When no post of it into a
          // root with this ts is recorded (not posted yet, or recorded before parts were kept), it shares it
          // as on main.
          if (own && !threadReplyTo(p) && (
            opts.queueRepo.isReplyToThread(own.threadTs, { channel: own.channel })
            || opts.queueRepo.unnamedReplyToChoiceRows(own.threadTs).some((id) => {
              const channels = threadMap.partChannels(id, own.threadTs);
              return channels.length === 0 || channels.includes(own.channel);
            })
          )) return undefined;
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
          if ((p as { quietRelease?: boolean }).quietRelease) return undefined; // releasing a quiet hold: posted, never a mention
          const fire = (p as { deliveryDeferralFire?: boolean }).deliveryDeferralFire === true;
          // At post time the decision was just made; if it can't be re-read now (quiet hours unreadable), no mention.
          let decision: DeliveryDecision | null;
          try { decision = fire ? null : decideForPayload(p); } catch { return undefined; }
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
          // A healthy connection receives each post back as an event; the inbound liveness watch
          // waits for it. Every post, root or part, registers once, here or in onPostedPart.
          inboundHandle?.expectEcho(ts);
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
          inboundHandle?.expectEcho(messageTs); // a multipart post's supplemental parts arrive only here
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
  // Decisions already in the dispatch buffer when this wire is built are retained from an earlier
  // run: posts that failed or never finished, which startServices() replays.
  const replayedAtStart = new Set(new DispatchBuffer(opts.home).pending().map((d) => d.decisionId));
  // A replayed notification for a row that has since left the active states is history, not news
  // (a post that failed, retried a day later): it posts nothing, and the row says why, unless the
  // episode already has its posted receipt. Returning ok drains it from the dispatch buffer.
  const dropStaleNotification = (p: OutboundPostPayload, state: string): void => {
    const key = p.notificationKey ?? p.qitemId;
    const notes = opts.queueRepo.transitionLog.listForQitem(p.qitemId).map((t) => t.transitionNote ?? "");
    const posted = notes.some((n) => n.startsWith("slack-owner-notification-posted ") && n.split(/\s+/).includes(`notification_key=${key}`));
    const note = `slack-owner-notification-dropped notification_key=${key} reason=row-not-active state=${state}`;
    if (!posted && !notes.includes(note)) {
      opts.queueRepo.update({ qitemId: p.qitemId, actorSession: "daemon@kernel", transitionNote: note });
    }
    outboundSeen.mark(key, "dropped-row-not-active");
    releaseRef(key);
  };
  // An earlier attempt of this exact decision may be in Slack with its response lost. A gate that would hold, trim, defer
  // or ack it (instead of handing it to delivery) resolves that first, through the reconciler. Found goes to delivery
  // unchanged, which records receipts for what was posted and never posts it again in another form. A post confirmed
  // partly in Slack (its first part found, the post not complete) also goes to delivery: only its own remaining parts
  // post, under its own part ids and in its own thread and channel, even during quiet hours. Never-attempted and absent
  // attempts, and a scan that couldn't finish or be read, haven't started: they go on through the gate like any other post. Where the gate posts,
  // delivery reconciles (keeping its at-least-once post for an unfinished scan); where it holds, the release posts it
  // after quiet. A decision that goes straight to delivery skips this.
  const resolveEarlierAttempt = async (decision: Parameters<SubsystemDeliverFn>[0]): Promise<Awaited<ReturnType<SubsystemDeliverFn>> | null> => {
    const landing = "landing" in deliver ? await (deliver as { landing: (d: typeof decision) => Promise<unknown> }).landing(decision) : "unattempted";
    if (landing === "found" || landing === "partial") return deliver(decision);
    return null;
  };

  // A digest post was decided before it was posted. By the time it is delivered (a buffered post replayed after a
  // restart, say), some members may already be owned elsewhere: posted (a receipt), or held for quiet hours (a hold
  // note, so the window's release job posts it). And if the recipient's quiet hours began in between, its routine
  // members are held now rather than posted into them; a member that has since become an escalation still posts.
  // The original decision only ever carries its original payload: if what's left differs, it goes out as a new
  // decision with its own id and receipts (enqueued before the original is acked), so a post under one id never has two
  // contents, and receipts bind to exactly the members posted under it. An earlier attempt of the original that may
  // have landed is resolved by the reconciler first. If the quiet state can't be read, nothing posts (see the catch).
  const deliverDigestPost = async (decision: Parameters<SubsystemDeliverFn>[0], p: OutboundPostPayload) => {
    const settled = await resolveEarlierAttempt(decision);
    if (settled) return settled;
    const recipient = (p.destinationSession ?? "").split("@")[0] ?? "";
    let quiet: ReturnType<typeof quietHoldFor>;
    try {
      quiet = recipient ? quietHoldFor(opts.queueRepo.db, recipient, new Date()) : null;
    } catch (error) {
      // An attempted digest (it may be in Slack) is retained: acked, the next flush would mint the ask again from the
      // row as it is now. A never-attempted one is acked: its members keep their digest notes, so the next flush
      // selects them again. A store check only: no Slack read on a failure path.
      if ("attempted" in deliver && (deliver as { attempted: (d: typeof decision) => boolean }).attempted(decision)) {
        log(`digest post ${decision.decisionId} retained: quiet hours couldn't be read: ${(error as Error).message}`);
        return { ok: false as const, class: "quiet-unreadable", detail: (error as Error).message };
      }
      log(`digest post ${decision.decisionId} not posted: quiet hours couldn't be read: ${(error as Error).message}`);
      return { ok: true as const };
    }
    const aggregate = (p as { memberReceipts?: Array<{ qitemId: string; notificationKey: string }> }).memberReceipts;
    const members = aggregate ?? (p.qitemId ? [{ qitemId: p.qitemId, notificationKey: p.notificationKey ?? p.qitemId }] : []);
    const owned = (m: { qitemId: string; notificationKey: string }) =>
      opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(m.qitemId, m.notificationKey)
      || opts.queueRepo.listTransitions(m.qitemId).some((t) => (t.transitionNote ?? "").startsWith("delivery-decision: quiet-hold ")
        && (t.transitionNote ?? "").split(/\s+/).includes(`notification_key=${m.notificationKey}`));
    const jobsRepo = new WatchdogJobsRepository(opts.queueRepo.db);
    const escalation = (m: { qitemId: string }) => {
      const row = opts.queueRepo.getById(m.qitemId);
      return !!row && row.humanIntent !== "update" && isEscalationClass(row.tags);
    };
    const kept = members.filter((m) => {
      if (owned(m)) return false;
      if (!quiet) return true;
      if (escalation(m)) return true;
      holdForQuiet({ queueRepo: opts.queueRepo, jobsRepo, qitemId: m.qitemId, entityId: recipient, hold: { ...quiet!, notificationKey: m.notificationKey } });
      return false;
    });
    if (kept.length === members.length) return deliver(decision); // unchanged: the original, as it is
    if (kept.length === 0 || !aggregate) return { ok: true as const }; // nothing left to post under it
    const keptIds = new Set(kept.map((m) => m.qitemId));
    const body = String(p.body ?? "").split("\n").filter((line) => [...keptIds].some((id) => line.endsWith(`[${id}]`))).join("\n");
    const summary = String(p.summary ?? "").replace(/— \d+ item\(s\)/, `— ${kept.length} item(s)`);
    const keptId = `${decision.decisionId}:kept:${createHash("sha256").update(kept.map((m) => m.notificationKey).sort().join(",")).digest("hex").slice(0, 16)}`;
    // Durable first: the new decision is in the buffer before the original is acked (returning ok). A crash between the
    // two replays the original, which computes the same kept set and id; the dispatcher accepts the pending id once.
    const res = selfDispatch(keptId, { ...p, memberReceipts: kept, body, summary });
    return res.ok ? { ok: true as const } : { ok: false as const, class: "kept-dispatch-refused", detail: res.error };
  };

  const engineDeliver: SubsystemDeliverFn = async (decision) => {
    const p = ((decision as { payload?: unknown }).payload ?? {}) as OutboundPostPayload & { deliveryDeferralFire?: boolean };
    // The decision-resolved notice is written at closure, so a closed row is its normal case.
    if (replayedAtStart.has(decision.decisionId) && p.qitemId && p.ownerNotificationKind !== "human-decision-resolved"
      && !(p as { deliveryDigestPost?: boolean }).deliveryDigestPost) {
      const state = opts.queueRepo.getById(p.qitemId)?.state;
      if (state && !isBlockerLive(state)) {
        dropStaleNotification(p, state);
        return { ok: true as const };
      }
    }
    // The T+30 deferral FIRE executes an already-made decision — never re-consult
    // (a re-consult would re-defer: the immediate-plus-deferred shape AM-F3 forbids).
    // R2 B-3 belt: an episode that already carries its posted receipt (a replayed
    // decision, or any second mint) posts NOTHING — exactly-once by the receipt.
    // A digest post is an already-decided aggregate — never re-consulted
    // (member decisions were recorded at containment; receipts land in onPosted).
    if ((p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return deliverDigestPost(decision, p);
    // Releasing an ask held for quiet hours: it posts as itself, never re-consulted (that would digest C and D again). A
    // receipt means it already did. A release can wait in the buffer (and be replayed after a restart), so it is
    // re-checked here, at post time, against the recipient's quiet, the row and the posting threshold as they are now.
    if ((p as { quietRelease?: boolean }).quietRelease) {
      const key = p.notificationKey ?? p.qitemId;
      if (p.qitemId && opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, key)) {
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      const settled = await resolveEarlierAttempt(decision);
      if (settled) return settled;
      const verdict = !p.qitemId ? "post" : await confirmReleaseAtPost({
        queueRepo: opts.queueRepo,
        jobsRepo: new WatchdogJobsRepository(opts.queueRepo.db),
        home: opts.home,
        registry: { loadHumanRegistry: () => registrySurface.loadHumanRegistry(opts.home) },
        entityId: (p.destinationSession ?? "").split("@")[0] ?? "",
        qitemId: p.qitemId,
        notificationKey: key,
      });
      if (verdict === "post") return deliver(decision);
      // Declined (the row says why) or couldn't be checked (nothing written): either way nothing posts now. Acking is
      // safe because the window's release job owns redelivery until the ask has a receipt or a disposition; keeping it
      // buffered would wait for a restart and block the job's own re-dispatch of the same decision id.
      releaseRef(p.qitemId);
      return { ok: true as const };
    }
    if (p.deliveryDeferralFire) {
      const fireKey = p.notificationKey ?? p.qitemId;
      if (p.qitemId && opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, fireKey)) {
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      return deliver(decision);
    }
    // A post confirmed partly in Slack finishes without consulting quiet hours, so it is resolved before the decision
    // (which reads them). Only a started multipart post is checked here, from the stores first, so an ordinary
    // retry isn't scanned twice; any other attempted decision is resolved at the gate below.
    const started = "unfinished" in deliver && (deliver as { unfinished: (d: typeof decision) => boolean }).unfinished(decision);
    if (started) {
      const settled = await resolveEarlierAttempt(decision);
      if (settled) return settled;
    }
    let ruled: DeliveryDecision | null;
    try {
      ruled = p.qitemId ? decideForPayload(p) : null;
    } catch (error) {
      // An attempted decision (it may be partly or wholly in Slack) is retained and nothing posts: acking it would drop
      // the post's missing parts and let the sweep offer the ask again under a new id, posting it from the start. Its
      // replay decides again once the quiet state reads. A store check only: no Slack read on a failure path.
      if ("attempted" in deliver && (deliver as { attempted: (d: typeof decision) => boolean }).attempted(decision)) {
        log(`delivery decision for attempted ${decision.decisionId} couldn't be made; retained: ${(error as Error).message}`);
        return { ok: false as const, class: "quiet-unreadable", detail: (error as Error).message };
      }
      // The decision couldn't be made (for example the person's quiet hours couldn't be read): post nothing and record
      // nothing. Releasing the in-flight guard lets the outbound sweep offer this still-unseen ask again and decide afresh.
      log(`delivery decision for ${p.qitemId} deferred: ${(error as Error).message}`);
      // Released by notification key, the guard's own key: nothing marks this ask seen, so the next sweep must see it.
      releaseRef(p.notificationKey ?? p.qitemId!);
      return { ok: true as const };
    }
    if (!started && ruled && (ruled.outcome === "log" || (ruled.outcome === "hold" && ruled.quietHold)
      || ruled.outcome === "digest" || ruled.deferMinutes !== undefined)) {
      const settled = await resolveEarlierAttempt(decision);
      if (settled) return settled;
    }
    if (ruled) {
      recordTerminationOnce(p, ruled);
      const episodeKey = p.notificationKey ?? p.qitemId;
      if (ruled.outcome === "log") {
        outboundSeen.mark(episodeKey, "log-class-contained");
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      if (ruled.outcome === "hold" && ruled.quietHold) {
        // Quiet hours: recorded on the row with its window, occurrence and revision; the release job posts it later.
        holdForQuiet({
          queueRepo: opts.queueRepo,
          jobsRepo: new WatchdogJobsRepository(opts.queueRepo.db),
          qitemId: p.qitemId,
          entityId: (p.destinationSession ?? "").split("@")[0] ?? "unknown",
          hold: { ...ruled.quietHold, notificationKey: episodeKey },
        });
        outboundSeen.mark(episodeKey, "quiet-held");
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
  selfDispatch = (decisionId, payload) =>
    wire.dispatcher.dispatch(OUTBOUND_OP, String((payload as { destinationSession?: string }).destinationSession ?? ""), payload, { decisionId });

  // Services are CONSTRUCTED here but started only via startServices() (post-bind, index.ts):
  // composing a daemon must never dial Slack or start pollers — the createDaemon-in-tests
  // hermeticity rule, same as every monitor in the supervision tree.
  const stops: Array<() => void> = [];
  const starts: Array<() => void> = [];
  let inboundHandle: SocketInboundHandle | undefined;
  let recovery: SlackRecovery | undefined;
  // Recovery covers the channels this machine owns and the threads tracked in them. The configured
  // default channel keeps its established seed; a channel newly recovered starts at adoption.
  const buildRecovery = (router: InboundRouter, seedDefault: boolean, relayed = false): SlackRecovery => new SlackRecovery({
    channels: ownedRecoveryChannels(cfg).map((channel) => (seedDefault && channel === cfg.channel ? { channel } : { channel, seed: "adoption" as const })),
    token: bot,
    stateDir: stateDir(opts.home),
    router,
    trackedThreads: (channels, closedSince) => threadMap.trackedForRecovery(channels, closedSince),
    fetchImpl: opts.fetchImpl,
    ...(relayed ? { relayed: true } : {}),
  });

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

  // A machine of a shared app receives its channels' events from the hub (routes/gateway.ts).
  let acceptForwarded: ((env: SocketEnvelope) => Promise<{ status: string; reason?: string }>) | undefined;
  let relayedReceived = 0; // envelopes a hub relayed here since this wire was built
  const forwardProblems = forwardChannelProblems(cfg);
  if (cfg.forwardChannels?.length && forwardProblems.length) log(`slack forwarding OFF: ${forwardProblems.join("; ")}`);
  const forwarding = Boolean(cfg.forwardChannels?.length && forwardProblems.length === 0 && inboundReady);

  // The router runs whenever the connector is enabled with a token: with the app-level token it
  // also holds the Socket Mode connection; without it, this machine takes its channels' events from
  // the hub that holds the shared app's connection.
  let router: InboundRouter | undefined;
  if (inboundReady || outboundReady) {
    const inboundSeen = new SeenStore(path.join(stateDir(opts.home), "slack-inbound-seen.jsonl"));
    const registry: RegistrySurface = registrySurface;
    const built = (router = new InboundRouter({
      queue: ports,
      seen: inboundSeen,
      deadLetter: dead,
      destination: cfg.inboundDestination,
      resolveSender: makeInboundSenderResolver(registry, opts.home),
      // S10 — deterministic thread routing: mapped thread → exactly the mapped seat; unmapped
      // or human-initiated → the configured orchestrator slot as an unrouted-signal row.
      resolveRoute: makeThreadRouteResolver({
        map: threadMap,
        unroutedDestination: cfg.inboundDestination,
        // A person's top-level message in a channel the map routes: its `inbound` seat or its rig's representative.
        resolveChannelDestination: (channel) =>
          resolveInboundChannelDestination(cfg, channel, (rig) => resolveRigRepresentative(opts.queueRepo.db, rig)),
        log,
      }),
      // A person's top-level message is its answer's root, marked as theirs, and stamped on their row
      // like a posted root, so a rebuild restores it as theirs.
      mintThread: (m) => {
        threadMap.open({ ...m, origin: "person" });
        try {
          opts.queueRepo.update({
            qitemId: m.conversationId,
            actorSession: "daemon@kernel",
            transitionNote: formatPostedStamp({ ...m, messageTs: m.threadTs, origin: "person" }),
          });
        } catch (e) {
          log(`thread stamp failed for ${m.conversationId}: ${(e as Error).message}`);
        }
      },
      resolveHumanReply: opts.resolveHumanReply,
      // #193 — a button click records its answer on the decision the clicked root belongs to;
      // a failed hand-back is retried with the event dead-letters, and each click is confirmed
      // in the decision's thread (a bot post, so inbound never ingests it).
      recordHumanAnswer: (input) => opts.queueRepo.recordHumanAnswer(input),
      actionDeadLetter: deadActions,
      ...(bot ? {
        // A stopped run posts nothing, and its rate-limit wait ends with the run: after a restart the click's
        // redelivery belongs to the new router, which must not race a stale retry from this one.
        acknowledgeAnswer: async ({ channel, threadTs, text }: { channel?: string; threadTs: string; text: string }) => {
          const target = channel ?? cfg.channel;
          if (!target || runCtl.signal.aborted) return false;
          const r = await postChatMessage(bot, { channel: target, thread_ts: threadTs, text }, opts.fetchImpl, undefined,
            (ms) => abortableSleep(ms, runCtl.signal));
          if (!r.ok) log(`answer acknowledgement not posted thread=${threadTs}: ${r.error}`);
          return r.ok;
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
      // Named-bot delivery: wired only with a valid botInbox and the bot token bots.info needs.
      ...(cfg.botInbox && bot && botInboxProblems(cfg).length === 0 ? {
        botInbox: {
          channel: cfg.botInbox.channel,
          destination: cfg.botInbox.destination,
          bots: cfg.botInbox.bots,
          lookupBot: (botId: string) => lookupBotApp(bot, botId, opts.fetchImpl),
        },
      } : {}),
      forward: {
        hostFor: (channel: string | undefined) => forwarding ? cfg.forwardChannels!.find((f) => f.channel === channel)?.host ?? null : null,
        send: makeEnvelopeForwarder({ fetchImpl: opts.fetchImpl as typeof fetch | undefined, loadRegistry: opts.loadHostRegistry }),
      },
      forwardDeadLetter: deadForwards,
      log,
    }));
    if (cfg.botInbox && (!bot || botInboxProblems(cfg).length > 0)) {
      log(`slack bot inbox OFF: ${!bot ? "SLACK_BOT_TOKEN unresolved (bots.info needs it)" : botInboxProblems(cfg).join("; ")}`);
    }
    // An envelope the hub relayed is handled here and never relayed again.
    acceptForwarded = (env) => {
      relayedReceived++;
      // A relayed event adopts its channel for recovery, from this local receipt time (only a channel configured here).
      if (!inboundReady) recovery?.adoptRelayed(envelopeChannel(env), Date.now());
      return handleEnvelope(env, () => {}, built, log, undefined, { relayed: true });
    };
    if (!inboundReady) {
      // No socket here, so no socket-driven retry: drain this machine's own retained events on the
      // same five-minute cadence the socket uses, once services start. The hub relays this machine's
      // channels' live events; each configured channel the hub has relayed here is also recovered,
      // from its first relayed event, so this machine, which owns it, gets what nobody received.
      const relayedRecovery = (recovery = buildRecovery(built, false, true));
      const recover = () => { void relayedRecovery.run().catch(() => log("channel recovery failed; checkpoint retained")); };
      let retryTimer: ReturnType<typeof setInterval> | undefined;
      starts.push(() => {
        relayedRecovery.initialize(); // channels adopted before a restart resume from their saved coverage
        retryTimer = setInterval(() => {
          recover();
          void built.retryDeadLetters().catch((e) => log(`slack dead-letter retry failed: ${(e as Error).message}`));
        }, opts.inboundRetryIntervalMs ?? 5 * 60 * 1000);
        retryTimer.unref?.();
      });
      stops.push(() => { relayedRecovery.stop(); if (retryTimer) clearInterval(retryTimer); });
    }
  }

  if (inboundReady && router) {
    const socketRouter = router;
    const receipts = new InboundReceiptStore(path.join(stateDir(opts.home), "slack-inbound-receipts.jsonl"));
    recovery = buildRecovery(socketRouter, true);
    starts.push(() => {
      recovery!.initialize(); // persist the once-only floor before any live events
      inboundHandle = startSocketInbound(app!, socketRouter, {
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
    ...(acceptForwarded ? { acceptForwarded } : {}),
    startServices: () => {
      if (servicesLive) return; // idempotent — a double post-bind start must not double-poll
      servicesLive = true;
      baseStartServices?.(); // replay un-Acked decisions through delivery (restart no-loss)
      for (const s of starts) s();
    },
    stop: () => {
      runCtl.abort(); // cancel this run's pending rate-limit waits before teardown
      for (const s of stops) { try { s(); } catch { /* best-effort */ } }
      baseStop();
    },
    status: () => ({
      platform: "slack", configurationDigest: channelStateDigest(cfg),
      outboundReady,
      inboundReady,
      inboundRouting,
      recovery: recovery?.status() ?? { state: "unavailable", reason: "inbound-not-configured" },
      inbound: inboundHandle?.status() ?? { state: inboundReady ? "not-started" : "not-configured", generation: 0, reconnects: 0 },
      // Durable inbound custody across event, click and relay files, even when inert.
      // Count records, not distinct messages; unreadable storage is null/unknown.
      ...deadLetterBacklogFields(dead, deadActions, deadForwards),
      // A machine with no connection of its own can take events a hub relays here; whether a hub does is
      // the hub's configuration, so this says only that it can, and how many have arrived.
      ...(router && !inboundReady ? { relayedInbound: { accepting: true, received: relayedReceived } } : {}),
      ...(forwarding ? { forwardChannels: cfg.forwardChannels!.length } : {}),
    }),
  };
}
