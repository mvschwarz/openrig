// A minimal ACP runner that keeps the runner contract, for testing the conformance check (docs/reference/runner-conformance).
// It's a test double, not a reference runner. Each --break <name> breaks one promise, so the test can show the check
// catches it.
//   node minimal-acp-runner.mjs --agent <command> [--break <name>]...
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";

const argv = process.argv.slice(2);
const agentCommand = argv[argv.indexOf("--agent") + 1];
const breaks = new Set(argv.flatMap((a, i) => (a === "--break" ? [argv[i + 1]] : [])));
const env = process.env;
const name = env.OPENRIG_RUNTIME ?? "runner";

// Activity posts go one at a time, in order, and never hold up the agent.
let sequence = 0;
let posting = Promise.resolve();
function post(hookEvent, subtype, extra = {}) {
  const body = JSON.stringify({ sessionName: env.OPENRIG_SESSION_NAME, nodeId: env.OPENRIG_NODE_ID, runtime: name,
    generation: breaks.has("wrong-generation") ? "gen-other" : env.OPENRIG_OCCUPANT_GENERATION,
    ...(breaks.has("no-sequence") ? {} : { sequence: ++sequence }), occurredAt: new Date().toISOString(), hookEvent, subtype, ...extra });
  const headers = { "content-type": "application/json", ...(breaks.has("no-token") ? {} : { authorization: `Bearer ${env.OPENRIG_ACTIVITY_HOOK_TOKEN}` }) };
  posting = posting.then(() => new Promise((resolve) => {
    const req = request(`${env.OPENRIG_URL}/api/activity/hooks`, { method: "POST", headers, timeout: 2000 }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", resolve);
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.end(body);
  }));
  return posting;
}
const record = (fields) => {
  if (!env.OPENRIG_LAUNCH_RESULT) return;
  writeFileSync(env.OPENRIG_LAUNCH_RESULT, JSON.stringify({ format: 1, attempt: env.OPENRIG_LAUNCH_ATTEMPT, harness: name,
    producer: "minimal-acp-runner test double", ...fields }));
};
const show = (text) => process.stdout.write(`${text}\r\n`);

// The agent, over stdio JSON-RPC.
const agent = spawn("/bin/sh", ["-c", `exec ${agentCommand} acp`], { stdio: ["pipe", "pipe", "ignore"] });
let nextId = 1;
const pending = new Map();
let buffered = "";
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const notify = (method, params) => agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
const answer = (id, payload) => agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);

let attention = false;
agent.stdout.on("data", (chunk) => {
  buffered += chunk;
  let nl;
  while ((nl = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === undefined) { pending.get(msg.id)?.(msg); pending.delete(msg.id); continue; }
    if (msg.id === undefined) continue;
    if (msg.method === "session/request_permission") {
      answer(msg.id, { result: { outcome: breaks.has("allow-permission") ? { outcome: "selected", optionId: msg.params.options[0].optionId } : { outcome: "cancelled" } } });
      if (!breaks.has("silent-permission")) show(`permission refused: ${msg.params.toolCall?.title}`);
      attention = true;
      void post("Notification", "permission_prompt");
    } else if (!breaks.has("ignore-unknown")) {
      answer(msg.id, { error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  }
});

let exiting = false;
agent.on("exit", async () => {
  if (exiting) return;
  await post("Stop", breaks.has("idle-on-exit") ? "end_turn" : `${name}_exited`);
  process.exit(1);
});
const shutDown = () => {
  exiting = true;
  if (!breaks.has("leave-agent")) agent.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGHUP", shutDown);
process.on("SIGTERM", shutDown);

// Turns: one submitted block is one prompt; a block that arrives mid-turn waits for the next one.
let sessionId;
let turn = 0;
let busy = false;
let cancelSent = false;
const queue = [];
async function prompt(text) {
  busy = true;
  cancelSent = false;
  turn += 1;
  show(`you ▸ ${text.split("\n")[0]}`);
  attention = false;
  await post("UserPromptSubmit", "accepted", { turnId: String(turn) });
  const res = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  if (res.error) {
    if (!breaks.has("no-error-post")) await post("Notification", "runtime_error");
  } else {
    const reason = breaks.has("cancelled-always") && cancelSent ? "cancelled" : res.result.stopReason;
    if (!attention || breaks.has("stop-while-attention")) await post("Stop", reason);
  }
  busy = false;
  if (queue.length) void prompt(queue.shift());
}
function submit(block) {
  if (block === "/abort") { abort(); return; }
  if (breaks.has("abort-in-block") && block.split("\n").includes("/abort")) abort();
  const parts = breaks.has("split-lines") ? block.split("\n") : [block];
  for (const part of parts) {
    if (busy && !breaks.has("no-queue")) queue.push(part);
    else void prompt(part);
  }
}
function abort() {
  if (!busy) return;
  cancelSent = true;
  notify("session/cancel", { sessionId });
}

// Input: raw mode with bracketed paste. Everything up to Enter is one block; Ctrl-C outside a paste aborts.
let inPaste = false;
let block = "";
let raw = "";
function onInput(chunk) {
  raw += chunk.toString("utf8");
  for (;;) {
    if (inPaste) {
      const end = raw.indexOf("\x1b[201~");
      if (end < 0) { block += raw; raw = ""; return; }
      block += raw.slice(0, end);
      raw = raw.slice(end + 6);
      inPaste = false;
      continue;
    }
    const start = raw.indexOf("\x1b[200~");
    const head = start < 0 ? raw : raw.slice(0, start);
    for (const ch of head) {
      if (ch === "\r") { const text = block; block = ""; if (text) submit(text); }
      else if (ch === "\x03") abort();
      else if (ch >= " ") block += ch;
    }
    if (start < 0) { raw = ""; return; }
    raw = raw.slice(start + 6);
    inPaste = true;
  }
}

async function main() {
  const init = await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  if (init.error) { show("the agent's handshake failed"); if (breaks.has("record-on-failure")) record({ nativeRef: "unknown" }); return; }
  const cwd = process.cwd();
  if (env.OPENRIG_RESUME_REF) {
    const res = await call("session/load", { sessionId: env.OPENRIG_RESUME_REF, cwd, mcpServers: [] });
    if (!res.error) { sessionId = env.OPENRIG_RESUME_REF; record({ nativeRef: sessionId }); }
    else if (res.error.code === -32002 || breaks.has("missing-on-any-error")) { record({ error: "missing" }); return; }
    else if (!breaks.has("new-on-resume")) return;
  }
  if (!sessionId) {
    if (breaks.has("record-early")) record({ nativeRef: "pending" });
    const res = await call("session/new", { cwd, mcpServers: [] });
    if (res.error) { show("the agent couldn't open a conversation"); if (breaks.has("record-on-failure")) record({ nativeRef: "unknown" }); return; }
    sessionId = res.result.sessionId;
    record({ nativeRef: sessionId });
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?2004h");
  process.stdin.on("data", onInput);
  show("ready");
  if (env.OPENRIG_FIRST_INPUT) {
    const text = readFileSync(env.OPENRIG_FIRST_INPUT, "utf8");
    void prompt(breaks.has("first-input-trim") ? text.trim() : text);
  }
}
void main();
