import { createHash } from "node:crypto";
import path from "node:path";
import type { OutboundDecision } from "../protocol.js";
import type { SubsystemDeliveryOutcome } from "../gateway-subsystem.js";
import type { OutboundPostPayload } from "../slack/outbound-driver.js";
import { MatrixClient } from "./matrix-api.js";
import { ThreadSeatMap } from "./thread-seat-map.js";
import { JsonStore } from "./state-store.js";
import { renderQuestion } from "./reactions.js";
import { OUTBOUND_OP } from "./capabilities.js";

// Matrix events have a 64 KiB ceiling including JSON framing and server fields.
// 4 KiB plain chunks leave room even for worst-case JSON escaping in both
// plain and HTML bodies, plus framing and server fields.
export const MESSAGE_CHUNK_BYTES = 4000;
export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let part = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > MESSAGE_CHUNK_BYTES) { chunks.push(part); part = ""; bytes = 0; }
    part += char; bytes += size;
  }
  if (part || !chunks.length) chunks.push(part);
  return chunks;
}
export function htmlBody(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}
export type MatrixPostPayload = OutboundPostPayload & { text?: string; formattedBody?: string; threadRootEventId?: string };
export class MatrixOutboundDriver {
  private readonly delivered: JsonStore<string[]>;
  private readonly posted: JsonStore<Record<string, string>>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly opts: {
    home: string; client: MatrixClient; map: ThreadSeatMap;
    roomFor: (ref: string) => Promise<string>; signal?: AbortSignal;
    shouldDeliver?: (payload: MatrixPostPayload) => boolean;
    onDelivered?: (payload: MatrixPostPayload, root: string, roomId: string) => void;
  }) { this.delivered = new JsonStore(path.join(opts.home, "state", "matrix-delivered.json"), []);
    this.posted = new JsonStore(path.join(opts.home, "state", "matrix-posted-parts.json"), {}); }

  deliver(decision: OutboundDecision): Promise<SubsystemDeliveryOutcome> {
    // Serialize roots and question-map writes. A retry and a sweep can otherwise
    // open two roots for one conversation while the first request is in flight.
    const pending = this.tail.then(() => this.deliverOnce(decision));
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  private async deliverOnce(decision: OutboundDecision): Promise<SubsystemDeliveryOutcome> {
    if (decision.op !== OUTBOUND_OP) return { ok: false, class: "matrix-unsupported-op" };
    if (this.opts.signal?.aborted) return { ok: false, class: "matrix-stopped" };
    if (this.delivered.read().includes(decision.decisionId)) return { ok: true };
    const payload = decision.payload as MatrixPostPayload;
    if (!payload || typeof payload !== "object") return { ok: false, class: "matrix-invalid-payload" };
    if (this.opts.shouldDeliver?.(payload) === false) return { ok: true };
    const roomId = await this.opts.roomFor(decision.entityBindingRef);
    const human = payload.destinationSession ?? decision.entityBindingRef;
    const seat = payload.sourceSession ?? "operator-agent@kernel";
    const conversationId = payload.qitemId || decision.decisionId;
    const existing = this.opts.map.resolveByConversation(human, seat, conversationId, roomId);
    // Update replies may reuse the referenced conversation; decisions always
    // have their own root so a reply never answers a different human gate.
    const referenced = payload.humanIntent === "update" && payload.replyTo
      ? this.opts.map.resolveByConversation(human, seat, payload.replyTo, roomId) : null;
    let root = payload.threadRootEventId ?? existing?.threadRootEventId ?? referenced?.threadRootEventId;
    const text = payload.text ?? [payload.summary, payload.humanDetail ?? payload.body, payload.evidenceRef].filter(Boolean).join("\n\n");
    const chunks = splitMessage(text || "OpenRig conversation");
    const transaction = (part: string) => createHash("sha256").update(`${payload.notificationKey ?? decision.decisionId}:${part}`).digest("hex");
    const send = async (part: string, body: string, formattedBody: string, threadRootEventId?: string) => {
      const key = transaction(part);
      const posted = this.posted.read()[key];
      if (posted) return { event_id: posted };
      const result = await this.opts.client.sendMessage(roomId, body, { formattedBody, threadRootEventId, transactionId: key, signal: this.opts.signal });
      this.posted.write({ ...this.posted.read(), [key]: result.event_id });
      return result;
    };
    for (const [index, chunk] of chunks.entries()) {
      // Arbitrary HTML is never sliced across tags. Long messages use escaped
      // HTML derived from each plain chunk, preserving content and valid markup.
      const formatted = chunks.length === 1 && payload.formattedBody !== undefined && Buffer.byteLength(payload.formattedBody) <= MESSAGE_CHUNK_BYTES
        ? payload.formattedBody : htmlBody(chunk);
      const result = await send(`body-${index}`, chunk, formatted, root);
      if (!root) {
        root = result.event_id;
        this.opts.map.open({ roomId, threadRootEventId: root, human, seat, conversationId });
      }
      this.opts.map.recordEvent(roomId, result.event_id, root);
    }
    for (const question of payload.ownerNotificationKind === "human-decision-resolved" ? [] : payload.humanQuestions ?? []) {
      const rendered = renderQuestion(question);
      const result = await send(`question-${question.id}`, rendered.text, htmlBody(rendered.text), root);
      this.opts.map.recordQuestion({ roomId, eventId: result.event_id, threadRootEventId: root!, human, seat, conversationId,
        questionId: question.id, emojiOptions: rendered.emojiOptions });
    }
    this.opts.map.open({ roomId, threadRootEventId: root!, human, seat, conversationId });
    this.opts.onDelivered?.(payload, root!, roomId);
    this.delivered.write([...this.delivered.read(), decision.decisionId]);
    return { ok: true };
  }
}
