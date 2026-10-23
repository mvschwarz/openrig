#!/usr/bin/env node
// A fake ACP v1 agent for tests: newline-delimited JSON-RPC on stdio, no model, no network.
// Each prompt picks its behaviour with a leading "scenario:<name> <arg>" line:
//   reply <text>   progress, then <text>, a usage_update, end_turn
//   permission     a tool_call, then session/request_permission; reports the outcome it received
//   slow           a chunk every 20 ms until cancelled (then stopReason cancelled) or 200 chunks
//   empty          a zero usage_update and end_turn with no content (an upstream failure the agent didn't surface)
//   error          a JSON-RPC error carrying the original code, message and data
//   hang           never answers the prompt
// FAKE_ACP_LOAD=1 advertises loadSession. FAKE_ACP_COMPANION_PID_FILE starts a detached companion that outlives
// stdin close (like Hermes's gateway) and writes its pid there. FAKE_ACP_IGNORE_EOF=1 keeps the agent itself running
// after its stdin closes, with stdout still open.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const sessions = new Map(); // sessionId -> { cancelled: boolean }
const waiting = new Map(); // our outgoing request id -> resolve
let nextSession = 0;
let nextRequest = 1000;

const send = (packet) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...packet })}\n`);
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const ask = (method, params) => new Promise((resolve) => { const id = ++nextRequest; waiting.set(id, resolve); send({ id, method, params }); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function prompt(id, { sessionId, prompt }) {
  const session = sessions.get(sessionId);
  if (!session) return send({ id, error: { code: -32002, message: `Unknown session ${sessionId}` } });
  session.cancelled = false;
  const text = (prompt ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const [, name = "reply", arg = ""] = /^scenario:(\S+)\s*(.*)/.exec(text) ?? [];
  if (name === "hang") return;
  if (name === "error") return send({ id, error: { code: -32603, message: "Internal error", data: { details: "context length exceeded" } } });
  if (name === "empty") {
    update(sessionId, { sessionUpdate: "usage_update", used: 0, size: 1000 });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (name === "slow") {
    for (let i = 0; i < 200; i++) {
      if (session.cancelled) return send({ id, result: { stopReason: "cancelled" } });
      chunk(sessionId, `step ${i} `);
      await sleep(20);
    }
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (name === "permission") {
    const toolCall = { toolCallId: `call-${sessionId}`, title: "Write notes.txt", kind: "edit", status: "pending", locations: [{ path: "/fixture/notes.txt" }] };
    update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const answer = await ask("session/request_permission", {
      sessionId, toolCall,
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }],
    });
    const outcome = answer?.result?.outcome;
    if (session.cancelled || outcome?.outcome === "cancelled") return send({ id, result: { stopReason: "cancelled" } });
    chunk(sessionId, outcome?.outcome === "selected" ? `permission ${outcome.optionId}` : `permission answer unreadable`);
    return send({ id, result: { stopReason: "end_turn" } });
  }
  chunk(sessionId, "working… ");
  chunk(sessionId, arg || "done");
  update(sessionId, { sessionUpdate: "usage_update", used: 120, size: 1000 });
  return send({ id, result: { stopReason: "end_turn" } });
}

function handle(packet) {
  const { id, method, params } = packet;
  if (method === undefined) { waiting.get(id)?.(packet); waiting.delete(id); return; }
  switch (method) {
    case "initialize": {
      const pidFile = process.env.FAKE_ACP_COMPANION_PID_FILE;
      if (pidFile) {
        const companion = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { detached: true, stdio: "ignore" });
        companion.unref();
        writeFileSync(pidFile, String(companion.pid));
      }
      return send({ id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: process.env.FAKE_ACP_LOAD === "1" },
        agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
      } });
    }
    case "session/new": {
      const sessionId = `fake-session-${++nextSession}`;
      sessions.set(sessionId, { cancelled: false });
      return send({ id, result: { sessionId } });
    }
    case "session/load":
      if (process.env.FAKE_ACP_LOAD !== "1") return send({ id, error: { code: -32601, message: "Method not found" } });
      return sessions.has(params?.sessionId)
        ? send({ id, result: null })
        : send({ id, error: { code: -32002, message: `Unknown session ${params?.sessionId}` } });
    case "session/prompt":
      return void prompt(id, params ?? {});
    case "session/cancel": {
      const session = sessions.get(params?.sessionId);
      if (session) session.cancelled = true;
      return;
    }
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found" } });
  }
}

if (process.env.FAKE_ACP_IGNORE_EOF === "1") setInterval(() => {}, 60_000);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) handle(JSON.parse(line));
});
