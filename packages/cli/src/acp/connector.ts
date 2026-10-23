import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { JsonRpcRequestError, JsonRpcTransportClosed, StdioJsonRpcPeer } from "./json-rpc-stdio.js";
import { findRunProcesses, RUN_MARKER } from "./run-processes.js";

// `rig acp run`: one queue row's task to one ACP agent turn, with the outcome back on that row. OpenRig carries the
// agent's permission requests to an owning seat and returns that seat's answer; it holds no permission policy of its
// own. The connector runs as the row's custodian seat and names the agent as executor; it never claims as the agent.

export interface AcpQueueRow {
  qitemId: string;
  state: string;
  destinationSession: string;
  body: string;
  resolution?: string | null;
  tags?: string[] | null;
}

/** The queue verbs the connector uses, as the calling seat. `rig acp` wires these to the daemon's queue API. */
export interface AcpQueue {
  show(qitemId: string): Promise<AcpQueueRow>;
  claim(qitemId: string): Promise<void>;
  /** A note, optionally with a state change. A note-only update stores no resolution (the queue keeps one only on close). */
  update(qitemId: string, change: { note: string; state?: string }): Promise<void>;
  create(row: { destination: string; body: string; summary: string; tags: string[] }): Promise<string>;
}

export interface AcpRunOptions {
  qitemId: string;
  /** The agent's program and arguments, e.g. ["hermes", "acp"]. No shell. */
  agent: string[];
  cwd: string;
  /** The calling seat, which must own the row. */
  self: string;
  /** Who answers permission requests (default: the calling seat). */
  permissionsTo?: string;
  /** Load this earlier session instead of starting one; refused rather than replaced when it can't load. */
  loadSession?: string;
  runId: string;
  logPath: string;
  pollMs?: number;
  /** Live progress for the terminal running the connector. */
  progress?: (line: string) => void;
  /** Resolves when the custodian asks to cancel the turn (Ctrl-C or `rig acp cancel`). */
  cancelRequested?: Promise<void>;
  /** Resolves when the custodian detaches without waiting (a second Ctrl-C): stdin closes and the turn reads unknown. */
  detachRequested?: Promise<void>;
  /** How long to wait for the agent to exit after its stdin closes (default 5 s). */
  exitWaitMs?: number;
}

export type AcpOutcomeKind = "completed" | "stopped" | "cancelled" | "failed" | "unknown";
export interface AcpOutcome { kind: AcpOutcomeKind; summary: string; text: string; sessionId?: string }

/** Agent text that reports a failed turn while still ending it `end_turn` (OpenClaw #178057; its #44294 is open). */
export const INTERRUPTION_MARKERS = ["[OpenClaw interruption]"];
const FINAL_STATES = new Set(["done", "canceled", "handed-off", "failed", "denied"]);
const NOTE_TEXT_LIMIT = 6000;
/** The command a permission row's owner runs; `done` needs a closure reason. */
export const answerCommand = (row: string) => `rig queue update ${row} --state done --closure-reason no-follow-on --resolution <optionId>`;

class DetachedBeforeTurnEnd extends Error {}

interface PermissionOption { optionId: string; name?: string; kind?: string }

export async function runAcpAssignment(queue: AcpQueue, options: AcpRunOptions): Promise<AcpOutcome> {
  const progress = options.progress ?? (() => {});
  const pollMs = options.pollMs ?? 2000;
  const permissionsTo = options.permissionsTo ?? options.self;
  let row = await queue.show(options.qitemId);
  if (row.destinationSession !== options.self) {
    throw new Error(`${options.qitemId} belongs to ${row.destinationSession}; run rig acp from that seat, or hand the row to ${options.self} first`);
  }
  if (row.state === "pending") { await queue.claim(options.qitemId); row = await queue.show(options.qitemId); }
  if (row.state !== "in-progress") throw new Error(`${options.qitemId} is ${row.state}; rig acp runs an in-progress or pending row`);

  mkdirSync(dirname(options.logPath), { recursive: true });
  const log = (entry: Record<string, unknown>) => appendFileSync(options.logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const child = spawn(options.agent[0]!, options.agent.slice(1), {
    cwd: options.cwd, stdio: "pipe", env: { ...process.env, [RUN_MARKER]: options.runId },
  });
  child.stderr.on("data", (data: Buffer) => log({ direction: "stderr", text: data.toString() }));
  const spawned = new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const peer = new StdioJsonRpcPeer(child, (direction, packet) => log({ direction, packet }));

  let sessionId: string | undefined;
  let text = "";
  let usage: { used?: number; size?: number; cost?: unknown } | undefined;
  let toolCalls = 0;
  let lastTool = "";
  let lastProgressNote = Date.now();
  let turnOver = false;
  let cancelRequestedAt: string | undefined;

  peer.onNotification("session/update", (params) => {
    const { sessionId: from, update } = params as { sessionId?: string; update?: Record<string, unknown> };
    if (!update || from !== sessionId) return; // another session's events never reach this row
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && content.text) { text += content.text; progress(content.text); }
    } else if (update.sessionUpdate === "tool_call") {
      toolCalls += 1; lastTool = `${update.title ?? "tool"} (${update.kind ?? "other"})`;
      progress(`\n[tool] ${lastTool}\n`);
    } else if (update.sessionUpdate === "usage_update") {
      usage = { used: update.used as number, size: update.size as number, cost: update.cost };
    }
    if (Date.now() - lastProgressNote >= 60_000) {
      lastProgressNote = Date.now();
      void queue.update(row.qitemId, { note: `ACP run ${options.runId} progress: ${toolCalls} tool calls (latest ${lastTool || "none"}), ${text.length} characters of output so far` }).catch(() => {});
    }
  });

  peer.onRequest("session/request_permission", async (params, requestId) => {
    const request = params as { sessionId?: string; toolCall?: Record<string, unknown>; options?: PermissionOption[] };
    if (request.sessionId !== sessionId) throw Object.assign(new Error(`no turn of session ${request.sessionId} is running here`), { code: -32602 });
    const offered = request.options ?? [];
    const toolCall = request.toolCall ?? {};
    for (;;) {
      if (turnOver || cancelRequestedAt) return { outcome: { outcome: "cancelled" } };
      const askId = await queue.create({
        destination: permissionsTo,
        summary: `Permission for ${row.qitemId}: ${String(toolCall.title ?? toolCall.toolCallId ?? "a tool call")} (${String(toolCall.kind ?? "other")})`,
        tags: ["acp-permission", ...(row.tags ?? []).filter((tag) => /^(project|mission|slice):/.test(tag))],
        body: permissionBody(row.qitemId, options.runId, sessionId!, requestId, toolCall, offered, options.logPath),
      });
      await queue.update(row.qitemId, { note: `ACP request ${requestId} (session ${sessionId}): permission asked of ${permissionsTo} as ${askId}; the turn waits for that answer` });
      progress(`\n[permission] asked ${permissionsTo} as ${askId}\n`);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (turnOver || cancelRequestedAt) {
          await queue.update(askId, { state: "canceled", note: `Stale: the turn of ${row.qitemId} was cancelled before an answer; any answer here is not sent` }).catch(() => {});
          return { outcome: { outcome: "cancelled" } };
        }
        const ask = await queue.show(askId);
        // The answer point: a cancel that landed during the read above still wins, and nothing is awaited between here and the reply.
        if (turnOver || cancelRequestedAt) {
          const stale = `Stale: the turn of ${row.qitemId} was cancelled; ${FINAL_STATES.has(ask.state) ? "this answer was" : "any answer here is"} not sent`;
          await queue.update(askId, FINAL_STATES.has(ask.state) ? { note: stale } : { state: "canceled", note: stale }).catch(() => {});
          return { outcome: { outcome: "cancelled" } };
        }
        if (!FINAL_STATES.has(ask.state)) continue;
        const chosen = chooseOption(offered, ask.resolution);
        if (chosen) {
          void queue.update(row.qitemId, { note: `ACP request ${requestId}: ${permissionsTo} answered ${chosen.optionId} on ${askId}; sent to the agent once` }).catch(() => {});
          return { outcome: { outcome: "selected", optionId: chosen.optionId } };
        }
        await queue.update(row.qitemId, { note: `ACP request ${requestId}: ${askId} closed ${ask.state} without an offered option (${JSON.stringify(ask.resolution ?? null)}); asking again` });
        break;
      }
    }
  });

  const record = async (outcome: AcpOutcome): Promise<AcpOutcome> => {
    const shown = outcome.text.length > NOTE_TEXT_LIMIT ? `${outcome.text.slice(0, NOTE_TEXT_LIMIT)}\n… (truncated; the full transcript is in ${options.logPath})` : outcome.text;
    await queue.update(row.qitemId, {
      note: `ACP run ${options.runId} outcome ${outcome.kind}: ${outcome.summary}${shown ? `\n\n${shown}` : ""}\nThis is the agent's report, not a judgment of the work; the row stays open for you to judge and close with your own resolution.`,
    });
    return outcome;
  };

  try {
    await spawned;
    const init = await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "openrig", version: "1" } }) as
      { protocolVersion?: number; agentCapabilities?: { loadSession?: boolean }; agentInfo?: { name?: string; version?: string } };
    const loads = init.agentCapabilities?.loadSession === true;
    if (options.loadSession) {
      if (!loads) return await record({ kind: "failed", summary: `the agent doesn't advertise loadSession, so session ${options.loadSession} wasn't loaded and no new session was started`, text: "" });
      await peer.request("session/load", { sessionId: options.loadSession, cwd: options.cwd, mcpServers: [] });
      sessionId = options.loadSession;
    } else {
      sessionId = (await peer.request("session/new", { cwd: options.cwd, mcpServers: [] }) as { sessionId: string }).sessionId;
    }
    const agent = `${init.agentInfo?.name ?? options.agent[0]} ${init.agentInfo?.version ?? "(no version reported)"}`;
    await queue.update(row.qitemId, {
      note: `ACP run ${options.runId}: executor ${agent} (protocol ${init.protocolVersion ?? "?"}, loadSession ${loads ? "advertised" : "not advertised"}), session ${sessionId} ${options.loadSession ? "loaded" : "new"}, custodian ${options.self}; transcript ${options.logPath}`,
    });
    void options.cancelRequested?.then(async () => {
      if (turnOver || cancelRequestedAt) return;
      cancelRequestedAt = new Date().toISOString();
      peer.notify("session/cancel", { sessionId });
      await queue.update(row.qitemId, { note: `ACP run ${options.runId}: cancel requested at ${cancelRequestedAt}; upstream inference and spend are unknown unless the provider shows them` });
    });
    // A detach settles the turn here even when the agent keeps its stdout open after stdin closes.
    const detached = new Promise<never>((_, reject) => {
      void options.detachRequested?.then(() => { void peer.end(0); reject(new DetachedBeforeTurnEnd()); });
    });
    detached.catch(() => {});
    const response = await Promise.race([peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text: row.body }] }), detached]) as { stopReason?: string };
    turnOver = true;
    return await record(classify(response.stopReason, text, usage, cancelRequestedAt, sessionId));
  } catch (error) {
    turnOver = true;
    if (error instanceof JsonRpcRequestError) {
      return await record({ kind: "failed", sessionId, text, summary: `${error.method} returned error ${error.error.code} ${error.error.message}${error.error.data === undefined ? "" : ` ${JSON.stringify(error.error.data)}`}` });
    }
    if (error instanceof DetachedBeforeTurnEnd) {
      return await record({ kind: "unknown", sessionId, text, summary: "detached before the turn ended; the agent may still be working" });
    }
    if (error instanceof JsonRpcTransportClosed) {
      return await record({ kind: "unknown", sessionId, text, summary: "the agent's connection closed before the turn ended" });
    }
    return await record({ kind: "failed", sessionId, text, summary: `the agent couldn't be run: ${(error as Error).message}` });
  } finally {
    turnOver = true;
    const exit = await peer.end(options.exitWaitMs ?? 5000);
    const left = await findRunProcesses(options.runId).catch(() => undefined);
    const settled = left === undefined ? "unknown (the process table couldn't be read)"
      : left.length === 0 ? "settled: no process carrying this run's marker remains"
        : `incomplete: ${left.length} process(es) carrying this run's marker still run (${left.map((p) => p.pid).join(", ")}); stop them with the runtime's own stop, or rig acp stop ${options.runId} -- <its stop command>`;
    await queue.update(row.qitemId, { note: `ACP run ${options.runId} detached: agent ${exit === "still-running" ? "still running after stdin closed" : `exited (code ${exit.code ?? "none"}, signal ${exit.signal ?? "none"})`}; ${settled}` }).catch(() => {});
    peer.release(); // a still-running agent keeps running, but holds nothing that keeps this process alive
  }
}

/** The stop reason alone doesn't say the work happened: a silent `end_turn` is unknown, not done. */
export function classify(stopReason: string | undefined, text: string, usage: { used?: number } | undefined, cancelRequestedAt: string | undefined, sessionId?: string): AcpOutcome {
  if (stopReason === "cancelled") {
    return { kind: "cancelled", sessionId, text, summary: `cancel ${cancelRequestedAt ? `requested at ${cancelRequestedAt}, ` : ""}acknowledged by the agent at ${new Date().toISOString()} (stopReason cancelled); upstream spend is unknown` };
  }
  if (stopReason !== "end_turn") return { kind: "stopped", sessionId, text, summary: `the agent stopped with ${stopReason ?? "no stop reason"}` };
  const interruption = INTERRUPTION_MARKERS.find((marker) => text.includes(marker));
  if (interruption) return { kind: "unknown", sessionId, text, summary: `the agent ended its turn but reported an interruption (${interruption}); not treated as done` };
  if (!text.trim() && !(usage?.used && usage.used > 0)) {
    return { kind: "unknown", sessionId, text, summary: `the agent ended its turn with no output and ${usage ? "zero" : "no"} usage reported; not treated as done` };
  }
  return { kind: "completed", sessionId, text, summary: "the agent ended its turn (end_turn)" };
}

/** An owner answers with the offered option's id; its kind (allow_once …) works when only one option has it. */
export function chooseOption(offered: PermissionOption[], answer: string | null | undefined): PermissionOption | undefined {
  const value = answer?.trim();
  if (!value) return undefined;
  const byId = offered.find((option) => option.optionId === value);
  if (byId) return byId;
  const byKind = offered.filter((option) => option.kind === value);
  return byKind.length === 1 ? byKind[0] : undefined;
}

function permissionBody(qitemId: string, runId: string, sessionId: string, requestId: string | number, toolCall: Record<string, unknown>, offered: PermissionOption[], logPath: string): string {
  const input = toolCall.rawInput === undefined ? undefined : JSON.stringify(toolCall.rawInput);
  const where = Array.isArray(toolCall.locations) ? (toolCall.locations as Array<{ path?: string }>).map((l) => l.path).filter(Boolean).join(", ") : "";
  return [
    `# The ACP agent working on ${qitemId} asks permission`,
    "",
    `- **Action:** ${String(toolCall.title ?? "(no title)")} (kind ${String(toolCall.kind ?? "other")}, tool call ${String(toolCall.toolCallId ?? "?")})`,
    where ? `- **Target:** ${where}` : undefined,
    input === undefined ? undefined : input.length > 2000 ? `- **Input:** \`${input.slice(0, 2000)}\` … (truncated; the full input is in ${logPath})` : `- **Input:** \`${input}\``,
    `- **Asked by:** ACP run ${runId}, session ${sessionId}, request ${requestId}`,
    "",
    "**Options the agent offered:**",
    ...offered.map((option) => `- \`${option.optionId}\`: ${option.name ?? ""}${option.kind ? ` (${option.kind})` : ""}`),
    "",
    `Answer on this row with \`${answerCommand("<this row>")}\`; don't hand it off.`,
    "The agent's own settings and policy decide what it asks; your answer goes back to this one request, once. The turn waits until you answer.",
  ].filter((line) => line !== undefined).join("\n");
}
