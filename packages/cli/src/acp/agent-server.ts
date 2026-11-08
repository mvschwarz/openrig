import { randomBytes } from "node:crypto";
import type { JsonRpcPeer } from "./json-rpc-stdio.js";

// OpenRig as an ACP agent (rig acp serve): an ACP app's prompt becomes a queue row to the team's receiver, the row's
// transitions and handoffs come back as progress, and its closing resolution is the reply. A question the team asks the
// caller while it works comes to the app as a permission request, and the choice goes back through the person's answer
// path. The queue is the only work store: a session is the rows tagged with its id, so it can be listed and reopened.
// A turn's end_turn says only that the turn ended: the reply says whether the team closed the item, and a cancel stops
// this process waiting, never the team.

export const ACP_PROTOCOL_VERSION = 1;
export const AUTH_METHOD_ID = "openrig-local";
export const SESSION_TAG = "acp-session:";
export const CWD_TAG = "acp-cwd:";
/** Where the caller's prompt ends in a row's body; the rest is the note rig acp serve adds for the team. */
const FOOTER = "\n\n---\nSent by ";

/** One queue row as this adapter reads it. */
export interface TeamRow {
  qitemId: string;
  state: string;
  destinationSession: string;
  handedOffTo: string | null;
  closureReason: string | null;
  closureTarget: string | null;
  resolution: string | null;
  /** Who closed the row, from its closing transition (a note written after the close doesn't change it); null while open. */
  closer: string | null;
}

export interface TeamTransition {
  transitionId: number;
  ts: string;
  state: string;
  transitionNote: string | null;
  actorSession: string;
}

/** A row to the caller that asks for a decision, with the choices it offers (none: words only). */
export interface TeamAsk {
  qitemId: string;
  sourceSession: string;
  state: string;
  tsCreated: string;
  summary: string | null;
  body: string;
  tags: string[];
  questions: Array<{ id: string; question: string; options: Array<{ id: string; label: string; recommended?: boolean }> }>;
  /** What's recorded so far, by question id: the chosen option's id, or the words of a typed reply. */
  answers: Record<string, string>;
}

/** A row the caller sent through rig acp serve. */
export interface SentRow {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  summary: string | null;
  body: string;
  tags: string[];
}

/** The daemon answered a create and refused it, so nothing was written. Any other failure of a create leaves it unknown. */
export class TeamRefused extends Error {}

/** The queue verbs the adapter uses, acting as the caller. */
export interface TeamQueue {
  /** Create the row under the id the adapter chose, so a create whose answer is lost can be read back by that id. Throws
   *  TeamRefused only for a refusal the daemon answered with. */
  create(row: { qitemId: string; destination: string; body: string; summary: string; tags: string[] }): Promise<void>;
  show(qitemId: string): Promise<TeamRow>;
  /** The row, or null when this machine has no such row; throws when it can't tell. */
  find(qitemId: string): Promise<TeamRow | null>;
  transitions(qitemId: string): Promise<TeamTransition[]>;
  /** The row a handoff of `qitemId` created on this machine, if any. */
  successor(qitemId: string): Promise<string | undefined>;
  /** Open asks addressed to `person`. */
  openAsks(person: string): Promise<TeamAsk[]>;
  /** Every ask to `person` tagged for one chat, open or settled, to replay with it. */
  sessionAsks(person: string, sessionId: string): Promise<TeamAsk[]>;
  /** Record the caller's choice on an ask, through the person's answer path; a refusal comes back with its reason. */
  answer(qitemId: string, questionId: string, optionId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Rows the caller sent through rig acp serve. */
  sent(caller: string): Promise<SentRow[]>;
}

/** What a session works through: the queue as the caller, and the seat that receives the caller's tasks (when set). */
export interface TeamConnection {
  queue: TeamQueue;
  caller: string;
  receiver: string | undefined;
  /** Something about this connection the person should know, said once in each session before its first prompt's work. */
  notice?: string;
}

export interface AcpAgentOptions {
  /** Reaches the daemon (`rig`'s: the local one, or OPENRIG_URL's) and resolves the caller; returns guidance when it can't.
   *  Called lazily, never at initialize. */
  connect: () => Promise<TeamConnection | { error: string }>;
  version: string;
  pollMs: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Settles when the app's connection ends: open turns stop following their work (nothing could carry a reply). */
  closed?: Promise<void>;
}

const ACTIVE_STATES = new Set(["pending", "in-progress", "blocked"]);
/** How long a cancel waits for the app to settle questions it was showing (ACP has the client answer them cancelled). */
const QUESTION_SETTLE_MS = 2000;
const AUTH_REQUIRED = -32000;
const INVALID_PARAMS = -32602;

class AcpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

interface Session {
  id: string;
  cwd: string;
  /** The first row each prompt created, oldest first, with the last row its work reached. */
  sent: Array<{ root: string; tail: string }>;
  turn?: { cancel: () => void };
  noticed?: boolean;
}

type ContentBlock = { type: string; text?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string } };

/** The questions one turn has put to the app. Once the turn has ended, nothing from them reaches the app or the queue. */
interface TurnQuestions {
  finished: boolean;
  /** The person cancelled the turn: no further question opens, though one the app is showing still settles. */
  cancelled: boolean;
  /** Questions the app is still showing, by tool call id, each with how the chat names it. */
  outstanding: Map<string, string>;
  tasks: Set<Promise<void>>;
}
type Update = Record<string, unknown>;

/** The prompt as plain text for the row's body: text as written, links and embedded text resources named. */
export function promptText(prompt: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text" && block.text) parts.push(block.text);
    else if (block.type === "resource_link" && block.uri) parts.push(`[${block.name ?? "link"}](${block.uri})`);
    else if (block.type === "resource" && block.resource?.uri) {
      parts.push(block.resource.text !== undefined ? `${block.resource.uri}:\n\`\`\`\n${block.resource.text}\n\`\`\`` : block.resource.uri);
    }
  }
  return parts.join("\n\n").trim();
}

/** A queue row id in the form the CLI mints (`qitem-<UTC yyyymmddhhmmss>-<16 hex>`). */
export const newQitemId = () => `qitem-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(8).toString("hex")}`;

function oneLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The person's own words in a prompt, for the row's summary and the session's title. An app that wraps them in its
 *  own instructions marks them (T3 Code sends several blocks of harness text, then `<user_request>…</user_request>`);
 *  the row's body keeps everything the app sent. Only a prompt with one opening and one closing mark is read this
 *  way: with more, an example could be taken for the request, so the prompt stands as sent. */
function personsWords(text: string): string {
  if (text.split("<user_request>").length !== 2 || text.split("</user_request>").length !== 2) return text;
  const marked = /<user_request>([\s\S]*?)<\/user_request>/.exec(text)?.[1];
  return marked?.trim() ? marked : text;
}

const toolStatus = (state: string) =>
  state === "pending" ? "pending" : ACTIVE_STATES.has(state) ? "in_progress" : state === "done" || state === "handed-off" ? "completed" : "failed";

const transitionLine = (t: TeamTransition) =>
  `${t.ts.slice(11, 19)}Z ${t.actorSession} · ${t.state}${t.transitionNote ? `: ${t.transitionNote}` : ""}`;

const textContent = (text: string) => [{ type: "content", content: { type: "text", text } }];

/** Where one prompt's work stands after a read of its rows. */
type ChainState = { kind: "open"; tail: TeamRow } | { kind: "ended"; tail: TeamRow; reply: string };

/** Follows one prompt's work through its rows: each row is a step, and its new notes are emitted as they appear. */
class ChainFollower {
  private readonly chain: string[];
  private readonly seen = new Map<string, { lines: string[]; lastId: number; status: string; title: string }>();
  /** The seats the work has reached; a question from one of them during the turn belongs to it. */
  readonly seats = new Set<string>();

  constructor(private readonly queue: TeamQueue, private readonly emit: (update: Update) => void, readonly root: string) {
    this.chain = [root];
  }

  async read(): Promise<ChainState> {
    for (;;) {
      let tail!: TeamRow;
      for (const qitemId of this.chain) {
        const row = await this.queue.show(qitemId);
        const transitions = await this.queue.transitions(qitemId);
        tail = row;
        this.seats.add(row.destinationSession);
        const status = toolStatus(row.state);
        let entry = this.seen.get(qitemId);
        if (!entry) {
          const title = qitemId === this.root ? `Sent to ${row.destinationSession} (${qitemId})` : `Handed to ${row.destinationSession} (${qitemId})`;
          entry = { lines: [], lastId: 0, status, title };
          this.seen.set(qitemId, entry);
          this.emit({ sessionUpdate: "tool_call", toolCallId: qitemId, kind: "other", status, title, rawInput: { qitemId, destination: row.destinationSession } });
        }
        const fresh = transitions.filter((t) => t.transitionId > entry!.lastId);
        if (fresh.length > 0 || status !== entry.status) {
          for (const t of fresh) { entry.lines.push(transitionLine(t)); entry.lastId = Math.max(entry.lastId, t.transitionId); }
          entry.status = status;
          // An app that shows a step collapsed still shows its title, so the latest note leads it: a narrow panel cuts the end.
          const noted = fresh.filter((t) => t.transitionNote).at(-1);
          this.emit({
            sessionUpdate: "tool_call_update", toolCallId: qitemId, status,
            ...(noted ? { title: `${noted.actorSession}: ${oneLine(noted.transitionNote!, 100)} · ${entry.title}` } : {}),
            ...(entry.lines.length > 0 ? { content: textContent(entry.lines.join("\n")) } : {}),
          });
        }
      }
      // Both handoff forms pass the work on: `handoff` leaves the row handed-off, `handoff-and-complete` closes it done
      // with closure reason handed_off_to. Either way the answer is the successor's, not this row's.
      if (tail.state === "handed-off" || (tail.state === "done" && tail.closureReason === "handed_off_to")) {
        const next = await this.queue.successor(tail.qitemId);
        if (next) { this.chain.push(next); continue; }
        return { kind: "ended", tail, reply: `${tail.qitemId} was handed to ${tail.handedOffTo ?? tail.closureTarget ?? "another seat"}, whose row isn't on this machine, so this app can't follow it further. Ask your team for its result.` };
      }
      if (ACTIVE_STATES.has(tail.state)) return { kind: "open", tail };
      // A done row's closure reason says how it ended (canceled is a done close too); the ordinary one goes unsaid.
      const reason = tail.closureReason && tail.closureReason !== "no-follow-on" ? ` (${tail.closureReason})` : "";
      const how = tail.state === "done" ? `done${reason}` : `as ${tail.state}${reason}`;
      return { kind: "ended", tail, reply: `${tail.closer ?? tail.destinationSession} closed ${tail.qitemId} ${how}.\n\n${tail.resolution?.trim() || "(No resolution was written.)"}` };
    }
  }
}

export function serveAcpAgent(peer: JsonRpcPeer, options: AcpAgentOptions): void {
  const sessions = new Map<string, Session>();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => {});
  let clientName = "an ACP app";
  /** The app asks forms (ACP `elicitation/create`, mode form), so a question's choices go to it as a form, each by its
   *  label. A permission request shows them only in apps that list each option: T3 Code shows a fixed Approve, which
   *  sends the first. */
  let asksForms = false;
  let connection: TeamConnection | undefined;
  void options.closed?.then(() => { for (const session of sessions.values()) session.turn?.cancel(); });

  const connected = async (): Promise<TeamConnection> => {
    if (connection) return connection;
    const result = await options.connect();
    if ("error" in result) throw new AcpError(AUTH_REQUIRED, result.error);
    connection = result;
    return result;
  };

  const update = (sessionId: string, body: Update) => peer.notify("session/update", { sessionId, update: body });
  const say = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  /** A question the app showed ends unanswered: its card says so, and so does the chat, which every app shows, since an
   *  app need not show a card's later text. */
  const unanswered = (sessionId: string, toolCallId: string, named: string, why: string) => {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, content: textContent(`${why} The question is still open in the OpenRig TUI and Slack.`) });
    say(sessionId, `\n\n${why} ${named} is still open in the OpenRig TUI and Slack.\n\n`);
  };
  const newSessionId = () => `acps-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;

  /** Each of the caller's prompts in a session, oldest first, by the rows tagged with its id. */
  const sessionRoots = async (team: TeamConnection, sessionId: string) =>
    (await team.queue.sent(team.caller)).filter((row) => row.tags.includes(`${SESSION_TAG}${sessionId}`))
      .sort((a, b) => a.tsCreated.localeCompare(b.tsCreated));

  /** Put one ask's open questions to the person, as a form where the app asks forms and otherwise as permission
   *  requests, one at a time, and record each choice. A reply that arrives after the turn ended answers nothing here:
   *  the question stays open in the TUI and Slack. */
  const askPerson = async (team: TeamConnection, sessionId: string, ask: TeamAsk, turn: TurnQuestions) => {
    const emit = (body: Update) => { if (!turn.finished) update(sessionId, body); };
    if (ask.questions.length === 0) {
      emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n${ask.sourceSession} asks you: ${ask.summary ?? oneLine(ask.body, 200)} (${ask.qitemId}). It wants an answer in words, which this app can't send: answer it in the OpenRig TUI or Slack.\n\n` } });
      return;
    }
    for (const q of ask.questions.filter((question) => !(question.id in ask.answers))) {
      if (turn.finished || turn.cancelled) return;
      const toolCallId = `${ask.qitemId}#${q.id}`;
      emit({ sessionUpdate: "tool_call", toolCallId, kind: "other", status: "pending", title: `${ask.sourceSession} asks: ${q.question}`, content: textContent(ask.body) });
      const label = (o: (typeof q.options)[number]) => (o.recommended ? `${o.label} (recommended)` : o.label);
      const named = `${ask.sourceSession}'s question "${q.question}" (${ask.qitemId})`;
      let chosenId: string | undefined;
      turn.outstanding.set(toolCallId, named);
      try {
        if (asksForms) {
          // Each choice is offered as its label, the one form every app shows as choices: T3 Code 0.1.7 builds them only
          // from `enum`, a value serving as both label and answer, and reads `oneOf` as free text. Labels that repeat
          // carry their option's id, so a value names one choice; the answer is mapped back by that exact value.
          const shown = q.options.map(label);
          const values = new Set(shown).size === shown.length ? shown : q.options.map((o, i) => `${shown[i]} (${o.id})`);
          const result = (await peer.request("elicitation/create", {
            sessionId, toolCallId, mode: "form", message: `${ask.sourceSession} asks: ${q.question}`,
            requestedSchema: { type: "object", required: [q.id], properties: { [q.id]: { type: "string", title: q.question, enum: values } } },
          })) as { action?: string; content?: Record<string, unknown> | null } | undefined;
          const value = result?.action === "accept" ? result.content?.[q.id] : undefined;
          chosenId = typeof value === "string" ? q.options[values.indexOf(value)]?.id : undefined;
        } else {
          const result = (await peer.request("session/request_permission", {
            sessionId,
            toolCall: { toolCallId, title: `${ask.sourceSession} asks: ${q.question}`, kind: "other", status: "pending" },
            options: q.options.map((o) => ({ optionId: o.id, name: label(o), kind: "allow_once" })),
          })) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
          chosenId = result?.outcome?.outcome === "selected" ? result.outcome.optionId : undefined;
        }
      } catch (error) {
        if (!turn.finished) unanswered(sessionId, toolCallId, named, `This app couldn't show the question (${(error as Error).message}).`);
        return;
      } finally {
        turn.outstanding.delete(toolCallId);
      }
      if (turn.finished) return;
      // Only one of the question's own options is recorded: the app's reply is checked again here.
      const chosen = q.options.find((o) => o.id === chosenId);
      if (!chosen) {
        unanswered(sessionId, toolCallId, named, "Not answered here.");
        return;
      }
      const recorded = await team.queue.answer(ask.qitemId, q.id, chosen.id).catch((error: Error) => ({ ok: false as const, reason: error.message }));
      emit(recorded.ok
        ? { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: textContent(`You answered: ${chosen.label}. ${ask.sourceSession} gets it as your answer.`) }
        : { sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: textContent(`Your choice (${chosen.label}) wasn't recorded: ${recorded.reason}`) });
      log(`session ${sessionId}: ${recorded.ok ? "answered" : "couldn't answer"} ${ask.qitemId} ${q.id}`);
    }
  };

  peer.onRequest("initialize", async (params) => {
    const p = (params ?? {}) as { clientInfo?: { name?: string; title?: string }; clientCapabilities?: { elicitation?: { form?: unknown } | null } };
    clientName = p.clientInfo?.title ?? p.clientInfo?.name ?? clientName;
    // ACP counts a mode as supported only when its field is present and not null.
    asksForms = p.clientCapabilities?.elicitation?.form != null;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {} },
      },
      authMethods: [{
        id: AUTH_METHOD_ID,
        name: "OpenRig on this machine",
        description: "Sends your work to your OpenRig team, as you, through the same OpenRig daemon as `rig` on this computer: the local one (start it with `rig daemon start`), unless OPENRIG_URL names another.",
      }],
      agentInfo: { name: "openrig", title: "OpenRig", version: options.version },
    };
  });

  peer.onRequest("authenticate", async (params) => {
    const methodId = (params as { methodId?: unknown } | undefined)?.methodId;
    if (methodId !== AUTH_METHOD_ID) throw new AcpError(INVALID_PARAMS, `Unknown auth method ${String(methodId)}; this agent offers ${AUTH_METHOD_ID}`);
    const team = await connected();
    log(`authenticated as ${team.caller}${team.receiver ? `, sending to ${team.receiver}` : ", with no receiver set"}`);
    return {};
  });

  peer.onRequest("session/new", async (params) => {
    await connected();
    const id = newSessionId();
    sessions.set(id, { id, cwd: String((params as { cwd?: unknown } | undefined)?.cwd ?? ""), sent: [] });
    return { sessionId: id };
  });

  peer.onRequest("session/list", async (params) => {
    const team = await connected();
    const cwd = (params as { cwd?: unknown } | undefined)?.cwd;
    const byId = new Map<string, { sessionId: string; cwd: string; title: string; updatedAt: string }>();
    for (const row of (await team.queue.sent(team.caller)).sort((a, b) => a.tsCreated.localeCompare(b.tsCreated))) {
      const sessionId = row.tags.find((t) => t.startsWith(SESSION_TAG))?.slice(SESSION_TAG.length);
      if (!sessionId) continue;
      const known = byId.get(sessionId);
      if (known) { if (row.tsUpdated > known.updatedAt) known.updatedAt = row.tsUpdated; continue; }
      byId.set(sessionId, {
        sessionId, cwd: row.tags.find((t) => t.startsWith(CWD_TAG))?.slice(CWD_TAG.length) ?? "",
        title: oneLine(personsWords(row.body.split(FOOTER)[0] ?? ""), 100), updatedAt: row.tsUpdated,
      });
    }
    const listed = [...byId.values()].filter((s) => typeof cwd !== "string" || s.cwd === cwd).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions: listed };
  });

  peer.onRequest("session/load", async (params) => {
    const p = (params ?? {}) as { sessionId?: string; cwd?: string };
    const team = await connected();
    const sessionId = String(p.sessionId ?? "");
    const roots = await sessionRoots(team, sessionId);
    if (roots.length === 0) throw new AcpError(INVALID_PARAMS, `No session ${sessionId} from ${team.caller} on this machine`);
    const session: Session = { id: sessionId, cwd: String(p.cwd ?? ""), sent: [] };
    const asks = (await team.queue.sessionAsks(team.caller, sessionId)).sort((a, b) => a.tsCreated.localeCompare(b.tsCreated));
    // Replay: each prompt as the caller wrote it, then its work as it stands now, the questions the team asked during
    // it with what's recorded, and the reply. Nothing is asked again here; an open question comes up in the next turn.
    for (const [i, row] of roots.entries()) {
      update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: row.body.split(FOOTER)[0] ?? "" } });
      const follower = new ChainFollower(team.queue, (u) => update(sessionId, u), row.qitemId);
      const state = await follower.read();
      session.sent.push({ root: row.qitemId, tail: state.tail.qitemId });
      const next = roots[i + 1]?.tsCreated;
      for (const ask of asks.filter((a) => (i === 0 || a.tsCreated >= row.tsCreated) && (next === undefined || a.tsCreated < next))) {
        for (const q of ask.questions) {
          const answer = ask.answers[q.id];
          const outcome = answer !== undefined ? `You answered: ${q.options.find((o) => o.id === answer)?.label ?? answer}.`
            : ACTIVE_STATES.has(ask.state) ? "Not answered yet. It's still open in the OpenRig TUI and Slack." : `Not answered: ${ask.qitemId} was closed (${ask.state}).`;
          update(sessionId, {
            sessionUpdate: "tool_call", toolCallId: `${ask.qitemId}#${q.id}`, kind: "other", status: answer === undefined && ACTIVE_STATES.has(ask.state) ? "pending" : "completed",
            title: `${ask.sourceSession} asks: ${q.question}`, content: [...textContent(ask.body), ...textContent(outcome)],
          });
        }
      }
      say(sessionId, state.kind === "ended" ? state.reply : `${state.tail.qitemId} is still ${state.tail.state} with ${state.tail.destinationSession}.`);
    }
    sessions.set(sessionId, session);
    return {};
  });

  peer.onNotification("session/cancel", (params) => {
    const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
    if (sessionId) sessions.get(sessionId)?.turn?.cancel();
  });

  peer.onRequest("session/prompt", async (params) => {
    const p = (params ?? {}) as { sessionId?: string; prompt?: ContentBlock[] };
    const session = p.sessionId ? sessions.get(p.sessionId) : undefined;
    if (!session) throw new AcpError(INVALID_PARAMS, `No session ${String(p.sessionId)} in this agent; start one with session/new or session/load`);
    if (session.turn) throw new AcpError(INVALID_PARAMS, "This session already has a turn running; wait for it or cancel it first");
    const team = await connected();
    const text = promptText(Array.isArray(p.prompt) ? p.prompt : []);
    if (!text) {
      say(session.id, "Nothing to send: the prompt had no text.");
      return { stopReason: "end_turn" };
    }
    if (!team.receiver) {
      say(session.id, "This OpenRig agent has no team receiver, so nothing was sent. Choose the seat that takes your team's new work with `rig config set acp.to <member@rig>`, or add `--to <member@rig>` to the agent's command in your app's settings.");
      return { stopReason: "end_turn" };
    }
    if (team.notice && !session.noticed) {
      session.noticed = true;
      say(session.id, `${team.notice}\n\n`);
    }

    let wake: () => void = () => {};
    const questions: TurnQuestions = { finished: false, cancelled: false, outstanding: new Map(), tasks: new Set() };
    session.turn = { cancel: () => { questions.cancelled = true; wake(); } };
    let root: string | undefined;
    try {
      // Each earlier item as it stands; one whose create was never confirmed may not exist, or can't be read: say which.
      const earlier = await Promise.all(session.sent.map(async (s) => {
        const row = await team.queue.find(s.tail).catch(() => undefined);
        return { ...s, row, state: row === undefined ? "state unknown" : row === null ? "not found here" : row.state };
      }));
      const open = earlier.filter((s) => s.row && ACTIVE_STATES.has(s.row.state));
      if (open.length > 0) say(session.id, `${open.map((s) => `${s.row!.qitemId} is still ${s.row!.state} with ${s.row!.destinationSession}`).join("; ")}. Sending this as a follow-up.\n\n`);
      const lineage = earlier.length === 0 ? "" : `\nFollows up on ${earlier.map((s) => `${s.root} (${s.tail === s.root ? "" : `reached ${s.tail}, `}${s.state})`).join(", ")}.`;
      const body = `${text}${FOOTER}${team.caller} from ${clientName} through rig acp serve (session ${session.id}).${lineage}\n` +
        `The app shows this item's notes and handoffs as progress, and its closing resolution as the answer: close it with a resolution written for ${team.caller}. ` +
        `A question with choices you ask ${team.caller} while this is open, tagged for this chat, appears in the app as a choice: ` +
        `rig queue create --destination ${team.caller} --human-questions-file … --tags ${SESSION_TAG}${session.id}.`;
      const turnStarted = new Date().toISOString();
      const qitemId = newQitemId();
      try {
        await team.queue.create({
          qitemId, destination: team.receiver, body, summary: `ACP: ${oneLine(personsWords(text), 100)}`,
          tags: ["acp-serve", `${SESSION_TAG}${session.id}`, ...(session.cwd ? [`${CWD_TAG}${session.cwd}`] : [])],
        });
      } catch (error) {
        const reason = (error as Error).message;
        // A refusal the daemon answered with wrote nothing, so it can be said plainly.
        if (error instanceof TeamRefused) throw new AcpError(-32603, `The team's queue refused the task: ${reason}`);
        // No answer: the request may still land after any readback, so only a row that reads back settles it.
        const landed = await team.queue.find(qitemId).catch(() => undefined);
        if (!landed) {
          session.sent.push({ root: qitemId, tail: qitemId });
          say(session.id, `Sending ${qitemId} to ${team.receiver} got no answer (${reason}), and ${landed === null ? "it wasn't found on the immediate readback" : "it couldn't be read back"}: delivery is unconfirmed, so it may still reach the team. A new prompt in this session names it, and \`rig queue show ${qitemId}\` shows it if it landed.`);
          throw new AcpError(-32603, `Couldn't confirm ${qitemId}: ${reason}`);
        }
        log(`session ${session.id}: ${qitemId}'s create got no answer, but it reads back`);
      }
      root = qitemId;
      const sent = { root, tail: root };
      session.sent.push(sent);
      log(`session ${session.id}: sent ${root} to ${team.receiver}`);

      // ponytail: polls the daemon for the chain's rows, their transitions and the caller's open asks; the
      // daemon's event stream is the upgrade path if a poll per open turn ever costs too much.
      const follower = new ChainFollower(team.queue, (u) => update(session.id, u), root);
      const seen = new Set<string>();
      /** Close this turn's questions: any the app still shows are named as open elsewhere, then nothing more comes from them. */
      const finishQuestions = (why: string) => {
        for (const [toolCallId, named] of questions.outstanding) unanswered(session.id, toolCallId, named, why);
        questions.finished = true;
      };
      for (;;) {
        const state = await follower.read();
        sent.tail = state.tail.qitemId;
        if (state.kind === "ended") {
          finishQuestions("The work closed before this was answered here.");
          say(session.id, state.reply);
          return { stopReason: "end_turn" };
        }
        const asks = await team.queue.openAsks(team.caller);
        // After a cancel, even one that landed during that read, no new question goes to the person.
        for (const ask of questions.cancelled ? [] : asks) {
          if (seen.has(ask.qitemId)) continue;
          // An ask tagged for a chat belongs to that chat alone. An untagged one from a seat this work reached might be
          // another chat's, so it isn't asked here; it's named, with where to answer it.
          const chats = ask.tags.filter((tag) => tag.startsWith(SESSION_TAG));
          if (chats.includes(`${SESSION_TAG}${session.id}`)) {
            seen.add(ask.qitemId);
            const task: Promise<void> = askPerson(team, session.id, ask, questions)
              .catch((error: Error) => log(`session ${session.id}: asking about ${ask.qitemId} failed: ${error.message}`))
              .finally(() => questions.tasks.delete(task));
            questions.tasks.add(task);
          } else if (chats.length === 0 && follower.seats.has(ask.sourceSession) && ask.tsCreated >= turnStarted) {
            seen.add(ask.qitemId);
            say(session.id, `\n\n${ask.sourceSession}, which this work reached, has a question for you that isn't tagged for this chat (${ask.qitemId}: ${ask.summary ?? oneLine(ask.body, 120)}). Answer it in the OpenRig TUI or Slack.\n\n`);
          }
        }
        if (questions.cancelled) {
          // ACP has the app answer the questions it was showing as cancelled; let those answers land before the turn ends.
          if (questions.tasks.size > 0) await Promise.race([Promise.allSettled([...questions.tasks]), sleep(QUESTION_SETTLE_MS)]);
          finishQuestions("Not answered here: the turn was cancelled.");
          say(session.id, `Stopped waiting. ${state.tail.qitemId} is still ${state.tail.state} with ${state.tail.destinationSession}: cancelling here doesn't stop the team's work. A new prompt in this session goes to the team as a follow-up and shows where this stands.`);
          return { stopReason: "cancelled" };
        }
        await Promise.race([sleep(options.pollMs), new Promise<void>((resolve) => { wake = resolve; })]);
      }
    } catch (error) {
      if (error instanceof AcpError || !root) throw error;
      say(session.id, `Lost track of ${root}: ${(error as Error).message}. The item stays with the team; its state is unknown from here.`);
      throw new AcpError(-32603, `Couldn't follow ${root}: ${(error as Error).message}`);
    } finally {
      questions.finished = true;
      session.turn = undefined;
    }
  });
}
