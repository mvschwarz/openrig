#!/usr/bin/env node
// Example OpenRig runner for DeepSeek Harness (dsh), not installed by OpenRig. Checked against a stand-in agent only;
// written for dsh 0.2.1-rc.2 (npm @deepseek-ai/dsh), ACP protocol 1 and Node 22 or later. No dependencies.
//
// It follows docs/reference/harness-runner-contract.md: it hosts `dsh --profile acp` over ACP on stdio, writes the
// launch record once the conversation is open, turns each submitted block into one prompt, reports turn boundaries as
// activity hooks, cancels on /abort or Ctrl-C, and sends permission requests to OpenRig: a person answers, or OpenRig
// permits when no one can be asked, and so does the runner when OpenRig can't answer (refusing and holding needs input
// only when the seat opted in to refusal). Copy it and maintain it as your own.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const RUNNER = "openrig-dsh-runner 1";
const NAME = process.env.OPENRIG_RUNTIME || "dsh"; // the preset's name: OpenRig passes it, and checks the record against it
const LIVENESS_SECONDS = 60;
const BEAT_MS = 30_000;
const ACTIVE_EVERY_MS = 15_000;
const POST_TIMEOUT_MS = 2_000;
const WAIT_SECONDS = 25;
const READ_TRIES = 3; // reads in a row that get no answer before the runner permits
// Refusals that say the request certainly isn't the seat's current occupant's live one: cancel it, and hold nothing.
const NOT_LIVE = ["stale_generation", "activity_grant_wrong_seat", "activity_grant_stale"];
// A read's states that end the request, answered cancelled (an `answered` that reaches there names an option dsh didn't
// offer). Any other state, like an unlisted status, permits.
const ENDED = ["refused", "withdrawn", "stale", "answered"];
const CANCELLED = { outcome: { outcome: "cancelled" } };
const ACP_RESOURCE_NOT_FOUND = -32002;

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

const UPLOADS_OFF = [
  "# Written by openrig-dsh-runner for this seat; safe to edit, and an existing file is left alone.",
  "# Don't attach this seat's session log, or its plugin package names and versions, to DeepSeek API requests.",
  "- id: session-log-deepseek",
  "  config:",
  "    enabled: false",
  "- id: plugin-package-inventory-deepseek",
  "  config:",
  "    enabled: false",
  "",
].join("\n");

/** Each seat gets its own writable dsh home (dsh rewrites its profile there on every start). OPENRIG_DSH_HOME names
 *  one you prepared yourself, which is used as it is. */
function seatHome() {
  if (process.env.OPENRIG_DSH_HOME) return process.env.OPENRIG_DSH_HOME;
  const seat = process.env.OPENRIG_NODE_ID || process.env.OPENRIG_SESSION_NAME || "default";
  const home = join(openrigHome(), "state", "dsh", seat, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const patch = join(home, "cordis.patch.yml");
  if (!existsSync(patch)) writeFileSync(patch, UPLOADS_OFF, { mode: 0o600 });
  return home;
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
      console.error(`openrig-dsh-runner: the first startup turn couldn't be read (${error.message}); not starting`);
      process.exit(2);
    }
  }

  const home = seatHome();
  const activity = new Activity({ sessionName: env.OPENRIG_SESSION_NAME, nodeId: env.OPENRIG_NODE_ID,
    runtime: NAME, generation: env.OPENRIG_OCCUPANT_GENERATION });
  const agentEnv = { ...env, DSH_HOME: home };
  delete agentEnv.OPENRIG_ACTIVITY_HOOK_TOKEN; // dsh's shell tool inherits this environment
  agentEnv.DSH_PERMISSION_MODE ??= "workspace-write";
  if (agentEnv.DSH_TELEMETRY_DISABLED === undefined && agentEnv.DSH_TELEMETRY_MODE === undefined) agentEnv.DSH_TELEMETRY_DISABLED = "1";

  const child = spawn(env.OPENRIG_DSH || "dsh", ["--profile", "acp"], { cwd, env: agentEnv, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.on("error", () => {});
  const peer = new AgentPeer(child, (line) => say(`[dsh] ${line}`));
  const state = { sessionId: null, turn: 0, running: false, cancelRequestedAt: null, holding: false, refused: false, queue: [], asks: new Set(), lastActive: 0 };
  const inflight = new Set();
  const track = (promise) => { inflight.add(promise); promise.finally(() => inflight.delete(promise)); return promise; };
  let agentExited = false;
  let stopping = false;
  let heartbeat;
  let tty = false;

  const restoreTty = () => {
    if (!tty) return;
    tty = false;
    process.stdout.write("\x1b[?2004l");
    try { process.stdin.setRawMode(false); } catch { /* already closed */ }
  };
  const finish = async (code) => {
    clearInterval(heartbeat);
    restoreTty();
    await Promise.race([Promise.allSettled([...inflight, activity.flushed()]), sleep(2_000)]);
    process.exit(code);
  };
  const fatal = async (message, code) => {
    stopping = true;
    say(`[openrig-dsh] ${message}`);
    if (!agentExited) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((done) => child.once("exit", done)), sleep(3_000)]);
    }
    await finish(code);
  };
  const postIdle = (subtype) => activity.post("Stop", subtype, { livenessSeconds: LIVENESS_SECONDS });
  const withdraw = (askId, reason) => track(callOpenRig("POST", `/api/activity/permission-requests/${encodeURIComponent(askId)}/withdraw`, { reason }, POST_TIMEOUT_MS));

  child.once("error", (error) => { agentExited = true; void fatal(`dsh couldn't be started (${error.message}); is it on PATH?`, 1); });
  child.on("exit", (code, signal) => {
    agentExited = true;
    peer.failAll("dsh exited");
    if (stopping) return;
    for (const ask of state.asks) ask.end("exited");
    say(`\n[openrig-dsh] dsh exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
    activity.post("Stop", `${NAME}_exited`);
    void finish(code === 0 ? 0 : 1);
  });

  peer.onNotification("session/update", (params) => {
    if (params.sessionId !== state.sessionId || !params.update) return;
    const update = params.update;
    const reporting = state.running && !state.holding; // while needs input is held, nothing may read working
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
    // dsh doesn't remember a permission nobody chose.
    const allow = options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind === "allow_always");
    const permit = (why) => {
      if (!allow) return refuse(`${why}, and the agent offered no allow option`);
      state.holding = false;
      say(`[permission] permitted: ${why} (${allow.optionId})`);
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
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
    say(`[permission] OpenRig asked a person (${askId}); waiting for their answer`);
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
        if (!state.refused) state.holding = false; // the turn ended the person's ask: no one is still being asked
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
            state.holding = false;
            say(`[permission] ${answer.state}: ${answer.optionId}`);
            resolve({ outcome: { outcome: "selected", optionId: answer.optionId } });
          } else if (live() && (read.status === 200 ? !ENDED.includes(answer.state) : !NOT_LIVE.includes(answer.code))) {
            // OpenRig stopped answering, or answered in a way the contract doesn't list: nobody can be asked. The ask stays
            // tracked, so the turn's end still withdraws it.
            resolve(permit(read.status === 0 ? "OpenRig couldn't be reached" : `OpenRig couldn't answer (${answer.code ?? read.status})`));
          } else {
            state.asks.delete(ask);
            state.holding = false; // a person said no, or the request is over: no one is still waiting
            say(`[permission] not answered (${answer.reason ?? answer.state ?? answer.code ?? read.status}); answered cancelled`);
            resolve(CANCELLED);
          }
        }
      })();
    });
  };

  peer.onRequest("session/request_permission", (params, requestId) => {
    if (params.sessionId !== state.sessionId) throw Object.assign(new Error(`no turn of conversation ${params.sessionId} runs here`), { code: -32602 });
    const toolCall = { title: String(params.toolCall?.title ?? "a tool call"), kind: String(params.toolCall?.kind ?? "other") };
    const options = Array.isArray(params.options) ? params.options : [];
    say(`\n[permission] dsh asks: ${toolCall.title} (${toolCall.kind}); options ${options.map((option) => option.optionId).join(", ")}`);
    if (!state.running || state.cancelRequestedAt) return CANCELLED;
    return askOwner(requestId, toolCall, options);
  });

  const abort = () => {
    if (!state.running) { say("[openrig-dsh] no turn is running"); return; }
    if (state.cancelRequestedAt) return;
    state.cancelRequestedAt = new Date().toISOString();
    peer.notify("session/cancel", { sessionId: state.sessionId });
    say(`\n[openrig-dsh] cancel requested at ${state.cancelRequestedAt}; the turn ends when dsh says so`);
    state.holding = false;
    for (const ask of state.asks) ask.end("turn_cancelled");
  };

  const runTurn = async (text) => {
    state.running = true;
    state.turn += 1;
    state.holding = false;
    state.refused = false;
    state.cancelRequestedAt = null;
    state.lastActive = 0;
    const turnId = String(state.turn);
    say(`\nyou ▸ ${firstLine(text)}`);
    activity.post("UserPromptSubmit", "accepted", { turnId });
    let stopReason;
    try {
      const result = await peer.request("session/prompt", { sessionId: state.sessionId, prompt: [{ type: "text", text }] });
      stopReason = String(result?.stopReason ?? "unreported");
    } catch (error) {
      if (agentExited) return;
      say(`\n[openrig-dsh] the turn failed: ${error.message}`);
      activity.post("Notification", "runtime_error", { turnId });
      stopReason = "error";
    }
    state.running = false;
    for (const ask of state.asks) ask.end("turn_ended");
    say(`\n── turn end (${stopReason}) ──`);
    if (state.holding) say("[openrig-dsh] a permission request went unanswered, so the seat reads needs input until the next prompt");
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
    if (state.running) say(`[queued: ${state.queue.length}] this goes to dsh after the current turn`);
    pump();
  };

  // Handshake, then open or reopen the conversation, then report it. Nothing is read as ready before this.
  let init;
  try {
    init = await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "openrig-dsh-runner", version: "1" } });
  } catch (error) {
    return fatal(`dsh didn't complete the ACP handshake (${error.message})`, 1);
  }
  const capabilities = init?.agentCapabilities ?? {};
  const producer = `${RUNNER}; dsh ${init?.agentInfo?.version ?? "(version not reported)"}; ACP ${init?.protocolVersion ?? "?"}`;
  const resumeRef = env.OPENRIG_RESUME_REF;
  if (resumeRef) {
    // The method dsh advertises; with neither advertised, session/resume, the method dsh 0.2.1-rc.2 answered in its
    // maintainer's checks. Only dsh's own "not found" counts as missing; anything else leaves the resume unconfirmed.
    const method = capabilities.sessionCapabilities?.resume ? "session/resume" : capabilities.loadSession ? "session/load" : "session/resume";
    try {
      await peer.request(method, { sessionId: resumeRef, cwd, mcpServers: [] });
    } catch (error) {
      if (error.code === ACP_RESOURCE_NOT_FOUND) {
        writeLaunchRecord({ error: "missing", producer });
        return fatal(`dsh says conversation ${resumeRef} doesn't exist (${error.message}); no new one was started`, 3);
      }
      return fatal(`dsh couldn't reopen conversation ${resumeRef} (${method}: ${error.message}); the resume is unconfirmed and no new conversation was started`, 4);
    }
    state.sessionId = resumeRef;
  } else {
    try {
      state.sessionId = (await peer.request("session/new", { cwd, mcpServers: [] }))?.sessionId ?? null;
    } catch (error) {
      return fatal(`dsh couldn't open a conversation (${error.message})`, 1);
    }
    if (!state.sessionId) return fatal("dsh opened a conversation without naming it", 1);
  }
  writeLaunchRecord({ nativeRef: state.sessionId, producer });
  say(`[openrig-dsh] ready · ${producer} · conversation ${state.sessionId}`);
  say(`[openrig-dsh] DSH_HOME ${home} · DSH_PERMISSION_MODE ${agentEnv.DSH_PERMISSION_MODE}`);
  say("[openrig-dsh] each submitted message is one prompt; /abort or Ctrl-C cancels the running turn");

  heartbeat = setInterval(() => { if (!state.running && !state.holding && !agentExited) postIdle("idle_heartbeat"); }, BEAT_MS);
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
  main().catch((error) => { console.error(`openrig-dsh-runner: ${error.stack ?? error}`); process.exit(1); });
}
