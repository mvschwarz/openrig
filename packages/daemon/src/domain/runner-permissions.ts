// Answered permissions for a runner seat (the harness runner contract §7, "the answered path"). A runner whose agent asks
// permission submits the request; OpenRig opens one ordinary ask to the default person, or to the person the seat's
// operator chose instead (`rig seat set-permissions-to`), with exactly the agent's offered options as its choices; the
// runner reads the one answer back and gives it to that same live request. With no one to ask, or an ask closed without
// a choice, OpenRig's default is permit with the agent's own allow option; a person's no is never a grant, and only the
// seat's opt-in (`--deny`) refuses every request.

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { isHumanSeatSessionRef } from "./session-name.js";
import { resolveRegisteredHumanAddress, type LoadResult } from "./gateway/human-registry.js";
import { resolveDefaultPerson } from "./gateway/participants.js";
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
/** The agent's own allow and reject options, kept on the ask so a person's yes or no in words maps to them. */
const ALLOW_TAG = "permission-allow:";
const REJECT_TAG = "permission-reject:";
const OPTION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const ANSWERABLE_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
/** What each ACP option kind means to the agent, told to the person beside the option. */
const NATIVE_MEANING: Record<string, string> = {
  allow_once: "allows this one tool call",
  allow_always: "the agent's harness remembers this choice and allows similar requests without asking; OpenRig doesn't record or revoke it",
  reject_once: "refuses this one tool call",
  reject_always: "the agent's harness remembers this refusal for similar requests",
};
const WITHDRAW_REASONS = new Set(["turn_cancelled", "turn_ended", "exited"]);
const MAX_AGENT_TEXT = 500;
const MAX_HANDOFF_HOPS = 10;
/** The seat setting that opts in to refusing every request; OpenRig's default is to ask a person, or permit. */
export const PERMISSIONS_DENY = "deny";
const SAID_YES = new Set(["yes", "y", "yep", "yeah", "ok", "okay", "sure", "fine", "allow", "allowed", "approve", "approved",
  "accept", "accepted", "permit", "permitted", "go", "go ahead", "do it", "lgtm"]);
const SAID_NO = new Set(["no", "n", "nope", "deny", "denied", "reject", "rejected", "refuse", "refused", "decline", "declined",
  "don't", "dont", "do not", "stop", "no thanks"]);

/** A person's typed reply that plainly says yes or no; anything else says neither. */
function typedYesOrNo(answer: unknown): "yes" | "no" | null {
  if (!answer || typeof answer !== "object" || (answer as { kind?: unknown }).kind !== "typed-reply") return null;
  const words = String((answer as { text?: unknown }).text ?? "").trim().toLowerCase().replace(/[.!?,;:]+$/, "").replace(/\s+/g, " ");
  return SAID_YES.has(words) ? "yes" : SAID_NO.has(words) ? "no" : null;
}

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

/** With no override, the default person answers, as for any ask that names no one: the chosen default, else the only
 *  registered person. With no one to ask, the caller permits. */
export function defaultPermissionOwner(registry: () => LoadResult): { ok: true; address: string } | { ok: false; message: string } {
  let loaded: LoadResult;
  try {
    loaded = registry();
  } catch (error) {
    return { ok: false, message: `the registered people can't be read: ${(error as Error).message}` };
  }
  if (!loaded.ok) return { ok: false, message: `the registered people can't be read: ${loaded.error}` };
  const fallback = resolveDefaultPerson(loaded.entities);
  return fallback.person ? { ok: true, address: fallback.person.address } : { ok: false, message: fallback.reason };
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

export type SubmitRefusalCode = "denied_by_seat" | "duplicate_request" | "invalid_permission_request" | "options_unsupported";
export type SubmitResult =
  | { ok: true; askId: string; created: boolean }
  | { ok: true; state: "permitted"; optionId: string; reason: string }
  | { ok: false; code: SubmitRefusalCode; message: string };
export type ReadResult =
  | { ok: true; state: "pending" | "withdrawn" | "stale" }
  | { ok: true; state: "answered" | "permitted"; optionId: string }
  | { ok: true; state: "refused"; reason: "no_allow_offered" | "said_no" }
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
    if (selected === PERMISSIONS_DENY) {
      return { ok: false, code: "denied_by_seat",
        message: "This seat's operator chose to refuse its runner's permission requests (rig seat set-permissions-to --deny). Refuse the request and hold attention." };
    }
    const allow = request.options.find((option) => option.kind === "allow_once") ?? request.options.find((option) => option.kind === "allow_always");
    const reject = request.options.find((option) => option.kind === "reject_once") ?? request.options.find((option) => option.kind === "reject_always");
    // OpenRig's default is permit: when no one can be asked, the agent gets its own allow option at once.
    const permit = (why: string): SubmitResult => allow
      ? { ok: true, state: "permitted", optionId: allow.optionId, reason: why }
      : { ok: false, code: "options_unsupported", message: `No one can be asked (${why}), and the agent offered no allow option to permit.` };
    const owner = selected ? resolvePermissionOwner(selected, this.deps.humanRegistry) : defaultPermissionOwner(this.deps.humanRegistry);
    if (!owner.ok) return permit(selected ? `the person chosen for this seat can't be asked: ${owner.message}` : `no one can be asked: ${owner.message}`);
    const ids = new Set(request.options.map((option) => option.optionId));
    if (request.options.length < 2 || request.options.length > 4 || ids.size !== request.options.length
      || request.options.some((option) => !OPTION_ID.test(option.optionId) || !ANSWERABLE_KINDS.has(option.kind))) {
      return permit("these options can't be shown to a person: an ask takes 2-4 options with distinct ids of letters, digits, \"-\" or \"_\"");
    }

    this.withdrawEarlierGenerations(seat);
    const askId = RunnerPermissions.askIdFor(seat, request);
    const existing = this.deps.queueRepo.getById(askId);
    if (existing) {
      if (tagValue(existing, TURN_TAG) === request.turnId) return { ok: true, askId, created: false };
      return { ok: false, code: "duplicate_request", message: `Request ${request.requestId} of this conversation was already submitted in turn ${tagValue(existing, TURN_TAG)}.` };
    }

    // The agent's own text, shown to the person: bounded like the summary.
    const title = clip(request.toolCall.title ?? "a tool call", MAX_AGENT_TEXT);
    const kind = clip(request.toolCall.kind ?? "other", MAX_AGENT_TEXT);
    const selection = this.latestSelection(seat.nodeId);
    const offered = request.options.map((option) => `- ${clip(option.name, MAX_AGENT_TEXT)} (${option.kind}, ${option.optionId}): ${NATIVE_MEANING[option.kind]}.`);
    await this.deps.queueRepo.create({
      qitemId: askId,
      sourceSession: seat.sessionName,
      destinationSession: owner.address,
      humanIntent: "decision",
      humanAlert: true,
      summary: clip(`Permission: ${seat.sessionName} asks to ${title} (${kind})`, 200),
      humanQuestions: [{ id: QUESTION_ID, question: clip(`Allow ${seat.sessionName} to ${title} (${kind})?`, MAX_QUESTION_TEXT),
        options: request.options.map((option) => ({ id: option.optionId,
          label: clip(option.kind.endsWith("_always") ? `${option.name} (remembered by the agent)` : option.name, MAX_OPTION_LABEL) })) }],
      tags: [RUNNER_PERMISSION_TAG, `${NODE_TAG}${seat.nodeId}`, `${GENERATION_TAG}${seat.generation}`, `${TURN_TAG}${request.turnId}`,
        ...(allow ? [`${ALLOW_TAG}${allow.optionId}`] : []), ...(reject ? [`${REJECT_TAG}${reject.optionId}`] : [])],
      nudge: false,
      body: [
        `${seat.sessionName}'s agent asks permission for one tool call, and is waiting on it.`,
        "",
        `- **Tool call:** ${title} (${kind}), as the agent described it.`,
        `- **Conversation:** ${request.nativeRef}, turn ${request.turnId}, request ${request.requestId}.`,
        `- **Why you:** ${selected ? selection ?? "you are the seat's chosen permission answer owner" : "you are the default person, and no one else is chosen for this seat"}.`,
        "",
        "**The options the agent offered:**",
        ...offered,
        "",
        "Your choice goes to this one request, once. A reply of just yes or no counts as the agent's allow or reject. Closing this without choosing counts as no answer, and then OpenRig's default applies: the request is permitted. If the agent's turn ends first, your answer isn't sent.",
      ].join("\n"),
    });
    return { ok: true, askId, created: true };
  }

  /** A grant's seat carries its launch generation: it reads only its own launch's requests. Only the current
   *  occupant's request can read pending or answered; an earlier occupant's reads stale, whatever answer it holds. */
  read(seat: { nodeId: string; generation?: string } | null, askId: string): ReadResult {
    const asked = this.deps.queueRepo.getById(askId);
    const origin = asked ? runnerPermissionOrigin(asked) : null;
    if (!asked || !origin || (seat && origin.nodeId !== seat.nodeId)) return { ok: false, code: "not_found", message: `No permission request ${askId} for this seat.` };
    const item = this.liveEnd(asked);
    const askIsCurrent = this.deps.currentGeneration(origin.nodeId) === origin.generation;
    const callerMatches = !seat?.generation || seat.generation === origin.generation;
    // Handed to someone this host can't follow (another host, or no row that carries the ask): still no answer, and the
    // handoff itself never permits.
    if (!item) return askIsCurrent && callerMatches ? { ok: true, state: "pending" } : { ok: true, state: "stale" };
    // Still open (pending, or claimed or parked by the person): no answer yet.
    if (item.state === "pending" || item.state === "in-progress" || item.state === "blocked") {
      if (askIsCurrent && callerMatches) return { ok: true, state: "pending" };
      if (!askIsCurrent) this.close(item, STALE_NOTE, "relaunched: a later occupant holds this seat");
      return { ok: true, state: "stale" };
    }
    if (item.state === "canceled") {
      const withdrawn = this.deps.queueRepo.listTransitions(item.qitemId).some((transition) => transition.transitionNote?.startsWith(WITHDRAWN_NOTE));
      return { ok: true, state: withdrawn ? "withdrawn" : "stale" };
    }
    if (!askIsCurrent || !callerMatches) return { ok: true, state: "stale" };
    const answer = item.humanAnswers?.[QUESTION_ID];
    const offered = item.humanQuestions?.find((question) => question.id === QUESTION_ID)?.options.map((option) => option.id) ?? [];
    if (typeof answer === "string" && offered.includes(answer)) return { ok: true, state: "answered", optionId: answer };
    // A plain no in words, or a deny from the Feed, is the agent's reject, and never a grant; a plain yes is its allow.
    const allowId = tagValue(item, ALLOW_TAG), rejectId = tagValue(item, REJECT_TAG);
    const said = item.closureReason === "denied" || item.state === "denied" ? "no" : typedYesOrNo(answer);
    if (said === "no") return rejectId ? { ok: true, state: "answered", optionId: rejectId } : { ok: true, state: "refused", reason: "said_no" };
    if (said === "yes" && allowId) return { ok: true, state: "answered", optionId: allowId };
    // Closed without an option is no answer, so OpenRig's default applies: permit.
    return allowId ? { ok: true, state: "permitted", optionId: allowId } : { ok: true, state: "refused", reason: "no_allow_offered" };
  }

  /** Wait up to `waitMs` for the ask to change, then read it. Subscribes before reading, so a change between the two isn't missed. */
  async readWhenChanged(seat: { nodeId: string; generation?: string } | null, askId: string, waitMs: number): Promise<ReadResult> {
    let release: () => void = () => {};
    const changed = new Promise<void>((resolve) => { release = resolve; });
    let liveId = askId; // after a route or handoff, the colleague's row is where the answer lands
    const unsubscribe = this.deps.eventBus.subscribe((event) => {
      const changedId = (event as { type?: string; qitemId?: string }).type === "queue.updated" ? (event as { qitemId?: string }).qitemId : undefined;
      if (changedId === askId || changedId === liveId) release();
    });
    try {
      const now = this.read(seat, askId);
      if (!now.ok || now.state !== "pending" || waitMs <= 0) return now;
      const asked = this.deps.queueRepo.getById(askId)!;
      liveId = this.liveEnd(asked)?.qitemId ?? askId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([changed, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
      if (timer) clearTimeout(timer);
      return this.read(seat, askId);
    } finally {
      unsubscribe();
    }
  }

  withdraw(seat: { nodeId: string; generation?: string } | null, askId: string, reason: string): WithdrawResult {
    if (!WITHDRAW_REASONS.has(reason)) {
      return { ok: false, code: "invalid_permission_request", message: "reason must be turn_cancelled, turn_ended or exited." };
    }
    const now = this.read(seat, askId);
    if (!now.ok || now.state !== "pending") return now;
    const asked = this.deps.queueRepo.getById(askId)!;
    const live = this.liveEnd(asked);
    // A handoff this host can't follow leaves its rows as they are; the runner just stops waiting.
    if (live) this.close(live, WITHDRAWN_NOTE, reason);
    return { ok: true, state: "withdrawn" };
  }

  /** A person who routes or hands the ask to a colleague means the colleague decides: follow each handoff (a handed-off
   *  row, or one completed with closure handed_off_to) along its own edge, to the row handed from it at the handed-to
   *  address. Null when that can't be followed on this host. */
  private liveEnd(item: QueueItem): QueueItem | null {
    let current = item;
    for (let hops = 0; current.state === "handed-off" || (current.state === "done" && current.closureReason === "handed_off_to"); hops++) {
      if (hops >= MAX_HANDOFF_HOPS || !current.handedOffTo) return null;
      // The newest: a reopened ask handed to the same person again has a later successor.
      const next = this.deps.db.prepare(`SELECT qitem_id FROM queue_items WHERE destination_session = ? AND handed_off_from = ?
        ORDER BY ts_created DESC, rowid DESC LIMIT 1`)
        .get(current.handedOffTo, current.qitemId) as { qitem_id: string } | undefined;
      const successor = next ? this.deps.queueRepo.getById(next.qitem_id) : null;
      if (!successor) return null;
      current = successor;
    }
    return current;
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
