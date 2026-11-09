// A minimal ACP runner that keeps the runner contract, for testing the conformance check (docs/reference/runner-conformance).
// It's a test double, not a reference runner. Each --break <name> breaks one promise, so the test can show the check
// catches it.
//   node minimal-acp-runner.mjs --agent <command> [--break <name>]... [--read-wait <seconds>|none] [--withdraw-after-stop]
// --read-wait keeps the contract another way: it reads with that waitSeconds (or none) and sleeps between pending reads.
// --read-retries <n> keeps it another way too: a read refusal the runner would permit on (a code section 7 marks "permits",
// or one it doesn't list) is retried n times, 1.5 s apart, before the runner permits; section 7 sets no time limit for that.
// A refusal section 7 cancels or holds on (a request that isn't the current occupant's, or the seat's opt-in to hold) is
// acted on at once.
// --withdraw-after-stop keeps it another way too: a cancelled or ended turn's ask is withdrawn after the turn's Stop is
// posted, not before; the contract doesn't order the two posts.
// --startup-idle <ms> keeps it another way too: with no first input, it reports idle once it's ready, as a runner may, and
// that first POST goes out <ms> late, holding the posts behind it, as a slow first request does. The agent gets each
// prompt without waiting on its accepted post, so it can die before the late report arrives.
// --interrupt-delay <ms> keeps it another way too: it handles a Ctrl-C <ms> late, as a runner whose event loop is busy
// does, and still sends session/cancel if the turn is open by then.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";

const argv = process.argv.slice(2);
const agentCommand = argv[argv.indexOf("--agent") + 1];
const breaks = new Set(argv.flatMap((a, i) => (a === "--break" ? [argv[i + 1]] : [])));
const readWait = argv.includes("--read-wait") ? argv[argv.indexOf("--read-wait") + 1] : "25";
const readQuery = readWait === "none" ? "" : `?waitSeconds=${readWait}`;
const withdrawAfterStop = argv.includes("--withdraw-after-stop");
const readRetries = argv.includes("--read-retries") ? Number(argv[argv.indexOf("--read-retries") + 1]) : 0;
const startupIdleMs = argv.includes("--startup-idle") ? Number(argv[argv.indexOf("--startup-idle") + 1]) : null;
const interruptDelayMs = argv.includes("--interrupt-delay") ? Number(argv[argv.indexOf("--interrupt-delay") + 1]) : 0;
// --beat: the optional working beat (section 4). While a turn is open and nothing waits on a person, post active/liveness
// every 10 s with livenessSeconds 30; after delivering an answer to an ask OpenRig opened, post active/permission_resolved
// first. Breaks: beat-after-stop, beat-during-ask, no-resolve, and beat-time-backwards (each beat says it happened 15 s
// before it did, so its sequence no longer rises with the runner's own time).
const beatMode = argv.includes("--beat");
let beatTurn = null;
// With --withdraw-after-stop: the ask a cancelled or ended turn withdraws once its Stop is posted.
let deferredWithdraw = null;
// --break stop-before-end: a non-exit Stop posted while the ask waits stands in for the turn's end, which is then not posted.
let stoppedEarly = false;
// The current turn's accepted prompt's occurredAt.
let acceptedAt = null;
if (beatMode) setInterval(() => {
  if (beatTurn !== null && (!attention || breaks.has("beat-during-ask"))) void post("active", "liveness", { turnId: String(beatTurn), livenessSeconds: 30,
    ...(breaks.has("beat-time-backwards") ? { occurredAt: new Date(Date.now() - 15_000).toISOString() } : {}) });
}, 10_000).unref();
const resolved = (ask) => { if (beatMode && !breaks.has("no-resolve")) void post("active", "permission_resolved", { turnId: String(turn), askId: ask.askId }); };
const env = process.env;
const name = env.OPENRIG_RUNTIME ?? "runner";

// Activity posts go one at a time, in order, and never hold up the agent.
// With --break idle-string-sequence-on-exit the first post is numbered 2, so a "1" falls below the accepted prompt.
let sequence = breaks.has("idle-string-sequence-on-exit") ? 1 : 0;
let posting = Promise.resolve();
let holdNextPostMs = 0;
function post(hookEvent, subtype, extra = {}) {
  const hold = holdNextPostMs;
  holdNextPostMs = 0;
  const body = JSON.stringify({ sessionName: env.OPENRIG_SESSION_NAME, nodeId: env.OPENRIG_NODE_ID, runtime: name,
    generation: breaks.has("wrong-generation") ? "gen-other" : env.OPENRIG_OCCUPANT_GENERATION,
    ...(breaks.has("no-sequence") ? {} : { sequence: ++sequence }), occurredAt: new Date().toISOString(), hookEvent, subtype, ...extra });
  const headers = { "content-type": "application/json", ...(breaks.has("no-token") ? {} : { authorization: `Bearer ${env.OPENRIG_ACTIVITY_HOOK_TOKEN}` }) };
  posting = posting.then(() => hold && new Promise((resolve) => setTimeout(resolve, hold))).then(() => new Promise((resolve) => {
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
const wrapper = env.OPENRIG_LAUNCH_WRAPPER === undefined ? [] : JSON.parse(env.OPENRIG_LAUNCH_WRAPPER);
if (!Array.isArray(wrapper) || (env.OPENRIG_LAUNCH_WRAPPER !== undefined && wrapper.length === 0)
  || wrapper.some((arg) => typeof arg !== "string" || /[\0\r\n]/.test(arg)) || (wrapper.length && !wrapper[0].trim())) {
  throw new Error("launch_wrapper unavailable; no agent started.");
}
const quote = (arg) => `'${arg.replace(/'/g, `'"'"'`)}'`;
const prefix = wrapper.length && !breaks.has("ignore-wrapper") ? wrapper.map(quote).join(" ") + " " : "";
const childEnv = { ...env };
if (!breaks.has("leak-wrapper")) delete childEnv.OPENRIG_LAUNCH_WRAPPER;
const agent = spawn("/bin/sh", ["-c", `exec ${prefix}${agentCommand} acp`], { stdio: ["pipe", "pipe", "ignore"], env: childEnv });
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
  beatTurn = null;
  await withdrawLive("exited");
  // --break idle-low-sequence-on-exit: an idle Stop for the dead turn, numbered below its accepted prompt but later in time.
  if (breaks.has("idle-low-sequence-on-exit")) await post("Stop", "idle_heartbeat", { livenessSeconds: 30, sequence: 1 });
  // --break idle-string-sequence-on-exit: an idle Stop for the dead turn at its accepted prompt's time, numbered below it but
  // as a string, which OpenRig doesn't read as a sequence.
  if (breaks.has("idle-string-sequence-on-exit")) await post("Stop", "idle_heartbeat", { livenessSeconds: 30, occurredAt: acceptedAt, sequence: "1" });
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
// person's, or OpenRig's permit. A person's own words (`said`) join the prompt queue, after the turn. A refusal,
// at submit or while reading, is read by its code: the seat's opt-in refuses and
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
  // --break beat-during-ask beats as soon as the ask waits too, so the check sees it whatever the 10 s timer's phase.
  if (breaks.has("beat-during-ask") && beatTurn !== null) void post("active", "liveness", { turnId: String(beatTurn), livenessSeconds: 30 });
  if (breaks.has("stop-before-end")) { stoppedEarly = true; void post("Stop", "idle_heartbeat", { livenessSeconds: 30 }); }
  // --break stop-low-sequence: an idle Stop while the ask waits, numbered below the accepted prompt but later in time.
  if (breaks.has("stop-low-sequence")) void post("Stop", "idle_heartbeat", { livenessSeconds: 30, sequence: 1 });
  // --break stop-numeric-time: an idle Stop while the ask waits, its occurredAt a number, which OpenRig dates by arrival.
  if (breaks.has("stop-numeric-time")) void post("Stop", "idle_heartbeat", { livenessSeconds: 30, occurredAt: 0 });
  // done: the agent has its answer. open: OpenRig's ask may still be open, so it's withdrawn at the turn's end.
  const ask = { id: msg.id, askId: submitted.body.askId, offered: options.map((o) => o.optionId), done: false, open: true };
  live = ask;
  // The agent may have exited, or ended the turn, while the submit was on its way.
  if (agent.exitCode !== null || agent.signalCode !== null) { await withdrawLive("exited"); return; }
  if (!busy || turn !== askedInTurn) { await withdrawLive("turn_ended"); return; }
  for (;;) {
    let read = await api("GET", `/api/activity/permission-requests/${encodeURIComponent(ask.askId)}${readQuery}`);
    const permitsOn = (r) => r.status >= 300 && !NOT_CURRENT.has(r.body?.code) && !HOLDS.has(r.body?.code);
    for (let tries = 0; permitsOn(read) && tries < readRetries && !ask.done; tries++) {
      await new Promise((done) => setTimeout(done, 1500));
      read = await api("GET", `/api/activity/permission-requests/${encodeURIComponent(ask.askId)}${readQuery}`);
    }
    if (ask.done && !breaks.has("late-deliver")) return;
    const state = read.status === 200 ? read.body?.state : undefined;
    if (state === "pending") { if (readWait !== "25") await new Promise((done) => setTimeout(done, 200)); continue; }
    // A listed answer means OpenRig closed its ask; anything else leaves it open, to withdraw at the turn's end.
    if (["answered", "permitted", "refused", "withdrawn", "stale"].includes(state)) ask.open = false;
    // A person who answered in words: their words join the prompt queue in order, after this turn, never as the answer.
    const said = state && typeof read.body?.said === "string" && read.body.said.trim() ? read.body.said : null;
    if (said && !breaks.has("drop-words")) queue.push(`The person who answered your permission request (${toolCall?.title}) also wrote:\n\n${said}`);
    if (said && breaks.has("said-as-answer") && !ask.done) {
      refuse(ask.id);
      attention = false;
    } else if ((state === "answered" || state === "permitted") && ask.offered.includes(read.body.optionId)) {
      select(ask.id, read.body.optionId);
      if (breaks.has("deliver-twice")) select(ask.id, read.body.optionId);
      attention = false;
      resolved(ask);
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
      else { permit(); attention = !allowOf(options); if (!attention) resolved(ask); }
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
  if (withdrawAfterStop && busy && (reason === "turn_cancelled" || reason === "turn_ended")) {
    deferredWithdraw ??= { askId: ask.askId, reason };
    return Promise.resolve();
  }
  return api("POST", `/api/activity/permission-requests/${encodeURIComponent(ask.askId)}/withdraw`, { reason });
}

async function prompt(text) {
  busy = true;
  cancelSent = false;
  turn += 1;
  stoppedEarly = false;
  beatTurn = turn;
  show(`you ▸ ${text.split("\n")[0]}`);
  attention = false;
  acceptedAt = new Date().toISOString();
  const accepted = post("UserPromptSubmit", "accepted", { turnId: String(turn), occurredAt: acceptedAt });
  if (startupIdleMs === null) await accepted; // with --startup-idle, the agent doesn't wait on the post, as in dsh's runner
  const res = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  await withdrawLive("turn_ended");
  if (!breaks.has("beat-after-stop")) beatTurn = null;
  if (res.error) {
    if (!breaks.has("no-error-post")) await post("Notification", "runtime_error");
  } else {
    const reason = breaks.has("cancelled-always") && cancelSent ? "cancelled" : res.result.stopReason;
    if ((!attention || breaks.has("stop-while-attention")) && !stoppedEarly) await post("Stop", reason);
  }
  if (deferredWithdraw) {
    const { askId, reason } = deferredWithdraw;
    deferredWithdraw = null;
    await api("POST", `/api/activity/permission-requests/${encodeURIComponent(askId)}/withdraw`, { reason });
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
  if (breaks.has("release-refusal-on-abort")) attention = false;
  void withdrawLive("turn_cancelled");
}
function interrupt() {
  if (breaks.has("ctrl-c-ignored")) return;
  if (interruptDelayMs) setTimeout(abort, interruptDelayMs);
  else abort();
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
      else if (ch === "\x03") interrupt();
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
  if (startupIdleMs !== null && !env.OPENRIG_FIRST_INPUT) {
    holdNextPostMs = startupIdleMs;
    void post("Stop", "idle_heartbeat", { livenessSeconds: 30 });
  }
  if (env.OPENRIG_FIRST_INPUT) {
    const text = readFileSync(env.OPENRIG_FIRST_INPUT, "utf8");
    void prompt(breaks.has("first-input-trim") ? text.trim() : text);
  }
}
void main();
