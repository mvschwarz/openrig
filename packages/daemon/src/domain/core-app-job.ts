import { runnerPermissionOrigin } from "./runner-permissions.js";
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
  /** Conservative continuity proof: filtered sequence jumps are fine; deleted log rows or a retention sweep reset. */
  eventReplay(cursor: string | undefined) {
    return this.access.db.transaction(() => {
      const head = this.bus.maxSeq(), after = cursor === undefined ? head : this.cursorSequence(cursor);
      const floor = (this.access.db.prepare("SELECT low_water_seq n FROM events_retention_marks WHERE id = 1").get() as { n: number } | undefined)?.n ?? 0;
      if (after === null || after > head || after < floor) return null;
      const count = (this.access.db.prepare("SELECT COUNT(*) n FROM events WHERE seq > ? AND seq <= ?").get(after, head) as { n: number }).n;
      if (count !== head - after) return null;
      // Notifications are prunable history. Filter retained pages in memory only after proving continuity.
      const sequences: number[] = [];
      let replayAfter = after;
      while (replayAfter < head) {
        const page = this.bus.replayPage(replayAfter, head, 500);
        for (const event of page) {
          if (event.type === "queue.created" || event.type === "queue.updated" || event.type === "queue.answer_recorded" || event.type === "mission_control.action_executed") {
            sequences.push(event.seq);
            if (sequences.length > 500) return null;
          }
        }
        replayAfter = page[page.length - 1]!.seq;
      }
      return { head, sequences };
    })();
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
  /** One authority probe per item: why it can't be answered, and whether its agent's authority is unknown. Only positive
   *  replacement or absence (the queue owner's `replaced`/`absent`) makes a permission ask stale; a seat with no readable tenure
   *  is unknown, which keeps the ask, its facts and its answer forms. */
  private assess(item: QueueItem): { reason: string | null; unknown: boolean } {
    const reason = appAskUnsupported(this.queue, item);
    if (reason) return { reason, unknown: false };
    const origin = runnerPermissionOrigin(item);
    if (!origin) return { reason: null, unknown: false };
    const authority = this.queue.runnerPermissionAuthority(origin);
    if (authority === "replaced" || authority === "absent") return { reason: "request_stale", unknown: false };
    return { reason: null, unknown: authority !== "current" };
  }
  private unsupported(item: QueueItem): string | null { return this.assess(item).reason; }
  request(credential: CoreAppCredential, requestId: string, actor: string) {
    const item = this.queue.getById(requestId);
    if (!item) throw new CoreAppError("request_not_found", 404);
    const { reason, unknown } = this.assess(item);
    return this.project(credential, item, reason, actor, unknown);
  }
  private project(credential: CoreAppCredential, item: QueueItem, unsupportedReason: string | null, actor: string, unknown = false) {
    const requestId = item.qitemId;
    if (unsupportedReason === "unsupported_request_kind" || unsupportedReason === "source_unavailable") return { requestId, answer: null, unsupportedReason, links: this.links(requestId, actor) };
    return { requestId, asker: item.sourceSession, askedPerson: item.destinationSession,
      actor: { address: actor, assurance: "app-attributed", appId: credential.appId }, state: item.state,
      decisionRevision: this.queue.decisionRevision(item), episodeKey: this.episodeKey(requestId),
      body: item.body, humanDetail: item.humanDetail ?? null, questions: item.humanQuestions ?? [], humanAnswers: item.humanAnswers ?? {},
      answer: unsupportedReason ? null : { job: "human-answer", forms: ["option", "typed-reply"] },
      ...(unsupportedReason ? { unsupportedReason } : {}),
      ...(unknown ? { occupantAuthority: "unknown", occupantAuthorityDetail: "The asking agent's seat can't be confirmed current right now. The question and answer stay open; no native effect is implied." } : {}),
      links: this.links(requestId, actor) };
  }
  needsMe(credential: CoreAppCredential, actor: string) {
    return this.snapshot(() => {
      try {
      const { current, partial } = humanAskAttention(this.queue);
      const view = feedPerspective(this.queue, actor);
      const requests = current.flatMap(item => {
        if (!view.inView(item.destinationSession)) return [];
        const { reason, unknown } = this.assess(item); // one authority probe per item, projected in the same boundary
        return reason ? [] : [this.project(credential, item, null, actor, unknown)];
      });
      return { version: 1, sources: [{ source: "queue", state: partial ? "partial" : "available" }], requests };
      } catch { return { version: 1, sources: [{ source: "queue", state: "unavailable", detail: "Queue source unavailable; absence does not establish resolution." }], requests: [] }; }
    });
  }
  private submissions(appId: string, requestId: string): CoreAppSubmission[] {
    return this.access.db.prepare("SELECT * FROM core_app_submissions WHERE app_id = ? AND request_id = ? ORDER BY rowid").all(appId, requestId) as CoreAppSubmission[];
  }
  private workLink(qitemId: string, requestId: string, actor: string): string {
    return `/api/apps/v1/work/${encodeURIComponent(qitemId)}?requestId=${encodeURIComponent(requestId)}&actor=${encodeURIComponent(actor)}`;
  }
  private workRecord(item: QueueItem, requestId: string, actor: string) {
    return { qitemId: item.qitemId, state: item.state, body: item.body, summary: item.summary, source: item.sourceSession,
      actor: this.queue.listTransitions(item.qitemId).at(-1)?.actorSession ?? null, replyTo: item.replyTo ?? null,
      handedOffFrom: item.handedOffFrom, handedOffTo: item.handedOffTo, blockedOn: item.blockedOn,
      closureReason: item.closureReason, evidenceRef: item.evidenceRef,
      completion: { status: ["done", "canceled", "denied", "failed", "handed-off"].includes(item.state) ? "closed-as-recorded" : "open",
        sourceQitemId: item.qitemId, closureReason: item.closureReason, evidenceRef: item.evidenceRef },
      links: { self: this.workLink(item.qitemId, requestId, actor), request: this.links(requestId, actor).self, result: this.links(requestId, actor).result } };
  }
  private graph(appId: string, requestId: string) {
    const root = this.queue.getById(requestId);
    const nodes = new Map<string, QueueItem>();
    const edges: Array<{ from: string; to: string; relation: string; sourceQitemId: string; captured?: true }> = [];
    let partial = false;
    if (!root || root.contentErasedAt) return { nodes, edges, partial: true };
    const pending: Array<{ id: string; hops: number }> = [{ id: requestId, hops: 0 }];
    const addEdge = (from: string, to: string, relation: string, captured = false) => {
      if (!edges.some(edge => edge.from === from && edge.to === to && edge.relation === relation)) {
        edges.push({ from, to, relation, sourceQitemId: to, ...(captured ? { captured: true as const } : {}) });
      }
    };
    for (const row of this.submissions(appId, requestId)) {
      for (const id of parse<Checkpoint>(row.checkpoint_json)?.workIds ?? []) {
        addEdge(requestId, id, "blocked-on", true); pending.push({ id, hops: 0 });
      }
    }
    while (pending.length) {
      const next = pending.shift()!;
      if (nodes.has(next.id)) continue;
      if (nodes.size >= 100 || next.hops > 20) { partial = true; continue; }
      const item = this.queue.getById(next.id);
      if (!item || item.contentErasedAt) { partial = true; continue; }
      nodes.set(item.qitemId, item);
      const related = this.queue.relatedTo(item.qitemId);
      if (related.length >= 101) partial = true;
      for (const edge of related.slice(0, 100)) {
        addEdge(item.qitemId, edge.item.qitemId, edge.relation);
        pending.push({ id: edge.item.qitemId, hops: next.hops + (edge.relation === "handed-off-from" ? 1 : 0) });
      }
      // A handed-to session address isn't an item ID. Only the actual successor's handedOffFrom is followable.
      if (item.handedOffTo && !related.some(edge => edge.relation === "handed-off-from" && edge.item.destinationSession === item.handedOffTo)) partial = true;
    }
    // A directed cycle is real but can't establish a complete handoff/dependency outcome.
    const active = new Set<string>(), visited = new Set<string>();
    const cycle = (id: string): boolean => {
      if (active.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id); active.add(id);
      const found = edges.some(edge => edge.from === id && cycle(edge.to)); active.delete(id); return found;
    };
    if (cycle(requestId)) partial = true;
    return { nodes, edges, partial };
  }
  private permission(item: QueueItem, nodes: Map<string, QueueItem>) {
    const origin = runnerPermissionOrigin(item);
    if (!origin) return { status: "not-applicable", nativeEffect: "unknown" };
    const authority = this.queue.runnerPermissionAuthority(origin);
    let live: QueueItem | undefined = item;
    const seen = new Set<string>();
    for (let hops = 0; live && (live.state === "handed-off" || live.state === "done" && live.closureReason === "handed_off_to"); hops++) {
      if (hops >= 20 || seen.has(live.qitemId)) { live = undefined; break; }
      seen.add(live.qitemId);
      const prior: QueueItem = live;
      live = [...nodes.values()].filter(row => row.handedOffFrom === prior.qitemId && row.destinationSession === prior.handedOffTo).at(-1);
    }
    if (!live) return { status: "unknown", nativeEffect: "unknown", reason: "handoff_unavailable" };
    const transitions = this.queue.listTransitions(live.qitemId);
    const withdrawal = [...transitions].reverse().find(t => t.transitionNote?.startsWith("runner-permission-withdrawn"));
    const stale = [...transitions].reverse().find(t => t.transitionNote?.startsWith("runner-permission-stale"));
    const source = (t: NonNullable<typeof withdrawal>) => ({ sourceQitemId: live!.qitemId, sourceTransitionId: t.transitionId, decider: t.actorSession, reason: t.transitionNote });
    if (withdrawal) return { status: "withdrawn", nativeEffect: "unknown", ...source(withdrawal) };
    if (stale || authority === "replaced" || authority === "absent") return { status: "stale", nativeEffect: "unknown", ...(stale ? source(stale) : { sourceQitemId: item.qitemId }) };
    if (authority !== "current") return { status: "unknown", nativeEffect: "unknown", reason: "occupant_unavailable" };
    // Only transitions in the current final state establish a decision, as the receiving-agent owner requires.
    let decision: ReturnType<QueueRepository["listTransitions"]>[number] | undefined;
    for (let i = transitions.length - 1; i >= 0 && transitions[i]!.state === live.state; i--) {
      const transition = transitions[i]!;
      if (transition.transitionNote?.startsWith("runner-permission-decided") || transition.ownerNotificationKind === "human-decision-resolved") { decision = transition; break; }
    }
    if (decision && !["pending", "in-progress", "blocked"].includes(live.state)) return { status: "decided", nativeEffect: "unknown", ...source(decision), option: typeof live.humanAnswers?.permission === "string" ? live.humanAnswers.permission : null };
    return { status: Object.keys(item.humanAnswers ?? {}).length ? "awaiting-agent" : "unknown", nativeEffect: "unknown", sourceQitemId: live.qitemId };
  }
  result(credential: CoreAppCredential, requestId: string, actor: string) {
    return this.snapshot(() => {
      const request = this.queue.getById(requestId);
      if (!request || request.contentErasedAt) throw new CoreAppError("source_unavailable", 404);
      if (appAskUnsupported(this.queue, request) === "unsupported_request_kind") throw new CoreAppError("unsupported_request_kind", 422);
      const graph = this.graph(credential.appId, requestId), permission = this.permission(request, graph.nodes);
      const answers = new Set(this.queue.answersForAsk(requestId).map(answer => answer.qitemId));
      const reply = [...graph.nodes.values()].find(item => item.replyTo === requestId && answers.has(item.qitemId));
      const isPermission = !!runnerPermissionOrigin(request);
      const answerReturn = reply ? { status: "returned", replyQitemId: reply.qitemId, source: reply.sourceSession, target: reply.destinationSession,
        body: reply.body, replyTo: reply.replyTo, links: { self: this.workLink(reply.qitemId, requestId, actor) } }
        : isPermission && Object.keys(request.humanAnswers ?? {}).length ? { status: permission.status === "decided" ? "returned" : "kept-for-agent", replyQitemId: null, sourceQitemId: requestId }
        : { status: graph.partial ? "unknown" : "not-returned", replyQitemId: null };
      const records = [...graph.nodes.values()].filter(item => item.qitemId !== requestId).map(item => this.workRecord(item, requestId, actor));
      return { request: this.request(credential, requestId, actor), submissions: this.submissions(credential.appId, requestId)
        .filter(row => !row.erased_at && parse<Binding>(row.binding_json)?.actor === actor).map(row => this.readAnswer(credential, row.answer_id, actor)),
        answerReturn, permissionDecision: permission, work: { status: graph.partial ? "partial" : "available", records, edges: graph.edges,
          completion: { status: "unknown", sourceQitemId: null, reason: "Inspect each recorded work closure; no product outcome is inferred." } },
        links: this.links(requestId, actor), sources: [{ source: "queue", state: graph.partial ? "partial" : "available" }] };
    });
  }
  work(credential: CoreAppCredential, qitemId: string, requestId: string, actor: string) {
    return this.snapshot(() => {
      if (!requestId) throw new CoreAppError("request_id_required", 400);
      const request = this.queue.getById(requestId);
      if (!request || appAskUnsupported(this.queue, request) === "unsupported_request_kind") throw new CoreAppError("work_not_found", 404);
      const item = this.graph(credential.appId, requestId).nodes.get(qitemId);
      if (!item || item.qitemId === requestId) throw new CoreAppError("work_not_found", 404);
      return this.workRecord(item, requestId, actor);
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
        outcome: result.answer!.outcome, decisionRevisionAfter: result.decisionRevision, unanswered: result.answer!.unanswered,
        ...(result.answer!.message ? { message: result.answer!.message } : {}),
        replyQitemId: result.createdQitemId === binding.requestId ? null : result.createdQitemId },
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
    // Occupant authority can end without changing dr1. Reuse the pure live-support check before any unfinished
    // repair/write; immutable completed action evidence above still wins, and own closes keep their existing repair.
    if (this.unsupported(item) === "request_stale") return { code: "request_stale", revision: current, retry: false };
    const withoutOwnReply = this.queue.decisionRevision(item, { excludeOperationReply: operation });
    const original = checkpoint?.before;
    // Another surface may have finished closing this exact original return. Its own close/answer fields are excluded
    // only after checking the original question/recipient/episode and the operation-tagged durable return.
    const sameQuestion = original && JSON.stringify([item.body, item.humanIntent, item.humanQuestions, item.destinationSession, item.blockedOn,
      this.episodeKey(item.qitemId), item.evidenceRef ?? null]) === JSON.stringify([original.body, original.humanIntent, original.humanQuestions,
      original.destinationSession, original.blockedOn, binding.episodeKey, original.evidenceRef ?? null]);
    if (ownReply && item.state === "done" && sameQuestion) return { revision: current, retry: true };
    const expected = checkpoint?.revision ?? binding.expectedRevision;
    if (item.state === "pending" && withoutOwnReply === expected) return { revision: current, retry: true };
    return { code: ownReply || checkpoint?.revision !== binding.expectedRevision ? "recovery_conflict" : "decision_revision_changed", revision: current, retry: false };
  }
  readAnswer(credential: CoreAppCredential, answerId: string, actor: string) {
    return this.snapshot(() => this.answerStatus(credential, answerId, actor));
  }
  private answerStatus(credential: CoreAppCredential, answerId: string, actor: string) {
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
  /** 503 for a submission whose persistence this call could not settle: `unsaved` only on confirmed absence, else `unknown`. */
  private persistenceUnavailable(answerId: string, state: "unsaved" | "unknown") {
    return new CoreAppError("app_job_unavailable", 503, { answerId, submission: { state }, retrySameSubmission: true });
  }
  async submit(credential: CoreAppCredential, answerId: string, value: unknown): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(answerId)) throw new CoreAppError("invalid_answer_id", 422);
    let binding: Binding;
    try { binding = this.binding(credential, value); } catch (error) {
      // No verified actor means no look at any earlier attempt with this ID: its persistence is unknown, never "unsaved".
      if (error instanceof CoreAppError && error.code === "app_job_unavailable") throw this.persistenceUnavailable(answerId, "unknown");
      throw error;
    }
    const hash = appHash(JSON.stringify(binding));
    const key = `${credential.appId}:${answerId}`;
    let existing: CoreAppSubmission | undefined;
    try { existing = this.row(credential.appId, answerId); } catch { throw this.persistenceUnavailable(answerId, "unknown"); }
    // An erased tombstone answers the same for any payload: the kept hash must not confirm a guessed answer.
    if (existing?.erased_at) throw new CoreAppError("source_unavailable", 409, { answerId, retrySameSubmission: false });
    if (existing && existing.binding_hash !== hash) throw new CoreAppError("answer_id_conflict", 409);
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
      try {
        db.transaction(() => {
          const item = this.queue.getById(binding.requestId);
          if (!item) throw new CoreAppError("request_not_found", 404);
          const reason = this.unsupported(item);
          if (reason) throw new CoreAppError(reason, 422);
          if (this.queue.decisionRevision(item) !== binding.expectedRevision) throw new CoreAppError("decision_revision_changed", 409);
          if ((this.episodeKey(item.qitemId)) !== binding.episodeKey) throw new CoreAppError("episode_changed", 409);
          const question = item.humanQuestions!.find(q => q.id === binding.questionId);
          const answer = binding.answer;
          if (!question || answer.kind === "option" && !question.options.some(o => o.id === answer.optionId)) throw new CoreAppError("invalid_question_option", 422);
          const returned = this.queue.getHumanAnswer(binding.requestId, binding.actor);
          const finalized = unansweredQuestions(item.humanQuestions!, item.humanAnswers ?? {}).length === 0;
          // The existing owner keeps the first committed return / finalized set. A new ID must never claim a
          // conflicting payload was applied when that original answer wins. The original ID remains repairable.
          if ((returned || finalized) && (answer.kind !== "option" || item.humanAnswers?.[binding.questionId] !== answer.optionId)) {
            throw new CoreAppError(returned ? "answer_already_returned" : "answer_already_finalized", 409, {
              retrySameSubmission: false, replyQitemId: returned?.qitemId ?? null,
              currentRevision: this.queue.decisionRevision(item), links: this.links(binding.requestId, binding.actor),
            });
          }
          if (binding.answer.kind === "typed-reply" && unansweredQuestions(item.humanQuestions!, item.humanAnswers ?? {})[0]?.id !== binding.questionId) throw new CoreAppError("typed_reply_question_mismatch", 409);
          const workIds = (db.prepare("SELECT qitem_id FROM queue_items WHERE blocked_on = ? ORDER BY rowid LIMIT 101").all(binding.requestId) as Array<{ qitem_id: string }>).map(row => row.qitem_id);
          const checkpoint: Checkpoint = { before: item, revision: binding.expectedRevision, workIds };
          db.prepare("INSERT INTO core_app_submissions (app_id, answer_id, request_id, binding_hash, binding_json, checkpoint_json) VALUES (?, ?, ?, ?, ?, ?)")
            .run(credential.appId, answerId, binding.requestId, hash, JSON.stringify(binding), JSON.stringify(checkpoint));
        })();
      } catch (error) {
        if (error instanceof CoreAppError) throw error;
        // The transaction rolled back, so this attempt stored nothing, but an earlier or concurrent attempt with this ID may have:
        // only the authoritative row says. A saved receipt wins, an incomplete row stays incomplete, absence is unsaved.
        let stored: CoreAppSubmission | undefined, readable = true;
        try { stored = this.row(credential.appId, answerId); } catch { readable = false; }
        if (stored?.erased_at) throw new CoreAppError("source_unavailable", 409, { answerId, retrySameSubmission: false });
        if (stored && stored.binding_hash !== hash) throw new CoreAppError("answer_id_conflict", 409);
        if (stored) return this.perform(credential, answerId, binding, hash);
        throw this.persistenceUnavailable(answerId, readable ? "unsaved" : "unknown");
      }
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
      let recovery: ReturnType<CoreAppJob["recovery"]>;
      try {
        const fresh = this.row(credential.appId, answerId)!;
        recovery = this.recovery(fresh, binding);
      } catch { throw this.persistenceUnavailable(answerId, "unknown"); }
      if (recovery.receipt) return { ...recovery.receipt, replayed: true };
      const retry = recovery.retry;
      if (error instanceof MissionControlWriteContractError || retry || recovery.code) throw new CoreAppError(retry ? "submission_incomplete" : recovery.code ?? "submission_conflict", retry ? 503 : 409,
        { answerId, ...(retry ? { submission: { state: "incomplete" } } : {}), retrySameSubmission: retry, currentRevision: recovery.revision, links: this.answerLinks(answerId, binding) });
      throw error;
    }
    return receipt!;
  }
}
