#!/usr/bin/env node
// Example OpenRig runner for the Antigravity CLI (agy) over `agy acp`, not installed by OpenRig. Adapted from an earlier
// version of the dsh example runner (community-harness-examples/dsh/) and checked once with agy 1.5.13 on a Gemini API key.
// ACP protocol 1, Node 22 or later, no dependencies. Setup arrives as arguments, because the pane has a minimal environment:
//   openrig-agy-runner.mjs [--agy-home DIR] [--agy PATH] [--key-file PATH] [--model ID] [--rig-path DIR]
//
// It follows docs/reference/harness-runner-contract.md: it hosts `agy acp` over ACP on stdio, writes the
// launch record once the conversation is open, turns each submitted block into one prompt, reports turn boundaries as
// activity hooks with a working beat through a long, quiet turn, cancels on /abort or Ctrl-C, and sends permission
// requests to OpenRig: a person answers, or OpenRig permits when no one can be asked, and so does the runner when OpenRig
// can't answer (refusing and holding needs input only when the seat opted in to refusal). Copy it and maintain it as your
// own.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const RUNNER = "openrig-agy-runner 1";
const NAME = process.env.OPENRIG_RUNTIME || "agy"; // the preset's name: OpenRig passes it, and checks the record against it
const LIVENESS_SECONDS = 60;
const BEAT_MS = 30_000;
// The working beat (contract section 4): every 10 s, more often than half its 30 s lifetime.
const WORK_LIVENESS_SECONDS = 30;
const WORK_BEAT_MS = 10_000;
const ACTIVE_EVERY_MS = 15_000;
const POST_TIMEOUT_MS = 2_000;
const WAIT_SECONDS = 25;
const READ_TRIES = 3; // reads in a row that get no answer before the runner permits
// Refusals that say the request certainly isn't the seat's current occupant's live one: cancel it, and hold nothing.
const NOT_LIVE = ["stale_generation", "activity_grant_wrong_seat", "activity_grant_stale"];
// A read's states that end the request, answered cancelled (an `answered` that reaches there names an option agy didn't
// offer). Any other state, like an unlisted status, permits.
const ENDED = ["refused", "withdrawn", "stale", "answered"];
const CANCELLED = { outcome: { outcome: "cancelled" } };
// The most pages of agy's session list read before a resume; a longer list decides nothing.
const LIST_PAGES = 50;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Turns terminal bytes into submitted blocks. Everything up to an Enter outside a paste is one block, line breaks
 *  included; a block that is exactly /abort, or a Ctrl-C byte, is the only control. */
export class InputFramer {
  #buffer = "";
  #pasting = false;
  #partial = "";

  push(chunk) {
    const events = [];
    const data = this.#partial + chunk;
    this.#partial = "";
    let i = 0;
    while (i < data.length) {
      if (data[i] === "\x1b") {
        const rest = data.slice(i);
        if (rest.startsWith(PASTE_START) || rest.startsWith(PASTE_END)) {
          this.#pasting = rest.startsWith(PASTE_START);
          i += PASTE_START.length;
          continue;
        }
        if (PASTE_START.startsWith(rest) || PASTE_END.startsWith(rest)) { this.#partial = rest; break; }
        if (!this.#pasting) { i += escapeLength(rest); continue; } // arrow keys and the like
      }
      const ch = data[i];
      i += 1;
      if (ch === "\x03") { this.#buffer = ""; this.#pasting = false; events.push({ type: "abort" }); continue; }
      if (this.#pasting) {
        if (ch === "\r") { if (data[i] === "\n") i += 1; this.#buffer += "\n"; } else this.#buffer += ch;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        const text = this.#buffer;
        this.#buffer = "";
        if (text.trim() === "/abort") events.push({ type: "abort" });
        else if (text.trim()) events.push({ type: "block", text });
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        if (this.#buffer) { this.#buffer = this.#buffer.slice(0, -1); events.push({ type: "erase" }); }
        continue;
      }
      if (ch >= " ") { this.#buffer += ch; events.push({ type: "echo", text: ch }); }
    }
    return events;
  }
}

function escapeLength(rest) {
  if (rest[1] === "[") {
    let j = 2;
    while (j < rest.length && !(rest.charCodeAt(j) >= 0x40 && rest.charCodeAt(j) <= 0x7e)) j += 1;
    return Math.min(j + 1, rest.length);
  }
  return rest[1] === "O" ? Math.min(3, rest.length) : 1;
}

/** JSON-RPC 2.0 with the agent, one message per line on its stdio. */
class AgentPeer {
  #child;
  #next = 1;
  #waiting = new Map();
  #requests = new Map();
  #notifications = new Map();

  constructor(child, onNoise) {
    this.#child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { message = null; }
      if (!message || typeof message !== "object") { if (line.trim()) onNoise(line); return; }
      if (message.method === undefined) {
        const waiter = this.#waiting.get(message.id);
        if (!waiter) return;
        this.#waiting.delete(message.id);
        if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? "error"), { code: message.error.code }));
        else waiter.resolve(message.result);
        return;
      }
      if (message.id === undefined) { this.#notifications.get(message.method)?.(message.params ?? {}); return; }
      const handler = this.#requests.get(message.method);
      if (!handler) { this.#write({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }); return; }
      Promise.resolve().then(() => handler(message.params ?? {}, message.id)).then(
        (result) => this.#write({ id: message.id, result }),
        (error) => this.#write({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }));
    });
  }

  request(method, params) {
    const id = this.#next++;
    return new Promise((resolve, reject) => { this.#waiting.set(id, { resolve, reject }); this.#write({ id, method, params }); });
  }

  notify(method, params) { this.#write({ method, params }); }
  onRequest(method, handler) { this.#requests.set(method, handler); }
  onNotification(method, handler) { this.#notifications.set(method, handler); }

  failAll(reason) {
    for (const waiter of this.#waiting.values()) waiter.reject(new Error(reason));
    this.#waiting.clear();
  }

  #write(message) {
    if (this.#child.stdin.writable) this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
}

const openrigHome = () => process.env.OPENRIG_HOME || join(homedir(), ".openrig");

/** The daemon's base URL and the seat's token: from the environment, else from activity-endpoint.json. */
function openrigEndpoint() {
  const env = process.env;
  let base = env.OPENRIG_URL || (env.OPENRIG_PORT ? `http://${env.OPENRIG_HOST || "127.0.0.1"}:${env.OPENRIG_PORT}` : "");
  let token = env.OPENRIG_ACTIVITY_HOOK_TOKEN || "";
  if (!base || !token) {
    try {
      const file = JSON.parse(readFileSync(join(openrigHome(), "activity-endpoint.json"), "utf8"));
      base ||= file.baseUrl ?? "";
      token ||= file.token ?? "";
    } catch { /* no daemon has written one yet */ }
  }
  return base && token ? { base: base.replace(/\/+$/, ""), token } : null;
}

async function callOpenRig(method, path, body, timeoutMs) {
  const endpoint = openrigEndpoint();
  if (!endpoint) return { status: 0, body: null };
  try {
    const response = await fetch(`${endpoint.base}${path}`, {
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${endpoint.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { /* not JSON */ }
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

/** Activity posts go one at a time, in order, and never hold up the agent. */
class Activity {
  #sequence = 0;
  #chain = Promise.resolve();

  constructor(identity) { this.identity = identity; }

  post(hookEvent, subtype, extra = {}) {
    const body = { ...this.identity, sequence: ++this.#sequence, occurredAt: new Date().toISOString(), hookEvent, subtype, ...extra };
    this.#chain = this.#chain.then(() => callOpenRig("POST", "/api/activity/hooks", body, POST_TIMEOUT_MS)).then(() => {}, () => {});
  }

  flushed() { return this.#chain; }
}

const args = process.argv.slice(2);
const argValue = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
/** The seat's agy login and state live in a HOME-style folder: --agy-home, else AGY_HOME, else the daemon user's HOME. */
const seatHome = () => argValue("--agy-home") || process.env.AGY_HOME || homedir();

/** agy's version as its CLI reports it, or null when it can't say.
 *  SIGKILL at the timeout, because a synchronous call waits for the child to exit, and a child can ignore SIGTERM. */
function cliVersion(bin, env) {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", env, timeout: 5_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
    return out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function writeLaunchRecord(fields) {
  const path = process.env.OPENRIG_LAUNCH_RESULT;
  if (!path) return;
  const record = { format: 1, attempt: process.env.OPENRIG_LAUNCH_ATTEMPT, harness: NAME, ...fields };
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (line) => process.stdout.write(`${line}\n`);
const firstLine = (text) => {
  const lines = text.split("\n");
  return lines.length > 1 ? `${lines[0]} … (+${lines.length - 1} lines)` : lines[0];
};

async function main() {
  const env = process.env;
  const cwd = process.cwd();
  let firstInput = null;
  if (env.OPENRIG_FIRST_INPUT) {
    try { firstInput = readFileSync(env.OPENRIG_FIRST_INPUT, "utf8"); } catch (error) {
      console.error(`openrig-agy-runner: the first startup turn couldn't be read (${error.message}); not starting`);
      process.exit(2);
    }
  }

  const home = seatHome();
  const activity = new Activity({ sessionName: env.OPENRIG_SESSION_NAME, nodeId: env.OPENRIG_NODE_ID,
    runtime: NAME, generation: env.OPENRIG_OCCUPANT_GENERATION });
  const agentEnv = { ...env, HOME: home };
  delete agentEnv.OPENRIG_ACTIVITY_HOOK_TOKEN; // agy's shell tool inherits this environment
  // API-key auth (docs: modelProvider "gemini" in agy's settings.json plus GEMINI_API_KEY in the environment): the key file
  // named by --key-file is read here and handed to agy's environment only; it is never printed, logged or put in argv.
  const keyFile = argValue("--key-file");
  if (keyFile) {
    try { agentEnv.GEMINI_API_KEY = readFileSync(keyFile, "utf8").trim(); } catch (error) { console.error(`openrig-agy-runner: the key file couldn't be read (${error.code ?? "error"}); not starting`); process.exit(2); }
  }
  const pinnedModel = argValue("--model");
  const rigPath = argValue("--rig-path");
  if (rigPath) agentEnv.PATH = `${rigPath}:${env.PATH ?? ""}`; // so the agent can run `rig`

  // --agy, or OPENRIG_AGY, names the agy executable; otherwise `agy` on the pane's PATH.
  const bin = argValue("--agy") || env.OPENRIG_AGY || "agy";
  const version = cliVersion(bin, agentEnv);
  const child = spawn(bin, ["acp"], { cwd, env: agentEnv, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.on("error", () => {});
  const peer = new AgentPeer(child, (line) => say(`[agy] ${line}`));
  const state = { implicit: false, sessionId: null, turn: 0, running: false, cancelRequestedAt: null, holding: false, refused: false, queue: [], asks: new Set(), lastActive: 0, asking: 0, waiting: 0, resolvedAsk: null };
  const inflight = new Set();
  const track = (promise) => { inflight.add(promise); promise.finally(() => inflight.delete(promise)); return promise; };
  let agentExited = false;
  let stopping = false;
  let heartbeat;
  let workBeat;
  let tty = false;
  // The turn may read working: it runs, nothing holds needs input, no permission request is being submitted or waits for its
  // permission_resolved, and agy is alive. The beat and the agent's own reports both go by it.
  const working = () => state.running && !state.holding && state.asking === 0 && !state.resolvedAsk && !agentExited;

  const restoreTty = () => {
    if (!tty) return;
    tty = false;
    process.stdout.write("\x1b[?2004l");
    try { process.stdin.setRawMode(false); } catch { /* already closed */ }
  };
  const finish = async (code) => {
    clearInterval(heartbeat);
    clearInterval(workBeat);
    restoreTty();
    await Promise.race([Promise.allSettled([...inflight, activity.flushed()]), sleep(2_000)]);
    process.exit(code);
  };
  const fatal = async (message, code) => {
    stopping = true;
    say(`[openrig-agy] ${message}`);
    if (!agentExited) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((done) => child.once("exit", done)), sleep(3_000)]);
    }
    await finish(code);
  };
  const postIdle = (subtype) => activity.post("Stop", subtype, { livenessSeconds: LIVENESS_SECONDS });
  const withdraw = (askId, reason) => track(callOpenRig("POST", `/api/activity/permission-requests/${encodeURIComponent(askId)}/withdraw`, { reason }, POST_TIMEOUT_MS));

  child.once("error", (error) => { agentExited = true; void fatal(`agy couldn't be started (${error.message}); is it on PATH?`, 1); });
  child.on("exit", (code, signal) => {
    agentExited = true;
    peer.failAll("agy exited");
    if (stopping) return;
    for (const ask of state.asks) ask.end("exited");
    say(`\n[openrig-agy] agy exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
    activity.post("Stop", `${NAME}_exited`);
    void finish(code === 0 ? 0 : 1);
  });

  // agy can continue on its own after a background task finishes: it sends updates and permission requests with no
  // session/prompt open. Treat that as an implicit turn: working while it talks, idle after IMPLICIT_QUIET_MS of silence
  // (and no open permission ask). A queued prompt waits until the implicit turn ends. Only an accepted prompt clears what
  // the last turn left: a refusal's held needs input stays held (no turn start, no idle), and after a cancel a late
  // permission request is still answered cancelled.
  const IMPLICIT_QUIET_MS = 20_000;
  let implicitTimer;
  const armImplicitEnd = () => {
    clearTimeout(implicitTimer);
    implicitTimer = setTimeout(() => {
      if (!state.implicit || state.asking > 0 || state.waiting > 0) { if (state.implicit) armImplicitEnd(); return; }
      state.implicit = false; state.running = false;
      for (const ask of state.asks) ask.end("turn_ended");
      say("\n── agent-initiated turn end (quiet) ──");
      if (state.holding) say("[openrig-agy] a permission request was refused, so the seat reads needs input until the next prompt");
      else postIdle("implicit_quiet");
      pump();
    }, IMPLICIT_QUIET_MS);
  };
  const beginImplicit = () => {
    if (state.running || agentExited) return;
    state.running = true; state.implicit = true; state.turn += 1;
    state.waiting = 0; state.resolvedAsk = null; state.lastActive = 0;
    say("\n[openrig-agy] agy continued on its own (a background task finished?); treating it as a turn");
    if (!state.holding) activity.post("UserPromptSubmit", "agent_initiated", { turnId: String(state.turn) });
    armImplicitEnd();
  };

  peer.onNotification("session/update", (params) => {
    if (params.sessionId !== state.sessionId || !params.update) return;
    if (!state.running) beginImplicit(); else if (state.implicit) armImplicitEnd();
    const update = params.update;
    const reporting = working();
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content?.type === "text") process.stdout.write(update.content.text);
      if (reporting && Date.now() - state.lastActive >= ACTIVE_EVERY_MS) { state.lastActive = Date.now(); activity.post("active", "agent_message"); }
    } else if (update.sessionUpdate === "tool_call") {
      say(`\n[tool] ${update.title ?? "tool"} (${update.kind ?? "other"})`);
      if (reporting) activity.post("PreToolUse", String(update.kind ?? "other"));
    }
  });

  const refuse = (why) => {
    state.holding = true;
    state.refused = true; // the seat's own refusal holds needs input until the next prompt
    say(`[permission] refused: ${why}. The seat reads needs input until the next prompt.`);
    activity.post("Notification", "permission_prompt", { turnId: String(state.turn) });
    return CANCELLED;
  };

  // The answered path: OpenRig opens one ask to the default person (or the seat's override, `rig seat
  // set-permissions-to`), and the runner reads the answer back for this same live request. With no one to ask, OpenRig
  // permits at once, and so does the runner when OpenRig can't answer. Only the seat's opt-in (`--deny`) refuses; a
  // request OpenRig says isn't the current occupant's, or that a person said no to with no reject option, is cancelled.
  const askOwner = async (requestId, toolCall, options) => {
    const turn = state.turn;
    const live = () => state.running && state.turn === turn && !state.cancelRequestedAt && !agentExited;
    const submitted = await callOpenRig("POST", "/api/activity/permission-requests", {
      sessionName: env.OPENRIG_SESSION_NAME, nodeId: env.OPENRIG_NODE_ID, generation: env.OPENRIG_OCCUPANT_GENERATION,
      nativeRef: state.sessionId, turnId: String(turn), requestId: String(requestId), toolCall,
      options: options.map((option) => ({ optionId: option.optionId, name: option.name ?? option.optionId, kind: option.kind })),
      occurredAt: new Date().toISOString(),
    }, 10_000);
    const askId = submitted.body?.ok ? submitted.body.askId : undefined;
    if (!live()) {
      if (askId) withdraw(askId, state.cancelRequestedAt ? "turn_cancelled" : agentExited ? "exited" : "turn_ended");
      return CANCELLED;
    }
    const offered = (optionId) => options.some((option) => option.optionId === optionId);
    // No one can be asked: OpenRig's default is permit, with the agent's own allow option.
    if (submitted.body?.ok && submitted.body.state === "permitted" && offered(submitted.body.optionId)) {
      say(`[permission] permitted: ${submitted.body.reason ?? "no one can be asked"} (${submitted.body.optionId})`);
      return { outcome: { outcome: "selected", optionId: submitted.body.optionId } };
    }
    // When OpenRig can't answer, nobody can be asked either, so the same default applies. allow_once is preferred, so
    // agy doesn't remember a permission nobody chose.
    const allow = options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind === "allow_always");
    const permit = (why) => {
      if (!allow) return refuse(`${why}, and the agent offered no allow option`);
      state.holding = state.refused || state.waiting > 0; // another ask may still wait on a person
      say(`[permission] permitted: ${why} (${allow.optionId})`);
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    };
    // A person who answered in their own words: OpenRig passes them back as `said`. They join the prompt queue like any
    // message, so agy gets them after this turn and after any message already waiting. They're never the answer.
    const passOn = (said) => {
      if (typeof said !== "string" || !said.trim()) return;
      say(`[permission] the person also wrote: ${firstLine(said)}`);
      submit(`The person who answered your permission request (${toolCall.title}) also wrote:\n\n${said}`);
    };
    if (!askId) {
      if (submitted.body?.code === "denied_by_seat") return refuse("the seat's operator chose to refuse its permission requests");
      if (NOT_LIVE.includes(submitted.body?.code)) {
        say(`[permission] cancelled: OpenRig says this isn't the seat's current request (${submitted.body.code})`);
        return CANCELLED;
      }
      return permit(submitted.status === 404 ? "this OpenRig has no answered path"
        : submitted.status === 0 ? "OpenRig couldn't be reached" : `OpenRig couldn't ask anyone (${submitted.body?.code ?? submitted.status})`);
    }
    state.holding = true; // OpenRig recorded the seat's permission prompt when it opened the ask
    state.waiting += 1;
    say(`[permission] OpenRig asked a person (${askId}); waiting for their answer`);
    // This ask no longer waits on a person; the seat still needs input while another one does, or after its own refusal.
    const stopWaiting = () => { state.waiting -= 1; state.holding = state.refused || state.waiting > 0; };
    // The agent got an answer or a permit for this ask: once nothing else waits, permission_resolved says the turn goes on.
    const resolved = () => { state.resolvedAsk = { turn, askId }; };
    return new Promise((resolve) => {
      let done = false; // the agent has its answer
      let ended = false; // OpenRig was told the request is over
      const ask = { end: (reason) => {
        if (ended) return;
        ended = true;
        state.asks.delete(ask);
        withdraw(askId, reason);
        if (done) return;
        done = true;
        stopWaiting(); // the turn ended the person's ask
        resolve(CANCELLED);
      } };
      state.asks.add(ask);
      void (async () => {
        let unanswered = 0;
        while (!done) {
          const read = await callOpenRig("GET", `/api/activity/permission-requests/${encodeURIComponent(askId)}?waitSeconds=${WAIT_SECONDS}`, null, (WAIT_SECONDS + 10) * 1_000);
          if (done) return;
          if (read.status === 0 && ++unanswered < READ_TRIES) { await sleep(2_000); continue; }
          if (read.status === 200 && read.body?.state === "pending") { unanswered = 0; continue; }
          done = true;
          const answer = read.body ?? {};
          // A person's option, or OpenRig's permit when they closed it without one.
          if ((answer.state === "answered" || answer.state === "permitted") && offered(answer.optionId) && live()) {
            state.asks.delete(ask);
            stopWaiting();
            say(`[permission] ${answer.state}: ${answer.optionId}`);
            resolve({ outcome: { outcome: "selected", optionId: answer.optionId } });
            resolved();
            passOn(answer.said);
          } else if (live() && (read.status === 200 ? !ENDED.includes(answer.state) : !NOT_LIVE.includes(answer.code))) {
            // OpenRig stopped answering, or answered in a way the contract doesn't list: nobody can be asked. The ask stays
            // tracked, so the turn's end still withdraws it.
            stopWaiting();
            resolve(permit(read.status === 0 ? "OpenRig couldn't be reached" : `OpenRig couldn't answer (${answer.code ?? read.status})`));
            if (!state.refused) resolved(); // permitted, not refused for want of an allow option
          } else {
            state.asks.delete(ask);
            stopWaiting(); // a person said no, or the request is over
            say(`[permission] not answered (${answer.reason ?? answer.state ?? answer.code ?? read.status}); answered cancelled`);
            resolve(CANCELLED);
            passOn(answer.said);
          }
        }
      })();
    });
  };

  peer.onRequest("session/request_permission", (params, requestId) => {
    if (params.sessionId !== state.sessionId) throw Object.assign(new Error(`no turn of conversation ${params.sessionId} runs here`), { code: -32602 });
    const toolCall = { title: String(params.toolCall?.title ?? "a tool call"), kind: String(params.toolCall?.kind ?? "other") };
    const options = Array.isArray(params.options) ? params.options : [];
    say(`\n[permission] agy asks: ${toolCall.title} (${toolCall.kind}); options ${options.map((option) => option.optionId).join(", ")}`);
    if (!state.running && !state.cancelRequestedAt) beginImplicit();
    if (!state.running || state.cancelRequestedAt) return CANCELLED;
    state.asking += 1; // no beat while a permission request is open: it may be waiting on a person
    return askOwner(requestId, toolCall, options).finally(() => { state.asking -= 1; if (state.implicit) armImplicitEnd(); setImmediate(settle); });
  });

  // Once nothing waits on a person or is being submitted, the seat holds no refusal of its own and agy is alive, say the turn
  // goes on. It goes out after the agent has its answer, and before the next beat.
  const settle = () => {
    const done = state.resolvedAsk;
    if (!done || state.holding || state.asking > 0) return;
    state.resolvedAsk = null;
    if (state.running && state.turn === done.turn && !agentExited) activity.post("active", "permission_resolved", { turnId: String(done.turn), askId: done.askId });
  };

  const abort = () => {
    if (!state.running) { say("[openrig-agy] no turn is running"); return; }
    if (state.cancelRequestedAt) return;
    state.cancelRequestedAt = new Date().toISOString();
    peer.notify("session/cancel", { sessionId: state.sessionId });
    say(`\n[openrig-agy] cancel requested at ${state.cancelRequestedAt}; the turn ends when agy says so`);
    if (!state.refused) state.holding = false; // the seat's own refusal holds until the next accepted prompt
    for (const ask of state.asks) ask.end("turn_cancelled");
  };

  const runTurn = async (text) => {
    state.running = true;
    state.turn += 1;
    state.holding = false;
    state.refused = false;
    state.waiting = 0;
    state.resolvedAsk = null;
    state.cancelRequestedAt = null;
    state.lastActive = 0;
    const turnId = String(state.turn);
    say(`\nyou ▸ ${firstLine(text)}`);
    activity.post("UserPromptSubmit", "accepted", { turnId });
    let stopReason;
    try {
      const result = await peer.request("session/prompt", { sessionId: state.sessionId, prompt: [{ type: "text", text }] });
      stopReason = String(result?.stopReason ?? "unreported");
      if (result?.usage) { // agy reports tokens per turn; keep a running total for the seat's per-task accounting
        state.usage ??= { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 0 };
        for (const k of Object.keys(state.usage)) state.usage[k] += Number(result.usage[k] ?? 0);
        say(`[usage] turn ${JSON.stringify(result.usage)} · seat total ${JSON.stringify(state.usage)}`);
      }
    } catch (error) {
      if (agentExited) return;
      say(`\n[openrig-agy] the turn failed: ${error.message}`);
      activity.post("Notification", "runtime_error", { turnId });
      stopReason = "error";
    }
    state.running = false;
    for (const ask of state.asks) ask.end("turn_ended");
    say(`\n── turn end (${stopReason}) ──`);
    if (state.holding) say("[openrig-agy] a permission request was refused, so the seat reads needs input until the next prompt");
    else postIdle(stopReason);
    pump();
  };

  const pump = () => {
    if (state.running || agentExited || state.queue.length === 0) return;
    void runTurn(state.queue.shift());
  };

  const submit = (text) => {
    if (agentExited) return;
    state.queue.push(text);
    if (state.running) say(`[queued: ${state.queue.length}] this goes to agy after the current turn`);
    pump();
  };

  // Handshake, then open or reopen the conversation, then report it. Nothing is read as ready before this.
  let init;
  try {
    init = await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "openrig-agy-runner", version: "1" } });
  } catch (error) {
    return fatal(`agy didn't complete the ACP handshake (${error.message})`, 1);
  }
  const capabilities = init?.agentCapabilities ?? {};
  const reported = init?.agentInfo?.version ? `${init.agentInfo.version} (as its ACP handshake reports it)` : "(version not reported)";
  const producer = `${RUNNER}; agy ${version ?? reported}; ACP ${init?.protocolVersion ?? "?"}`;
  const resumeRef = env.OPENRIG_RESUME_REF;
  // Whether agy's own session list names a conversation, following its pages: true, false when every page was read and
  // none names it, or undefined when the list fails, answers in another shape, or runs past LIST_PAGES pages. An ACP
  // cursor is an opaque string, possibly empty, passed back unchanged; an absent or null one ends the list.
  const listsConversation = async (id) => {
    let cursor;
    for (let page = 0; page < LIST_PAGES; page += 1) {
      let listing;
      try { listing = await peer.request("session/list", cursor === undefined ? {} : { cursor }); } catch { return undefined; }
      if (!Array.isArray(listing?.sessions) || listing.sessions.some((session) => typeof session?.sessionId !== "string")) return undefined;
      if (listing.sessions.some((session) => session.sessionId === id)) return true;
      if (listing.nextCursor === undefined || listing.nextCursor === null) return false;
      if (typeof listing.nextCursor !== "string") return undefined;
      cursor = listing.nextCursor;
    }
    return undefined;
  };
  if (resumeRef) {
    // agy 1.5.13: session/resume of an unknown id answers -32603 "Failed to read session ..."; session/load of an unknown id
    // SUCCEEDS silently (the failure only shows at the first prompt), so never use session/load here. The session list is
    // the evidence of absence: a resume failure counts as missing only when every list page was read and none names the id.
    const method = capabilities.sessionCapabilities?.resume ? "session/resume" : null;
    if (!method) return fatal(`agy doesn't advertise session/resume; refusing to resume conversation ${resumeRef}`, 4);
    try {
      await peer.request(method, { sessionId: resumeRef, cwd, mcpServers: [] });
    } catch (error) {
      const listed = capabilities.sessionCapabilities?.list ? await listsConversation(resumeRef) : undefined;
      if (listed === false) {
        writeLaunchRecord({ error: "missing", producer });
        return fatal(`agy holds no conversation ${resumeRef} (${error.message}); no new one was started`, 3);
      }
      return fatal(`agy couldn't reopen conversation ${resumeRef} (${method}: ${error.message}); the resume is unconfirmed and no new conversation was started`, 4);
    }
    state.sessionId = resumeRef;
  } else {
    try {
      const created = await peer.request("session/new", { cwd, mcpServers: [] });
      state.sessionId = created?.sessionId ?? null;
      state.model = created?.models?.currentModelId ?? null;
    } catch (error) {
      return fatal(`agy couldn't open a conversation (${error.message})`, 1);
    }
    if (!state.sessionId) return fatal("agy opened a conversation without naming it", 1);
  }
  // agy's default model on API-key auth is Gemini 3.1 Pro (Low), not Neon: pin it with session/set_model, then report what we set.
  if (pinnedModel) {
    try { await peer.request("session/set_model", { sessionId: state.sessionId, modelId: pinnedModel }); state.model = pinnedModel; }
    catch (error) { say(`[openrig-agy] couldn't pin model ${pinnedModel} (${error.message}); agy's own default stays`); }
  }
  writeLaunchRecord({ nativeRef: state.sessionId, producer });
  say(`[openrig-agy] ready · ${producer} · conversation ${state.sessionId}${state.model ? ` · model ${state.model}` : ""}`);
  say(`[openrig-agy] HOME ${home}`);
  say("[openrig-agy] each submitted message is one prompt; /abort or Ctrl-C cancels the running turn");

  // OpenRig 0.7.18+ (#3150): a run-bound runner may post `observations.model.id` (harness-runner-contract.md, "observations").
  // It is a separate report from activity: no hookEvent, its own increasing sequence, renewed before the 10-minute freshness
  // window ends. Older OpenRig versions answer an error, which is ignored; the model is also printed in the pane.
  let observationSequence = 0;
  const observeModel = () => {
    if (!state.model || !env.OPENRIG_RUN_ID) return;
    const body = { runId: env.OPENRIG_RUN_ID, sequence: ++observationSequence, occurredAt: new Date().toISOString(), observations: { model: { id: state.model } } };
    track(callOpenRig("POST", "/api/activity/hooks", body, POST_TIMEOUT_MS));
  };
  observeModel();
  const observeBeat = setInterval(observeModel, 5 * 60_000);
  observeBeat.unref();

  heartbeat = setInterval(() => { if (!state.running && !state.holding && !agentExited) postIdle("idle_heartbeat"); }, BEAT_MS);
  // While a turn runs and nothing waits on a person: the turn is still outstanding and agy is alive. Not progress.
  workBeat = setInterval(() => {
    if (working()) {
      activity.post("active", "liveness", { turnId: String(state.turn), livenessSeconds: WORK_LIVENESS_SECONDS });
    }
  }, WORK_BEAT_MS);
  for (const signal of ["SIGHUP", "SIGTERM"]) {
    process.on(signal, () => {
      if (state.running && !state.cancelRequestedAt) peer.notify("session/cancel", { sessionId: state.sessionId });
      for (const ask of state.asks) ask.end("exited");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
    });
  }
  process.on("SIGINT", abort);

  const framer = new InputFramer();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?2004h");
    tty = true;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      for (const event of framer.push(chunk)) {
        if (event.type === "echo") process.stdout.write(event.text);
        else if (event.type === "erase") process.stdout.write("\b \b");
        else if (event.type === "abort") { process.stdout.write("\n"); abort(); }
        else if (event.type === "block") { process.stdout.write("\n"); submit(event.text); }
      }
    });
  } else {
    createInterface({ input: process.stdin }).on("line", (line) => {
      if (line.trim() === "/abort") abort();
      else if (line.trim()) submit(line);
    });
  }

  if (firstInput !== null) submit(firstInput);
  else postIdle("idle_heartbeat");
}

const invoked = (() => {
  try { return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null; } catch { return null; }
})();
if (invoked === import.meta.url) {
  main().catch((error) => { console.error(`openrig-agy-runner: ${error.stack ?? error}`); process.exit(1); });
}
