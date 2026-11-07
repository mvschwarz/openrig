import { randomBytes } from "node:crypto";
import type { JsonRpcPeer } from "./json-rpc-stdio.js";

// OpenRig as an ACP agent (rig acp serve): an ACP app's prompt becomes a queue row to the team's receiver, the row's
// transitions and handoffs come back as progress, and its closing resolution is the reply. The queue is the only work
// store; this process keeps nothing but which rows each open session sent. A turn's end_turn says only that the turn
// ended: the reply says whether the team closed the item, and a cancel stops this process waiting, never the team.

export const ACP_PROTOCOL_VERSION = 1;
export const AUTH_METHOD_ID = "openrig-local";

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
}

/** What a session works through: the queue as the caller, and the seat that receives the caller's tasks (when set). */
export interface TeamConnection {
  queue: TeamQueue;
  caller: string;
  receiver: string | undefined;
}

export interface AcpAgentOptions {
  /** Reaches the local daemon and resolves the caller; returns guidance when it can't. Called lazily, never at initialize. */
  connect: () => Promise<TeamConnection | { error: string }>;
  version: string;
  pollMs: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Settles when the app's connection ends: open turns stop following their work (nothing could carry a reply). */
  closed?: Promise<void>;
}

const ACTIVE_STATES = new Set(["pending", "in-progress", "blocked"]);
const AUTH_REQUIRED = -32000;
const INVALID_PARAMS = -32602;

class AcpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

interface Session {
  id: string;
  /** The first row each prompt created, oldest first, with the last row its work reached. */
  sent: Array<{ root: string; tail: string; closed: boolean }>;
  turn?: { cancel: () => void };
}

type ContentBlock = { type: string; text?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string } };

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

const toolStatus = (state: string) =>
  state === "pending" ? "pending" : ACTIVE_STATES.has(state) ? "in_progress" : state === "done" || state === "handed-off" ? "completed" : "failed";

const transitionLine = (t: TeamTransition) =>
  `${t.ts.slice(11, 19)}Z ${t.actorSession} · ${t.state}${t.transitionNote ? `: ${t.transitionNote}` : ""}`;

export function serveAcpAgent(peer: JsonRpcPeer, options: AcpAgentOptions): void {
  const sessions = new Map<string, Session>();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => {});
  let clientName = "an ACP app";
  let connection: TeamConnection | undefined;
  void options.closed?.then(() => { for (const session of sessions.values()) session.turn?.cancel(); });

  const connected = async (): Promise<TeamConnection> => {
    if (connection) return connection;
    const result = await options.connect();
    if ("error" in result) throw new AcpError(AUTH_REQUIRED, result.error);
    connection = result;
    return result;
  };

  const update = (sessionId: string, body: Record<string, unknown>) => peer.notify("session/update", { sessionId, update: body });
  const say = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

  peer.onRequest("initialize", async (params) => {
    const p = (params ?? {}) as { clientInfo?: { name?: string; title?: string } };
    clientName = p.clientInfo?.title ?? p.clientInfo?.name ?? clientName;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [{
        id: AUTH_METHOD_ID,
        name: "OpenRig on this machine",
        description: "Sends your work to your OpenRig team through the OpenRig daemon running on this computer, as you; this agent talks only to that daemon. Start it with `rig daemon start`.",
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

  peer.onRequest("session/new", async () => {
    await connected();
    const id = `acps-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
    sessions.set(id, { id, sent: [] });
    return { sessionId: id };
  });

  peer.onNotification("session/cancel", (params) => {
    const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
    if (sessionId) sessions.get(sessionId)?.turn?.cancel();
  });

  peer.onRequest("session/prompt", async (params) => {
    const p = (params ?? {}) as { sessionId?: string; prompt?: ContentBlock[] };
    const session = p.sessionId ? sessions.get(p.sessionId) : undefined;
    if (!session) throw new AcpError(INVALID_PARAMS, `No session ${String(p.sessionId)} in this agent; start one with session/new`);
    if (session.turn) throw new AcpError(INVALID_PARAMS, "This session already has a turn running; wait for it or cancel it first");
    const team = await connected();
    const text = promptText(Array.isArray(p.prompt) ? p.prompt : []);
    if (!text) {
      say(session.id, "Nothing to send: the prompt had no text.");
      return { stopReason: "end_turn" };
    }
    if (!team.receiver) {
      say(session.id, "This OpenRig agent has no team receiver, so nothing was sent. Add `--to <member@rig>` (the seat that takes your team's new work) to the agent's command in your app's settings.");
      return { stopReason: "end_turn" };
    }

    let cancelled = false;
    let wake: () => void = () => {};
    session.turn = { cancel: () => { cancelled = true; wake(); } };
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
      const body = `${text}\n\n---\nSent by ${team.caller} from ${clientName} through rig acp serve (session ${session.id}).${lineage}\n` +
        `The app shows this item's notes and handoffs as progress, and its closing resolution as the answer: close it with a resolution written for ${team.caller}.`;
      const qitemId = newQitemId();
      try {
        await team.queue.create({ qitemId, destination: team.receiver, body, summary: `ACP: ${oneLine(text, 100)}`, tags: ["acp-serve", `acp-session:${session.id}`] });
      } catch (error) {
        const reason = (error as Error).message;
        // A refusal the daemon answered with wrote nothing, so it can be said plainly.
        if (error instanceof TeamRefused) throw new AcpError(-32603, `The team's queue refused the task: ${reason}`);
        // No answer: the request may still land after any readback, so only a row that reads back settles it.
        const landed = await team.queue.find(qitemId).catch(() => undefined);
        if (!landed) {
          session.sent.push({ root: qitemId, tail: qitemId, closed: false });
          say(session.id, `Sending ${qitemId} to ${team.receiver} got no answer (${reason}), and ${landed === null ? "it wasn't found on the immediate readback" : "it couldn't be read back"}: delivery is unconfirmed, so it may still reach the team. A new prompt in this session names it, and \`rig queue show ${qitemId}\` shows it if it landed.`);
          throw new AcpError(-32603, `Couldn't confirm ${qitemId}: ${reason}`);
        }
        log(`session ${session.id}: ${qitemId}'s create got no answer, but it reads back`);
      }
      root = qitemId;
      const sent = { root, tail: root, closed: false };
      session.sent.push(sent);
      log(`session ${session.id}: sent ${root} to ${team.receiver}`);

      // ponytail: polls the local daemon for the chain's rows and transitions; the daemon's event stream is the upgrade
      // path if a poll per open turn ever costs too much.
      const chain: string[] = [root];
      const seen = new Map<string, { lines: string[]; lastId: number; status: string }>();
      for (;;) {
        let tail!: TeamRow;
        for (const qitemId of chain) {
          const row = await team.queue.show(qitemId);
          const transitions = await team.queue.transitions(qitemId);
          tail = row;
          const status = toolStatus(row.state);
          let entry = seen.get(qitemId);
          if (!entry) {
            entry = { lines: [], lastId: 0, status };
            seen.set(qitemId, entry);
            update(session.id, {
              sessionUpdate: "tool_call", toolCallId: qitemId, kind: "other", status,
              title: qitemId === root ? `Sent to ${row.destinationSession} (${qitemId})` : `Handed to ${row.destinationSession} (${qitemId})`,
              rawInput: { qitemId, destination: row.destinationSession },
            });
          }
          const fresh = transitions.filter((t) => t.transitionId > entry!.lastId);
          if (fresh.length > 0 || status !== entry.status) {
            for (const t of fresh) { entry.lines.push(transitionLine(t)); entry.lastId = Math.max(entry.lastId, t.transitionId); }
            entry.status = status;
            update(session.id, {
              sessionUpdate: "tool_call_update", toolCallId: qitemId, status,
              ...(entry.lines.length > 0 ? { content: [{ type: "content", content: { type: "text", text: entry.lines.join("\n") } }] } : {}),
            });
          }
        }

        sent.tail = tail.qitemId;
        // Both handoff forms pass the work on: `handoff` leaves the row handed-off, `handoff-and-complete` closes it done
        // with closure reason handed_off_to. Either way the answer is the successor's, not this row's.
        if (tail.state === "handed-off" || (tail.state === "done" && tail.closureReason === "handed_off_to")) {
          const next = await team.queue.successor(tail.qitemId);
          if (next) { chain.push(next); continue; }
          sent.closed = true;
          say(session.id, `${tail.qitemId} was handed to ${tail.handedOffTo ?? tail.closureTarget ?? "another seat"}, whose row isn't on this machine, so this app can't follow it further. Ask your team for its result.`);
          return { stopReason: "end_turn" };
        }
        if (!ACTIVE_STATES.has(tail.state)) {
          sent.closed = true;
          const who = tail.closer ?? tail.destinationSession;
          // A done row's closure reason says how it ended (canceled is a done close too); the ordinary one goes unsaid.
          const reason = tail.closureReason && tail.closureReason !== "no-follow-on" ? ` (${tail.closureReason})` : "";
          const how = tail.state === "done" ? `done${reason}` : `as ${tail.state}${reason}`;
          say(session.id, `${who} closed ${tail.qitemId} ${how}.\n\n${tail.resolution?.trim() || "(No resolution was written.)"}`);
          return { stopReason: "end_turn" };
        }
        if (cancelled) {
          say(session.id, `Stopped waiting. ${tail.qitemId} is still ${tail.state} with ${tail.destinationSession}: cancelling here doesn't stop the team's work. A new prompt in this session goes to the team as a follow-up and shows where this stands.`);
          return { stopReason: "cancelled" };
        }
        await Promise.race([sleep(options.pollMs), new Promise<void>((resolve) => { wake = resolve; })]);
      }
    } catch (error) {
      if (error instanceof AcpError || !root) throw error;
      say(session.id, `Lost track of ${root}: ${(error as Error).message}. The item stays with the team; its state is unknown from here.`);
      throw new AcpError(-32603, `Couldn't follow ${root}: ${(error as Error).message}`);
    } finally {
      session.turn = undefined;
    }
  });
}
