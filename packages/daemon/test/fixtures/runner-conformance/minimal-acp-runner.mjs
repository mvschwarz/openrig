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
// One JSON request to OpenRig with the hook token: { status, body }, or status 0 when it couldn't be reached.
function api(method, path, payload) {
  return new Promise((resolve) => {
    const req = request(`${env.OPENRIG_URL}${path}`, { method, timeout: 30_000,
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENRIG_ACTIVITY_HOOK_TOKEN}` } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => { let body; try { body = JSON.parse(text); } catch { body = undefined; } resolve({ status: res.statusCode, body }); });
    });
    req.on("error", () => resolve({ status: 0 }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0 }); });
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

// The agent, over stdio JSON-RPC.
const agent = spawn("/bin/sh", ["-c", `exec ${agentCommand} acp`], { stdio: ["pipe", "pipe", "ignore"] });
agent.stdin.on("error", () => { /* the agent has gone; its exit is reported below */ });
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
      void onPermission(msg);
    } else if (!breaks.has("ignore-unknown")) {
      answer(msg.id, { error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  }
});

let exiting = false;
agent.on("exit", async () => {
  if (exiting) return;
  await withdrawLive("exited");
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

// Permissions. Every request goes to OpenRig's answered path, and the runner delivers the option that comes back: the
// person's, or OpenRig's permit. A refusal, at submit or while reading, is read by its code: the seat's opt-in refuses and
// holds attention; one that says the request isn't the current occupant's answers cancelled and holds nothing, as a
// refused, stale or withdrawn read does; anything else (404, unreachable, a "permits" code or one the contract doesn't
// list) permits with the agent's allow_once, else allow_always, or refuses and holds when there's no allow option. An
// answer is delivered once, while that request is still live, and the ask is withdrawn when the turn is cancelled or ends,
// or the agent exits.
const HOLDS = new Set(["denied_by_seat", "options_unsupported"]);
// A revoked grant isn't here: one is reissued after a lost response, so it can still be the live occupant, and it permits.
const NOT_CURRENT = new Set(["stale_generation", "activity_grant_wrong_seat", "activity_grant_stale",
  ...(breaks.has("cancel-on-revoked") ? ["activity_grant_revoked"] : [])]);
let live = null;
const refuse = (id) => answer(id, { result: { outcome: { outcome: "cancelled" } } });
const select = (id, optionId) => answer(id, { result: { outcome: { outcome: "selected", optionId } } });
const allowOf = (options) => {
  const kinds = breaks.has("prefer-always") ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"];
  for (const kind of kinds) { const option = options.find((o) => o.kind === kind); if (option) return option; }
  return undefined;
};
async function onPermission(msg) {
  const { toolCall, options } = msg.params;
  if (!breaks.has("silent-permission")) show(`permission asked: ${toolCall?.title}`);
  const refuseAndHold = () => { refuse(msg.id); attention = true; void post("Notification", "permission_prompt"); };
  const permit = () => { const allow = allowOf(options); if (allow) select(msg.id, allow.optionId); else refuseAndHold(); };
  if (breaks.has("no-submit")) { refuseAndHold(); return; }
  const askedInTurn = turn;
  const submitted = await api("POST", "/api/activity/permission-requests", {
    sessionName: env.OPENRIG_SESSION_NAME, nodeId: env.OPENRIG_NODE_ID, generation: env.OPENRIG_OCCUPANT_GENERATION,
    nativeRef: sessionId, turnId: String(turn), requestId: breaks.has("wrong-request-id") ? `${msg.id}-other` : msg.id,
    toolCall: { title: toolCall?.title, kind: toolCall?.kind }, options, occurredAt: new Date().toISOString() });
  if (submitted.status === 200 && submitted.body?.state === "permitted") { select(msg.id, submitted.body.optionId); return; }
  if (submitted.status !== 200 || !submitted.body?.askId) {
    const status = submitted.status, code = submitted.body?.code;
    if (HOLDS.has(code)) { if (breaks.has("permit-on-deny")) permit(); else refuseAndHold(); }
    else if (NOT_CURRENT.has(code) && !breaks.has("permit-on-not-current")) { if (breaks.has("hold-on-cancel")) refuseAndHold(); else refuse(msg.id); }
    else if ((status === 404 && breaks.has("refuse-on-404")) || (status === 0 && breaks.has("refuse-on-unreachable"))
      || (status !== 404 && status !== 0 && breaks.has("refuse-on-refusal"))) refuseAndHold();
    else permit();
    return;
  }
  // A person is asked. OpenRig records the seat's permission prompt, so the runner doesn't post it.
  attention = true;
  if (breaks.has("self-prompt")) void post("Notification", "permission_prompt");
  // done: the agent has its answer. open: OpenRig's ask may still be open, so it's withdrawn at the turn's end.
  const ask = { id: msg.id, askId: submitted.body.askId, offered: options.map((o) => o.optionId), done: false, open: true };
  live = ask;
  // The agent may have exited, or ended the turn, while the submit was on its way.
  if (agent.exitCode !== null || agent.signalCode !== null) { await withdrawLive("exited"); return; }
  if (!busy || turn !== askedInTurn) { await withdrawLive("turn_ended"); return; }
  for (;;) {
    const read = await api("GET", `/api/activity/permission-requests/${encodeURIComponent(ask.askId)}?waitSeconds=25`);
    if (ask.done && !breaks.has("late-deliver")) return;
    const state = read.status === 200 ? read.body?.state : undefined;
    if (state === "pending") continue;
    // A listed answer means OpenRig closed its ask; anything else leaves it open, to withdraw at the turn's end.
    if (["answered", "permitted", "refused", "withdrawn", "stale"].includes(state)) ask.open = false;
    if ((state === "answered" || state === "permitted") && ask.offered.includes(read.body.optionId)) {
      select(ask.id, read.body.optionId);
      if (breaks.has("deliver-twice")) select(ask.id, read.body.optionId);
      attention = false;
    } else if (!ask.done) {
      // A refused, withdrawn or stale read, or a refusal saying the request isn't the current occupant's: it can't take an
      // answer, and no person is still waiting, so it's cancelled and nothing is held. The seat's opt-in refuses and holds.
      // Anything else means no one can answer it, so it's permitted.
      const code = read.status === 200 ? undefined : read.body?.code;
      const cancelled = (state === "refused" && !breaks.has("permit-on-refused-read")) || state === "withdrawn" || state === "stale"
        || (NOT_CURRENT.has(code) && !breaks.has("permit-on-not-current"));
      if (HOLDS.has(code) || NOT_CURRENT.has(code)) ask.open = false;
      if (HOLDS.has(code)) { refuse(ask.id); attention = true; }
      else if (cancelled || (!state && breaks.has("cancel-on-read-error")) || (state && breaks.has("cancel-on-unlisted-state"))) {
        refuse(ask.id); attention = breaks.has("hold-on-cancel");
      }
      else { permit(); attention = !allowOf(options); }
    }
    ask.done = true;
    if (live === ask && (!ask.open || breaks.has("forget-permitted-ask"))) live = null;
    return;
  }
}
// Only a cancelled turn's request still has an agent waiting on it; after a turn's end or an exit there's no one to answer.
// Either way no person is still waiting, so nothing is held. An ask the agent already has its answer to (permitted after a
// read got none) is still withdrawn, so it doesn't stay open for a person.
function withdrawLive(reason) {
  const ask = live;
  if (!ask) return Promise.resolve();
  live = null;
  if (!ask.done) {
    ask.done = true;
    if (reason === "turn_cancelled") refuse(ask.id);
    if (!breaks.has("hold-after-withdraw")) attention = false;
  }
  if (!ask.open || breaks.has("no-withdraw")) return Promise.resolve();
  ask.open = false;
  return api("POST", `/api/activity/permission-requests/${encodeURIComponent(ask.askId)}/withdraw`, { reason });
}

async function prompt(text) {
  busy = true;
  cancelSent = false;
  turn += 1;
  show(`you ▸ ${text.split("\n")[0]}`);
  attention = false;
  await post("UserPromptSubmit", "accepted", { turnId: String(turn) });
  const res = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  await withdrawLive("turn_ended");
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
  if (breaks.has("paste-answers") && live && !live.done) { live.done = true; select(live.id, live.offered[0]); attention = false; return; }
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
  void withdrawLive("turn_cancelled");
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
