import { randomUUID } from "node:crypto";
import type { EventBus } from "./event-bus.js";
import { CoreAppAccess, CoreAppError, appObject, exactKeys, appHash, type CoreAppCredential, type CoreAppSubmission } from "./core-app-access.js";
import { humanAskAttention, appAskUnsupported } from "./human-ask-attention.js";
import { feedPerspective } from "./feed-perspective.js";
import { unansweredQuestions } from "./human-questions.js";
import { mcOperationTag, type QueueRepository, type QueueItem } from "./queue-repository.js";
import { MissionControlWriteContract, MissionControlWriteContractError, operationFingerprint, type MissionControlActionInput, type MissionControlActionResult } from "./mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "./mission-control/mission-control-action-log.js";

interface Binding {
  job: "human-answer"; actor: string; requestId: string; questionId: string; episodeKey: string | null; expectedRevision: string;
  answer: { kind: "option"; optionId: string } | { kind: "typed-reply"; text: string };
}
interface Checkpoint { revision: string; before: QueueItem; workIds: string[] }
const parse = <T>(value: string | null): T | null => value ? JSON.parse(value) as T : null;

/** Composition only: the existing write contract owns answer validation, return, close, audit and permission handoff. */
export class CoreAppJob {
  readonly epoch = randomUUID();
  private readonly inFlight = new Map<string, Promise<Record<string, unknown>>>();
  constructor(readonly access: CoreAppAccess, readonly queue: QueueRepository, readonly bus: EventBus,
    private readonly writes: MissionControlWriteContract, private readonly log: MissionControlActionLog) {}

  cursor(seq = this.bus.maxSeq()): string { return Buffer.from(`${this.epoch}:${seq}`).toString("base64url"); }
  cursorSequence(cursor: string): number | null {
    const decoded = Buffer.from(cursor, "base64url").toString();
    const [epoch, raw, extra] = decoded.split(":");
    return epoch === this.epoch && extra === undefined && /^\d+$/.test(raw ?? "") && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  }
  snapshot<T>(read: () => T): T & { readAt: string; cursor: string } {
    return this.access.db.transaction(() => ({ ...read(), readAt: new Date().toISOString(), cursor: this.cursor() }))();
  }
  actor(credential: CoreAppCredential, value: unknown): string { return this.access.authorizeActor(credential, value); }
  private episodeKey(requestId: string): string | null {
    // A direct ask's creation notification is not a re-park episode. Preserve genuine parked episodes only.
    return this.queue.listTransitions(requestId).some(t => t.state === "blocked") ? this.queue.currentHumanRequiredEpisode(requestId)?.key ?? null : null;
  }
  links(requestId: string, actor: string) {
    const path = `/api/apps/v1/requests/${encodeURIComponent(requestId)}`, query = `?actor=${encodeURIComponent(actor)}`;
    return { self: path + query, result: `${path}/result${query}` };
  }
  request(credential: CoreAppCredential, requestId: string, actor: string) {
    const item = this.queue.getById(requestId);
    if (!item) throw new CoreAppError("request_not_found", 404);
    const unsupportedReason = appAskUnsupported(this.queue, item);
    return { requestId, asker: item.sourceSession, askedPerson: item.destinationSession,
      actor: { address: actor, assurance: "app-attributed", appId: credential.appId }, state: item.state,
      decisionRevision: this.queue.decisionRevision(item), episodeKey: this.episodeKey(requestId),
      body: item.body, humanDetail: item.humanDetail ?? null, questions: item.humanQuestions ?? [], humanAnswers: item.humanAnswers ?? {},
      answer: unsupportedReason ? null : { job: "human-answer", forms: ["option", "typed-reply"] },
      ...(unsupportedReason ? { unsupportedReason } : {}), links: this.links(requestId, actor) };
  }
  needsMe(credential: CoreAppCredential, actor: string) {
    return this.snapshot(() => {
      const { current, partial } = humanAskAttention(this.queue);
      const view = feedPerspective(this.queue, actor);
      return { version: 1, sources: [{ source: "queue", state: partial ? "partial" : "available" }],
        requests: current.filter(item => view.inView(item.destinationSession) && !appAskUnsupported(this.queue, item))
          .map(item => this.request(credential, item.qitemId, actor)) };
    });
  }
  private row(appId: string, answerId: string): CoreAppSubmission | undefined {
    return this.access.db.prepare("SELECT * FROM core_app_submissions WHERE app_id = ? AND answer_id = ?").get(appId, answerId) as CoreAppSubmission | undefined;
  }
  private input(binding: Binding, appId: string, answerId: string): MissionControlActionInput {
    return { verb: "answer", qitemId: binding.requestId, actorSession: binding.actor, identityProvenance: "claimed:v1", expectedRevision: binding.expectedRevision,
      ...(binding.answer.kind === "option" ? { questionId: binding.questionId, optionId: binding.answer.optionId } : { decision: binding.answer.text }),
      auditNotes: { operationId: `core-app:${appId}:${answerId}`, app: { appId, actorAssurance: "app-attributed", answerId } } };
  }
  private binding(credential: CoreAppCredential, value: unknown): Binding {
    const body = appObject(value); exactKeys(body, ["job", "actor", "requestId", "questionId", "episodeKey", "expectedRevision", "answer"]);
    if (body.job !== "human-answer") throw new CoreAppError("unsupported_job", 422);
    const actor = this.actor(credential, body.actor);
    for (const key of ["requestId", "questionId", "expectedRevision"] as const) if (typeof body[key] !== "string" || !body[key]) throw new CoreAppError("invalid_answer_binding", 422);
    if (body.episodeKey !== null && typeof body.episodeKey !== "string") throw new CoreAppError("invalid_answer_binding", 422);
    const answer = appObject(body.answer);
    if (answer.kind === "option") {
      exactKeys(answer, ["kind", "optionId"]);
      if (typeof answer.optionId !== "string" || !answer.optionId) throw new CoreAppError("invalid_option", 422);
    } else if (answer.kind === "typed-reply") {
      exactKeys(answer, ["kind", "text"]);
      if (typeof answer.text !== "string" || !answer.text.trim() || answer.text.includes("\0") || Buffer.byteLength(answer.text, "utf8") > 16384) throw new CoreAppError("invalid_answer_text", 422);
      answer.text = answer.text.trim();
    } else throw new CoreAppError("unsupported_answer_form", 422);
    return { job: "human-answer", actor, requestId: body.requestId as string, questionId: body.questionId as string,
      episodeKey: body.episodeKey as string | null, expectedRevision: body.expectedRevision as string,
      answer: answer.kind === "option" ? { kind: "option", optionId: answer.optionId as string } : { kind: "typed-reply", text: answer.text as string } };
  }
  private answerLinks(answerId: string, binding: Binding) {
    const links = this.links(binding.requestId, binding.actor);
    return { self: `/api/apps/v1/answers/${encodeURIComponent(answerId)}?actor=${encodeURIComponent(binding.actor)}`, request: links.self, result: links.result };
  }
  private receipt(appId: string, answerId: string, binding: Binding, result: MissionControlActionResult) {
    return { answerId, appId, actor: { address: binding.actor, assurance: "app-attributed" }, requestId: binding.requestId,
      questionId: binding.questionId, episodeKey: binding.episodeKey, expectedRevision: binding.expectedRevision, answer: binding.answer, replayed: false,
      submission: { state: "committed", actionId: result.actionId, recordedAt: result.auditedAt,
        outcome: result.answer!.outcome, decisionRevisionAfter: result.decisionRevision, unanswered: result.answer!.unanswered },
      links: this.answerLinks(answerId, binding) };
  }
  /** Read-only: only proven own effects with an unchanged decision can be repaired. */
  private recovery(row: CoreAppSubmission, binding: Binding) {
    const item = this.queue.getById(binding.requestId), checkpoint = parse<Checkpoint>(row.checkpoint_json);
    const input = this.input(binding, row.app_id, row.answer_id), operation = operationFingerprint(input);
    const reply = this.queue.getHumanAnswer(binding.requestId, binding.actor);
    const ownReply = reply?.tags?.includes(mcOperationTag(operation)) ? reply : null;
    const action = this.log.findOperation(binding.requestId, operation);
    if (action?.auditNotes?.appReceipt) return { receipt: action.auditNotes.appReceipt as Record<string, unknown>, revision: null, retry: false };
    if (!item || item.contentErasedAt) return { code: "source_unavailable", revision: null, retry: false };
    const current = this.queue.decisionRevision(item);
    const withoutOwnReply = this.queue.decisionRevision(item, { excludeOperationReply: operation });
    const original = checkpoint?.before;
    // Another surface may have finished closing this exact original return. Its own close/answer fields are excluded
    // only after checking the original question/recipient/episode and the operation-tagged durable return.
    const sameQuestion = original && JSON.stringify([item.body, item.humanIntent, item.humanQuestions, item.destinationSession, item.blockedOn,
      this.episodeKey(item.qitemId)]) === JSON.stringify([original.body, original.humanIntent, original.humanQuestions,
      original.destinationSession, original.blockedOn, binding.episodeKey]);
    if (ownReply && item.state === "done" && sameQuestion) return { revision: current, retry: true };
    const expected = checkpoint?.revision ?? binding.expectedRevision;
    if (item.state === "pending" && withoutOwnReply === expected) return { revision: current, retry: true };
    return { code: ownReply || checkpoint?.revision !== binding.expectedRevision ? "recovery_conflict" : "decision_revision_changed", revision: current, retry: false };
  }
  readAnswer(credential: CoreAppCredential, answerId: string, actor: string) {
    const row = this.row(credential.appId, answerId);
    if (!row) throw new CoreAppError("answer_not_found", 404);
    if (row.erased_at) return { answerId, submission: { state: "source_unavailable" }, retrySameSubmission: false };
    const binding = parse<Binding>(row.binding_json)!;
    if (binding.actor !== actor) throw new CoreAppError("answer_not_found", 404);
    const saved = parse<Record<string, unknown>>(row.receipt_json);
    if (saved) return { ...saved, replayed: true };
    const recovery = this.recovery(row, binding);
    if (recovery.receipt) return { ...recovery.receipt, replayed: true };
    return { answerId, appId: credential.appId, requestId: binding.requestId, actor: { address: actor, assurance: "app-attributed" },
      submission: { state: recovery.retry ? "incomplete" : "conflict", ...(recovery.code ? { conflictCode: recovery.code } : {}) },
      retrySameSubmission: recovery.retry, currentRevision: recovery.revision, links: this.answerLinks(answerId, binding) };
  }
  async submit(credential: CoreAppCredential, answerId: string, value: unknown): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(answerId)) throw new CoreAppError("invalid_answer_id", 422);
    const binding = this.binding(credential, value), hash = appHash(JSON.stringify(binding));
    const key = `${credential.appId}:${answerId}`;
    const existing = this.row(credential.appId, answerId);
    if (existing && existing.binding_hash !== hash) throw new CoreAppError("answer_id_conflict", 409);
    if (existing?.erased_at) throw new CoreAppError("source_unavailable", 409, { answerId, retrySameSubmission: false });
    if (this.inFlight.has(key)) return { ...await this.inFlight.get(key)!, replayed: true };
    const promise = this.perform(credential, answerId, binding, hash);
    this.inFlight.set(key, promise);
    try { return await promise; } finally { this.inFlight.delete(key); }
  }
  private async perform(credential: CoreAppCredential, answerId: string, binding: Binding, hash: string): Promise<Record<string, unknown>> {
    const db = this.access.db;
    let row = this.row(credential.appId, answerId);
    let expectedRevision = binding.expectedRevision;
    if (row) {
      const saved = parse<Record<string, unknown>>(row.receipt_json);
      if (saved) return { ...saved, replayed: true };
      const recovery = this.recovery(row, binding);
      if (recovery.receipt) return { ...recovery.receipt, replayed: true };
      if (!recovery.retry) throw new CoreAppError(recovery.code!, 409, { answerId, currentRevision: recovery.revision, links: this.answerLinks(answerId, binding), retrySameSubmission: false });
      expectedRevision = recovery.revision!;
    } else {
      // Synchronous validation/reservation before the existing owner reaches any delivery await.
      db.transaction(() => {
        const item = this.queue.getById(binding.requestId);
        if (!item) throw new CoreAppError("request_not_found", 404);
        const reason = appAskUnsupported(this.queue, item);
        if (reason) throw new CoreAppError(reason, 422);
        if (this.queue.decisionRevision(item) !== binding.expectedRevision) throw new CoreAppError("decision_revision_changed", 409);
        if ((this.episodeKey(item.qitemId)) !== binding.episodeKey) throw new CoreAppError("episode_changed", 409);
        const question = item.humanQuestions!.find(q => q.id === binding.questionId);
        const answer = binding.answer;
        if (!question || answer.kind === "option" && !question.options.some(o => o.id === answer.optionId)) throw new CoreAppError("invalid_question_option", 422);
        if (binding.answer.kind === "typed-reply" && unansweredQuestions(item.humanQuestions!, item.humanAnswers ?? {})[0]?.id !== binding.questionId) throw new CoreAppError("typed_reply_question_mismatch", 409);
        const workIds = (db.prepare("SELECT qitem_id FROM queue_items WHERE blocked_on = ? ORDER BY rowid LIMIT 101").all(binding.requestId) as Array<{ qitem_id: string }>).map(row => row.qitem_id);
        const checkpoint: Checkpoint = { before: item, revision: binding.expectedRevision, workIds };
        db.prepare("INSERT INTO core_app_submissions (app_id, answer_id, request_id, binding_hash, binding_json, checkpoint_json) VALUES (?, ?, ?, ?, ?, ?)")
          .run(credential.appId, answerId, binding.requestId, hash, JSON.stringify(binding), JSON.stringify(checkpoint));
      })();
      row = this.row(credential.appId, answerId)!;
    }
    const checkpoint = parse<Checkpoint>(row.checkpoint_json)!;
    const input = this.input(binding, credential.appId, answerId), operation = operationFingerprint(input);
    let receipt: Record<string, unknown> | null = null;
    try {
      await this.writes.act({ ...input, expectedRevision, appSubmission: {
        checkpoint: item => {
          checkpoint.revision = this.queue.decisionRevision(item, { excludeOperationReply: operation });
          db.prepare("UPDATE core_app_submissions SET checkpoint_json = ? WHERE app_id = ? AND answer_id = ? AND erased_at IS NULL")
            .run(JSON.stringify(checkpoint), credential.appId, answerId);
        },
        verify: () => {
          const recovery = this.recovery(this.row(credential.appId, answerId)!, binding);
          if (!recovery.retry) throw new CoreAppError("recovery_conflict", 409, { retrySameSubmission: false });
        },
        finalize: result => {
          receipt = this.receipt(credential.appId, answerId, binding, result);
          db.prepare("UPDATE core_app_submissions SET receipt_json = ? WHERE app_id = ? AND answer_id = ? AND erased_at IS NULL")
            .run(JSON.stringify(receipt), credential.appId, answerId);
          return receipt;
        },
      } });
    } catch (error) {
      const fresh = this.row(credential.appId, answerId)!;
      const recovery = this.recovery(fresh, binding);
      const retry = recovery.retry;
      if (error instanceof MissionControlWriteContractError || retry) throw new CoreAppError(retry ? "submission_incomplete" : recovery.code ?? "submission_conflict", retry ? 503 : 409,
        { answerId, retrySameSubmission: retry, currentRevision: recovery.revision, links: this.answerLinks(answerId, binding) });
      throw error;
    }
    return receipt!;
  }
}
