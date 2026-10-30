// Answered permissions for a runner seat (the harness runner contract §7, "the answered path"). A runner whose agent asks
// permission submits the request; OpenRig opens one ask to the registered person the seat's operator chose
// (`rig seat set-permissions-to`), with exactly the agent's offered options as its choices; the runner reads that person's
// one answer back and gives it to that same live request. Nothing here grants: an unselected owner, a stale or withdrawn
// request, a typed reply or a close without an offered option all leave the agent's request refused, as before.

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { isHumanSeatSessionRef } from "./session-name.js";
import { resolveRegisteredHumanAddress, type LoadResult } from "./gateway/human-registry.js";
import { MAX_OPTION_LABEL, MAX_QUESTION_TEXT } from "./human-questions.js";
import type { QueueItem, QueueRepository } from "./queue-repository.js";
import type { EventBus } from "./event-bus.js";

export const RUNNER_PERMISSION_TAG = "runner-permission";
const QUESTION_ID = "permission";
const NODE_TAG = "permission-node:";
const GENERATION_TAG = "permission-generation:";
const TURN_TAG = "permission-turn:";
const WITHDRAWN_NOTE = "runner-permission-withdrawn";
const STALE_NOTE = "runner-permission-stale";
const OPTION_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** allow_always is hidden from the answerer in this version, so one answer can't become standing policy. */
const ANSWERABLE_KINDS = new Set(["allow_once", "reject_once", "reject_always"]);
const WITHDRAW_REASONS = new Set(["turn_cancelled", "turn_ended", "exited"]);

export type PermissionOwnerRefusal = { ok: false; code: "permissions_to_not_a_person" | "permissions_to_unavailable"; message: string };

/** The registered person `ref` names, as their canonical address. Only a person answers in this version: a seat address
 *  is refused, even when its member name matches a registered person. */
export function resolvePermissionOwner(ref: string, registry: () => LoadResult): { ok: true; address: string } | PermissionOwnerRefusal {
  if (!isHumanSeatSessionRef(ref)) {
    return { ok: false, code: "permissions_to_not_a_person",
      message: `${ref} isn't a person's address. In this version only a registered person answers a seat's permission requests.` };
  }
  let loaded: LoadResult;
  try {
    loaded = registry();
  } catch (error) {
    return { ok: false, code: "permissions_to_unavailable", message: `The registered people can't be read: ${(error as Error).message}` };
  }
  if (!loaded.ok) return { ok: false, code: "permissions_to_unavailable", message: loaded.error };
  const address = resolveRegisteredHumanAddress(ref, loaded.entities);
  if (!address) return { ok: false, code: "permissions_to_not_a_person", message: `${ref} isn't a registered person.` };
  return { ok: true, address };
}

export type RunnerPermissionSeat = { nodeId: string; sessionName: string; generation: string };
export type RunnerPermissionOption = { optionId: string; name: string; kind: string };
export type RunnerPermissionRequest = {
  nativeRef: string;
  turnId: string;
  requestId: string;
  toolCall: { title?: string; kind?: string };
  options: RunnerPermissionOption[];
};

export type SubmitRefusalCode = "route_unsupported" | "duplicate_request" | "invalid_permission_request" | "options_unsupported";
export type SubmitResult = { ok: true; askId: string; created: boolean } | { ok: false; code: SubmitRefusalCode; message: string };
export type ReadResult =
  | { ok: true; state: "pending" | "withdrawn" | "stale" }
  | { ok: true; state: "answered"; optionId: string }
  | { ok: true; state: "refused"; reason: "typed_reply" | "closed_without_an_offered_option" }
  | { ok: false; code: "not_found"; message: string };
export type WithdrawResult = ReadResult | { ok: false; code: "invalid_permission_request"; message: string };

const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
/** A JSON-RPC id or prompt number as the runner passed it: a number reads as its decimal string, so 7 and "7" match. */
const idText = (value: unknown): string | null => typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
const clip = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, max - 1)}…`;
const tagValue = (item: QueueItem, prefix: string): string | null => item.tags?.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? null;

/** A permission ask's own seat and generation, from its create-time tags. */
export function runnerPermissionOrigin(item: Pick<QueueItem, "tags">): { nodeId: string; generation: string } | null {
  if (!item.tags?.includes(RUNNER_PERMISSION_TAG)) return null;
  const nodeId = tagValue(item as QueueItem, NODE_TAG);
  const generation = tagValue(item as QueueItem, GENERATION_TAG);
  return nodeId && generation ? { nodeId, generation } : null;
}

/** Validate a runner's submitted request into its parts, or say what's wrong with it. */
export function parseRunnerPermissionRequest(body: Record<string, unknown>): { ok: true; request: RunnerPermissionRequest } | { ok: false; message: string } {
  const nativeRef = text(body.nativeRef), turnId = idText(body.turnId), requestId = idText(body.requestId);
  if (!nativeRef || !turnId || !requestId) return { ok: false, message: "A permission request needs nativeRef, turnId and requestId." };
  if (!Array.isArray(body.options)) return { ok: false, message: "A permission request needs options[]." };
  const options: RunnerPermissionOption[] = [];
  for (const raw of body.options as unknown[]) {
    const option = (raw ?? {}) as Record<string, unknown>;
    const optionId = text(option.optionId), name = text(option.name), kind = text(option.kind);
    if (!optionId || !name || !kind) return { ok: false, message: "Each option needs optionId, name and kind." };
    options.push({ optionId, name, kind });
  }
  const toolCall = (body.toolCall ?? {}) as Record<string, unknown>;
  return { ok: true, request: { nativeRef, turnId, requestId, options,
    toolCall: { title: text(toolCall.title) ?? undefined, kind: text(toolCall.kind) ?? undefined } } };
}

export class RunnerPermissions {
  constructor(private readonly deps: {
    db: Database.Database;
    queueRepo: QueueRepository;
    eventBus: EventBus;
    humanRegistry: () => LoadResult;
    ownerOf: (nodeId: string) => string | null;
    currentGeneration: (nodeId: string) => string | null;
  }) {}

  /** One ask per live agent request: the same seat generation, conversation and request id always name the same ask. */
  static askIdFor(seat: RunnerPermissionSeat, request: Pick<RunnerPermissionRequest, "nativeRef" | "requestId">): string {
    const key = JSON.stringify([seat.nodeId, seat.generation, request.nativeRef, request.requestId]);
    return `qitem-runner-permission-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  }

  async submit(seat: RunnerPermissionSeat, request: RunnerPermissionRequest): Promise<SubmitResult> {
    const selected = this.deps.ownerOf(seat.nodeId);
    if (!selected) {
      return { ok: false, code: "route_unsupported",
        message: "No one is chosen to answer this seat's permission requests (rig seat set-permissions-to). Refuse the request and hold attention." };
    }
    const owner = resolvePermissionOwner(selected, this.deps.humanRegistry);
    if (!owner.ok) return { ok: false, code: "route_unsupported", message: `This seat's chosen answer owner can't answer: ${owner.message}` };
    const answerable = request.options.filter((option) => option.kind !== "allow_always");
    const ids = new Set(answerable.map((option) => option.optionId));
    if (answerable.length < 2 || answerable.length > 4 || ids.size !== answerable.length
      || answerable.some((option) => !OPTION_ID.test(option.optionId) || !ANSWERABLE_KINDS.has(option.kind))) {
      return { ok: false, code: "options_unsupported",
        message: "These options can't be offered to a person: after allow_always is hidden, 2-4 options with distinct ids of letters, digits, \"-\" or \"_\", each allow_once, reject_once or reject_always, are needed. Refuse the request and hold attention." };
    }

    this.withdrawEarlierGenerations(seat);
    const askId = RunnerPermissions.askIdFor(seat, request);
    const existing = this.deps.queueRepo.getById(askId);
    if (existing) {
      if (tagValue(existing, TURN_TAG) === request.turnId) return { ok: true, askId, created: false };
      return { ok: false, code: "duplicate_request", message: `Request ${request.requestId} of this conversation was already submitted in turn ${tagValue(existing, TURN_TAG)}.` };
    }

    const title = request.toolCall.title ?? "a tool call";
    const kind = request.toolCall.kind ?? "other";
    const selection = this.latestSelection(seat.nodeId);
    const offered = request.options.map((option) => `- ${option.name} (${option.kind}, ${option.optionId})${option.kind === "allow_always" ? ": hidden in this version" : ""}`);
    await this.deps.queueRepo.create({
      qitemId: askId,
      sourceSession: seat.sessionName,
      destinationSession: owner.address,
      humanIntent: "decision",
      humanAlert: true,
      summary: clip(`Permission: ${seat.sessionName} asks to ${title} (${kind})`, 200),
      humanQuestions: [{ id: QUESTION_ID, question: clip(`Allow ${seat.sessionName} to ${title} (${kind})?`, MAX_QUESTION_TEXT),
        options: answerable.map((option) => ({ id: option.optionId, label: clip(option.name, MAX_OPTION_LABEL) })) }],
      tags: [RUNNER_PERMISSION_TAG, `${NODE_TAG}${seat.nodeId}`, `${GENERATION_TAG}${seat.generation}`, `${TURN_TAG}${request.turnId}`],
      nudge: false,
      body: [
        `${seat.sessionName}'s agent asks permission for one tool call, and is waiting on it.`,
        "",
        `- **Tool call:** ${title} (${kind}), as the agent described it.`,
        `- **Conversation:** ${request.nativeRef}, turn ${request.turnId}, request ${request.requestId}.`,
        `- **Why you:** ${selection ?? "you are the seat's chosen permission answer owner"}.`,
        "",
        "**The options the agent offered:**",
        ...offered,
        "",
        "Choose one only if you hold the authority for this effect. Your choice goes to this one request, once. A typed reply is read as words, never as approval. If the agent's turn ends first, your answer isn't sent.",
      ].join("\n"),
    });
    return { ok: true, askId, created: true };
  }

  read(seat: { nodeId: string } | null, askId: string): ReadResult {
    const item = this.deps.queueRepo.getById(askId);
    const origin = item ? runnerPermissionOrigin(item) : null;
    if (!item || !origin || (seat && origin.nodeId !== seat.nodeId)) return { ok: false, code: "not_found", message: `No permission request ${askId} for this seat.` };
    if (item.state === "pending") {
      if (this.deps.currentGeneration(origin.nodeId) === origin.generation) return { ok: true, state: "pending" };
      this.close(item, STALE_NOTE, "relaunched: a later occupant holds this seat");
      return { ok: true, state: "stale" };
    }
    if (item.state === "canceled") {
      const withdrawn = this.deps.queueRepo.listTransitions(askId).some((transition) => transition.transitionNote?.startsWith(WITHDRAWN_NOTE));
      return { ok: true, state: withdrawn ? "withdrawn" : "stale" };
    }
    const answer = item.humanAnswers?.[QUESTION_ID];
    const offered = item.humanQuestions?.find((question) => question.id === QUESTION_ID)?.options.map((option) => option.id) ?? [];
    if (item.state === "done" && typeof answer === "string" && offered.includes(answer)) return { ok: true, state: "answered", optionId: answer };
    return { ok: true, state: "refused", reason: answer && typeof answer === "object" ? "typed_reply" : "closed_without_an_offered_option" };
  }

  /** Wait up to `waitMs` for the ask to change, then read it. Subscribes before reading, so a change between the two isn't missed. */
  async readWhenChanged(seat: { nodeId: string } | null, askId: string, waitMs: number): Promise<ReadResult> {
    let release: () => void = () => {};
    const changed = new Promise<void>((resolve) => { release = resolve; });
    const unsubscribe = this.deps.eventBus.subscribe((event) => {
      if ((event as { type?: string; qitemId?: string }).type === "queue.updated" && (event as { qitemId?: string }).qitemId === askId) release();
    });
    try {
      const now = this.read(seat, askId);
      if (!now.ok || now.state !== "pending" || waitMs <= 0) return now;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([changed, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
      if (timer) clearTimeout(timer);
      return this.read(seat, askId);
    } finally {
      unsubscribe();
    }
  }

  withdraw(seat: { nodeId: string; sessionName?: string } | null, askId: string, reason: string): WithdrawResult {
    if (!WITHDRAW_REASONS.has(reason)) {
      return { ok: false, code: "invalid_permission_request", message: "reason must be turn_cancelled, turn_ended or exited." };
    }
    const now = this.read(seat, askId);
    if (!now.ok || now.state !== "pending") return now;
    this.close(this.deps.queueRepo.getById(askId)!, WITHDRAWN_NOTE, reason);
    return { ok: true, state: "withdrawn" };
  }

  /** A relaunch makes every open ask from the seat's earlier generations stale, so none of them can still be answered. */
  private withdrawEarlierGenerations(seat: RunnerPermissionSeat): void {
    const open = this.deps.db.prepare(`SELECT qitem_id FROM queue_items WHERE state = 'pending'
      AND EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = ?)
      AND NOT EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = ?)`)
      .all(`${NODE_TAG}${seat.nodeId}`, `${GENERATION_TAG}${seat.generation}`) as Array<{ qitem_id: string }>;
    for (const { qitem_id } of open) {
      const item = this.deps.queueRepo.getById(qitem_id);
      if (item && runnerPermissionOrigin(item)) this.close(item, STALE_NOTE, "relaunched: a later occupant holds this seat");
    }
  }

  private close(item: QueueItem, note: string, reason: string): void {
    this.deps.queueRepo.update({ qitemId: item.qitemId, actorSession: item.sourceSession, state: "canceled",
      transitionNote: `${note} reason=${reason}: the runner's request ended, so any answer here is not sent.` });
  }

  /** Who chose this seat's answer owner, and when, from the audit event. */
  private latestSelection(nodeId: string): string | null {
    try {
      const row = this.deps.db.prepare(`SELECT payload, created_at FROM events WHERE node_id = ? AND type = 'node.permissions_to_changed'
        ORDER BY seq DESC LIMIT 1`).get(nodeId) as { payload: string; created_at: string } | undefined;
      if (!row) return null;
      const payload = JSON.parse(row.payload) as { operator?: string | null; reason?: string };
      return `chosen by ${payload.operator ?? "an operator"} at ${row.created_at}${payload.reason ? ` (${payload.reason})` : ""}`;
    } catch {
      return null;
    }
  }
}
