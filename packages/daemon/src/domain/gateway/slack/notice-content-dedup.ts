import type { QueueRepository } from "../../queue-repository.js";
import { HUMAN_ALERT_TAG } from "../human-registry.js";
import type { SubsystemDeliverFn } from "../gateway-subsystem.js";
import type { OutboundPostPayload } from "./outbound-driver.js";
import { callWebApi, type FetchImpl } from "./slack-api.js";

type LastNotice = {
  readonly payload: OutboundPostPayload;
  readonly channel: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly count: number;
  readonly status?: string;
};

/** One wire lifetime, no time window: only a delivered standing status replaces the comparison. */
export class SlackNoticeContentDedup {
  private readonly last = new Map<string, LastNotice>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: {
    queue: QueueRepository; token: string; fetchImpl?: FetchImpl; signal: AbortSignal;
    seen: (key: string) => void; log: (message: string) => void;
  }) {}

  private key(p: OutboundPostPayload): string | null {
    if (p.ownerNotificationKind !== "human-update" || p.humanIntent !== "update" || p.replyTo
      || !p.sourceSession || !p.destinationSession || !this.opts.queue.isPersonAddress(p.destinationSession)
      || p.tags?.includes(HUMAN_ALERT_TAG) || p.sharedChannel
      || ("deliveryDigestPost" in p && p.deliveryDigestPost)) return null;
    return JSON.stringify([p.sourceSession, p.destinationSession]);
  }

  posted(p: OutboundPostPayload, messageTs: string, channel: string, threadTs?: string): void {
    const key = this.key(p);
    if (key && messageTs !== "reconciled") this.last.set(key, { payload: p, messageTs, channel, threadTs, count: 1 });
  }

  async deliver(p: OutboundPostPayload, post: () => ReturnType<SubsystemDeliverFn>, resume = false): ReturnType<SubsystemDeliverFn> {
    const key = this.key(p);
    if (!key) return post();
    const previous = this.pending.get(key);
    const run = async () => {
      // Concurrent sweeps must compare with the post that actually finished before them.
      if (previous) await previous.catch(() => undefined);
      if (!resume && await this.mark(key, p)) return { ok: true as const };
      return post();
    };
    const current = run();
    this.pending.set(key, current);
    try { return await current; }
    finally { if (this.pending.get(key) === current) this.pending.delete(key); }
  }

  private async mark(key: string, p: OutboundPostPayload): Promise<boolean> {
    const last = this.last.get(key);
    // A disclosure-carrying notice never takes the repeat path: the edit
    // doesn't render the quiet-hours note, so a matching repeat would hide a
    // disclosure the normal post shows. Post normally instead.
    if (!last || p.quietUnreadable || last.payload.qitemId === p.qitemId || last.payload.summary !== p.summary || last.payload.body !== p.body
      || last.payload.humanDetail !== p.humanDetail || last.payload.evidenceRef !== p.evidenceRef
      || (p.evidenceRef && !/^https:\/\//.test(p.evidenceRef))) return false;
    const fetchImpl: FetchImpl = (url, init) => (this.opts.fetchImpl ?? fetch)(url, { ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, this.opts.signal]) : this.opts.signal });
    // Like settled asks, read the exact original primary, preserving its blocks and reconciliation marker.
    const method = last.threadTs ? "conversations.replies" : "conversations.history";
    const read = await callWebApi(method, this.opts.token, { channel: last.channel, limit: 1, inclusive: true,
      ...(last.threadTs ? { ts: last.threadTs, oldest: last.messageTs } : { latest: last.messageTs }) }, fetchImpl, 10_000, "get-query");
    const messages: unknown[] = Array.isArray(read.json.messages) ? read.json.messages : [];
    const message = messages.find((m): m is Record<string, unknown> => typeof m === "object" && m !== null && "ts" in m && m.ts === last.messageTs);
    if (!read.ok || !message || typeof message.text !== "string" || !Array.isArray(message.blocks)) {
      this.opts.log(`slack notice repeat read failed for ${p.qitemId}; posting normally`);
      return false;
    }
    const status = `sent again at ${new Date().toISOString()} (${last.count + 1} times)`;
    const text = last.status && message.text.startsWith(last.status + "\n") ? message.text.slice(last.status.length + 1) : message.text;
    const blocks: unknown[] = message.blocks;
    const update = await callWebApi("chat.update", this.opts.token, { channel: last.channel, ts: last.messageTs,
      text: status + "\n" + text,
      blocks: [{ type: "context", block_id: "or-identical-content", elements: [{ type: "mrkdwn", text: status }] },
        ...blocks.filter((b) => !(typeof b === "object" && b !== null && "block_id" in b && b.block_id === "or-identical-content"))] }, fetchImpl);
    if (!update.ok || update.json.ts !== last.messageTs || update.json.channel !== last.channel) {
      this.opts.log(`slack notice repeat edit failed for ${p.qitemId}; posting normally`);
      return false;
    }
    const notificationKey = p.notificationKey ?? p.qitemId;
    this.opts.queue.update({ qitemId: p.qitemId, actorSession: "daemon@kernel", state: "done", closureReason: "no-follow-on",
      transitionNote: `slack-owner-notification-marked notification_key=${notificationKey} reason=identical-content qitem_id=${last.payload.qitemId} channel=${last.channel} message_ts=${last.messageTs} count=${last.count + 1}` });
    this.last.set(key, { ...last, count: last.count + 1, status });
    this.opts.seen(notificationKey);
    return true;
  }
}
