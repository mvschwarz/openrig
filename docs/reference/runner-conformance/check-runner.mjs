#!/usr/bin/env node
// OpenRig runner conformance check: point it at your runner and see which promises of the runner contract
// (docs/reference/harness-runner-contract.md) it keeps. It needs Node and tmux, and no OpenRig daemon:
//   - your runner starts in a private tmux server, with the environment a runner-preset launch gives it;
//   - the fake ACP agent beside this file stands in for your agent (your runner starts it where it would start the real one);
//   - a small local endpoint stands in for OpenRig's activity route, and records what your runner posts;
//   - input arrives the way `rig send` delivers it: one bracketed paste with raw newlines, then Enter.
//
//   node check-runner.mjs --runner '<command>' [--name <preset name>] [--resume] [--first-input] [--launch-wrapper]
//                         [--cases 1,2,4] [--wait-ms 8000] [--pass-env NAME] [--json] [--keep]
//
// `{agent}` in the command is replaced with the fake agent's path, an executable that takes any arguments your runner
// adds. For example: --runner 'my-runner --agent-command {agent}'. --resume and --first-input say your preset declares
// `resume: true` and `first_input: true`; --launch-wrapper declares `launch_wrapper: true`. Without a declaration, its case is skipped.
// The runner gets a clean environment: PATH, HOME, USER, SHELL, LANG and TMPDIR, the OpenRig variables, and any
// --pass-env names. Exit status: 0 when nothing fails, 1 when a case fails, 2 for a usage or setup problem.
//
// It checks the runner's side only. How OpenRig reads those posts (working, idle, needs input) is OpenRig's own tests'
// job, and one real run with your agent is still the useful check (section 10 of the contract). Passing this is
// evidence for the versions you ran, not certification.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const usage = "usage: node check-runner.mjs --runner '<command with {agent}>' [--name <preset>] [--resume] [--first-input] [--launch-wrapper] [--cases 1,2] [--wait-ms 8000] [--pass-env NAME] [--json] [--keep]";

function parseArgs(argv) {
  const opts = { name: "runner", cases: undefined, passEnv: [], resume: false, firstInput: false, launchWrapper: false, json: false, keep: false, waitMs: 8000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`); return argv[++i]; };
    if (flag === "--runner") opts.runner = value();
    else if (flag === "--name") opts.name = value();
    else if (flag === "--cases") opts.cases = value().split(",").map((c) => c.trim()).filter(Boolean);
    else if (flag === "--pass-env") opts.passEnv.push(value());
    else if (flag === "--wait-ms") opts.waitMs = Number(value());
    else if (flag === "--resume") opts.resume = true;
    else if (flag === "--first-input") opts.firstInput = true;
    else if (flag === "--launch-wrapper") opts.launchWrapper = true;
    else if (flag === "--json") opts.json = true;
    else if (flag === "--keep") opts.keep = true;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!opts.runner) throw new Error("--runner is required");
  if (!opts.runner.includes("{agent}")) throw new Error("--runner must contain {agent}, where your runner takes its agent command");
  if (!/^[A-Za-z0-9._-]+$/.test(opts.name)) throw new Error("--name must be a preset name (letters, digits, '.', '_' or '-')");
  if (!(opts.waitMs > 0)) throw new Error("--wait-ms must be a positive number");
  return opts;
}

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`${error.message}\n${usage}`); process.exit(2); }
if (spawnSync("tmux", ["-V"]).status !== 0) { console.error("tmux is required: the check drives your runner in a tmux pane, as OpenRig does."); process.exit(2); }

const socket = `openrig-runner-check-${process.pid}`;
const tmux = (...args) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
const sh = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Settling times and per-step bounds grow with --wait-ms on a slow machine; they never shrink below these values. The
// fake agent's own delays and holds grow by the same factor, so each settle keeps its place against what it measures.
const scale = (ms) => Math.round(ms * Math.max(1, opts.waitMs / 8000));
async function waitFor(read, ms = opts.waitMs) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(50);
  }
}

// The stand-in for OpenRig's activity route and, for a launch that scripts one, its answered permission routes (section 7).
// Each launch has its own token; a request without one is refused, as OpenRig does.
const posts = [];
const tokens = new Map();
const OPTION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const ANSWERABLE = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
// A JSON-RPC id or prompt number as the runner passed it: a number reads as its decimal string, so 7 and "7" match.
const idText = (value) => typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    const url = new URL(req.url, "http://stand-in");
    posts.push({ at: Date.now(), method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), token, body, raw });
    const send = (status, payload) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    const h = tokens.get(token);
    if (req.method === "POST" && url.pathname === "/api/activity/hooks") {
      if (!h) return send(401, { ok: false });
      return body ? send(200, { ok: true }) : send(400, { ok: false, code: "invalid_json" });
    }
    const ask = url.pathname.match(/^\/api\/activity\/permission-requests(?:\/([^/]+)(\/withdraw)?)?$/);
    if (!ask) return send(404, { ok: false, code: "not_found" });
    if (!h) return send(401, { ok: false });
    // Without a scripted ask, the stand-in is an OpenRig that predates the answered path: 404, so the runner permits.
    if (!h.asks) return send(404, { ok: false, code: "not_found" });
    // A scripted `drop` closes the connection unanswered: an OpenRig the runner can't reach.
    const drop = req.method === "POST" && !ask[1] ? h.asks.script.submit?.drop : req.method === "GET" && h.asks.script.read?.drop;
    if (drop) return void res.socket.destroy();
    if (req.method === "POST" && !ask[1]) return submitAsk(h, body, raw, send);
    const entry = h.asks.byId.get(decodeURIComponent(ask[1] ?? ""));
    if (!entry) return send(404, { ok: false, code: "not_found" });
    if (req.method === "GET" && h.asks.script.read) return send(h.asks.script.read.status, { ok: false, code: h.asks.script.read.code });
    if (req.method === "POST" && ask[2]) {
      if (!["turn_cancelled", "turn_ended", "exited"].includes(body?.reason)) return send(400, { ok: false, code: "invalid_permission_request" });
      entry.withdrawn = body.reason;
      entry.wake();
      return send(200, { ok: true, ...askState(h, entry) });
    }
    if (req.method === "GET" && !ask[2]) {
      const waitMs = Math.min(Number(url.searchParams.get("waitSeconds") ?? 0), 25) * 1000;
      const reply = () => send(200, { ok: true, ...askState(h, entry) });
      if (askState(h, entry).state !== "pending" || !(waitMs > 0)) return reply();
      const timer = setTimeout(() => { entry.waiters.delete(reply); reply(); }, waitMs);
      entry.waiters.add(() => { clearTimeout(timer); reply(); });
      return undefined;
    }
    return send(404, { ok: false, code: "not_found" });
  });
});

// What the scripted ask reads as now: an answer once its time has come, `withdrawn` after a withdraw, otherwise pending. A
// `late` answer is what the stand-in reports after a withdraw, so a runner that keeps reading and delivers it is caught.
function askState(h, entry) {
  const script = h.asks.script;
  if (entry.withdrawn) return script.late ?? { state: "withdrawn" };
  if (script.answer && Date.now() >= entry.created + (script.answer.afterMs ?? 0)) {
    const { state, optionId, reason, said } = script.answer;
    return { state, ...(optionId ? { optionId } : {}), ...(reason ? { reason } : {}), ...(said ? { said } : {}) };
  }
  return { state: "pending" };
}

// Submit, checked as OpenRig checks it: the seat and generation, nativeRef as a string, turnId and requestId as a string
// or a number. When no one can be asked, OpenRig permits with the agent's allow_once, else allow_always: here when the
// script says so, or for options a person can't be shown (2-4 with distinct ids). With no allow option it refuses.
function submitAsk(h, body, raw, send) {
  const script = h.asks.script;
  const problems = [];
  if (!body) return send(400, { ok: false, code: "invalid_json" });
  if (body.sessionName !== h.session) return send(404, { ok: false, code: "session_not_found" });
  if (!text(body.nativeRef)) problems.push(`nativeRef must be a non-empty string (got ${JSON.stringify(body.nativeRef)})`);
  for (const key of ["turnId", "requestId"]) if (!idText(body[key])) problems.push(`${key} must be a non-empty string or a number (got ${JSON.stringify(body[key])})`);
  const options = Array.isArray(body.options) ? body.options : null;
  if (!options) problems.push("options must be an array");
  else if (options.some((o) => !text(o?.optionId) || !text(o?.name) || !text(o?.kind))) problems.push("each option needs optionId, name and kind");
  h.asks.submitted.push({ body, problems });
  if (problems.length) return send(400, { ok: false, code: "invalid_permission_request", error: problems.join("; ") });
  if (body.generation !== h.generation) return send(409, { ok: false, code: "stale_generation" });
  if (script.submit?.status) return send(script.submit.status, { ok: false, code: script.submit.code });
  const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
  const permit = (reason) => allow ? send(200, { ok: true, state: "permitted", optionId: allow.optionId, reason })
    : send(422, { ok: false, code: "options_unsupported" });
  if (script.submit?.permitted) return permit("no one can be asked");
  if (options.length < 2 || options.length > 4 || new Set(options.map((o) => o.optionId)).size !== options.length
    || options.some((o) => !OPTION_ID.test(o.optionId) || !ANSWERABLE.has(o.kind))) return permit("these options can't be shown to a person");
  const requestId = idText(body.requestId), turnId = idText(body.turnId);
  const key = JSON.stringify([body.generation, text(body.nativeRef), requestId]);
  const earlier = h.asks.byKey.get(key);
  if (earlier) return send(200, { ok: true, askId: earlier.askId, created: false });
  if ([...h.asks.byKey.values()].some((e) => e.requestId === requestId && e.turnId !== turnId)) return send(409, { ok: false, code: "duplicate_request" });
  const entry = { askId: `ask-${h.label}-${h.asks.byKey.size + 1}`, requestId, turnId, created: Date.now(), waiters: new Set() };
  entry.wake = () => { for (const w of [...entry.waiters]) w(); entry.waiters.clear(); };
  if (script.answer) setTimeout(entry.wake, script.answer.afterMs ?? 0);
  h.asks.byKey.set(key, entry);
  h.asks.byId.set(entry.askId, entry);
  return send(200, { ok: true, askId: entry.askId, created: true });
}
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const launches = [];
async function launch(label, { scenario = {}, env = {}, asks, launchWrapper = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `runner-check-${label}-`));
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  mkdirSync(join(dir, "home"));
  mkdirSync(join(dir, "launch"));
  const id = randomBytes(4).toString("hex");
  const h = {
    label, dir, cwd, token: randomBytes(16).toString("hex"), session: `check-${label}@runner-check`, nodeId: `node-${label}-${id}`,
    generation: `gen-${id}`, attempt: `attempt-${id}`, recordPath: join(dir, "launch", "record.json"), agentLog: join(dir, "agent.jsonl"),
    target: `check-${label}`,
  };
  if (asks) h.asks = { script: asks, byKey: new Map(), byId: new Map(), submitted: [] };
  tokens.set(h.token, h);
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  const agent = join(dir, "agent");
  writeFileSync(agent, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(join(here, "fake-acp-agent.mjs"))} --scenario ${sh(join(dir, "scenario.json"))} --log ${sh(h.agentLog)} "$@"\n`);
  chmodSync(agent, 0o755);
  h.agent = agent;
  if (launchWrapper) {
    h.wrapperLog = join(dir, "wrapper.json");
    const wrapper = join(dir, "wrapper.sh");
    writeFileSync(wrapper, `#!/bin/sh\nrecord=$1\ntag=$2\nseparator=$3\nshift 3\n${sh(process.execPath)} -e 'const [file, tag, separator, ...argv] = process.argv.slice(1); require("node:fs").writeFileSync(file, JSON.stringify({tag, separator, argv, launchWrapper: process.env.OPENRIG_LAUNCH_WRAPPER ?? null}));' "$record" "$tag" "$separator" "$@"\nexec "$@"\n`);
    env = { ...env, OPENRIG_LAUNCH_WRAPPER: JSON.stringify(["/bin/sh", wrapper, h.wrapperLog, "literal ' $ ; space", "--"]) };
  }
  const vars = {
    PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, SHELL: process.env.SHELL, LANG: process.env.LANG,
    TMPDIR: process.env.TMPDIR, TERM: "xterm-256color",
    ...Object.fromEntries(opts.passEnv.map((name) => [name, process.env[name]])),
    OPENRIG_HOME: join(dir, "home"), OPENRIG_URL: base, OPENRIG_ACTIVITY_HOOK_TOKEN: h.token, OPENRIG_SESSION_NAME: h.session,
    OPENRIG_NODE_ID: h.nodeId, OPENRIG_RUNTIME: opts.name, OPENRIG_OCCUPANT_GENERATION: h.generation,
    OPENRIG_LAUNCH_RESULT: h.recordPath, OPENRIG_LAUNCH_ATTEMPT: h.attempt, ...env,
  };
  const assignments = Object.entries(vars).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${sh(value)}`).join(" ");
  const command = opts.runner.replaceAll("{agent}", sh(agent));
  writeFileSync(join(dir, "launch.sh"), `#!/bin/sh\ncd ${sh(cwd)} || exit 1\nexec /usr/bin/env -i ${assignments} /bin/sh -c ${sh(command)}\n`);
  chmodSync(join(dir, "launch.sh"), 0o755);
  const started = tmux("new-session", "-d", "-s", h.target, "-x", "200", "-y", "50", join(dir, "launch.sh"));
  if (started.status !== 0) throw new Error(`tmux couldn't start the runner: ${started.stderr.trim()}`);
  Object.assign(h, {
    log: () => !existsSync(h.agentLog) ? [] : readFileSync(h.agentLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    received: (method) => h.log().filter((e) => e.dir === "in" && e.msg.method === method),
    sent: (method) => h.log().filter((e) => e.dir === "out" && e.msg.method === method),
    answerTo: (method) => { const ask = h.sent(method)[0]; return ask && h.log().find((e) => e.dir === "in" && e.msg.id === ask.msg.id && !e.msg.method); },
    replyTo: (entry) => h.log().find((e) => e.dir === "out" && e.msg.id === entry.msg.id && !e.msg.method),
    events: (event) => h.log().filter((e) => e.dir === "event" && e.event === event),
    prompts: () => h.received("session/prompt").map((e) => (e.msg.params?.prompt ?? []).filter((b) => b.type === "text").map((b) => b.text).join("")),
    posts: () => posts.filter((p) => p.path === "/api/activity/hooks" && (p.token === h.token || p.body?.sessionName === h.session)),
    permissionCalls: (method, suffix = "") => posts.filter((p) => p.token === h.token && p.method === method
      && p.path.startsWith("/api/activity/permission-requests") && p.path.endsWith(suffix)),
    hooks: (event, subtype) => h.posts().filter((p) => p.body?.hookEvent === event && (subtype === undefined || p.body?.subtype === subtype)),
    record: () => { if (!existsSync(h.recordPath)) return undefined; try { return JSON.parse(readFileSync(h.recordPath, "utf8")); } catch { return { unreadable: true }; } },
    paste: (text) => {
      const file = join(dir, `paste-${randomBytes(3).toString("hex")}`);
      writeFileSync(file, text);
      const buffer = `b-${randomBytes(3).toString("hex")}`;
      tmux("load-buffer", "-b", buffer, file);
      tmux("paste-buffer", "-t", h.target, "-b", buffer, "-d", "-r", "-p");
      tmux("send-keys", "-t", h.target, "Enter");
    },
    keys: (...keys) => tmux("send-keys", "-t", h.target, ...keys),
    stop: () => tmux("kill-session", "-t", h.target),
    screen: () => tmux("capture-pane", "-p", "-t", h.target).stdout ?? "",
  });
  launches.push(h);
  return h;
}

// An ordinary send arrives inside an envelope, so a line in it that reads /abort is still just text.
const message = (h, body) => `From: checker@runner-check\nTo: ${h.session}\n---\n${body}`;
const nonExitStops = (h, after = 0) => h.hooks("Stop").filter((p) => p.at >= after && !String(p.body?.subtype ?? "").endsWith("_exited"));
// Whether post `a` comes before post `b` in the runner's own order, as OpenRig orders them: by `occurredAt` when it's a
// non-blank string that reads as a time, otherwise by its arrival; then by `sequence`, when both carry a positive whole number.
const postedAt = (p) => {
  const value = p?.body?.occurredAt;
  const t = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : p?.at ?? 0;
};
const sequenceOf = (p) => { const value = p?.body?.sequence; return Number.isSafeInteger(value) && value > 0 ? value : null; };
const precedes = (a, b) => postedAt(a) !== postedAt(b) ? postedAt(a) < postedAt(b)
  : sequenceOf(a) !== null && sequenceOf(b) !== null && sequenceOf(a) < sequenceOf(b);
// Non-exit Stops the runner posted after `post` in that order. An idle report from before the turn began (a runner may report
// idle at startup) is never one made during it, however late its POST arrives.
const stopsAfter = (h, post) => nonExitStops(h).filter((p) => !post || !precedes(p, post));
const ready = (h, ms) => waitFor(() => h.record()?.nativeRef && h.record(), ms);

function result(id, title, { proposed = false } = {}) {
  const r = { id, title, status: "pass", checks: [], ...(proposed ? { proposed: true } : {}) };
  r.check = (name, ok, detail) => { r.checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) }); if (!ok) r.status = "fail"; return ok; };
  r.skip = (reason) => { r.status = "skip"; r.reason = reason; return r; };
  return r;
}

const cases = {
  async "1"() {
    const r = result("1", "Handshake: the launch record comes only after the conversation is open");
    const h = await launch("1", { scenario: { newDelayMs: scale(2000), sessionId: "fake-session-1" } });
    const asked = await waitFor(() => h.received("session/new")[0]);
    if (!r.check("the runner opens a conversation with session/new", asked, "no session/new arrived")) return r;
    // Until the agent's answer is logged, there must be no record. The agent logs each message before it sends it, so a
    // record read before a log that still holds no answer was written before the answer went out. Reading against the
    // agent's log, not after a fixed settle, keeps a busy machine from reading a correct runner's record as early.
    let early;
    await waitFor(() => {
      const record = h.record();
      if (h.replyTo(asked)) return true;
      if (record) early = record;
      return early;
    }, scale(2000) + opts.waitMs);
    r.check("no launch record while session/new is still unanswered", !early, `a record was written early: ${JSON.stringify(early)}`);
    const record = await ready(h);
    r.check("a launch record arrives after session/new is answered", record, `no record with a nativeRef at ${h.recordPath}`);
    if (!record) return r;
    const answered = h.replyTo(asked);
    r.check("the record is written after the answer", answered && statSync(h.recordPath).mtimeMs >= answered.at - 5, "the record's time precedes the answer");
    r.check("format 1, this attempt, this preset", record.format === 1 && record.attempt === h.attempt && record.harness === opts.name,
      `format=${record.format} attempt=${record.attempt} harness=${record.harness}`);
    r.check("nativeRef is the agent's conversation id", record.nativeRef === "fake-session-1", `nativeRef=${record.nativeRef}`);
    r.check("producer names the runner's versions", typeof record.producer === "string" && record.producer.trim(), "no producer");
    return r;
  },

  async "1b"() {
    const r = result("1b", "A failed handshake writes no launch record and claims no turn");
    for (const [label, scenario] of [["initialize error", { initialize: "error" }], ["initialize exit", { initialize: "exit" }],
      ["session/new error", { newSession: "error" }], ["session/new exit", { newSession: "exit" }]]) {
      const h = await launch(`1b-${label.replace(/[^a-z]+/g, "-")}`, { scenario });
      await waitFor(() => h.events("exit")[0] || h.log().some((e) => e.dir === "out" && e.msg.error), opts.waitMs);
      await sleep(scale(1500));
      const record = h.record();
      r.check(`${label}: no conversation in a launch record`, !record?.nativeRef, `record: ${JSON.stringify(record)}`);
      r.check(`${label}: no accepted prompt or idle report`, h.hooks("UserPromptSubmit").length === 0 && nonExitStops(h).length === 0,
        `posts: ${h.posts().map((p) => `${p.body?.hookEvent}/${p.body?.subtype}`).join(", ")}`);
    }
    return r;
  },

  async "2"() {
    const r = result("2", "Input framing, queued messages and cancel");
    const h = await launch("2", { scenario: { turns: [{}, { holdMs: scale(15000) }, { holdMs: scale(15000), ignoreCancel: true, endAfterCancelMs: scale(300) }, {}] } });
    if (!r.check("the runner opens its conversation", await ready(h), "no launch record")) return r;
    const block = message(h, "first line\n/abort\nthird line");
    h.paste(block);
    await waitFor(() => h.prompts().length >= 1);
    await waitFor(() => nonExitStops(h).length >= 1, scale(3000));
    await sleep(scale(500));
    r.check("one pasted block is exactly one session/prompt", h.prompts().length === 1, `got ${h.prompts().length} prompts`);
    r.check("the prompt holds the whole block, byte for byte", h.prompts()[0] === block, `got ${JSON.stringify(h.prompts()[0])}`);

    h.paste(message(h, "please hold"));
    if (!r.check("the next block starts the next turn", await waitFor(() => h.prompts().length >= 2), "no second prompt")) return r;
    // A block that arrives while the agent works, with a line reading /abort, is still one message for later.
    const queued = message(h, "sent while the agent works\n/abort\nstill part of the message");
    h.paste(queued);
    await sleep(scale(1200));
    r.check("a block sent mid-turn waits for the next turn", h.prompts().length === 2, `got ${h.prompts().length} prompts during the turn`);
    r.check("a line reading /abort inside a block isn't control", h.received("session/cancel").length === 0, "the runner sent session/cancel");

    const before = Date.now();
    h.paste("/abort");
    const cancel = await waitFor(() => h.received("session/cancel")[0], scale(3000));
    r.check("a block that is exactly /abort sends session/cancel", cancel, "no session/cancel");
    const stopped = await waitFor(() => nonExitStops(h, before)[0], scale(3000));
    r.check("the cancelled turn reports Stop/cancelled", stopped?.body?.subtype === "cancelled", `got ${stopped ? `Stop/${stopped.body.subtype}` : "no Stop"}`);
    await sleep(scale(300));
    r.check("one /abort sends one session/cancel", h.received("session/cancel").length === 1, `got ${h.received("session/cancel").length}`);
    r.check("the waiting block becomes the next prompt", await waitFor(() => h.prompts()[2] === queued, scale(4000)), `prompts: ${JSON.stringify(h.prompts().slice(2))}`);

    // The agent keeps this turn open until the cancel arrives and then ends it end_turn, so a runner that handles Ctrl-C
    // late on a busy machine still has a turn to cancel. Only its delivery is timed, by the per-step bound.
    const interrupted = Date.now();
    await sleep(scale(200));
    h.keys("C-c");
    r.check("Ctrl-C outside a paste sends session/cancel", await waitFor(() => h.received("session/cancel").length >= 2), "no second session/cancel");
    const ended = await waitFor(() => nonExitStops(h, interrupted)[0], scale(6000));
    r.check("cancelled is reported only on the agent's own stop reason", ended?.body?.subtype === "end_turn",
      `the agent ended the turn end_turn; the runner reported ${ended ? `Stop/${ended.body.subtype}` : "no Stop"}`);
    return r;
  },

  async "3"() {
    const r = result("3", "Activity: turn boundaries, posted in order with the seat's identity");
    const h = await launch("3");
    if (!r.check("the runner opens its conversation", await ready(h), "no launch record")) return r;
    h.paste(message(h, "a short turn"));
    const accepted = await waitFor(() => h.hooks("UserPromptSubmit", "accepted")[0]);
    r.check("UserPromptSubmit/accepted when the prompt is given", accepted, `posts: ${h.posts().map((p) => p.body?.hookEvent).join(", ")}`);
    r.check("the accepted post names a turnId", accepted && accepted.body.turnId !== undefined && accepted.body.turnId !== "", "no turnId");
    const end = await waitFor(() => h.hooks("Stop", "end_turn")[0]);
    r.check("Stop/end_turn when the turn ends", end, "no Stop/end_turn");
    r.check("accepted comes before the turn's end", accepted && end && accepted.at <= end.at, "out of order");
    const all = h.posts();
    const missing = all.flatMap((p) => ["sessionName", "nodeId", "runtime", "generation", "sequence", "occurredAt", "hookEvent", "subtype"]
      .filter((k) => p.body?.[k] === undefined).map((k) => `${p.body?.hookEvent ?? "?"} lacks ${k}`));
    r.check("every post carries the contract's fields", missing.length === 0, missing.join("; "));
    r.check("every post uses the hook token", all.every((p) => p.token === h.token), "a post without the bearer token");
    r.check("every post names this seat and preset",
      all.every((p) => p.body?.sessionName === h.session && p.body?.nodeId === h.nodeId && p.body?.runtime === opts.name),
      all.map((p) => `${p.body?.sessionName}/${p.body?.nodeId}/${p.body?.runtime}`).join(", "));
    const seqs = all.map((p) => Number(p.body?.sequence));
    r.check("sequence rises with each post", seqs.every((s, i) => Number.isFinite(s) && (i === 0 || s > seqs[i - 1])), `sequences: ${seqs.join(", ")}`);
    const beats = all.filter((p) => p.body?.livenessSeconds !== undefined);
    r.check("livenessSeconds, when given, is a whole number from 1 to 3600",
      beats.every((p) => Number.isInteger(p.body.livenessSeconds) && p.body.livenessSeconds >= 1 && p.body.livenessSeconds <= 3600),
      beats.map((p) => p.body.livenessSeconds).join(", "));
    return r;
  },

  // The optional working beat (section 4). When a runner posts active/liveness in a quiet turn, each beat names the open
  // turn it belongs to, keeps the post order, comes often enough for its own lifetime, stops at the turn's end, and never
  // runs while a person is asked; after an answer, active/permission_resolved comes before the next beat. Order is read
  // from the runner's own sequence and times, so a slow delivery never reads as a broken runner.
  async "3b"() {
    const r = result("3b", "Working beat (optional): beats name their open turn, keep order, and stop at its end and while a person is asked");
    const quiet = scale(22000);
    const seqOf = (p) => Number(p?.body?.sequence);
    const at = (p) => Date.parse(p.body.occurredAt);
    const h = await launch("3b", { scenario: { turns: [{ silent: true, holdMs: quiet }, {}] } });
    if (!r.check("the runner opens its conversation", await ready(h), "no launch record")) return r;
    h.paste(message(h, "a long, quiet turn"));
    const accepted = await waitFor(() => h.hooks("UserPromptSubmit", "accepted")[0]);
    const end = await waitFor(() => h.hooks("Stop", "end_turn")[0], quiet + opts.waitMs);
    await sleep(scale(11000)); // room for a beat a runner wrongly sends after the Stop
    const beats = h.hooks("active", "liveness");
    if (!beats.length) return r.skip("the runner sends no working beat in a quiet turn; the beat is optional (section 4)");
    r.check("each beat names the turn it belongs to", accepted && beats.every((b) => b.body.turnId === accepted.body.turnId),
      `turnIds: ${beats.map((b) => b.body.turnId).join(", ")}`);
    // In the runner's own time order, not delivery's: a post delivered late still has to fit where the runner sent it.
    const byTime = (a, b) => at(a) - at(b) || seqOf(a) - seqOf(b);
    const timed = h.posts().slice().sort(byTime);
    r.check("sequence rises with the runner's own time across every post, beats included",
      timed.every((p, i) => Number.isFinite(seqOf(p)) && Number.isFinite(at(p)) && (i === 0 || seqOf(p) > seqOf(timed[i - 1]))),
      `sequences in occurredAt order: ${timed.map(seqOf).join(", ")}`);
    const life = (b) => (Number.isFinite(b.body.livenessSeconds) ? b.body.livenessSeconds : 30);
    const inTurn = beats.filter((b) => !end || seqOf(b) < seqOf(end)).sort(byTime);
    const gaps = inTurn.map((b, i) => at(b) - at(i === 0 ? accepted : inTurn[i - 1]));
    r.check("beats come more often than every livenessSeconds / 2", inTurn.every((b, i) => gaps[i] <= life(b) * 500 + 1000),
      `gaps by the runner's own times: ${gaps.join(", ")} ms`);
    r.check("no beat after the turn's Stop", end && beats.every((b) => seqOf(b) < seqOf(end)),
      `beats after Stop/end_turn: ${beats.filter((b) => end && seqOf(b) > seqOf(end)).length}`);

    // A person is asked first, and answers after a while; the agent then carries on, quietly, in the same turn.
    const p = await launch("3b-asked", { scenario: { turns: [{ permission: true, silent: true, holdMs: quiet }, {}] },
      asks: { answer: { afterMs: scale(12000), state: "answered", optionId: "allow-once" } } });
    if (!r.check("asked: the runner opens its conversation", await ready(p), "no launch record")) return r;
    p.paste(message(p, "edit the notes"));
    const submitted = await waitFor(() => p.permissionCalls("POST").find((c) => c.path === "/api/activity/permission-requests"), scale(5000));
    if (!r.check("asked: the request is submitted", submitted, "no submit")) return r;
    await waitFor(() => p.hooks("Stop", "end_turn")[0], scale(12000) + quiet + opts.waitMs);
    const resolvedPost = p.hooks("active", "permission_resolved")[0];
    const before = p.hooks("active", "liveness").filter((b) => at(b) > submitted.at && (!resolvedPost || seqOf(b) < seqOf(resolvedPost)));
    r.check("asked: no beat while the ask waits on a person", before.length === 0, `${before.length} beats while it waited`);
    r.check("asked: after the answer, active/permission_resolved names the turn and the ask, before any beat",
      resolvedPost && resolvedPost.body.askId && resolvedPost.body.turnId === p.hooks("UserPromptSubmit", "accepted")[0]?.body.turnId,
      resolvedPost ? `permission_resolved: ${JSON.stringify({ turnId: resolvedPost.body.turnId, askId: resolvedPost.body.askId })}` : "no permission_resolved");

    // OpenRig permits at submit when no one can be asked: no ask opens, so nothing waits and the beats go on.
    const q = await launch("3b-permitted", { scenario: { turns: [{ permission: true, silent: true, holdMs: quiet }, {}] },
      asks: { submit: { permitted: true } } });
    if (!r.check("permitted at submit: the runner opens its conversation", await ready(q), "no launch record")) return r;
    q.paste(message(q, "edit the notes"));
    const qEnd = await waitFor(() => q.hooks("Stop", "end_turn")[0], quiet + opts.waitMs);
    const qBeats = q.hooks("active", "liveness").filter((b) => !qEnd || seqOf(b) < seqOf(qEnd));
    r.check("permitted at submit: the quiet turn's beats go on, with no ask to resolve", qBeats.length > 0, "no beat in the quiet turn after the permit");
    return r;
  },

  // Section 7's default is permit: when no one can be asked, the agent gets its own allow option at once, allow_once before
  // allow_always. Only the seat's opt-in refusal (denied_by_seat), or a request with no allow option, is refused at once,
  // shown, and held as needs input until the next prompt, even when the turn is cancelled.
  async "4"() {
    const r = result("4", "Permissions: permitted when no one can be asked; refused and held only on denied_by_seat or no allow option");
    const option = (optionId, kind) => ({ optionId, name: optionId, kind });
    const withAlways = [option("allow-once", "allow_once"), option("allow-always", "allow_always"), option("reject-once", "reject_once")];
    const rejectOnly = [option("reject-once", "reject_once"), option("reject-always", "reject_always")];
    const cells = [
      // label, the stand-in's answered path (none: an OpenRig without it, which answers 404), the options, permitted, and
      // whether /abort cancels the turn after the refusal
      ["404", undefined, withAlways, true],
      ["unreachable", { submit: { drop: true } }, withAlways, true],
      ["denied_by_seat", { submit: { status: 409, code: "denied_by_seat" } }, withAlways, false],
      ["denied_by_seat, then /abort", { submit: { status: 409, code: "denied_by_seat" } }, withAlways, false, true],
      ["no allow option", undefined, rejectOnly, false],
    ];
    await Promise.all(cells.map(async ([label, asks, options, permitted, abort]) => {
      const turns = [{ permission: { options }, holdMs: scale(abort ? 4000 : 1500) }, {}];
      const h = await launch(`4-${label.replace(/[^a-z0-9]+/g, "-")}`, { scenario: { turns }, asks });
      if (!r.check(`${label}: the runner opens its conversation`, await ready(h), "no launch record")) return;
      h.paste(message(h, "edit the notes"));
      const asked = await waitFor(() => h.sent("session/request_permission")[0]);
      if (!r.check(`${label}: the agent's permission request is sent`, asked, "the turn never reached the request")) return;
      // A runner may take a moment to find OpenRig unreachable; everything else is answered at once.
      const answer = await waitFor(() => h.answerTo("session/request_permission"), scale(label === "unreachable" ? 10000 : 3000));
      if (!r.check(`${label}: the request is answered, not left pending`, answer, "no answer")) return;
      if (label !== "unreachable") r.check(`${label}: it's answered at once (within 2 s)`, answer.at - asked.at <= 2000, `${answer.at - asked.at} ms`);
      const got = answer.msg.result?.outcome;
      if (permitted) {
        r.check(`${label}: the agent gets its allow_once option`, got?.outcome === "selected" && got.optionId === "allow-once",
          `answer: ${JSON.stringify(answer.msg.result ?? answer.msg.error)}`);
        r.check(`${label}: the turn's end is reported as usual`, await waitFor(() => h.hooks("Stop", "end_turn")[0], scale(4000)),
          "no Stop/end_turn after the permit");
        r.check(`${label}: nothing is held as needs input`, h.hooks("Notification", "permission_prompt").length === 0, "the runner posted permission_prompt");
        return;
      }
      r.check(`${label}: the answer is a refusal, never an allow option`, got?.outcome === "cancelled",
        `answer: ${JSON.stringify(answer.msg.result ?? answer.msg.error)}`);
      const shown = await waitFor(() => h.hooks("Notification", "permission_prompt")[0], scale(3000));
      r.check(`${label}: Notification/permission_prompt is posted`, shown, "no permission_prompt post");
      if (label === "denied_by_seat") r.check(`${label}: what was asked is shown in the pane`, await waitFor(() => h.screen().includes("Edit notes.txt"), scale(3000)),
        "the pane never showed the tool call's title, Edit notes.txt");
      // A cancelled turn is still a turn's end: the refusal stays held until the next accepted prompt.
      if (abort) {
        h.paste("/abort");
        r.check(`${label}: /abort sends session/cancel`, await waitFor(() => h.received("session/cancel")[0], scale(3000)), "no session/cancel");
      }
      await waitFor(() => h.log().some((e) => e.dir === "out" && e.msg.result?.stopReason), scale(abort ? 6000 : 4000));
      await sleep(scale(800));
      r.check(`${label}: no idle Stop or beat while holding that attention`, shown && nonExitStops(h, shown.at).length === 0,
        `posted ${nonExitStops(h, shown?.at ?? 0).map((p) => `Stop/${p.body.subtype}`).join(", ")}`);
      const next = Date.now();
      h.paste(message(h, "carry on"));
      r.check(`${label}: the next prompt is accepted as usual, which clears it`,
        await waitFor(() => h.hooks("UserPromptSubmit", "accepted").some((p) => p.at >= next)), "no accepted post for the next prompt");
    }));
    return r;
  },

  // Section 7's answered path: the runner submits the live request, delivers the option that comes back (the person's
  // answer, or OpenRig's permit) once while that request is live, and withdraws it when the turn or the agent ends.
  async "4b"() {
    const r = result("4b", "Answered permissions: the person's answer or OpenRig's permit reaches the live request, and nothing else does");
    const options = ["allow-once", "reject-once"];
    const submits = (h) => h.permissionCalls("POST").filter((p) => p.path === "/api/activity/permission-requests");
    const withdraws = (h) => h.permissionCalls("POST", "/withdraw");
    const answers = (h) => { const asked = h.sent("session/request_permission")[0];
      return asked ? h.log().filter((e) => e.dir === "in" && e.msg.id === asked.msg.id && !e.msg.method) : []; };
    const outcome = (h) => answers(h)[0]?.msg.result?.outcome;
    const open = async (label, asks, turns = [{ permission: true }, {}]) => {
      const h = await launch(`4b-${label}`, { scenario: { turns }, asks });
      if (!await ready(h)) { r.check(`${label}: the runner opens its conversation`, false, "no launch record"); return undefined; }
      h.paste(message(h, "edit the notes"));
      await waitFor(() => h.sent("session/request_permission")[0]);
      return h;
    };

    // An answer from the chosen person: the offered option, once, and the turn then reports as usual.
    for (const [label, optionId] of [["allow", "allow-once"], ["deny", "reject-once"]]) {
      const h = await open(label, { answer: { afterMs: 400, state: "answered", optionId } });
      if (!h) continue;
      const submitted = await waitFor(() => submits(h)[0], scale(3000));
      if (!r.check(`${label}: the request is submitted to /api/activity/permission-requests`, submitted, "no submit")) continue;
      const asked = h.sent("session/request_permission")[0];
      // The submit isn't one of the runner's ordered activity posts, so it can arrive before the accepted prompt does.
      const accepted = await waitFor(() => h.hooks("UserPromptSubmit", "accepted")[0], scale(3000));
      const sent = submitted.body ?? {};
      if (label === "allow") {
        r.check("the submit passes OpenRig's checks", h.asks.submitted[0]?.problems.length === 0, h.asks.submitted[0]?.problems.join("; "));
        r.check("it uses the hook token", submitted.token === h.token, "no bearer token");
        r.check("requestId is the agent's JSON-RPC id", idText(sent.requestId) === String(asked?.msg.id), `requestId=${JSON.stringify(sent.requestId)}`);
        r.check("turnId is the accepted prompt's", accepted && idText(sent.turnId) === String(accepted.body.turnId), `turnId=${JSON.stringify(sent.turnId)}`);
        r.check("nativeRef and generation name this conversation and occupant", sent.nativeRef === h.record()?.nativeRef && sent.generation === h.generation,
          `nativeRef=${sent.nativeRef} generation=${sent.generation}`);
        r.check("the agent's options are passed on as offered", JSON.stringify((sent.options ?? []).map((o) => o.optionId)) === JSON.stringify(options),
          JSON.stringify(sent.options));
      }
      const delivered = await waitFor(() => outcome(h), scale(4000));
      r.check(`${label}: the agent gets the chosen option`, delivered?.outcome === "selected" && delivered.optionId === optionId, `got ${JSON.stringify(delivered)}`);
      await waitFor(() => h.hooks("Stop", "end_turn")[0], scale(3000));
      await sleep(scale(300));
      r.check(`${label}: it's delivered once`, answers(h).length === 1, `${answers(h).length} answers`);
      if (label === "allow") {
        r.check("OpenRig records the prompt; the runner doesn't post permission_prompt itself", h.hooks("Notification", "permission_prompt").length === 0,
          "the runner posted permission_prompt for a created ask");
        const reads = h.permissionCalls("GET");
        // Section 7 bounds the wait at 25 s and no lower; OpenRig's read takes 0 to 25 or none.
        r.check("each read waits at most 25 s", reads.length > 0 && reads.every((p) => p.query.waitSeconds === undefined || Number(p.query.waitSeconds) <= 25),
          reads.map((p) => p.query.waitSeconds ?? "(none)").join(", "));
        r.check("after the answer, the turn's end is reported as usual", h.hooks("Stop", "end_turn").length > 0, "no Stop/end_turn after delivery");
      }
    }

    // OpenRig's permit, at submit or at a read, is delivered like an answer. So is the runner's own permit when OpenRig
    // can't give an answer: a refusal section 7's table marks "permits" (two of them 409s, like stale_generation, so the
    // code decides, never the status; a revoked grant can still be the live occupant's, since one is reissued after a lost
    // response), a read that gets no answer, or a status, code or read state the section doesn't list. A refusal saying
    // the request isn't the current occupant's, and a refused, stale or withdrawn read, can't take an answer: the agent
    // gets cancelled, and nothing is held.
    const outcomes = [
      ["permitted at submit", { submit: { permitted: true } }, "allow-once"],
      ["permitted at read", { answer: { afterMs: 300, state: "permitted", optionId: "allow-once" } }, "allow-once"],
      // A person's own words come back beside the outcome, and never change the option delivered.
      ["permitted at read, with the person's words", { answer: { afterMs: 300, state: "permitted", optionId: "allow-once", said: "only the notes file" } }, "allow-once"],
      ["duplicate_request", { submit: { status: 409, code: "duplicate_request" } }, "allow-once"],
      ["activity_grant_pending", { submit: { status: 409, code: "activity_grant_pending" } }, "allow-once"],
      ["activity_grant_revoked", { submit: { status: 401, code: "activity_grant_revoked" } }, "allow-once"],
      ["unreachable read", { read: { drop: true } }, "allow-once"],
      ["unlisted read status (500)", { read: { status: 500, code: "internal_error" } }, "allow-once"],
      ["unlisted read state (deferred)", { answer: { afterMs: 300, state: "deferred" } }, "allow-once"],
      ["stale_generation", { submit: { status: 409, code: "stale_generation" } }, null],
      ["activity_grant_stale read", { read: { status: 409, code: "activity_grant_stale" } }, null],
      ["refused read (said_no)", { answer: { afterMs: 300, state: "refused", reason: "said_no" } }, null],
      ["stale ask", { answer: { afterMs: 300, state: "stale" } }, null],
      ["withdrawn ask", { answer: { afterMs: 300, state: "withdrawn" } }, null],
    ];
    await Promise.all(outcomes.map(async ([label, asks, optionId]) => {
      const h = await open(label.replace(/[^a-z0-9]+/g, "-"), asks, [{ permission: true, holdMs: scale(800) }, {}]);
      if (!h) return;
      // Section 7 sets no time limit for what follows a read, so the check waits its ordinary per-step bound (--wait-ms),
      // and longer when the read got no answer, which a runner may retry a few times before it permits.
      const got = await waitFor(() => outcome(h), label === "unreachable read" ? scale(10000) : opts.waitMs);
      if (!optionId) {
        r.check(`${label}: the agent gets cancelled`, got?.outcome === "cancelled", `got ${JSON.stringify(got)}`);
        r.check(`${label}: nothing is held`, await waitFor(() => h.hooks("Stop", "end_turn")[0], scale(3000))
          && !h.hooks("Notification", "permission_prompt").length, "no Stop/end_turn after the cancel, or the runner posted permission_prompt");
        return;
      }
      r.check(`${label}: the agent gets its allow_once option`, got?.outcome === "selected" && got.optionId === optionId, `got ${JSON.stringify(got)}`);
      await waitFor(() => h.hooks("Stop", "end_turn")[0], scale(3000));
      await sleep(scale(300));
      r.check(`${label}: it's delivered once`, answers(h).length === 1, `${answers(h).length} answers`);
      r.check(`${label}: the turn's end is reported as usual`, h.hooks("Stop", "end_turn").length > 0, "no Stop/end_turn after the permit");
      if (label === "permitted at submit") r.check(`${label}: there's no ask to read`, h.permissionCalls("GET").length === 0,
        `${h.permissionCalls("GET").length} reads`);
      // A read that got no answer leaves OpenRig's ask open, so it must not stay in the person's Feed after the turn.
      if (label === "unreachable read" || label.startsWith("unlisted read")) r.check(`${label}: the ask is still withdrawn at the turn's end`,
        await waitFor(() => withdraws(h).some((w) => w.body?.reason === "turn_ended"), scale(3000)), `withdraws: ${JSON.stringify(withdraws(h).map((w) => w.body))}`);
    }));

    // No answer: the request stays pending and visible, a pasted message isn't an answer, and /abort withdraws it, after
    // which a late answer isn't delivered.
    {
      const h = await open("pending", { late: { state: "answered", optionId: "allow-once" } });
      if (h) {
        await sleep(scale(1500));
        r.check("pending: the runner keeps reading the ask", h.permissionCalls("GET").length >= 1, "no read of the ask");
        r.check("pending: nothing is delivered while no one has answered", answers(h).length === 0, `got ${JSON.stringify(outcome(h))}`);
        const turn = h.hooks("UserPromptSubmit", "accepted").at(-1);
        r.check("pending: no idle Stop while it waits", stopsAfter(h, turn).length === 0, stopsAfter(h, turn).map((p) => p.body.subtype).join(", "));
        h.paste(message(h, "allow it"));
        await sleep(scale(800));
        r.check("pending: a pasted message isn't an answer", answers(h).length === 0, `got ${JSON.stringify(outcome(h))}`);
        const abortedAt = Date.now();
        h.paste("/abort");
        const withdrawn = await waitFor(() => withdraws(h)[0], scale(3000));
        r.check("pending: /abort withdraws the ask with turn_cancelled", withdrawn?.body?.reason === "turn_cancelled", `withdraw: ${JSON.stringify(withdrawn?.body)}`);
        r.check("pending: the agent's request is answered cancelled", (await waitFor(() => outcome(h), scale(3000)))?.outcome === "cancelled",
          `got ${JSON.stringify(outcome(h))}`);
        // Once the ask is withdrawn no person is still waiting, so the cancelled turn's own end is reported as usual (the
        // pasted message above runs as the next turn, so only that turn's Stop/cancelled counts). The contract doesn't
        // order the Stop and the withdraw, so the Stop is any after /abort, not only one after the withdraw arrived.
        r.check("pending: after /abort, the turn's end is reported, holding nothing",
          await waitFor(() => h.hooks("Stop", "cancelled").some((p) => p.at >= abortedAt), scale(3000)), "no Stop/cancelled after /abort");
        await sleep(scale(1200));
        r.check("pending: an answer after the withdraw isn't delivered", answers(h).every((a) => a.msg.result?.outcome?.outcome !== "selected"),
          `answers: ${JSON.stringify(answers(h).map((a) => a.msg.result))}`);
      }
    }
    // The turn ending, or the agent exiting, while the ask waits also withdraws it.
    for (const [label, permission, reason] of [["turn end", { waitMs: scale(1500) }, "turn_ended"], ["agent exit", { exitAfterMs: scale(1500) }, "exited"]]) {
      const h = await open(label.replace(/[^a-z]+/g, "-"), {}, [{ permission }, {}]);
      if (!h) continue;
      const withdrawn = await waitFor(() => withdraws(h)[0], scale(4000));
      r.check(`${label}: the ask is withdrawn with ${reason}`, withdrawn?.body?.reason === reason, `withdraw: ${JSON.stringify(withdrawn?.body)}`);
      // The turn's own end: a Stop with the agent's own stop reason, after the agent answered that turn's session/prompt,
      // on either side of the withdraw (the contract doesn't order them). A Stop posted before the turn ended doesn't count.
      if (reason === "turn_ended") {
        const turnEnd = await waitFor(() => {
          const asked = h.sent("session/request_permission")[0];
          const prompt = asked && h.received("session/prompt").filter((p) => p.at <= asked.at).at(-1);
          return prompt && h.replyTo(prompt);
        }, scale(4000));
        const stopReason = turnEnd?.msg.result?.stopReason;
        r.check(`${label}: nothing is held once the ask is withdrawn`,
          stopReason && await waitFor(() => h.hooks("Stop", stopReason).some((p) => p.at >= turnEnd.at), scale(3000)),
          `no Stop/${stopReason ?? "(no turn end)"} after the agent ended the turn`);
      }
    }
    return r;
  },

  // Section 7: a person who answers in their own words gets them passed on. OpenRig carries them as the read's `said`, and
  // a runner queues them for the agent like any other prompt, after the turn, never as the answer. A runner that drops
  // them still keeps the contract, so the result is advisory.
  async "4c"() {
    const r = result("4c", "The person's words: a read's said is queued to the agent as a prompt (advisory)", { proposed: true });
    const said = "Only the notes file, please. Leave the rest alone.";
    const h = await launch("4c", { scenario: { turns: [{ permission: true }, {}] },
      asks: { answer: { afterMs: 300, state: "permitted", optionId: "allow-once", said } } });
    if (!r.check("the runner opens its conversation", await ready(h), "no launch record")) return r;
    h.paste(message(h, "edit the notes"));
    if (!r.check("the first turn ends", await waitFor(() => h.hooks("Stop", "end_turn")[0], scale(6000)), "no Stop/end_turn")) return r;
    const later = await waitFor(() => h.prompts().slice(1).find((prompt) => prompt?.includes(said)), scale(4000));
    r.check("the person's words are queued to the agent as a prompt, after the turn", later, `prompts: ${JSON.stringify(h.prompts())}`);
    return r;
  },

  async "5"() {
    const r = result("5", "Generation: every post carries the launch's occupant generation");
    const h = await launch("5");
    if (!r.check("the runner opens its conversation", await ready(h), "no launch record")) return r;
    h.paste(message(h, "a short turn"));
    await waitFor(() => h.hooks("Stop", "end_turn")[0]);
    const all = h.posts();
    r.check("the runner posted something", all.length > 0, "no posts");
    r.check("generation is OPENRIG_OCCUPANT_GENERATION on every post", all.every((p) => p.body?.generation === h.generation),
      all.map((p) => p.body?.generation).join(", "));
    return r;
  },

  async "6"() {
    const r = result("6", "Resume: the same conversation, or an honest missing or unconfirmed");
    if (!opts.resume) return r.skip("the preset doesn't declare resume (--resume): OpenRig passes OPENRIG_RESUME_REF only to one that does");
    const reopenCalls = (h) => [...h.received("session/load"), ...h.received("session/resume")];
    {
      const h = await launch("6-same", { scenario: { knownSessions: ["fake-old-1"] }, env: { OPENRIG_RESUME_REF: "fake-old-1" } });
      const record = await ready(h);
      const call = reopenCalls(h)[0];
      r.check("same: the agent is asked to reopen OPENRIG_RESUME_REF", call?.msg.params?.sessionId === "fake-old-1",
        call ? `asked for ${call.msg.params?.sessionId}` : "no session/load or session/resume");
      r.check("same: in the launch's working folder", call && realpathSync(String(call.msg.params?.cwd ?? "")) === realpathSync(h.cwd),
        `cwd=${call?.msg.params?.cwd}`);
      r.check("same: the record reports that conversation", record?.nativeRef === "fake-old-1", `record: ${JSON.stringify(h.record())}`);
      r.check("same: no new conversation starts", h.received("session/new").length === 0, "session/new was sent");
    }
    {
      const h = await launch("6-missing", { scenario: { reopenError: "missing" }, env: { OPENRIG_RESUME_REF: "fake-gone" } });
      const record = await waitFor(() => h.record());
      r.check("missing: the agent's own not-found is reported as error: missing", record?.error === "missing" && !record.nativeRef,
        `record: ${JSON.stringify(record)}`);
      await sleep(scale(800));
      r.check("missing: no new conversation starts", h.received("session/new").length === 0, "session/new was sent");
    }
    {
      const h = await launch("6-other", { scenario: { reopenError: "error" }, env: { OPENRIG_RESUME_REF: "fake-elsewhere" } });
      await waitFor(() => reopenCalls(h)[0] && h.log().some((e) => e.dir === "out" && e.msg.error));
      await sleep(scale(2500));
      const record = h.record();
      r.check("other failure: not reported missing or resumed", !record || (record.error && record.error !== "missing" && !record.nativeRef),
        `record: ${JSON.stringify(record)}`);
      r.check("other failure: no new conversation starts", h.received("session/new").length === 0, "session/new was sent");
    }
    return r;
  },

  async "7"() {
    const r = result("7", "Death mid-turn: Stop/<preset>_exited, never an idle report");
    const h = await launch("7", { scenario: { turns: [{ exit: true }] } });
    if (!r.check("the runner opens its conversation", await ready(h), "no launch record")) return r;
    h.paste(message(h, "this turn kills the agent"));
    const died = await waitFor(() => h.events("exit")[0]);
    if (!r.check("the agent exits mid-turn", died, "the agent didn't exit")) return r;
    const exited = await waitFor(() => h.hooks("Stop", `${opts.name}_exited`)[0], scale(4000));
    r.check(`Stop/${opts.name}_exited is posted`, exited, `posts: ${h.posts().map((p) => `${p.body?.hookEvent}/${p.body?.subtype}`).join(", ")}`);
    // Any idle report for the turn the agent died in counts, before or after the exit; one from before the turn doesn't.
    const turn = h.hooks("UserPromptSubmit", "accepted")[0];
    const idle = turn ? stopsAfter(h, turn) : nonExitStops(h, died.at);
    r.check("no idle report for the turn it died in", idle.length === 0, idle.map((p) => p.body.subtype).join(", "));
    return r;
  },

  async "7b"() {
    const r = result("7b", "Errors: a failed prompt is a runtime error, not a permission request");
    const h = await launch("7b", { scenario: { turns: [{ error: true }, {}] } });
    if (!r.check("the runner opens its conversation", await ready(h), "no launch record")) return r;
    h.paste(message(h, "this prompt fails"));
    const posted = await waitFor(() => h.hooks("Notification", "runtime_error")[0]);
    r.check("a failed session/prompt posts Notification/runtime_error", posted,
      `posts: ${h.posts().map((p) => `${p.body?.hookEvent}/${p.body?.subtype}`).join(", ")}`);
    r.check("it isn't reported as a permission request", h.hooks("Notification", "permission_prompt").length === 0, "permission_prompt posted");
    return r;
  },

  // Section 9 marks this duty "(Proposed)", and a runner may list in `limits` what keeps running, so the result is reported
  // on its own: never a pass or a fail, and never the exit status.
  async "7c"() {
    const r = result("7c", "Shutdown: closing the pane ends the agent (proposed in section 9; advisory)", { proposed: true });
    const h = await launch("7c", { scenario: { stubborn: true } });
    if (!r.check("the runner opens its conversation", await ready(h), "no launch record")) return r;
    const pid = h.events("started")[0]?.pid;
    h.stop();
    const gone = await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, scale(5000));
    r.check("closing the pane ends the agent process", gone, `agent pid ${pid} still running ${scale(5000) / 1000} s later; list it in limits if that's expected`);
    if (!gone) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    return r;
  },

  async "8"() {
    const r = result("8", "Unknown requests from the agent get -32601, and the runner carries on");
    const h = await launch("8", { scenario: { unknownRequest: true } });
    const answer = await waitFor(() => h.answerTo("fake/unknown_method"));
    r.check("the unknown request is answered -32601", answer?.msg.error?.code === -32601, `answer: ${JSON.stringify(answer?.msg ?? null)}`);
    if (!r.check("the runner opens its conversation", await ready(h), "no launch record")) return r;
    h.paste(message(h, "still working?"));
    r.check("the next prompt still goes through", await waitFor(() => h.prompts().length === 1), "no prompt after the unknown request");
    return r;
  },

  async "9"() {
    const r = result("9", "First input: OPENRIG_FIRST_INPUT's exact bytes are the first prompt");
    if (!opts.firstInput) return r.skip("the preset doesn't declare first_input (--first-input): OpenRig passes no OPENRIG_FIRST_INPUT");
    const dir = mkdtempSync(join(tmpdir(), "runner-check-first-"));
    const file = join(dir, "first-input");
    const text = "Read the plan first.\n\n  Then say ready.\n";
    writeFileSync(file, text, { mode: 0o600 });
    const h = await launch("9", { env: { OPENRIG_FIRST_INPUT: file } });
    const first = await waitFor(() => h.prompts()[0]);
    r.check("the first prompt is the file's bytes, newlines and spaces included", first === text, `got ${JSON.stringify(first)}`);
    if (!opts.keep) rmSync(dir, { recursive: true, force: true });
    return r;
  },
  async "10"() {
    const r = result("10", "Launch wrapper: the runner wraps its native child and scrubs the handoff environment");
    if (!opts.launchWrapper) return r.skip("the preset doesn't declare launch_wrapper (--launch-wrapper): OpenRig passes no OPENRIG_LAUNCH_WRAPPER");
    const h = await launch("10", { launchWrapper: true });
    r.check("the wrapped child opens its conversation", await ready(h), "no launch record");
    const seen = existsSync(h.wrapperLog) ? JSON.parse(readFileSync(h.wrapperLog, "utf8")) : undefined;
    r.check("the wrapper receives literal arguments and the native child command", seen?.tag === "literal ' $ ; space" && seen?.separator === "--"
      && seen?.argv?.[0] === h.agent, JSON.stringify(seen ?? null));
    r.check("OPENRIG_LAUNCH_WRAPPER is absent from the wrapper and child environment", seen?.launchWrapper === null
      && h.events("started")[0]?.launchWrapper === null, "wrapper handoff leaked to native child");
    return r;
  },

};

const order = ["1", "1b", "2", "3", "3b", "4", "4b", "4c", "5", "6", "7", "7b", "7c", "8", "9", "10"];
const selected = opts.cases ?? order;
const unknown = selected.filter((id) => !order.includes(id));
if (unknown.length) { console.error(`unknown case ${unknown.join(", ")}; cases are ${order.join(", ")}`); process.exit(2); }
let results;
try {
  results = await Promise.all(order.filter((id) => selected.includes(id)).map(async (id) => {
    try { return await cases[id](); } catch (error) { return { id, title: id, status: "fail", checks: [{ name: "the case ran", ok: false, detail: error.message }] }; }
  }));
} finally {
  tmux("kill-server");
  server.close();
  // A runner or agent can still be writing its last lines as its pane closes, so cleanup waits a moment and never fails the report.
  await sleep(scale(300));
  if (!opts.keep) for (const h of launches) try { rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* left in the temp folder */ }
}

// A proposed duty's result is advisory: it says whether the runner met it, outside pass, fail and the exit status.
for (const r of results) if (r.proposed && r.status !== "skip") { r.met = r.status === "pass"; r.status = "advisory"; }
const summary = Object.fromEntries(["pass", "fail", "skip", "advisory"].map((s) => [s, results.filter((r) => r.status === s).length]));
if (opts.json) {
  console.log(JSON.stringify({ check: "openrig-runner-conformance", format: 1, runner: opts.runner, name: opts.name, results, summary }, null, 2));
} else {
  console.log(`OpenRig runner conformance check (docs/reference/harness-runner-contract.md)\nrunner: ${opts.runner}\npreset: ${opts.name}\n`);
  for (const r of results) {
    const label = r.status === "advisory" ? "NOTE" : r.status.toUpperCase();
    const outcome = r.status === "advisory" ? (r.met ? ": met" : ": not met") : r.reason ? `: ${r.reason}` : "";
    console.log(`${label.padEnd(5)} ${r.id.padEnd(3)} ${r.title}${outcome}`);
    for (const c of r.checks.filter((c) => !c.ok)) console.log(`      x ${c.name}: ${c.detail}`);
  }
  console.log(`\n${summary.pass} pass, ${summary.fail} fail, ${summary.skip} skipped, ${summary.advisory} advisory (not counted)${opts.keep ? `; launch folders kept under ${tmpdir()}` : ""}`);
}
process.exit(summary.fail ? 1 : 0);
