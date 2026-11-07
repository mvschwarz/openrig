// Edit the posted primary, never re-render an old ask from its mutable queue body.
// Queue receipts are the durable backlog; successful edits alone get an edited receipt.
import type { QueueRepository } from "../../queue-repository.js";
import type { QueueTransition } from "../../queue-transition-log.js";
import { createHash } from "node:crypto";
import { resolveRegisteredHumanAddress } from "../human-registry.js";
import { callWebApi, type FetchImpl, type WebApiResult } from "./slack-api.js";
import { budgetLeft, HISTORY, REPLIES, MethodBackoff, newRecoveryBudget } from "./recovery-budget.js";
import { parsePostedStamp } from "./thread-seat-map.js";
import { TYPED_REPLY_HINT, CHANNEL_REPLY_HINT, HUMAN_REQUIRED_REPLY_HINT, QUESTION_BLOCK_PREFIX, escapeSlackText, redactSecrets } from "./message.js";

const UPDATE = "chat.update";
const EDITED = "slack-ask-settled";
const RATE_LIMIT = "slack-ask-edit-rate-limit";
/** The posted message itself is gone or can never be edited by us: recorded, so a restart doesn't ask Slack again. */
const UNAVAILABLE = "slack-ask-settle-unavailable";
const goneErrors = new Set(["message_not_found", "thread_not_found", "cant_update_message", "original message unavailable"]);
const STATUS_BLOCK = "or-settled";
const permanentErrors = new Set(["missing_scope", "not_in_channel", "channel_not_found", "is_archived",
  "cant_update_message", "invalid_blocks", "message_not_found", "thread_not_found", "original message unavailable"]);
const hints = new Set([TYPED_REPLY_HINT, CHANNEL_REPLY_HINT, HUMAN_REQUIRED_REPLY_HINT]);
const terminal = new Set(["done", "canceled", "denied", "failed", "handed-off"]);
const field = (note: string, key: string) => note.split(/\s+/).find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1);
type Block = { type?: string; block_id?: string; elements?: Array<{ text?: string }>; [key: string]: unknown };

/** Remove only our answer controls, retaining authored content and reconciliation identity. */
function handledMessage(message: { text: string; blocks: Block[] }, status: string) {
  let text = message.text;
  const previousStatus = message.blocks.find((b) => b.block_id === STATUS_BLOCK)?.elements?.[0]?.text;
  if (previousStatus && text.startsWith(previousStatus + "\n")) text = text.slice(previousStatus.length + 1);
  const blocks = message.blocks.flatMap((block): Block[] => {
    if (block.block_id === STATUS_BLOCK) return [];
    if (block.type === "actions" && block.block_id?.startsWith(QUESTION_BLOCK_PREFIX)) {
      // The labels remain history after their controls disappear, as in the resolved-notice render.
      const buttons = block.elements as unknown as Array<{ text?: { text?: string }; style?: string }>;
      return [{ type: "section", text: { type: "mrkdwn", text: buttons.map((b) => `• ${b.text?.text ?? ""}${b.style === "primary" ? " (recommended)" : ""}`).join("\n") } }];
    }
    const hint = block.type === "context" && block.elements?.length === 1 ? block.elements[0]?.text : undefined;
    if (!hint || !hints.has(hint)) return [block];
    // This generated hint's last occurrence, never a matching sentence earlier in the brief.
    const at = text.lastIndexOf("\n" + hint);
    if (at >= 0) text = text.slice(0, at) + text.slice(at + hint.length + 1);
    return [];
  });
  return { text: status + "\n" + text,
    blocks: [{ type: "context", block_id: STATUS_BLOCK, elements: [{ type: "mrkdwn", text: status }] }, ...blocks] };
}

function statusLine(t: QueueTransition, label?: string): string {
  const what = label ?? (t.ownerNotificationKind === "human-decision-resolved" ? "Answered" : t.state === "done" ? "Done"
    : t.state === "canceled" ? "Canceled" : terminal.has(t.state) ? t.state : "Handled");
  const note = redactSecrets((t.transitionNote ?? "").replace(/\s+/g, " ")).slice(0, 1000);
  return escapeSlackText([`${what}${t.closureReason ? ` · ${t.closureReason}` : ""}`, t.ts, `by ${t.actorSession}`, note].filter(Boolean).join(" · "));
}

export class SlackAskSettlement {
  private readonly pending = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly unavailable = new Set<string>();
  private readonly backoff = new MethodBackoff();
  private budget = newRecoveryBudget(Date.now());
  private readonly controller = new AbortController();
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = true;
  private lastFailure: string | null = null;

  constructor(private readonly opts: { queue: QueueRepository; token: string; fetchImpl?: FetchImpl; log: (message: string) => void }) {}

  start(): void {
    this.stopped = false;
    this.unsubscribe = this.opts.queue.subscribeChanges((id) => this.enqueue(id));
    for (const id of this.opts.queue.transitionLog.postedHumanAskIds()) {
      for (const transition of this.opts.queue.transitionLog.listForQitem(id)) {
        const note = transition.transitionNote ?? "";
        if (!note.startsWith(RATE_LIMIT + " ")) continue;
        const method = field(note, "method");
        const until = Number(field(note, "retry_at"));
        if (method && Number.isFinite(until)) this.backoff.hold(method, until);
      }
      this.enqueue(id);
    }
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort();
  }

  status() { return { pending: this.pending.size, lastFailure: this.lastFailure }; }

  private enqueue(id: string): void {
    if (this.stopped) return;
    if (!this.pending.has(id)) this.pending.set(id, 0);
    if (!this.running && !this.timer) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, Math.max(0, ms));
    this.timer.unref?.();
  }

  private async pump(): Promise<void> {
    this.running = true;
    try {
      while (!this.stopped && this.pending.size) {
        const now = Date.now();
        if (now >= this.budget.deadline) this.budget = newRecoveryBudget(now);
        if (!budgetLeft(this.budget, now)) { this.schedule(this.budget.deadline - now); return; }
        const next = [...this.pending].find(([, at]) => at <= now);
        if (!next) { this.schedule(Math.min(...this.pending.values()) - now); return; }
        const id = next[0];
        const wait = await this.settleOne(id);
        if (wait === null) this.pending.delete(id);
        else { this.pending.delete(id); this.pending.set(id, Date.now() + wait); }
      }
    } catch (error) {
      this.lastFailure = `settlement retained: ${(error as Error).message}`;
      this.opts.log(this.lastFailure);
      this.schedule(30_000);
    } finally { this.running = false; }
  }

  private async api(method: string, body: Record<string, unknown>): Promise<WebApiResult> {
    this.budget.calls++;
    const fetchImpl: FetchImpl = (url, init) => (this.opts.fetchImpl ?? fetch)(url, { ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, this.controller.signal]) : this.controller.signal });
    return callWebApi(method, this.opts.token, body, fetchImpl, Math.max(1, this.budget.deadline - Date.now()),
      method === HISTORY || method === REPLIES ? "get-query" : "json-post");
  }

  private failed(id: string, key: string, method: string, result: WebApiResult): number {
    this.lastFailure = `${id}: ${method} not done (${result.error ?? result.status})`;
    this.opts.log(`slack ask settlement retained: ${this.lastFailure}`);
    if (permanentErrors.has(result.error ?? "")) {
      this.unavailable.add(key);
      // Scope, membership or a rendering fault can be fixed, so those are asked again after a restart; a gone message can't.
      if (goneErrors.has(result.error ?? "")) {
        try {
          this.opts.queue.update({ qitemId: id, actorSession: "daemon@kernel",
            transitionNote: `${UNAVAILABLE}${key.slice(EDITED.length)} error=${(result.error ?? "").replace(/\s+/g, "_")}` });
        } catch (error) {
          this.opts.log(`slack ask settlement: couldn't record ${id} as unavailable (${(error as Error).message}); skipped until restart`);
        }
      }
      return 0;
    }
    const count = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, count);
    const wait = Math.max(Math.min(30_000 * 2 ** Math.min(count - 1, 7), 3_600_000), (result.retryAfterSeconds ?? 0) * 1000);
    if (result.status === 429) {
      const until = Date.now() + wait;
      this.backoff.hold(method, until);
      this.opts.queue.update({ qitemId: id, actorSession: "daemon@kernel",
        transitionNote: `${RATE_LIMIT} method=${method} retry_at=${until}` });
    }
    return wait;
  }

  private desired(id: string, episode: QueueTransition, recipient: string, transitions: QueueTransition[]) {
    const item = this.opts.queue.getById(id);
    if (!item) return undefined;
    const after = transitions.filter((t) => t.transitionId > episode.transitionId && ![
      "slack-posted ", "slack-owner-notification-posted ", EDITED + " ", RATE_LIMIT + " ", UNAVAILABLE + " ",
    ].some((prefix) => (t.transitionNote ?? "").startsWith(prefix)));
    const make = (t: QueueTransition, label?: string) => {
      const status = statusLine(t, label);
      return { status, revision: createHash("sha256").update(status).digest("hex").slice(0, 24) };
    };
    const exit = after.find((t) => terminal.has(t.state) || t.ownerNotificationKind === "human-decision-resolved"
      || (episode.state === "blocked" && t.state !== "blocked"));
    const replacement = after.find((t) => t.ownerNotificationKind === "human-required");
    if (replacement) return exit && exit.transitionId < replacement.transitionId
      ? make(exit) : make(replacement, "Asked again");
    const rerouted = after.find((t) => (t.transitionNote ?? "").startsWith("fallback-routed:"));
    if (rerouted) return make(rerouted, "Handled");
    if (terminal.has(item.state)) {
      const latest = after.filter((t) => t.state === item.state).at(-1);
      return latest ? make(latest) : undefined;
    }
    const registry = this.opts.queue.humanRegistry();
    const samePerson = (address: string | null) => address === recipient || (registry.ok &&
      resolveRegisteredHumanAddress(recipient, registry.entities) !== null &&
      resolveRegisteredHumanAddress(address, registry.entities) === resolveRegisteredHumanAddress(recipient, registry.entities));
    if (episode.state === "pending" && samePerson(item.destinationSession)) {
      const reopened = after.filter((t) => (t.transitionNote ?? "").startsWith("reopen acknowledged:")).at(-1);
      if (reopened) {
        const answered = this.opts.queue.getHumanAnswer(id, recipient) ?? this.opts.queue.committedAnswerFromAnother(id, recipient);
        return make(reopened, answered ? "Open again · Earlier answer retained" : "Open again · Reply in this thread to answer");
      }
    }
    // A reopened work row does not reopen the older park it already left. A new human park has its own episode above.
    if (exit) return make(exit);
    if (episode.state === "blocked" && item.state === "blocked" && registry.ok && !samePerson(item.blockedOn)) {
      const moved = after.at(-1);
      if (moved) return make(moved, "Handled");
    }
    return undefined;
  }

  /** null = no remaining edits; 0 = next primary; positive = retained retry. */
  private async settleOne(id: string): Promise<number | null> {
    if (!this.opts.queue.db.prepare("SELECT 1 FROM queue_items WHERE qitem_id = ?").get(id)) return null;
    const transitions = this.opts.queue.transitionLog.listForQitem(id);
    for (const receipt of transitions) {
      const note = receipt.transitionNote ?? "";
      if (!note.startsWith("slack-owner-notification-posted ") || field(note, "kind") !== "human-required" || field(note, "digest")) continue;
      const key = field(note, "notification_key");
      const episode = transitions.find((t) => `${id}:${t.transitionId}` === key);
      if (!episode) continue;
      const messageTs = field(note, "message_ts");
      const stamp = transitions.filter((t) => t.transitionId < receipt.transitionId)
        .map((t) => parsePostedStamp(t.transitionNote ?? ""))
        .filter((s) => s !== null && s.messageTs === messageTs && s.origin === "posted").at(-1);
      if (!stamp) continue; // No authoritative channel/timestamp: never guess a replacement post.
      const edited = `${EDITED} notification_key=${key} channel=${stamp.channel} message_ts=${messageTs}`;
      if (this.unavailable.has(edited)) continue;
      // Recorded as gone for this exact message; a new post of the episode has its own message_ts and is tried.
      const gone = `${UNAVAILABLE} notification_key=${key} channel=${stamp.channel} message_ts=${messageTs} `;
      if (transitions.some((t) => t.transitionNote?.startsWith(gone))) continue;
      const desired = this.desired(id, episode, stamp.human, transitions);
      if (!desired) continue;
      const lastAck = transitions.filter((t) => t.transitionNote === edited || t.transitionNote?.startsWith(edited + " ")).at(-1);
      if (lastAck && field(lastAck.transitionNote!, "revision") === desired.revision) continue;
      if (this.budget.calls + 2 > 4) return Math.max(1, this.budget.deadline - Date.now());
      const method = stamp.messageTs === stamp.threadTs ? HISTORY : REPLIES;
      const held = Math.max(this.backoff.waitMs(method, Date.now()), this.backoff.waitMs(UPDATE, Date.now()));
      if (held) return held;
      // Exact original message, including on an upgrade with only the old posted stamps.
      const read = await this.api(method, { channel: stamp.channel, limit: 1, inclusive: true,
        ...(method === HISTORY ? { latest: messageTs } : { ts: stamp.threadTs, oldest: messageTs }) });
      if (this.stopped) return null;
      if (!read.ok) return this.failed(id, edited, method, read);
      this.budget.entries++;
      const message = (Array.isArray(read.json.messages) ? read.json.messages : []).find((m) => m?.ts === messageTs);
      if (!message || typeof message.text !== "string" || !Array.isArray(message.blocks)) {
        return this.failed(id, edited, method, { ...read, error: "original message unavailable" });
      }
      if (!budgetLeft(this.budget, Date.now())) return 0;
      // A queue change during the read may add information; derive again before writing.
      const current = this.desired(id, episode, stamp.human, this.opts.queue.transitionLog.listForQitem(id));
      if (!current || this.stopped) return null;
      const update = await this.api(UPDATE, { channel: stamp.channel, ts: messageTs, ...handledMessage(message, current.status) });
      if (this.stopped) return null;
      if (!update.ok) return this.failed(id, edited, UPDATE, update);
      if (update.json.ts !== messageTs || update.json.channel !== stamp.channel) {
        return this.failed(id, edited, UPDATE, { ...update, error: "update acknowledgement did not name the requested message" });
      }
      const afterUpdate = this.desired(id, episode, stamp.human, this.opts.queue.transitionLog.listForQitem(id));
      if (afterUpdate?.revision !== current.revision) return 0; // The write landed for an obsolete state; reconcile it again.
      this.failures.delete(edited);
      this.opts.queue.update({ qitemId: id, actorSession: "daemon@kernel", transitionNote: `${edited} revision=${current.revision}` });
      return 0;
    }
    return null;
  }
}
