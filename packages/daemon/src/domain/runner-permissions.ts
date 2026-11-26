// Answered permissions for a runner seat (the harness runner contract §7, "the answered path"). A runner whose agent asks
// permission submits the request; OpenRig opens one ordinary ask to the default person, or to the person the seat's
// operator chose instead (`rig seat set-permissions-to`), with exactly the agent's offered options as its choices; the
// runner reads the one answer back and gives it to that same live request. With no one to ask, or an ask closed without
// a choice, OpenRig's default is permit with the agent's own allow option; a person's no is never a grant, and only the
// seat's opt-in (`--deny`) refuses every request. Each default permit leaves one pull-only record on the stream.
//
// A native ask (slice 15) is the same contract for a harness's own permission prompt, submitted by that harness's
// permission hook (Claude Code's PermissionRequest): the prompt stays open in the seat's terminal while the person can
// answer here too. It differs where a default would decide for the person: with no one to ask it is not asked (no permit,
// no refusal), and the harness's prompt carries on; an ask closed without an answer is unanswered, never permitted. Its
// owner can also be the return route of the work the seat is running (the person's own conversation). A person's pick of
// an offered option, or a plain yes or no, is their own answer; only their words go to an agent to judge.

import type Database from "better-sqlite3";
import { ActivityGrantStore } from "./activity-grants.js";
import { createHash } from "node:crypto";
import { isHumanSeatSessionRef } from "./session-name.js";
import { routeOnThisHost } from "./return-route.js";
import { redactTranscriptContent } from "./transcript-redaction.js";
import { resolveRegisteredHumanAddress, type LoadResult } from "./gateway/human-registry.js";
import { resolveDefaultPerson } from "./gateway/participants.js";
import { MAX_OPTION_LABEL, MAX_QUESTION_TEXT } from "./human-questions.js";
import type { QueueItem, QueueRepository } from "./queue-repository.js";
import type { EventBus } from "./event-bus.js";
import type { StreamStore } from "./stream-store.js";

export const RUNNER_PERMISSION_TAG = "runner-permission";
/** The stream tag on OpenRig's record of each permit it decided by default. */
export const RUNNER_PERMIT_TAG = "runner-permission-permit";
const QUESTION_ID = "permission";
const NODE_TAG = "permission-node:";
const GENERATION_TAG = "permission-generation:";
const TURN_TAG = "permission-turn:";
const RUN_TAG = "permission-run:";
const NATIVE_TURN_TAG = "permission-native-turn:";
const WITHDRAWN_NOTE = "runner-permission-withdrawn";
const STALE_NOTE = "runner-permission-stale";
/** The agent's own allow and reject options, kept on the ask so a person's yes or no in words maps to them. */
const ALLOW_TAG = "permission-allow:";
const ALLOW_KIND_TAG = "permission-allow-kind:";
const REJECT_TAG = "permission-reject:";
const ASK_PREFIX = "qitem-runner-permission-";
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

/** A native ask's harness (the one whose own permission prompt it is), e.g. `permission-native-hook:claude-code`. */
const NATIVE_HOOK_TAG = "permission-native-hook:";
/** The fingerprint of the native tool call (its conversation, actor, tool and exact input), to match its later completion. */
const CALL_TAG = "permission-call:";
/** Who in the native conversation asked: `main`, or a subagent's id. */
const ACTOR_TAG = "permission-actor:";
/** Until when the harness's hook takes an answer here; after it (and a grace), an open native ask is over. */
const ANSWER_BY_TAG = "permission-answer-by:";
/** Which owner source a native ask went to: chosen-person, return-route or default-person. */
const ASKED_TAG = "permission-asked:";
/** Each option a native ask offers. An ask to a conversation can't carry questions (only a person's ask does), so its
 *  options travel as these. */
const OPTION_TAG = "permission-option:";
/** The harness's hook took the answer: recorded on the row that holds the decision, before the hook returns it. */
const TAKEN_NOTE = "runner-permission-taken-by-hook";
/** A tool call with this ask's exact input completed in the same conversation (matched by content, not by id). */
const COMPLETED_NOTE = "runner-permission-tool-completed";
const RESOLVED_CALL_NOTE = "runner-permission-call-resolved";
/** An agent's decision on a request (`rig seat decide-permission`), whoever records it. */
const DECIDED_NOTE = "runner-permission-decided";
/** A decision an agent records with `--relay`: its report that this is the person's own answer. OpenRig didn't get that
 *  answer from the person, so it stays unconfirmed, whoever the caller is or says it is. */
const RELAYED_DECISION = `${DECIDED_NOTE} as relayed by`;
/** The words a native decision's note ends with, each as a JSON string: the person's own as OpenRig received them, and
 *  what the decider reported they said. Its other text (the decider, a checked option id) can't end the note this way. */
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
const DECISION_WORDS = new RegExp(`(?:, because ${QUOTED})?(?:; the person wrote (${QUOTED}))?(?:; the decider reported they said (${QUOTED}))?$`);
/** The rows that can be a native ask: the WHERE clause of idx_queue_items_native_permission (migration 199), repeated byte
 *  for byte, which is what lets the planner read that small index instead of every row a seat ever sent. */
const NATIVE_ASK_ROWS = `tags LIKE '%"${NATIVE_HOOK_TAG}%'`;
const NATIVE_WITHDRAW_REASONS = new Set(["answer_window_ended", "answered_in_terminal"]);
const NATIVE_HOOK_ID = /^[a-z][a-z0-9-]{0,39}$/;
const FINGERPRINT = /^[a-f0-9]{16,64}$/;
const NATIVE_ACTOR = /^[A-Za-z0-9_-]{1,128}$/;
/** How much of the exact action an ask shows, and what the hook may send of it. */
const MAX_ACTION_TEXT = 4000;
const MAX_ACTION_INPUT = 65536;
const MAX_WORDS = 1000;
/** The hook's window when it names none, and the longest it may name (openrig-core's hook names a day). */
const DEFAULT_HOLD_SECONDS = 300;
const MAX_HOLD_SECONDS = 86400;
/** After its window, an open native ask is given this long for its hook's own withdrawal before OpenRig ends it. */
const NATIVE_GRACE_MS = 60_000;
/** A tool call's completion settles a native ask asked within this long. */
const SETTLE_LOOKBACK_MS = 6 * 3600 * 1000;
const HARNESS_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };
const harnessName = (hook: string): string => HARNESS_NAMES[hook] ?? hook;
/** A waiting hook reads its ask again as soon as each read answers (the read route holds one for 25 s at most), and 2 s
 *  after one that failed. A hook that hasn't read its ask for this long isn't reading it (it was killed outright, say), so
 *  an answer recorded now hasn't reached the prompt. */
const HOOK_SILENT_MS = 60_000;
/** When each native ask's hook last reached this daemon about it (its submit, or the start of a read), per database and in
 *  memory only: nothing is written. `since` is when this daemon began noting; a restarted daemon begins again, and a hook
 *  that's reading is noted within seconds. Past 1000 asks, the oldest note goes. */
const hookReads = new WeakMap<Database.Database, { since: number; at: Map<string, number> }>();
function hookReadsOf(db: Database.Database): { since: number; at: Map<string, number> } {
  let reads = hookReads.get(db);
  if (!reads) { reads = { since: Date.now(), at: new Map() }; hookReads.set(db, reads); }
  return reads;
}
function noteHookRead(db: Database.Database, askId: string): void {
  const { at } = hookReadsOf(db);
  at.delete(askId);
  at.set(askId, Date.now());
  if (at.size > 1000) at.delete(at.keys().next().value!);
}
const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Whether a native ask's answer can reach its prompt now, from its hook's reads as this daemon saw them: `hookLastRead`
 *  when one was seen, and `notReached`, the plain words for whoever answered, when the hook hasn't read the ask for
 *  HOOK_SILENT_MS (nor since this daemon began noting, that long ago). Nothing is refused or undone: the answer stays
 *  recorded, and a hook that does read the ask again takes it as usual. The hook taking it (`taken`) stays the proof
 *  that it reached the hook. */
export function nativeAnswerReach(db: Database.Database, ask: Pick<QueueItem, "qitemId" | "sourceSession">, now = Date.now()):
  { hookLastRead?: string; notReached?: string } {
  const reads = hookReadsOf(db);
  const last = reads.at.get(ask.qitemId);
  const since = last ?? reads.since;
  return { ...(last !== undefined ? { hookLastRead: isoSeconds(last) } : {}),
    ...(now - since > HOOK_SILENT_MS ? { notReached: `It hasn't reached ${ask.sourceSession}'s prompt: the seat's permission hook hasn't read`
      + ` this ask since ${isoSeconds(since)}, so nothing has taken the answer there (the hook may have been stopped). Check the seat`
      + ` (rig capture ${ask.sourceSession}): if its prompt is still open, an answer in its terminal reaches it.` } : {}) };
}

/** A person's typed reply that plainly says yes or no; anything else says neither. */
function typedYesOrNo(answer: unknown): "yes" | "no" | null {
  if (!answer || typeof answer !== "object" || (answer as { kind?: unknown }).kind !== "typed-reply") return null;
  return plainYesOrNo(String((answer as { text?: unknown }).text ?? ""));
}

/** Words that plainly say yes or no (the same short lists a person's typed reply is read with); anything else says neither. */
export function plainYesOrNo(text: string): "yes" | "no" | null {
  const words = text.trim().toLowerCase().replace(/[.!?,;:]+$/, "").replace(/\s+/g, " ");
  return SAID_YES.has(words) ? "yes" : SAID_NO.has(words) ? "no" : null;
}

/** The harness a native ask is for (its own permission prompt), or null for a runner's ask. */
export function nativePermissionHook(item: Pick<QueueItem, "tags">): string | null {
  return item.tags?.find((tag) => tag.startsWith(NATIVE_HOOK_TAG))?.slice(NATIVE_HOOK_TAG.length) ?? null;
}

/** Whether a native ask's window, plus a grace for its hook's own withdrawal, has passed: its hook no longer takes an
 *  answer, so one given now would reach no one. */
export function nativeAskPastWindow(item: Pick<QueueItem, "tags">, now = Date.now()): boolean {
  const by = Date.parse(item.tags?.find((tag) => tag.startsWith(ANSWER_BY_TAG))?.slice(ANSWER_BY_TAG.length) ?? "");
  return nativePermissionHook(item) !== null && Number.isFinite(by) && now > by + NATIVE_GRACE_MS;
}

/** The note a native ask past its window closes with. */
export function nativeWindowEndedNote(item: Pick<QueueItem, "tags">): string {
  return `${WITHDRAWN_NOTE} reason=answer_window_ended: ${nativeWithdrawText("answer_window_ended", nativePermissionHook(item) ?? "claude-code")}`;
}

/** A person's words, kept whole but on one line, bounded. */
const oneLine = (value: string): string => clip(value.replace(/\s+/g, " ").trim(), MAX_WORDS);
/** Words a native decision's note quoted as JSON (DECISION_WORDS), or null. */
function quoted(json: string | undefined): string | null {
  try { return json ? String(JSON.parse(json)) || null : null; } catch { return null; }
}

/** A person's typed reply that says more than a plain yes or no: their own words, whole. */
function typedWords(answer: unknown): string | null {
  if (!answer || typeof answer !== "object" || (answer as { kind?: unknown }).kind !== "typed-reply" || typedYesOrNo(answer)) return null;
  const words = String((answer as { text?: unknown }).text ?? "").trim();
  return words || null;
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
/** The exact action a harness's own prompt shows, as its permission hook received it. */
export type NativeAction = {
  tool: string;
  /** The tool's input, as the harness gave it; `inputText` instead when the hook had to cut it (`inputCut`). */
  input?: unknown;
  inputText?: string;
  inputCut?: boolean;
  /** A subagent's id; null for the main conversation. */
  agent?: string | null;
  /** The call's fingerprint (claudeToolCallFingerprint in the hook scripts), to match its later completion. */
  callFingerprint?: string;
};
export type RunnerPermissionRequest = {
  nativeRef: string;
  runId?: string;
  nativeTurnId?: string;
  turnId: string;
  requestId: string;
  toolCall: { title?: string; kind?: string };
  options: RunnerPermissionOption[];
  /** Set for a native ask: the harness whose own permission prompt this is (`claude-code`). */
  nativeHook?: string;
  action?: NativeAction;
  /** How long the harness's hook takes an answer here. */
  holdSeconds?: number;
};

export type SubmitRefusalCode = "denied_by_seat" | "duplicate_request" | "invalid_permission_request" | "options_unsupported" | "turn_withdrawn";
export type SubmitResult =
  | { ok: true; askId: string; created: boolean; askedOf?: string; answerBy?: string }
  | { ok: true; state: "permitted"; optionId: string; reason: string }
  /** A native ask nobody can be asked: nothing is decided, and the harness's own prompt carries on. */
  | { ok: true; state: "not_asked"; reason: string }
  | { ok: false; code: SubmitRefusalCode; message: string };
/** What a native ask's read adds: how it was answered and by whom, the words for the harness's agent, why it ended, and
 *  whether the hook took the answer and the tool call later completed. */
export type NativeReadFacts = {
  hook: string;
  /** Whose answer it is: `person`, the person's own, as OpenRig received it from them (a pick, or a plain yes or no, in
   *  Feed, Steering, the TUI or Slack); `relayed`, an agent's report that it's the person's own answer (`--relay`), which
   *  OpenRig didn't get from them, so it's unconfirmed; `agent`, an agent's judgment on the person's words. Absent on an ask
   *  closed as denied, which says who closed it (`by`), not whose answer it was. */
  answeredAs?: "person" | "relayed" | "agent";
  by?: string;
  /** The person's words as OpenRig received them from the person. */
  said?: string;
  /** The words the decider reported the person said (`--person-said`), when they aren't `said`: its report, unconfirmed. */
  reported?: string;
  message?: string;
  why?: string;
  taken?: boolean;
  toolCompleted?: boolean;
  /** A decision call that recorded nothing: the ask was already answered, or it ended. */
  unchanged?: boolean;
  /** On an answer the hook hasn't taken: when the seat's hook last read the ask, as this daemon saw it, and, when it hasn't
   *  read it lately, the plain words saying the answer hasn't reached the prompt (nativeAnswerReach). */
  hookLastRead?: string;
  notReached?: string;
};
type ReadOk =
  /** `unanswered`: a native ask closed without an answer. Nothing was decided; the harness's own prompt carries on. */
  | { ok: true; state: "pending" | "withdrawn" | "stale" | "unanswered" }
  | { ok: true; state: "answered" | "permitted"; optionId: string; said?: string }
  | { ok: true; state: "refused"; reason: "no_allow_offered" | "said_no"; said?: string };
export type ReadResult = (ReadOk & { native?: NativeReadFacts }) | { ok: false; code: "not_found"; message: string };
export type WithdrawResult = ReadResult | { ok: false; code: "invalid_permission_request"; message: string };

const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
/** A JSON-RPC id or prompt number as the runner passed it: a number reads as its decimal string, so 7 and "7" match. */
const idText = (value: unknown): string | null => typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
const clip = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, max - 1)}…`;
const tagValue = (item: QueueItem, prefix: string): string | null => item.tags?.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? null;
/** An option as a person reads it in a record; one the agent's harness remembers says so. */
const optionText = (name: string, kind: string | null, optionId: string): string =>
  `${clip(name, MAX_AGENT_TEXT)} (${kind ? `${kind}, ` : ""}${optionId})${kind === "allow_always" ? `: ${NATIVE_MEANING.allow_always}` : ""}`;

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
  if ((body.runId !== undefined || body.nativeTurnId !== undefined)
    && (!text(body.runId) || !text(body.nativeTurnId) || String(body.runId).length > 1024 || String(body.nativeTurnId).length > 1024))
    return { ok: false, message: "Native permission correlation requires both runId and nativeTurnId." };
  if (!Array.isArray(body.options)) return { ok: false, message: "A permission request needs options[]." };
  const options: RunnerPermissionOption[] = [];
  for (const raw of body.options as unknown[]) {
    const option = (raw ?? {}) as Record<string, unknown>;
    const optionId = text(option.optionId), name = text(option.name), kind = text(option.kind);
    if (!optionId || !name || !kind) return { ok: false, message: "Each option needs optionId, name and kind." };
    options.push({ optionId, name, kind });
  }
  const toolCall = (body.toolCall ?? {}) as Record<string, unknown>;
  const native = parseNativeParts(body);
  if (native && "message" in native) return { ok: false, message: native.message };
  return { ok: true, request: { nativeRef, turnId, requestId, options,
    ...(body.runId ? { runId: text(body.runId)!, nativeTurnId: text(body.nativeTurnId)! } : {}),
    toolCall: { title: text(toolCall.title) ?? undefined, kind: text(toolCall.kind) ?? undefined }, ...(native ?? {}) } };
}

/** A native ask's own parts (`nativeHook`, `action`, `holdSeconds`), or what's wrong with them; null for a runner's ask. */
function parseNativeParts(body: Record<string, unknown>): Pick<RunnerPermissionRequest, "nativeHook" | "action" | "holdSeconds"> | { message: string } | null {
  if (body.nativeHook === undefined) return null;
  const hook = text(body.nativeHook);
  if (!hook || !NATIVE_HOOK_ID.test(hook)) return { message: "nativeHook names the harness whose own permission prompt this is, such as claude-code." };
  const action = (body.action ?? {}) as Record<string, unknown>;
  const tool = text(action.tool);
  if (!tool || tool.length > 128) return { message: "A native permission request needs action.tool: the tool its prompt names." };
  if (action.callFingerprint !== undefined && (typeof action.callFingerprint !== "string" || !FINGERPRINT.test(action.callFingerprint)))
    return { message: "action.callFingerprint is the hook's hex fingerprint of the call." };
  if (action.agent != null && (typeof action.agent !== "string" || !NATIVE_ACTOR.test(action.agent)))
    return { message: "action.agent is a subagent's id, or null for the main conversation." };
  const hold = body.holdSeconds;
  const holdSeconds = typeof hold === "number" && Number.isSafeInteger(hold) && hold >= 1 && hold <= MAX_HOLD_SECONDS ? hold : DEFAULT_HOLD_SECONDS;
  return { nativeHook: hook, holdSeconds, action: { tool,
    ...(action.input !== undefined ? { input: action.input } : {}),
    ...(typeof action.inputText === "string" ? { inputText: action.inputText.slice(0, MAX_ACTION_INPUT) } : {}),
    inputCut: action.inputCut === true, agent: (action.agent as string | null | undefined) ?? null,
    ...(typeof action.callFingerprint === "string" ? { callFingerprint: action.callFingerprint } : {}) } };
}

/** The exact action as an ask shows it: a command as its text, any other tool's input as its JSON. Text that looks like a
 *  credential (the transcript route's redaction list) is shown as [REDACTED] before anything is stored, and the display is
 *  bounded; the request itself is never changed. */
export function nativeActionDisplay(action: NativeAction): { title: string; text: string; redacted: boolean; cut: boolean } {
  const input = action.input as Record<string, unknown> | undefined;
  let raw: string;
  if (typeof action.inputText === "string") raw = action.inputText;
  else if (action.tool === "Bash" && input && typeof input.command === "string") raw = input.command;
  else {
    try { raw = JSON.stringify(action.input ?? {}, null, 2) ?? "{}"; } catch { raw = "(its input couldn't be read)"; }
  }
  const redactedText = redactTranscriptContent(raw);
  const cut = action.inputCut === true || redactedText.length > MAX_ACTION_TEXT;
  const shown = redactedText.length > MAX_ACTION_TEXT ? redactedText.slice(0, MAX_ACTION_TEXT) : redactedText;
  const first = shown.split("\n").map((line) => line.trim()).find((line) => line.length > 0 && line !== "{") ?? "";
  return { title: `${action.tool}: ${clip(first, 160)}`, text: shown, redacted: redactedText !== raw, cut };
}

/** A fence that a code block's own text can't close. */
function fenceFor(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

export class RunnerPermissions {
  // Routes construct short-lived services; counts must span those instances while a queue create awaits.
  private static readonly submissions = new WeakMap<Database.Database, Map<string, number>>();
  private submissionKey(nodeId: string, target: { runId?: string; nativeTurnId?: string }): string {
    return JSON.stringify([nodeId, target.runId, target.nativeTurnId]);
  }
  private submissions(): Map<string, number> {
    let counts = RunnerPermissions.submissions.get(this.deps.db);
    if (!counts) { counts = new Map(); RunnerPermissions.submissions.set(this.deps.db, counts); }
    return counts;
  }
  constructor(private readonly deps: {
    db: Database.Database;
    queueRepo: QueueRepository;
    eventBus: EventBus;
    humanRegistry: () => LoadResult;
    ownerOf: (nodeId: string) => string | null;
    currentGeneration: (nodeId: string) => string | null;
    /** Where each default permit is recorded; without one, nothing is recorded. */
    stream?: Pick<StreamStore, "emit">;
    /** Settles when the daemon starts shutting down: a waiting read answers then, so it doesn't hold the shutdown. */
    stopping?: Promise<unknown>;
  }) {}

  /** One ask per live agent request: the same seat generation, conversation and request id always name the same ask. */
  static askIdFor(seat: RunnerPermissionSeat, request: Pick<RunnerPermissionRequest, "nativeRef" | "requestId">): string {
    const key = JSON.stringify([seat.nodeId, seat.generation, request.nativeRef, request.requestId]);
    return `qitem-runner-permission-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  }

  async submit(seat: RunnerPermissionSeat, request: RunnerPermissionRequest): Promise<SubmitResult> {
    if (request.nativeHook) return this.submitNative(seat, request);
    if (this.turnFenced(seat.nodeId, request)) return { ok: false, code: "turn_withdrawn", message: "Native turn permissions are withdrawn." };
    const selected = this.deps.ownerOf(seat.nodeId);
    if (selected === PERMISSIONS_DENY) {
      return { ok: false, code: "denied_by_seat",
        message: "This seat's operator chose to refuse its runner's permission requests (rig seat set-permissions-to --deny). Refuse the request and hold attention." };
    }
    const allow = request.options.find((option) => option.kind === "allow_once") ?? request.options.find((option) => option.kind === "allow_always");
    const reject = request.options.find((option) => option.kind === "reject_once") ?? request.options.find((option) => option.kind === "reject_always");
    // OpenRig's default is permit: when no one can be asked, the agent gets its own allow option at once.
    const permit = (why: string): SubmitResult => {
      if (this.turnFenced(seat.nodeId, request)) return { ok: false, code: "turn_withdrawn", message: "Native turn permissions are withdrawn." };
      if (!allow) return { ok: false, code: "options_unsupported", message: `No one can be asked (${why}), and the agent offered no allow option to permit.` };
      // One record per request and turn: a resubmitted request finds its record already there.
      const key = JSON.stringify([seat.nodeId, seat.generation, request.nativeRef, request.requestId, request.turnId]);
      this.recordPermit(`runner-permit-request-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`, seat.sessionName, seat.nodeId, () => [
        `OpenRig permitted ${seat.sessionName}'s agent by default, without asking anyone: ${why}.`,
        "",
        `- **Tool call:** ${clip(request.toolCall.title ?? "a tool call", MAX_AGENT_TEXT)} (${clip(request.toolCall.kind ?? "other", MAX_AGENT_TEXT)}), as the agent described it.`,
        `- **Option given:** ${optionText(allow.name, allow.kind, allow.optionId)}.`,
        `- **Conversation:** ${request.nativeRef}, turn ${request.turnId}, request ${request.requestId}.`,
      ]);
      return { ok: true, state: "permitted", optionId: allow.optionId, reason: why };
    };
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
    const counts = this.submissions(), key = this.submissionKey(seat.nodeId, request);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    try {
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
          ...(request.runId && request.nativeTurnId ? [`${RUN_TAG}${request.runId}`, `${NATIVE_TURN_TAG}${request.nativeTurnId}`] : []),
          ...(allow ? [`${ALLOW_TAG}${allow.optionId}`, `${ALLOW_KIND_TAG}${allow.kind}`] : []), ...(reject ? [`${REJECT_TAG}${reject.optionId}`] : [])],
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
          "Your answer, a choice or your own words, goes to this host's receiving agent, which decides this one request while the agent waits: it acts on a clear answer at once, and asks you back when your words aren't clear. Where no agent can decide here, your answer is kept and the request waits, and nothing runs: decide directly with rig seat decide-permission, or set up a receiving agent. Closing this without answering counts as no answer, and then OpenRig's default applies: the request is permitted. If the agent's turn ends first, your answer isn't sent.",
        ].join("\n"),
      });
      if (this.turnFenced(seat.nodeId, request)) {
        this.withdrawOne(seat, askId, "turn_cancelled");
        return { ok: false, code: "turn_withdrawn", message: "Native turn ended while the ask was being submitted." };
      }
      return { ok: true, askId, created: true };
    } finally {
      const remaining = counts.get(key)! - 1;
      if (remaining) counts.set(key, remaining); else counts.delete(key);
    }
  }

  /** A harness's own permission prompt, submitted by its permission hook. With someone to ask, one ask opens and the hook
   *  waits on it while the prompt stays open in the seat's terminal; with no one, nothing is asked and nothing decided
   *  (`not_asked`): the prompt carries on, as it does without OpenRig. Never a default permit or a refusal. */
  private async submitNative(seat: RunnerPermissionSeat, request: RunnerPermissionRequest): Promise<SubmitResult> {
    const hook = request.nativeHook!, action = request.action!;
    const name = harnessName(hook);
    const notAsked = (why: string): SubmitResult => ({ ok: true, state: "not_asked",
      reason: `${why.charAt(0).toUpperCase()}${why.slice(1)}. Nothing was decided: ${name}'s own prompt stays open in the seat's terminal.` });
    const ids = new Set(request.options.map((option) => option.optionId));
    if (request.options.length < 2 || request.options.length > 4 || ids.size !== request.options.length
      || request.options.some((option) => !OPTION_ID.test(option.optionId) || !ANSWERABLE_KINDS.has(option.kind))) {
      return notAsked("these options can't be shown to a person: an ask takes 2-4 options with distinct ids of letters, digits, \"-\" or \"_\"");
    }
    const owner = this.nativeOwner(seat);
    if (!owner.ok) return notAsked(owner.why);
    this.withdrawEarlierGenerations(seat);
    const askId = RunnerPermissions.askIdFor(seat, request);
    const existing = this.deps.queueRepo.getById(askId);
    if (existing) {
      if (tagValue(existing, TURN_TAG) === request.turnId) return { ok: true, askId, created: false, askedOf: existing.destinationSession,
        answerBy: tagValue(existing, ANSWER_BY_TAG) ?? undefined };
      return { ok: false, code: "duplicate_request", message: `Request ${request.requestId} of this conversation was already submitted in turn ${tagValue(existing, TURN_TAG)}.` };
    }
    const allow = request.options.find((option) => option.kind === "allow_once") ?? request.options.find((option) => option.kind === "allow_always");
    const reject = request.options.find((option) => option.kind === "reject_once") ?? request.options.find((option) => option.kind === "reject_always");
    const shown = nativeActionDisplay(action);
    const holdSeconds = request.holdSeconds ?? DEFAULT_HOLD_SECONDS;
    const answerBy = new Date(Date.now() + holdSeconds * 1000).toISOString();
    const window = holdSeconds % 3600 === 0 ? `${holdSeconds / 3600} hour${holdSeconds === 3600 ? "" : "s"}`
      : holdSeconds % 60 === 0 ? `${holdSeconds / 60} minute${holdSeconds === 60 ? "" : "s"}` : `${holdSeconds} s`;
    const fence = fenceFor(shown.text);
    const description = action.tool === "Bash" && typeof (action.input as { description?: unknown } | undefined)?.description === "string"
      ? oneLine(redactTranscriptContent(String((action.input as { description: string }).description))) : null;
    const byRoute = owner.source === "return-route";
    const optionNames = request.options.map((option) => option.name).join(", ");
    const allowId = allow?.optionId ?? "allow", rejectId = reject?.optionId ?? "deny";
    await this.deps.queueRepo.create({
      qitemId: askId,
      sourceSession: seat.sessionName,
      destinationSession: owner.address,
      // A person gets an ordinary ask, alerted where they answer (Feed, Slack). A conversation gets a task its own hooks bring
      // it, with the options as tags: questions are for a person to click.
      ...(byRoute ? {} : { humanIntent: "decision" as const, humanAlert: true,
        humanQuestions: [{ id: QUESTION_ID, question: clip(`Allow ${seat.sessionName} to ${shown.title}?`, MAX_QUESTION_TEXT),
          options: request.options.map((option) => ({ id: option.optionId, label: clip(option.name, MAX_OPTION_LABEL) })) }] }),
      summary: clip(`Permission: ${seat.sessionName} asks to ${shown.title}`, 200),
      tags: [RUNNER_PERMISSION_TAG, `${NODE_TAG}${seat.nodeId}`, `${GENERATION_TAG}${seat.generation}`, `${TURN_TAG}${request.turnId}`,
        `${NATIVE_HOOK_TAG}${hook}`, `${ASKED_TAG}${owner.source}`, `${ANSWER_BY_TAG}${answerBy}`, `${ACTOR_TAG}${action.agent ?? "main"}`,
        ...request.options.map((option) => `${OPTION_TAG}${option.optionId}`),
        ...(action.callFingerprint ? [`${CALL_TAG}${action.callFingerprint}`] : []),
        ...(allow ? [`${ALLOW_TAG}${allow.optionId}`, `${ALLOW_KIND_TAG}${allow.kind}`] : []), ...(reject ? [`${REJECT_TAG}${reject.optionId}`] : [])],
      nudge: false,
      body: [
        `${seat.sessionName}'s ${name} is waiting at its own permission prompt for one tool call${action.agent ? ` (from its subagent ${action.agent})` : ""}.`,
        "",
        `- **Why you:** ${owner.why}.`,
        `- **Tool:** ${action.tool}${description ? `, described by ${name} as: ${description}` : ""}`,
        "- **The exact action:**",
        "",
        fence,
        shown.text,
        fence,
        "",
        `Shown as ${name} gave it${shown.redacted ? ", with text that looks like a credential shown as [REDACTED]" : ""}${shown.cut ? `, cut at ${MAX_ACTION_TEXT} characters` : ""}. OpenRig changes nothing in the request: an allow lets it run exactly as ${name} asked.`,
        `- **Its options here:** ${optionNames}. A remembered choice ("don't ask again") is only in the seat's terminal.`,
        "",
        ...(byRoute ? [
          "Ask your person, showing them the action above. Then record their answer:",
          `- **A plain yes or no is their own answer.** Pass it on exactly, with no second confirmation: \`rig seat decide-permission ${askId} --option ${allowId} --relay --person-said "<their exact words>"\` (or \`--option ${rejectId}\`). It's recorded as relayed by you, with their words as you report them: unconfirmed, since OpenRig doesn't get it from them.`,
          `- **Words or a condition** ("yes, but not on main"): judge whether this exact action meets them. If it does, \`--option ${allowId}\`; if it doesn't, \`--option ${rejectId}\`, each with \`--reason "<why>" --person-said "<their exact words>"\`. A deny takes their words back to ${seat.sessionName}'s agent so it can adapt; it's recorded as your judgment, not their no, with their words as you report them. If you can't tell what they meant, ask them again.`,
          "- **Never decide without their answer.** If they don't answer, leave it: the prompt waits in the seat's terminal.",
          `- **Answer here, not in ${seat.sessionName}'s terminal,** even when you see its prompt there: keys typed into the seat answer the prompt in the terminal and end this ask. The openrig plugin's \`rig_seat_decide_permission\` tool takes the same answer as the command.`,
        ] : [
          `Answer with ${optionNames}, or in your own words. A choice, or a plain yes or no, is your own answer: it goes to the prompt as you gave it. Your own words go to this host's receiving agent, which judges whether this exact action meets them: it allows it if it does, and otherwise denies it with your words, so the agent can adapt. It asks you back when your words aren't clear.`,
        ]),
        "",
        `OpenRig takes an answer here until ${answerBy} (${window}). The prompt is also open in the seat's terminal, and the first answer counts. Once it's answered there, or after that time, an answer here is too late and isn't sent. Closing this without an answer decides nothing.`,
      ].join("\n"),
    });
    // The hook reads it next: its submit counts as its first read.
    noteHookRead(this.deps.db, askId);
    return { ok: true, askId, created: true, askedOf: owner.address, answerBy };
  }

  /** Who answers a native prompt: the person chosen for the seat (`rig seat set-permissions-to`), else the return route of
   *  the work the seat is running (the person's own conversation; `seatReturnRoute`), else the default person. Nobody, and
   *  nothing is asked. */
  private nativeOwner(seat: RunnerPermissionSeat): { ok: true; address: string; source: "chosen-person" | "return-route" | "default-person"; why: string }
    | { ok: false; why: string } {
    const selected = this.deps.ownerOf(seat.nodeId);
    if (selected === PERMISSIONS_DENY) {
      return { ok: false, why: "this seat's operator opted in to refusing runner permission requests (rig seat set-permissions-to --deny); OpenRig doesn't refuse a harness's own prompt" };
    }
    let chosenProblem: string | null = null;
    if (selected) {
      const chosen = resolvePermissionOwner(selected, this.deps.humanRegistry);
      if (chosen.ok) return { ok: true, address: chosen.address, source: "chosen-person",
        why: this.latestSelection(seat.nodeId) ?? "you are the seat's chosen permission answer owner" };
      chosenProblem = chosen.message;
    }
    const route = this.seatReturnRoute(seat.sessionName);
    if (route) return { ok: true, address: route.address, source: "return-route",
      why: route.routes > 1 && !route.inProgress
        ? `your conversation handed ${seat.sessionName} its newest open work (${route.row}), and this address is that work's return route; it holds open work from ${route.routes} conversations, and none is in progress`
        : `your conversation handed ${seat.sessionName} the work it's running (${route.row}), and this address is that work's return route${route.routes > 1 ? `; it holds open work from ${route.routes} conversations, and this one's is in progress` : ""}` };
    const fallback = defaultPermissionOwner(this.deps.humanRegistry);
    if (fallback.ok) return { ok: true, address: fallback.address, source: "default-person",
      why: "you are the default person, and no one else is chosen for this seat or reached by its work's return route" };
    return { ok: false, why: `No one can be asked${chosenProblem ? ` (the person chosen for this seat: ${chosenProblem})` : ""}: the seat's work carries no return route on this host, and ${fallback.message}` };
  }

  /** The return route of the open work addressed to the seat (pending, in progress or blocked), with the row that carries
   *  it and how many conversations' work is open there. One route is that route. Work from several conversations gives the
   *  route of the work the seat is on, its newest in-progress row, else of its newest open row: a seat's prompt is about
   *  the work in its hands, and an older row it never claimed (a review's result, say) doesn't silence the conversation
   *  that handed it that work. A route that is the seat's own address is never one; when the chosen work's route names
   *  another host, there's none. */
  private seatReturnRoute(sessionName: string): { address: string; row: string; routes: number; inProgress: boolean } | null {
    let rows: Array<{ qitem_id: string; return_route: string; state: string }>;
    try {
      rows = this.deps.db.prepare(`SELECT qitem_id, return_route, state FROM queue_items WHERE destination_session = ?
        AND state IN ('pending','in-progress','blocked') AND return_route IS NOT NULL
        ORDER BY state = 'in-progress' DESC, ts_created DESC, rowid DESC`).all(sessionName) as typeof rows;
    } catch { return null; }
    const routed = rows.filter((row) => routeOnThisHost(row.return_route) !== sessionName);
    const chosen = routed[0];
    const address = chosen ? routeOnThisHost(chosen.return_route) : null;
    if (!chosen || !address) return null;
    return { address, row: chosen.qitem_id, routes: new Set(routed.map((row) => row.return_route)).size, inProgress: chosen.state === "in-progress" };
  }

  /** A grant's seat carries its launch generation: it reads only its own launch's requests. Only the current
   *  occupant's request can read pending or answered; an earlier occupant's reads stale, whatever answer it holds.
   *  `authority` is a caller's own check of the ask's seat, used in place of a second one. */
  read(seat: { nodeId: string; generation?: string } | null, askId: string, authority?: { current: boolean; unknown: boolean }): ReadResult {
    const result = this.readAsk(seat, askId, authority);
    const asked = result.ok ? this.deps.queueRepo.getById(askId) : null;
    const hook = asked ? nativePermissionHook(asked) : null;
    return result.ok && asked && hook ? { ...result, native: this.nativeFacts(asked, hook, result) } : result;
  }

  private readAsk(seat: { nodeId: string; generation?: string } | null, askId: string, authority?: { current: boolean; unknown: boolean }): ReadResult {
    const asked = this.deps.queueRepo.getById(askId);
    const origin = asked ? runnerPermissionOrigin(asked) : null;
    if (!asked || !origin || (seat && origin.nodeId !== seat.nodeId)) return { ok: false, code: "not_found", message: `No permission request ${askId} for this seat.` };
    const native = nativePermissionHook(asked) !== null;
    if (this.turnFenced(origin.nodeId, { runId: tagValue(asked, RUN_TAG) ?? undefined, nativeTurnId: tagValue(asked, NATIVE_TURN_TAG) ?? undefined }))
      return { ok: true, state: "withdrawn" };
    const item = this.liveEnd(asked);
    const { current: askIsCurrent, unknown } = authority ?? this.seatAuthority(origin);
    const callerMatches = !seat?.generation || seat.generation === origin.generation;
    // Unknown authority proves neither that this ask is current nor that a successor replaced it: it waits, unclosed and
    // ungranted, until the seat's generation is proven (current: as usual; replaced or gone: stale). A caller of another
    // generation never gets this wait.
    const unproven = unknown && callerMatches;
    // Handed to someone this host can't follow (another host, or no row that carries the ask): still no answer, and the
    // handoff itself never permits.
    if (!item) return (askIsCurrent && callerMatches) || unproven ? { ok: true, state: "pending" } : { ok: true, state: "stale" };
    // Still open (pending, or claimed or parked by the person): no answer yet.
    if (item.state === "pending" || item.state === "in-progress" || item.state === "blocked") {
      // A native ask past its window, whose hook never withdrew it (the harness ended it, or it died): it's over.
      if (native && this.pastWindow(asked)) {
        this.close(item, WITHDRAWN_NOTE, "answer_window_ended", nativeWithdrawText("answer_window_ended", nativePermissionHook(asked)!));
        return { ok: true, state: "withdrawn" };
      }
      if ((askIsCurrent && callerMatches) || unproven) return { ok: true, state: "pending" };
      if (!askIsCurrent && !unknown) this.close(item, STALE_NOTE, "relaunched: a later occupant holds this seat");
      return { ok: true, state: "stale" };
    }
    if (item.state === "canceled") {
      const withdrawn = this.deps.queueRepo.listTransitions(item.qitemId).some((transition) => transition.transitionNote?.startsWith(WITHDRAWN_NOTE));
      return { ok: true, state: withdrawn ? "withdrawn" : "stale" };
    }
    if (!callerMatches || (!askIsCurrent && !unknown)) return { ok: true, state: "stale" };
    // A request withdrawn after its row closed without a decision: it ended, so nothing decides it now. That holds whether or
    // not the seat can be read; only then does unknown authority leave the rest waiting.
    if (this.withdrawnAfterClose(item)) return { ok: true, state: "withdrawn" };
    if (unproven) return { ok: true, state: "pending" };
    // The person's answer, from the live row or back along the rows the request was handed through.
    const answer = this.personAnswer(item);
    // The options travel with the ask: a row handed to an agent to decide carries none of its own.
    const offered = this.offeredOptions(item);
    const allowId = tagValue(item, ALLOW_TAG), rejectId = tagValue(item, REJECT_TAG);
    // A refusing close (denied) is the agent's reject, and never a grant.
    if (item.closureReason === "denied" || item.state === "denied") {
      return rejectId ? { ok: true, state: "answered", optionId: rejectId } : { ok: true, state: "refused", reason: "said_no" };
    }
    if (answer != null) {
      // An answer counts only through an explicit decision (`rig seat decide-permission`, or a person's own direct reply
      // where no agent is wired to decide). An ordinary close without one leaves it waiting: never a direct action from
      // a kept click or plain yes or no, and never the default permit over the person's answer.
      if (!this.explicitlyDecided(item)) return { ok: true, state: "pending" };
      if (typeof answer === "string" && offered.includes(answer)) return { ok: true, state: "answered", optionId: answer };
      // A plain no in words is the agent's reject, and never a grant; a plain yes is its allow.
      const said = typedYesOrNo(answer);
      if (said === "no") return rejectId ? { ok: true, state: "answered", optionId: rejectId } : { ok: true, state: "refused", reason: "said_no" };
      if (said === "yes" && allowId) return { ok: true, state: "answered", optionId: allowId };
      // Other words nobody decided on are kept: the request waits for an explicit decision, or the turn's end.
      return { ok: true, state: "pending" };
    }
    // A native ask closed with no answer decides nothing: a close is never an approval, and the harness's prompt carries on.
    if (native) return { ok: true, state: "unanswered" };
    // Closed with no answer at all is no answer, so OpenRig's default applies: permit.
    if (!allowId) return { ok: true, state: "refused", reason: "no_allow_offered" };
    this.recordClosedAsk(asked, item, origin.nodeId, allowId);
    return { ok: true, state: "permitted", optionId: allowId };
  }

  /** Whether the ask's seat still holds its generation. The `currentGeneration` callback is asked once, and a throw or null
   *  from it is no answer: the one authority helper decides whether that is positive replacement or absence (not current,
   *  not unknown) or unknown (the callback alone never makes the ask current, even if the helper then reads it as current). */
  private seatAuthority(origin: { nodeId: string; generation: string }): { current: boolean; unknown: boolean } {
    let generation: string | null;
    try { generation = this.deps.currentGeneration(origin.nodeId); } catch { generation = null; }
    if (generation !== null) return { current: generation === origin.generation, unknown: false };
    const authority = this.deps.queueRepo.runnerPermissionAuthority(origin);
    return { current: false, unknown: authority !== "replaced" && authority !== "absent" };
  }

  /** The record of a permit after an ask closed without a choice: one per ask, however often the runner reads it. */
  private recordClosedAsk(asked: QueueItem, closed: QueueItem, nodeId: string, allowId: string): void {
    this.recordPermit(`runner-permit-ask-${asked.qitemId.slice(ASK_PREFIX.length)}`, asked.sourceSession, nodeId, () => {
      // Who closed it: the close itself, since later notes and delivery receipts on a closed row repeat its state.
      const closer = this.deps.queueRepo.closingTransition(closed.qitemId, closed.state)?.actorSession ?? "someone";
      const row = closed.qitemId === asked.qitemId ? "the ask" : `${closed.qitemId}, the row it was handed to at ${closed.destinationSession},`;
      const label = asked.humanQuestions?.find((question) => question.id === QUESTION_ID)?.options.find((option) => option.id === allowId)?.label;
      return [
        `OpenRig permitted ${asked.sourceSession}'s agent by default: its permission ask ${asked.qitemId} closed without a choice.`
          + ` ${closer} closed ${row} as ${closed.state}${closed.closureReason ? ` (${closed.closureReason})` : ""}.`,
        "",
        `- **Ask:** ${asked.summary ?? "a permission request"}, asked of ${asked.destinationSession}.`,
        `- **Option given:** ${optionText(label ?? allowId, tagValue(asked, ALLOW_KIND_TAG), allowId)}.`,
      ];
    });
  }

  /** Best effort: a record that can't be built or written is logged, and the permit goes ahead unchanged. With no stream,
   *  nothing is read to build one. */
  private recordPermit(streamItemId: string, sessionName: string, nodeId: string, lines: () => string[]): void {
    if (!this.deps.stream) return;
    try {
      this.deps.stream.emit({ streamItemId, sourceSession: sessionName, body: lines().join("\n"), hintType: "observation", hintUrgency: "low",
        hintTags: [RUNNER_PERMIT_TAG, `${NODE_TAG}${nodeId}`] });
    } catch (error) {
      console.error(`[runner-permissions] the record of a default permit for ${sessionName} wasn't written`, error);
    }
  }

  /** Wait up to `waitMs` for the ask to change, then read it. Subscribes before reading, so a change between the two isn't missed. */
  async readWhenChanged(seat: { nodeId: string; generation?: string } | null, askId: string, waitMs: number): Promise<ReadResult> {
    let release: () => void = () => {};
    const changed = new Promise<void>((resolve) => { release = resolve; });
    let liveId = askId; // after a route or handoff, the colleague's row is where the answer lands
    const unsubscribe = this.deps.eventBus.subscribe((event) => {
      const { type, qitemId } = event as { type?: string; qitemId?: string };
      // A handoff while this read waits (the person's answer going to the receiving agent) moves the request to a new
      // row: follow it, so the decision recorded there wakes this read rather than its next one.
      if (type === "queue.handed_off" && (qitemId === askId || qitemId === liveId)) {
        const asked = this.deps.queueRepo.getById(askId);
        liveId = (asked ? this.liveEnd(asked)?.qitemId : undefined) ?? liveId;
        return;
      }
      if (type === "queue.updated" && (qitemId === askId || qitemId === liveId)) release();
    });
    try {
      const now = this.withWords(askId, this.read(seat, askId));
      // A native ask's own hook reading it (the read it waits on): noted, so an answer recorded while it isn't reading says so.
      if (now.ok && now.native) noteHookRead(this.deps.db, askId);
      if (!now.ok || now.state !== "pending" || waitMs <= 0) return now;
      const asked = this.deps.queueRepo.getById(askId)!;
      liveId = this.liveEnd(asked)?.qitemId ?? askId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([changed, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }),
        ...(this.deps.stopping ? [this.deps.stopping] : [])]);
      if (timer) clearTimeout(timer);
      return this.withWords(askId, this.read(seat, askId));
    } finally {
      unsubscribe();
    }
  }

  /** An agent's decision on a request its person answered (`rig seat decide-permission`): one of the options the agent
   *  offered, recorded on the row that holds the request now, with who decided and why. A request that's no longer
   *  pending (decided, withdrawn or stale) returns as it is and nothing is written, so deciding twice changes nothing. */
  decide(askId: string, optionId: string, decider: string, reason: string, relayed: { relay?: boolean; personSaid?: string } = {}):
    ReadResult | { ok: false; code: "invalid_option" | "not_recorded" | "relay_unsupported"; message: string } {
    // One authority check for the whole decision, shared with its read. A second check could prove the seat current after
    // the read waited on unknown authority, and record a decision on a row already closed as denied or with no answer.
    const requested = this.deps.queueRepo.getById(askId);
    const hook = requested ? nativePermissionHook(requested) : null;
    // Only a harness's own prompt takes the person's answer relayed as theirs; a runner's request records the deciding agent.
    if (relayed.relay && requested && runnerPermissionOrigin(requested) && !hook) {
      return { ok: false, code: "relay_unsupported", message: `${askId} is a runner's request, which records the deciding agent's decision. --relay is for a seat's own ${harnessName("claude-code")} prompt. Nothing was decided.` };
    }
    const origin = requested ? runnerPermissionOrigin(requested) : null;
    const authority = origin ? this.seatAuthority(origin) : null;
    const now = this.read(null, askId, authority ?? undefined);
    // Nothing is written: a native ask says so, since the first answer counts and a later one is told it was too late.
    if (!now.ok || now.state !== "pending") return hook && now.ok ? { ...now, native: { ...(now.native ?? { hook }), unchanged: true } } : now;
    const asked = this.deps.queueRepo.getById(askId)!;
    const live = this.liveEnd(asked);
    if (!live) return now; // handed somewhere this host can't follow: nothing here to decide on
    // An explicit decision on a closed row is final: a read that waited on unproven authority must not let a later,
    // luckier authority check overwrite it.
    if ((live.state === "done" || live.state === "failed") && this.explicitlyDecided(live)) return now;
    // A decision isn't recorded on authority that can't be proven: it would wait as an unread decision. Decide again once the seat reads.
    if (authority?.unknown) {
      return { ok: false, code: "not_recorded", message: `${askId}'s seat can't be read right now, so its request can't be confirmed current. Nothing was decided. Decide again shortly.` };
    }
    // The same check proved a successor holds the seat: the ask is stale, and nothing is written.
    if (authority && !authority.current) return { ok: true, state: "stale" };
    const offered = this.offeredOptions(live);
    if (!offered.includes(optionId)) {
      return { ok: false, code: "invalid_option", message: `${optionId} isn't one of the options the agent offered: ${offered.join(", ") || "none recorded"}. Nothing was decided.` };
    }
    // Kept apart: what OpenRig received from the person (their words or pick on the request, placed by their own answer), and
    // what the decider reports they said, which stays its report. Neither replaces the other, and a report never reads as
    // their own answer: only an answer OpenRig receives from the person does.
    const typed = this.personAnswer(live) as { kind?: unknown; text?: unknown } | string | undefined;
    const typedText = typed && typeof typed === "object" && typed.kind === "typed-reply" ? String(typed.text ?? "").trim() || null : null;
    const received = typedText && hook ? oneLine(typedText) : typedText;
    const said = relayed.personSaid?.trim() ? oneLine(relayed.personSaid) : null;
    const reported = said !== null && said !== received ? said : null;
    const why = reason ? clip(reason, MAX_AGENT_TEXT) : "";
    // A native ask's note quotes its words as JSON, so a read can take them back from its end (DECISION_WORDS).
    const quote = (value: string) => hook ? JSON.stringify(value) : `"${value}"`;
    const words = `${why ? `, because ${hook ? quote(why) : why}` : ""}${received ? `; the person wrote ${quote(received)}`
      : typeof typed === "string" ? `; the person chose ${typed}` : ""}${reported ? `; the decider reported they said ${quote(reported)}` : ""}`;
    const transitionNote = hook && relayed.relay
      ? `${RELAYED_DECISION} ${decider}, unconfirmed (OpenRig didn't get this answer from the person): ${optionId}${words}`
      : `${DECIDED_NOTE} by ${decider}, an agent, not the person: ${optionId}${words}`;
    const recorded = this.deps.queueRepo.recordPermissionDecision({ qitemId: live.qitemId, actorSession: decider, questionId: QUESTION_ID, optionId,
      transitionNote, ...(hook ? { resolution: nativeDecisionMessage({ decider, relay: relayed.relay === true,
        denies: optionId === tagValue(asked, REJECT_TAG), received, reported, reason: why }) } : {}) });
    if (!recorded) return { ok: false, code: "not_recorded", message: `The decision couldn't be recorded on ${live.qitemId} (its row is ${live.state}). Nothing was decided. Read the request again.` };
    return this.read(null, askId);
  }

  /** A native ask's hook took the answer it read, and is about to return it to the harness's prompt: recorded once, on the
   *  row that holds the decision. It records only that the hook has it, not that the harness applied it. */
  taken(seat: { nodeId: string; generation?: string } | null, askId: string, optionId: string): ReadResult {
    const asked = this.deps.queueRepo.getById(askId);
    const hook = asked ? nativePermissionHook(asked) : null;
    const origin = asked ? runnerPermissionOrigin(asked) : null;
    if (!asked || !hook || !origin || (seat && (seat.nodeId !== origin.nodeId || (seat.generation && seat.generation !== origin.generation))))
      return { ok: false, code: "not_found", message: `No native permission request ${askId} for this seat.` };
    const now = this.read(seat, askId);
    if (!now.ok || now.state !== "answered" || now.optionId !== optionId) return now;
    const live = this.liveEnd(asked);
    if (live && !this.deps.queueRepo.listTransitions(live.qitemId).some((t) => t.transitionNote?.startsWith(TAKEN_NOTE))) {
      const name = harnessName(hook);
      this.deps.queueRepo.transitionLog.append({ qitemId: live.qitemId, state: live.state, actorSession: asked.sourceSession,
        transitionNote: `${TAKEN_NOTE}: ${name}'s permission hook in ${asked.sourceSession} took this answer (${optionId}) and is returning it to the prompt. Whether ${name} applied it isn't seen by OpenRig; a completed tool call is recorded only when one with this exact input is seen.` });
    }
    return this.read(seat, askId);
  }

  /** A seat's Claude tool calls resolved (its PostToolBatch, which names every call in the batch: run, failed or denied), by
   *  their fingerprints. For each, the newest native ask from this seat's generation and actor with that fingerprint that
   *  isn't settled yet: one still open was answered in the seat's terminal, so it's withdrawn and a later answer here is
   *  too late; one decided allow gets the tool call's completion recorded; one decided deny gets nothing (its call was
   *  denied, not run). The match is by content (conversation, actor, tool and exact input), since the harness's permission
   *  request carries no tool-call id. Returns how many asks it settled. */
  settleCompletedCalls(seat: { nodeId: string; sessionName: string; generation: string }, actor: string | null, fingerprints: readonly unknown[]): number {
    const since = new Date(Date.now() - SETTLE_LOOKBACK_MS).toISOString();
    const settledHere = new Set<string>();
    let settled = 0;
    // Every Claude seat's tool batch comes here, almost always with no native ask to find: the read covers only the seat's
    // native asks in the lookback (the partial index), never every row the seat ever sent.
    const candidates = this.deps.db.prepare(`SELECT qitem_id FROM queue_items WHERE source_session = ? AND ts_created >= ?
      AND ${NATIVE_ASK_ROWS} AND tags LIKE ? ORDER BY ts_created DESC, rowid DESC LIMIT 20`);
    for (const fingerprint of fingerprints.slice(0, 64)) {
      if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) continue;
      const rows = candidates.all(seat.sessionName, since, `%"${CALL_TAG}${fingerprint}"%`) as Array<{ qitem_id: string }>;
      const matches = rows.flatMap(({ qitem_id }) => {
        if (settledHere.has(qitem_id)) return [];
        const asked = this.deps.queueRepo.getById(qitem_id);
        const hook = asked ? nativePermissionHook(asked) : null;
        if (!asked || !hook || !asked.tags?.includes(`${CALL_TAG}${fingerprint}`) || tagValue(asked, NODE_TAG) !== seat.nodeId
          || tagValue(asked, GENERATION_TAG) !== seat.generation || tagValue(asked, ACTOR_TAG) !== (actor ?? "main")) return [];
        const live = this.liveEnd(asked);
        if (!live || live.state === "canceled") return [];
        const transitions = this.deps.queueRepo.listTransitions(live.qitemId);
        if (transitions.some((t) => t.transitionNote?.startsWith(COMPLETED_NOTE) || t.transitionNote?.startsWith(RESOLVED_CALL_NOTE))
          || this.withdrawnAfterClose(live)) return [];
        const open = live.state === "pending" || live.state === "in-progress" || live.state === "blocked";
        const decision = open ? null : this.read(null, qitem_id);
        return [{ qitem_id, asked, hook, live, open, decision }];
      });
      // A completed call can belong to an earlier answered ask while an identical later prompt is still waiting.
      // Consume an outstanding decision first; content alone is no reason to withdraw that later live prompt.
      const hasDecision = (match: typeof matches[number]): boolean => match.decision?.ok === true
        && (match.decision.state === "answered" || (match.decision.state === "refused" && match.decision.reason === "said_no"));
      for (const { qitem_id, asked, hook, live, open, decision } of [...matches.filter(hasDecision), ...matches.filter(match => !hasDecision(match))]) {
        settledHere.add(qitem_id);
        if (open) {
          this.close(live, WITHDRAWN_NOTE, "answered_in_terminal", `${nativeWithdrawText("answered_in_terminal", hook)} ${harnessName(hook)} reported a tool call with exactly this input resolved in the same conversation, without an answer from here (matched by its content; there's no tool-call id).`);
        } else {
          if (!decision?.ok || (decision.state !== "answered" && !(decision.state === "refused" && decision.reason === "said_no"))) break;
          const denied = decision.state === "refused" || decision.optionId === tagValue(asked, REJECT_TAG);
          this.deps.queueRepo.transitionLog.append({ qitemId: live.qitemId, state: live.state, actorSession: asked.sourceSession,
            transitionNote: denied
              ? `${RESOLVED_CALL_NOTE}: a tool batch resolved this denied call; no tool completion is claimed.`
              : `${COMPLETED_NOTE}: a tool call with exactly this input completed in the same ${harnessName(hook)} conversation after this allow (matched by its content; there's no tool-call id). It ran, unless the terminal's own answer came first.` });
        }
        settled++;
        break;
      }
    }
    return settled;
  }

  /** The option ids the request offered: its question's (back along the rows it was handed through), else a native ask's
   *  own option tags (an ask to a conversation, which carries no questions). */
  private offeredOptions(item: QueueItem): string[] {
    const asked = this.deps.queueRepo.permissionQuestionsFor(item)?.find((question) => question.id === QUESTION_ID)?.options.map((option) => option.id);
    if (asked?.length) return asked;
    return (item.tags ?? []).filter((tag) => tag.startsWith(OPTION_TAG)).map((tag) => tag.slice(OPTION_TAG.length));
  }

  /** Whether the ask's window, plus a grace for its hook's own withdrawal, has passed. */
  private pastWindow(asked: QueueItem): boolean {
    return nativeAskPastWindow(asked);
  }

  /** The transition that decided the row: `rig seat decide-permission`'s, a person's own direct reply, or a refusing close. */
  private decisionTransition(item: QueueItem): ReturnType<QueueRepository["listTransitions"]>[number] | null {
    const transitions = this.deps.queueRepo.listTransitions(item.qitemId);
    for (let i = transitions.length - 1; i >= 0 && transitions[i]!.state === item.state; i--) {
      const t = transitions[i]!;
      if (t.transitionNote?.startsWith("runner-permission-decided") || t.ownerNotificationKind === "human-decision-resolved") return t;
    }
    return this.deps.queueRepo.closingTransition(item.qitemId, item.state);
  }

  /** What a native ask's read adds (NativeReadFacts). */
  private nativeFacts(asked: QueueItem, hook: string, result: ReadOk): NativeReadFacts {
    const facts: NativeReadFacts = { hook };
    const live = this.liveEnd(asked) ?? asked;
    const notes = [...this.deps.queueRepo.listTransitions(asked.qitemId),
      ...(live.qitemId !== asked.qitemId ? this.deps.queueRepo.listTransitions(live.qitemId) : [])].map((t) => t.transitionNote ?? "");
    if (notes.some((note) => note.startsWith(TAKEN_NOTE))) facts.taken = true;
    if (notes.some((note) => note.startsWith(COMPLETED_NOTE))) facts.toolCompleted = true;
    if (result.state === "withdrawn" || result.state === "stale") {
      const ended = [...notes].reverse().find((note) => note.startsWith(WITHDRAWN_NOTE) || note.startsWith(STALE_NOTE));
      const why = ended?.match(/reason=([A-Za-z_]+)/)?.[1];
      if (why) facts.why = why;
    }
    if (result.state === "answered" || (result.state === "refused" && result.reason === "said_no")) {
      const decision = this.decisionTransition(live);
      const note = decision?.transitionNote ?? "";
      const by = decision?.actorSession ?? live.destinationSession;
      const denies = result.state === "refused" || result.optionId === tagValue(asked, REJECT_TAG);
      const decided = note.startsWith(DECIDED_NOTE);
      // The person's own answer only as OpenRig received it from them, on its human-answer path: never from a relay, from who
      // the caller is or says it is, or from the row's answer slot, which a decision fills with its option too. An ask closed
      // as denied any other way says who closed it, not whose answer it was.
      const human = !decided && decision?.ownerNotificationKind === "human-decision-resolved";
      facts.by = by;
      if (decided || human) facts.answeredAs = human ? "person" : note.startsWith(RELAYED_DECISION) ? "relayed" : "agent";
      const typed = live.humanAnswers?.[QUESTION_ID] as { kind?: unknown; text?: unknown } | string | undefined;
      const [, wrote, told] = decided ? DECISION_WORDS.exec(note) ?? [] : [];
      const words = decided ? quoted(wrote) : human && typed && typeof typed === "object" && typed.kind === "typed-reply"
        ? oneLine(String(typed.text ?? "")) || null : null;
      const reported = quoted(told);
      if (words) facts.said = words;
      if (reported) facts.reported = reported;
      const recorded = decided ? live.resolution?.split("\n").filter(Boolean).pop() ?? null : null;
      facts.message = recorded ?? (decided
        ? nativeDecisionMessage({ decider: by, relay: facts.answeredAs === "relayed", denies, received: words, reported, reason: "" })
        : !human ? `Denied: ${by} closed this ask as denied in OpenRig${live.resolution ? `: "${oneLine(live.resolution)}"` : "."}`
        : denies ? `Denied by ${by} in OpenRig: their own answer${words && plainYesOrNo(words) !== "no" ? `. They wrote: "${words}"` : "."}`
          : `Allowed once by ${by} in OpenRig: their own answer${words && plainYesOrNo(words) !== "yes" ? `. They wrote: "${words}"` : "."}`);
      // Until the hook takes it, say whether it's reading the ask at all.
      if (!facts.taken) Object.assign(facts, nativeAnswerReach(this.deps.db, asked));
    }
    return facts;
  }

  withdrawTurn(seat: RunnerPermissionSeat, target: { runId: string; nativeTurnId: string }): { confirmed: boolean; withdrawn: number; pendingSubmissions: number } {
    if (!target.runId || !target.nativeTurnId) return { confirmed: false, withdrawn: 0, pendingSubmissions: 0 };
    if (this.deps.currentGeneration(seat.nodeId) !== seat.generation) {
      const grants = new ActivityGrantStore(this.deps.db), active = grants.activeForNode(seat.nodeId);
      if (!active || active.runId !== target.runId || active.generation !== seat.generation || grants.standing(active.grantId) !== "current")
        return { confirmed: false, withdrawn: 0, pendingSubmissions: 0 };
    }
    if (!this.turnFenced(seat.nodeId, target)) this.deps.eventBus.emit({ type: "agent.runner_turn_fenced", nodeId: seat.nodeId,
      generation: seat.generation, ...target });
    const rows = this.deps.db.prepare(`SELECT qitem_id FROM queue_items
      WHERE EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value=?)
      AND EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value=?)
      AND EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value=?)`).all(
        `${NODE_TAG}${seat.nodeId}`, `${RUN_TAG}${target.runId}`, `${NATIVE_TURN_TAG}${target.nativeTurnId}`) as { qitem_id: string }[];
    let withdrawn = 0, confirmed = true;
    for (const row of rows) {
      const result = this.withdrawOne(seat, row.qitem_id, "turn_cancelled", true);
      if (result.ok && result.state === "withdrawn") withdrawn++;
      else if (!result.ok || result.state === "pending") confirmed = false;
    }
    const pendingSubmissions = this.submissions().get(this.submissionKey(seat.nodeId, target)) ?? 0;
    return { confirmed: confirmed && pendingSubmissions === 0, withdrawn, pendingSubmissions };
  }

  private turnFenced(nodeId: string, target: { runId?: string; nativeTurnId?: string }): boolean {
    return !!(target.runId && target.nativeTurnId && this.deps.db.prepare(`SELECT 1 FROM events WHERE node_id=?
      AND type='agent.runner_turn_fenced' AND json_extract(payload,'$.runId')=? AND json_extract(payload,'$.nativeTurnId')=? LIMIT 1`)
      .get(nodeId, target.runId, target.nativeTurnId));
  }

  withdraw(seat: { nodeId: string; generation?: string } | null, askId: string, reason: string): WithdrawResult {
    return this.withdrawOne(seat, askId, reason);
  }

  private withdrawOne(seat: { nodeId: string; generation?: string } | null, askId: string, reason: string, requireLocal = false): WithdrawResult {
    // A native ask's hook also says why it stopped: its window ended, or the prompt was answered in the terminal.
    const nativeReason = NATIVE_WITHDRAW_REASONS.has(reason) && (() => { const ask = this.deps.queueRepo.getById(askId); return !!ask && !!nativePermissionHook(ask); })();
    if (!WITHDRAW_REASONS.has(reason) && !nativeReason) {
      return { ok: false, code: "invalid_permission_request", message: "reason must be turn_cancelled, turn_ended or exited." };
    }
    const asked = this.deps.queueRepo.getById(askId);
    const origin = asked ? runnerPermissionOrigin(asked) : null;
    if (!asked || !origin || seat && (seat.nodeId !== origin.nodeId || seat.generation && seat.generation !== origin.generation))
      return { ok: false, code: "not_found", message: "Permission request does not belong to this seat." };
    const now = this.read(seat, askId);
    if (!now.ok || !["pending", "withdrawn"].includes(now.state)) return now;
    const live = this.liveEnd(asked);
    if (live && this.withdrawnAfterClose(live)) return { ok: true, state: "withdrawn" };
    // A handoff this host can't follow leaves its rows as they are; the runner just stops waiting. A row closed without a
    // decision (its answer kept, so the request read pending) can't be canceled: the withdrawal is recorded on it instead.
    const hook = nativePermissionHook(asked);
    if (live && (live.state === "pending" || live.state === "in-progress" || live.state === "blocked")) this.close(live, WITHDRAWN_NOTE, reason);
    else if (live) this.deps.queueRepo.update({ qitemId: live.qitemId, actorSession: live.sourceSession, state: live.state,
      transitionNote: `${WITHDRAWN_NOTE} reason=${reason}: ${hook ? nativeWithdrawText(reason, hook) : "the runner's request ended, so any answer or decision here is not sent."}` });
    return !requireLocal || live ? { ok: true, state: "withdrawn" } : { ok: true, state: "pending" };
  }

  /** A person who closed the ask with their own words, not a choice or a plain yes or no: the read passes them back as
   *  `said`, from the row that holds the answer, for the runner to give the agent. The outcome and option are unchanged. */
  private withWords(askId: string, result: ReadResult): ReadResult {
    if (!result.ok || !(result.state === "permitted" || (result.state === "refused" && result.reason === "no_allow_offered"))) return result;
    const asked = this.deps.queueRepo.getById(askId);
    const live = asked ? this.liveEnd(asked) : null;
    const said = typedWords(live ? this.personAnswer(live) : undefined);
    return said ? { ...result, said } : result;
  }

  /** Whether the runner's request was withdrawn after this row closed (recorded on the row, since it can't be canceled). */
  private withdrawnAfterClose(item: QueueItem): boolean {
    const transitions = this.deps.queueRepo.listTransitions(item.qitemId);
    for (let i = transitions.length - 1; i >= 0 && transitions[i]!.state === item.state; i--) {
      if (transitions[i]!.transitionNote?.startsWith(WITHDRAWN_NOTE)) return true;
    }
    return false;
  }

  /** Whether the row's close is an explicit decision: `rig seat decide-permission`'s, recorded on the row (also after an
   *  agent's ordinary close), or a person's own direct reply where no agent is wired to decide. */
  private explicitlyDecided(item: QueueItem): boolean {
    const transitions = this.deps.queueRepo.listTransitions(item.qitemId);
    for (let i = transitions.length - 1; i >= 0 && transitions[i]!.state === item.state; i--) {
      const t = transitions[i]!;
      if (t.transitionNote?.startsWith("runner-permission-decided") || t.ownerNotificationKind === "human-decision-resolved") return true;
    }
    return false;
  }

  /** The answer the request holds: the live row's own, else the nearest one back along the rows it was handed through
   *  (a person answered there, and the row was handed on to decide), so a person's no is never lost to a later close. */
  private personAnswer(item: QueueItem): unknown {
    let current: QueueItem | null = item;
    for (let hops = 0; current && hops <= MAX_HANDOFF_HOPS; hops++) {
      const answer = current.humanAnswers?.[QUESTION_ID];
      if (answer != null) return answer;
      current = current.handedOffFrom ? this.deps.queueRepo.getById(current.handedOffFrom) : null;
      if (current && !runnerPermissionOrigin(current)) return undefined;
    }
    return undefined;
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

  private close(item: QueueItem, note: string, reason: string, explanation?: string): void {
    const hook = nativePermissionHook(item);
    this.deps.queueRepo.update({ qitemId: item.qitemId, actorSession: item.sourceSession, state: "canceled",
      transitionNote: `${note} reason=${reason}: ${explanation ?? (hook ? nativeWithdrawText(reason, hook) : "the runner's request ended, so any answer here is not sent.")}` });
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

/** Why a native ask ended, in the words the person reading it sees: an answer here now is too late. */
function nativeWithdrawText(reason: string, hook: string): string {
  const name = harnessName(hook);
  if (reason === "answer_window_ended") {
    return `${name}'s permission hook stopped taking an answer here when its window ended, and the prompt is waiting in the seat's terminal. Too late here: answer in the terminal. An answer here isn't sent.`;
  }
  if (reason === "answered_in_terminal") {
    return `the prompt ended in the seat's terminal: it was answered or cancelled there, or the seat's ${name} stopped (a relaunch, say). An answer here is too late and isn't sent.`;
  }
  return `${name}'s request ended (${reason}), so an answer here isn't sent; if the prompt is still open, it's in the seat's terminal.`;
}

/** The one line a native decision recorded with `rig seat decide-permission` gives the harness's agent (as a deny's
 *  message) and the record: who decided and how (a relay stays unconfirmed: OpenRig didn't get that answer from the
 *  person), the person's words as OpenRig received them, the words the decider reported, and an agent's reason. */
function nativeDecisionMessage(input: { decider: string; relay: boolean; denies: boolean; received: string | null; reported: string | null; reason: string }): string {
  const { decider, relay, denies, received, reported, reason } = input;
  const words = `${received ? ` The person said: "${received}"` : ""}${reported ? ` ${decider} reports they said: "${reported}"` : ""}`;
  if (relay) return `${denies ? "Denied" : "Allowed once"}: ${decider} relayed this as the person's answer (unconfirmed: OpenRig didn't get this answer from them)${words ? `.${words}` : ", with none of their words."}`;
  return denies
    ? `Not allowed: ${decider}, deciding on the person's answer, judged that this exact action doesn't meet it${reason ? ` (${reason})` : ""}. That's its judgment, not the person's own no.${words}`
    : `Allowed once: ${decider}, deciding on the person's answer, judged that this exact action meets it${reason ? ` (${reason})` : ""}.${words}`;
}

/** Whether a native ask from this seat is open and still in its window: a person can answer the prompt through OpenRig
 *  right now, so the prompt alert waits (the wake ladder's permission leg), and so does its relay task, which would tell the
 *  same conversation to type the answer into the seat. After the window, or once the ask is settled, the alert goes on as
 *  before. */
export function nativeAskHoldsPrompt(db: Database.Database, sessionName: string, now = Date.now()): boolean {
  try {
    // The seat's native asks only (the partial index), not every row it ever sent: the wake ladder asks this on its ticks.
    const rows = db.prepare(`SELECT tags FROM queue_items WHERE source_session = ? AND state IN ('pending','in-progress','blocked','handed-off')
      AND ${NATIVE_ASK_ROWS} ORDER BY ts_created DESC LIMIT 20`).all(sessionName) as Array<{ tags: string | null }>;
    return rows.some(({ tags }) => {
      let parsed: unknown;
      try { parsed = JSON.parse(tags ?? "[]"); } catch { return false; }
      const by = Array.isArray(parsed) ? parsed.find((tag): tag is string => typeof tag === "string" && tag.startsWith(ANSWER_BY_TAG)) : undefined;
      const until = Date.parse(by?.slice(ANSWER_BY_TAG.length) ?? "");
      return Array.isArray(parsed) && parsed.includes(RUNNER_PERMISSION_TAG) && Number.isFinite(until) && now <= until;
    });
  } catch { return false; }
}
