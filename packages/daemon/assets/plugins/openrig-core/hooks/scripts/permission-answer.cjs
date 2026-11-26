#!/usr/bin/env node
"use strict";

// OpenRig's permission-answer hook: Claude Code's PermissionRequest, in a seat (slice 15, the native permission answer).
//
// When the seat's Claude asks permission for a tool call, this hook submits the exact request to the seat's OpenRig daemon
// (the permission-request route of the harness runner contract, as a native ask) and waits, for a bounded window, for the
// answer of whoever OpenRig asks: the person chosen for the seat, the person's own conversation that handed the seat its
// work (its return route), or the default person. Meanwhile Claude Code's own dialog stays open in the seat's terminal,
// and whichever answer comes first counts (Claude Code 2.1.330, checked on a lane: the dialog is drawn and answerable while
// this hook waits).
//
// What it returns to Claude Code:
// - Allow once, or Deny with a message carrying the person's words (or the deciding agent's judgment, said as such).
// - Nothing at all in every other case: no one to ask, no answer in the window, the ask withdrawn or stale, a daemon it
//   can't reach, or any error. With no decision object Claude Code's own prompt simply carries on. It never blocks a tool
//   call on its own failure (no onFailure "block"), never remembers a rule (no updatedPermissions) and never changes the
//   request (no updatedInput).
// When it stops waiting without an answer it withdraws the ask, so a later answer reads as too late. Claude Code ends this
// hook (SIGTERM) when the prompt is answered No or cancelled in the terminal; a Yes there leaves it running, and the
// tool call's completion (the activity relay's PostToolBatch fingerprints) settles the ask instead. A Claude Code that's
// gone ends it too.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const relay = require("./activity-relay.cjs");

/** How long an answer through OpenRig is taken: a day. The dialog stays open in the terminal meanwhile, so this costs the
 *  person at the pane nothing, and this hook ends sooner whenever the prompt does (a terminal No or Esc ends it, a terminal
 *  Yes settles its ask, and a Claude Code that's gone stops it). So a person's answer to a prompt that's still open is
 *  carried, however long their reply took through their own conversation, rather than refused as too late. Keep it below
 *  this hook's timeout in hooks/claude.json; Claude Code 2.1.330 caps a hook's timeout only at 2^31-1 ms (about 24 days). */
const WINDOW_SECONDS = 86400;
/** How often the hook checks that the Claude Code that started it is still there. */
const PARENT_CHECK_MS = 2000;
const NATIVE_HOOK = "claude-code";
const OPTIONS = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
/** Tools whose prompt a plain allow doesn't answer (they need the person's own input): left to the terminal. */
const TERMINAL_ONLY_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const SUBMIT_TIMEOUT_MS = 5000;
const READ_WAIT_SECONDS = 25;
const MARK_TIMEOUT_MS = 2000;
const RETRY_MS = 2000;
/** The most of a tool's input sent to the daemon whole; a larger one is sent cut, and the ask says so. */
const MAX_INPUT_JSON = 65536;
const ACTOR = /^[A-Za-z0-9_-]{1,128}$/;

function firstString(...values) {
  for (const value of values) if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The OpenRig Claude Code seat this hook runs in, from the environment OpenRig launches it with; null elsewhere. */
function seatOf(env) {
  const sessionName = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME);
  const nodeId = firstString(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID);
  const runtime = firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME);
  const generation = firstString(env.OPENRIG_OCCUPANT_GENERATION, env.RIGGED_OCCUPANT_GENERATION);
  if (runtime !== "claude-code" || !sessionName || !nodeId || !generation) return null;
  return { sessionName, nodeId, generation };
}

/** One call to the daemon with node:http (as the activity relay posts): `{ status, data }`, or null when there's no answer
 *  in time or it can't be read. Never throws. */
function daemonCall(endpoint, method, route, body, timeoutMs) {
  return new Promise((resolve) => {
    let request = null;
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { if (request) request.destroy(); done(null); }, timeoutMs);
    try {
      const url = new URL(route, endpoint.baseUrl);
      const client = url.protocol === "http:" ? require("node:http") : url.protocol === "https:" ? require("node:https") : null;
      if (!client) return done(null);
      const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
      request = client.request(url, {
        method, agent: false,
        headers: { authorization: `Bearer ${endpoint.token}`,
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) },
      }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; if (text.length > 1_000_000) request.destroy(); });
        response.on("end", () => {
          let data = null;
          try { data = JSON.parse(text); } catch { data = null; }
          done({ status: response.statusCode ?? 0, data });
        });
        response.on("error", () => done(null));
      });
      request.on("error", () => done(null));
      request.end(payload ?? undefined);
    } catch {
      done(null);
    }
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const askPath = (askId, tail = "") => `/api/activity/permission-requests/${encodeURIComponent(askId)}${tail}`;

/** The answer a read carries, as Claude Code's decision: allow, or deny with the words for its agent; null for anything else. */
function decisionFrom(data) {
  if (!data || data.ok !== true) return null;
  if (data.state === "answered" && data.optionId === "allow") return { optionId: "allow", decision: { behavior: "allow" } };
  if ((data.state === "answered" && data.optionId === "deny") || (data.state === "refused" && data.reason === "said_no")) {
    const message = firstString(data.native && data.native.message) || "Denied through OpenRig.";
    return { optionId: "deny", decision: { behavior: "deny", message } };
  }
  return null;
}

/** Submit this prompt, wait within the window, and return `{ output, outcome }`: output is the hook's stdout object, or null
 *  for no decision (Claude Code's own prompt carries on). `state.askId` names the open ask while it waits, for the signal
 *  handler's withdrawal. */
async function answerPermission({ input, env = process.env, call, windowMs = WINDOW_SECONDS * 1000, now = Date.now, wait = sleep, state = {} }) {
  const none = (outcome) => ({ output: null, outcome });
  if (input.hook_event_name !== "PermissionRequest") return none("not a permission request");
  const seat = seatOf(env);
  if (!seat) return none("not an OpenRig Claude Code seat");
  const tool = firstString(input.tool_name);
  const sessionId = firstString(input.session_id);
  if (!tool || !sessionId) return none("no tool or conversation named");
  if (TERMINAL_ONLY_TOOLS.has(tool)) return none(`${tool} is answered in the terminal`);
  const agent = typeof input.agent_id === "string" && ACTOR.test(input.agent_id) ? input.agent_id : null;
  const toolInput = input.tool_input === undefined ? {} : input.tool_input;
  let inputJson = "{}";
  try { inputJson = JSON.stringify(toolInput) ?? "{}"; } catch { inputJson = "{}"; }
  const callFingerprint = relay.claudeToolCallFingerprint(sessionId, agent, tool, toolInput);
  const invocation = crypto.randomUUID();
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));
  const submitted = await call("POST", "/api/activity/permission-requests", {
    sessionName: seat.sessionName, nodeId: seat.nodeId, generation: seat.generation, runtime: "claude-code",
    nativeHook: NATIVE_HOOK, nativeRef: sessionId, turnId: invocation, requestId: invocation, holdSeconds: windowSeconds,
    action: { tool, agent, ...(callFingerprint ? { callFingerprint } : {}),
      ...(inputJson.length <= MAX_INPUT_JSON ? { input: toolInput } : { inputText: inputJson.slice(0, MAX_INPUT_JSON), inputCut: true }) },
    toolCall: { title: tool, kind: tool },
    options: OPTIONS, occurredAt: new Date(now()).toISOString(),
  }, SUBMIT_TIMEOUT_MS);
  if (!submitted) return none("the daemon didn't answer the submit");
  if (submitted.status !== 200 || !submitted.data || submitted.data.ok !== true) {
    return none(`the submit was refused (${submitted.status}${submitted.data && submitted.data.code ? ` ${submitted.data.code}` : ""})`);
  }
  if (submitted.data.state === "not_asked") return none(`not asked: ${submitted.data.reason ?? "no one to ask"}`);
  if (submitted.data.state || typeof submitted.data.askId !== "string") return none(`no ask opened (${submitted.data.state ?? "no ask id"})`);
  const askId = submitted.data.askId;
  state.askId = askId;
  const take = async (found, how) => {
    state.askId = null;
    // The hook has the answer: recorded before it's returned, never as the harness having applied it.
    await call("POST", askPath(askId, "/taken"), { optionId: found.optionId }, MARK_TIMEOUT_MS);
    return { output: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: found.decision } },
      outcome: `${found.optionId} ${how} (${askId}, asked of ${submitted.data.askedOf ?? "someone"})` };
  };
  const deadline = now() + windowMs;
  while (now() < deadline) {
    const waitSeconds = Math.min(READ_WAIT_SECONDS, Math.floor((deadline - now()) / 1000));
    if (waitSeconds < 1) break;
    const read = await call("GET", askPath(askId, `?waitSeconds=${waitSeconds}`), null, (waitSeconds + 10) * 1000);
    // No answer from the daemon (it may be restarting): the prompt is open in the terminal meanwhile; read again.
    if (!read || read.status >= 500) { await wait(Math.min(RETRY_MS, Math.max(0, deadline - now()))); continue; }
    if (read.status !== 200 || !read.data || read.data.ok !== true) {
      state.askId = null;
      return none(`the read was refused (${read.status}${read.data && read.data.code ? ` ${read.data.code}` : ""})`);
    }
    const found = decisionFrom(read.data);
    if (found) return take(found, "answered");
    if (read.data.state !== "pending") { state.askId = null; return none(`ask ${read.data.state}${read.data.native && read.data.native.why ? ` (${read.data.native.why})` : ""}: ${askId}`); }
  }
  // The window ended: withdraw, so a later answer is too late. One that landed at the very end still counts.
  const withdrawn = await call("POST", askPath(askId, "/withdraw"), { reason: "answer_window_ended" }, MARK_TIMEOUT_MS);
  state.askId = null;
  const late = withdrawn && withdrawn.status === 200 ? decisionFrom(withdrawn.data) : null;
  if (late) return take(late, "answered at the window's end");
  return none(`no answer in ${windowSeconds} s: withdrawn (${askId})`);
}

/** One line per prompt, for whoever checks what the hook did (no tool input, no credentials). */
function logLine(line, env = process.env) {
  try {
    const dir = path.join(os.tmpdir(), `openrig-permission-answer-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "permission-answer.log");
    try { if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* no log yet */ }
    const seat = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME) || "-";
    fs.appendFileSync(file, `${new Date().toISOString()} ${seat} pid=${process.pid} ${line.replace(/[\r\n]+/g, " ")}\n`);
  } catch { /* best effort */ }
}

// --- seat project boundary: keep this block identical in every script that has it ---
// A Claude started from inside a seat (its shell, its Bash tool) inherits the seat's environment, so it loads this plugin
// and its hooks would act as the seat. OpenRig tells the plugin the seat's launch project in OPENRIG_SEAT_PROJECT_DIR;
// Claude's own CLAUDE_PROJECT_DIR is fixed for the life of a Claude and names the project it was started in (unlike the
// hook payload's cwd, which follows a `cd`). The seat's effects run only when the two name the same folder. Spellings of
// one folder (a symlink, a trailing slash, letter case on a case-insensitive disk) count as the same, and a missing
// variable (an older or manual launch, a runtime without CLAUDE_PROJECT_DIR) leaves the hook doing what it always did.
function runsForThisSeatsProject(env = process.env) {
  const launch = env.OPENRIG_SEAT_PROJECT_DIR;
  const project = env.CLAUDE_PROJECT_DIR;
  if (!launch || !project) return true;
  const canonical = (dir) => {
    const absolute = path.resolve(dir);
    // .native gives the case the disk has (plain realpathSync keeps the case the path was typed in), which is what Claude's
    // CLAUDE_PROJECT_DIR carries on a case-insensitive filesystem such as macOS's default.
    try { return fs.realpathSync.native(absolute); } catch { return absolute; }
  };
  return canonical(launch) === canonical(project);
}
// --- end seat project boundary ---

async function main() {
  // Before anything is read or posted: a Claude started elsewhere inside this seat is not the seat.
  if (!runsForThisSeatsProject()) { logLine("not this seat's project: nothing asked"); return; }
  const input = parseJson(await readStdin());
  const endpoint = relay.resolveEndpoint(process.env);
  if (!endpoint.baseUrl || !endpoint.token) { logLine("no OpenRig daemon endpoint or token: nothing asked"); return; }
  const call = (method, route, body, timeoutMs) => daemonCall(endpoint, method, route, body, timeoutMs);
  const state = { askId: null, ended: false };
  // Claude Code ends this hook when the prompt is answered No or cancelled in the terminal: withdraw the ask, so an answer
  // given elsewhere afterwards reads as too late, then exit with no decision.
  const onSignal = (signal) => {
    if (state.ended) return;
    state.ended = true;
    const askId = state.askId;
    if (!askId) process.exit(0);
    call("POST", askPath(askId, "/withdraw"), { reason: "answered_in_terminal" }, 1500)
      .then((result) => logLine(`${signal}: withdrawn as answered in the terminal (${askId}, ${result ? result.status : "no answer"})`))
      .finally(() => process.exit(0));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, onSignal);
  // A Claude Code that's gone without ending this hook (killed, say) leaves it waiting for a prompt no one has: stop the same
  // way, so its ask doesn't stay open for the rest of the window.
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) onSignal("its Claude Code is gone"); }, PARENT_CHECK_MS).unref();
  const result = await answerPermission({ input, call, state });
  if (state.ended) return;
  state.ended = true;
  logLine(result.outcome);
  if (result.output) process.stdout.write(JSON.stringify(result.output));
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = { answerPermission, decisionFrom, seatOf, daemonCall, WINDOW_SECONDS, OPTIONS };
