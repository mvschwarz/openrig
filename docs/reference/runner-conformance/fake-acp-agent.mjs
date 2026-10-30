#!/usr/bin/env node
// A scriptable fake ACP agent for the runner conformance check (check-runner.mjs). It speaks just enough of ACP v1 over
// stdio, newline-delimited JSON-RPC, to exercise a runner without a model, credentials or the network. It was written
// after the fake agent in bpamiri/dsh-seat (Apache-2.0), which showed the approach.
//
//   node fake-acp-agent.mjs --scenario <file.json> --log <file.jsonl> [any arguments the runner adds are ignored]
//
// The scenario says how to answer; the log records every message in and out, so the check can compare them.
//   sessionId        the id `session/new` returns (default "fake-session-1")
//   initialize       "error" or "exit" to fail the handshake there
//   newSession       "error" or "exit" to fail `session/new`
//   newDelayMs       wait this long before answering `session/new`
//   knownSessions    ids `session/load` and `session/resume` reopen
//   reopenError      "missing" (the agent's own "no such session") or "error", for an id it doesn't know
//   unknownRequest   send the runner a request with a method it can't know, once, after `initialize`
//   stubborn         keep running after a hangup or after input closes; only SIGTERM or SIGKILL ends it
//   turns            one entry per `session/prompt`, in order (the last one repeats):
//     holdMs         keep the turn open this long; `session/cancel` ends it early as "cancelled"
//     ignoreCancel   on `session/cancel`, keep the turn open and end it with stopReason (default end_turn) anyway
//     permission     ask `session/request_permission` first, then carry on whatever the answer
//     error          answer the prompt with a JSON-RPC error
//     exit           exit with status 3 instead of answering
//     stopReason     the stop reason to return (default "end_turn")
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const scenarioFile = arg("--scenario") ?? process.env.RUNNER_CHECK_SCENARIO;
const logFile = arg("--log") ?? process.env.RUNNER_CHECK_AGENT_LOG;
const scenario = scenarioFile ? JSON.parse(readFileSync(scenarioFile, "utf8")) : {};

const log = (entry) => { if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`); };
const send = (msg) => { log({ dir: "out", msg }); process.stdout.write(`${JSON.stringify(msg)}\n`); };
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const exit = (status, why) => { log({ dir: "event", event: "exit", status, why }); process.exit(status); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

log({ dir: "event", event: "started", pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2) });
// Ctrl-C is the runner's to handle, so the agent never takes it as a signal. A stubborn agent also outlives a hangup and
// its input closing, as some real agents do: only the runner ending it (SIGTERM or SIGKILL) stops it.
process.on("SIGINT", () => log({ dir: "event", event: "signal", signal: "SIGINT" }));
process.on("SIGHUP", () => scenario.stubborn ? log({ dir: "event", event: "signal", signal: "SIGHUP" }) : exit(0, "SIGHUP"));
process.on("SIGTERM", () => exit(0, "SIGTERM"));

let sessionId;
let turn = 0;
let nextId = 1;
const answers = new Map();
let cancelTurn = null;

function ask(method, params) {
  const id = `agent-${nextId++}`;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => answers.set(id, resolve));
}

async function prompt(id, params) {
  const spec = (scenario.turns ?? [])[Math.min(turn, (scenario.turns?.length ?? 1) - 1)] ?? {};
  turn += 1;
  if (spec.exit) exit(3, `turn ${turn}`);
  if (spec.error) { fail(id, -32603, "fake agent: this turn fails"); return; }
  send({ jsonrpc: "2.0", method: "session/update",
    params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `turn ${turn}` } } } });
  if (spec.permission) {
    await ask("session/request_permission", {
      sessionId: params.sessionId,
      toolCall: { toolCallId: `call-${turn}`, title: "Edit notes.txt", kind: "edit" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
  }
  let stopReason = spec.stopReason ?? "end_turn";
  if (spec.holdMs) {
    const cancelled = await new Promise((resolve) => {
      const timer = setTimeout(() => { cancelTurn = null; resolve(false); }, spec.holdMs);
      cancelTurn = () => { if (spec.ignoreCancel) return; clearTimeout(timer); cancelTurn = null; resolve(true); };
    });
    if (cancelled) stopReason = "cancelled";
  }
  reply(id, { stopReason });
}

async function reopen(id, params) {
  if ((scenario.knownSessions ?? []).includes(params.sessionId)) { sessionId = params.sessionId; reply(id, null); return; }
  if (scenario.reopenError === "missing") fail(id, -32002, `Session not found: ${params.sessionId}`);
  else fail(id, -32603, "fake agent: reopen failed");
}

async function handle(msg) {
  if (msg.id !== undefined && msg.method === undefined) { answers.get(msg.id)?.(msg); answers.delete(msg.id); return; }
  switch (msg.method) {
    case "initialize":
      if (scenario.initialize === "exit") exit(2, "initialize");
      if (scenario.initialize === "error") { fail(msg.id, -32603, "fake agent: initialize fails"); return; }
      reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
      if (scenario.unknownRequest) await ask("fake/unknown_method", { note: "a method no runner knows" });
      return;
    case "session/new":
      if (scenario.newDelayMs) await sleep(scenario.newDelayMs);
      if (scenario.newSession === "exit") exit(2, "session/new");
      if (scenario.newSession === "error") { fail(msg.id, -32603, "fake agent: session/new fails"); return; }
      sessionId = scenario.sessionId ?? "fake-session-1";
      reply(msg.id, { sessionId });
      return;
    case "session/load":
    case "session/resume":
      await reopen(msg.id, msg.params ?? {});
      return;
    case "session/prompt":
      await prompt(msg.id, msg.params ?? {});
      return;
    case "session/cancel":
      cancelTurn?.();
      return;
    default:
      if (msg.id !== undefined) fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { log({ dir: "event", event: "garbage", line }); return; }
  log({ dir: "in", msg });
  void handle(msg);
});
lines.on("close", () => { if (scenario.stubborn) { log({ dir: "event", event: "stdin-closed" }); setInterval(() => {}, 60_000); } else exit(0, "stdin closed"); });
