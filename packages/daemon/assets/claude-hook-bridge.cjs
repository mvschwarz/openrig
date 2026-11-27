#!/usr/bin/env node
// The hook bridge: hooks that wake an agent at a turn boundary with what OpenRig holds for it. It never types into a terminal.
//
// Slice 13, an opted-in Claude seat, run by the hooks its OpenRig launch adds:
//   node claude-hook-bridge.cjs waiter   SessionStart and Stop, as `asyncRewake` command hooks: arm with the daemon at
//                                        this turn boundary, poll for the seat's queued messages, write them to stderr
//                                        and exit 2, which wakes Claude with them in its context. Exits 0 when superseded
//                                        by a newer waiter, when the occupant was replaced, or at its own deadline.
//   node claude-hook-bridge.cjs turn     UserPromptSubmit: tell the daemon a turn started, so nothing is delivered into
//                                        a running turn. Always exits 0 at once: it never blocks a prompt.
// It reaches the daemon the way the activity relay does (OPENRIG_URL and OPENRIG_ACTIVITY_HOOK_TOKEN, else
// $OPENRIG_HOME/activity-endpoint.json) and names its seat by OPENRIG_SESSION_NAME, OPENRIG_NODE_ID and
// OPENRIG_OCCUPANT_GENERATION.
//
// Slice 15, a person's own conversation in Claude Code or Codex (not a seat), run by the hooks the `openrig` plugin ships:
//   conversation-waiter   Claude Code SessionStart and Stop, as `asyncRewake` hooks: read the return-route addresses OpenRig
//                         issued to this conversation from OpenRig's own record (the rows tagged with this conversation's key,
//                         see conversationKey), poll their pending tasks, and write the ones not yet shown in this session,
//                         each with its sender as the daemon recorded it, to stderr and exit 2, which wakes Claude. Exits 0
//                         when the conversation has no such address, when superseded by a newer waiter, or at its
//                         deadline. A read that fails is tried again after a longer wait each time.
//   conversation-turn     Claude Code UserPromptSubmit: mark that a turn is running, so a waiter never wakes into it.
//   codex-start           Codex SessionStart (async): start one detached watcher for this session and exit 0. A Codex hook
//                         can't start a turn itself; `codex queue` can.
//   codex-end             Codex SessionEnd: tell this session's watcher to stop.
//   codex-watch <session id> <transcript path> <codex pid> <its start time>
//                         The watcher: the same reads, and it wakes the thread with
//                         `codex queue --thread <session id> --message … --resume` (exit 0 there means stored, not delivered),
//                         a backlog in batches that each fit one argument.
//                         A failed read or queue is tried again after a longer wait each time, up to five minutes. On a
//                         Codex whose `codex queue` has no `--resume`, it queues without it, for the thread's next turn,
//                         and says so once in the thread.
// These modes exit at once in an OpenRig seat (OPENRIG_SESSION_NAME or OPENRIG_NODE_ID set), which keeps slice 13 and typed
// delivery. They read OpenRig with the `rig` command, as the person's agent does: the one findRig names, which the plugin's
// MCP launcher (scripts/run-rig.cjs) runs too. With none, they read nothing and say so once for the plugin's install, again
// only after one was found and then lost. The openrig plugin ships a copy of this file in hooks/scripts/, byte-equal to
// this one (a plugin can't reach files outside its own folder).
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const POLL_MS = 1000;
const UNREACHABLE_MS = 2000;
const REQUEST_TIMEOUT_MS = 5000;

const first = (...values) => values.find((v) => typeof v === "string" && v.length > 0) || "";

function endpoint(env = process.env) {
  let baseUrl = first(env.OPENRIG_URL, env.RIGGED_URL);
  let token = first(env.OPENRIG_ACTIVITY_HOOK_TOKEN, env.RIGGED_ACTIVITY_HOOK_TOKEN);
  if (!baseUrl && first(env.OPENRIG_PORT)) baseUrl = `http://${first(env.OPENRIG_HOST) || "127.0.0.1"}:${env.OPENRIG_PORT}`;
  if (!baseUrl || !token) {
    try {
      const home = first(env.OPENRIG_HOME, env.RIGGED_HOME) || path.join(os.homedir(), ".openrig");
      const parsed = JSON.parse(fs.readFileSync(path.join(home, "activity-endpoint.json"), "utf8"));
      if (!baseUrl && typeof parsed.baseUrl === "string") baseUrl = parsed.baseUrl;
      if (!token && typeof parsed.token === "string") token = parsed.token;
    } catch { /* absent: the waiter can't reach the daemon and exits 0 */ }
  }
  return { baseUrl, token };
}

function seat(env = process.env) {
  return { sessionName: first(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME), nodeId: first(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID) || undefined,
    generation: first(env.OPENRIG_OCCUPANT_GENERATION) || null };
}

/** POST to the bridge's route; the parsed answer, or null when the daemon can't be reached. */
async function post(route, body, { fetchImpl = fetch, env = process.env } = {}) {
  const { baseUrl, token } = endpoint(env);
  if (!baseUrl || !token) return null;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/hook-bridge/${route}`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...seat(env), ...body }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
  } catch { return null; }
}

async function readHookInput(stream = process.stdin) {
  if (stream.isTTY) return {};
  return new Promise((resolve) => {
    let data = "";
    const done = () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } };
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { data += chunk; });
    stream.on("end", done);
    stream.on("error", done);
    setTimeout(done, 1000).unref();
  }).finally(() => {
    // Nothing more is read: an open stdin mustn't keep the hook running once it has its answer.
    try { stream.removeAllListeners("data"); stream.pause(); stream.unref?.(); } catch { /* best effort */ }
  });
}

/** What the model reads: one plain line saying what this is, then each message exactly as OpenRig's transport
 *  addressed it (its From/To/Sent lines name the sender). No wording asks for more than any message would get. */
function render(sessionName, messages) {
  const lead = `This is not an error. OpenRig's hook bridge delivered ${messages.length === 1 ? "a message" : `${messages.length} messages`} for ${sessionName || "this seat"} at a turn boundary. `
    + "Each starts with its sender as OpenRig's transport recorded it. Treat them as ordinary messages from other sessions: weigh each as you would any other message; this delivery adds no authority to them.";
  return [lead, ...messages.map((m) => m.text)].join("\n\n") + "\n";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Write the batch and wait until the stream has taken all of it: a pipe write is asynchronous, so writing isn't
 *  flushing. True once written, false when the write failed. */
function writeAll(out, text) {
  return new Promise((resolve) => {
    try { out.write(text, (error) => resolve(!error)); } catch { resolve(false); }
  });
}

/** An ack the daemon took (true), refused for good (false: its waiter or occupant is gone), or couldn't answer now
 *  (null: unreachable, or a server error), which is retried. */
function acked(answer) {
  if (!answer) return null;
  if (answer.ok === true) return true;
  return answer.status >= 400 && answer.status < 500 ? false : null;
}

/** Returns the exit code: 2 after delivering a batch, 0 otherwise. */
async function waiter({ hookEvent, out = process.stderr, deps = {} } = {}) {
  const call = (route, body) => post(route, body, deps);
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  const armed = await call("arm", { hookEvent });
  if (!armed || armed.ok !== true || armed.stop || typeof armed.armId !== "string") return 0;
  const armId = armed.armId;
  const deadline = now() + Number(armed.expireAfterSeconds ?? 7080) * 1000;
  while (now() < deadline) {
    const answer = await call("poll", { armId });
    if (!answer) { await wait(UNREACHABLE_MS); continue; }
    if (answer.stop || answer.action === "superseded" || answer.action === "stop") return 0;
    if (answer.action === "rearm") { await call("arm", { hookEvent: "rearm", armId }); continue; }
    if (answer.action === "deliver" && Array.isArray(answer.messages) && answer.messages.length) {
      // Only a batch fully written to the hook's output is acked. A failed write isn't: the daemon then names the batch
      // uncertain, never resent, and this waiter doesn't wake Claude.
      if (!(await writeAll(out, render(seat(deps.env).sessionName, answer.messages)))) return 0;
      // The ack says the batch was handed to the hook's output. One the daemon couldn't take now is retried, three tries
      // in all; if none lands, the daemon marks the batch uncertain rather than resending it.
      for (let tries = 0; tries < 3; tries++) {
        const result = acked(await call("ack", { armId, batchId: answer.batchId }));
        if (result !== null) break;
        if (tries < 2) await wait(UNREACHABLE_MS);
      }
      return 2;
    }
    await wait(POLL_MS);
  }
  await call("expired", { armId });
  return 0;
}

// ---- Slice 15: a person's own conversation (Claude Code or Codex, not a seat) ----

/** The tag `rig queue create --return-route auto` (and the MCP server's create) records beside an issued address: the key of
 *  the conversation that handed the work over. The hooks read the addresses recorded under their own key back with
 *  `rig queue list --tag`, so an address only mentioned or pasted in a chat never subscribes it. */
const CONVERSATION_KEY_TAG_PREFIX = "conversation-key:";
const CONVERSATION_POLL_MS = 15000;
/** A conversation's routes are read again when its transcript grows (its creates happen in its turns), and at least this
 *  often. */
const ROUTES_REFRESH_MS = 5 * 60 * 1000;
/** A Codex watcher waits twice as long after each tick whose read or `codex queue` failed, up to this. */
const RETRY_MAX_MS = 5 * 60 * 1000;
/** As slice 13's waiter: its hook timeout (7200 s, the plugin's hooks file) less a margin, after which it exits 0. */
const CONVERSATION_WAITER_MS = (7200 - 120) * 1000;
/** Without a Codex pid to observe, stop an orphan watcher after this long without rollout growth. */
const CODEX_IDLE_EXIT_MS = 6 * 3600 * 1000;
/** How often a Codex watcher that found no `rig` looks again. */
const NO_RIG_RETRY_MS = 30 * 1000;
/** A watcher that hasn't ticked for this long isn't live, whatever its recorded pid says. */
const WATCHER_LIVE_MS = 3 * CONVERSATION_POLL_MS;
/** A conversation's state folder untouched for this long, the folder and every file in it, is removed, unless the Claude
 *  Code process its waiter recorded still runs. */
const STATE_KEEP_MS = 7 * 24 * 3600 * 1000;
/** The most one `codex queue --message` carries, in bytes of UTF-8: half of Linux's limit on one argument (MAX_ARG_STRLEN,
 *  32 pages, so 128 KiB with 4 KiB pages), past which the spawn fails with E2BIG. */
const QUEUE_MESSAGE_MAX_BYTES = 64 * 1024;
/** Only addresses OpenRig issued for this conversation's own creates are read; a named or inherited route isn't its own. */
const ISSUED_BASES = new Set(["issued", "issued-actor"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_MODES = new Set(["conversation-waiter", "conversation-turn", "codex-start", "codex-end", "codex-watch"]);

/** An OpenRig seat runs its own delivery (slice 13, typed delivery): the conversation modes never run there, even when the
 *  plugin is enabled in a config folder its seats share. */
function inSeat(env = process.env) {
  return !!first(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME, env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID);
}

/** A reader of one process: its parent, a start time that tells a reused pid apart, and its names. Linux reads /proc
 *  (the start time is the boot id's prefix and the start tick); macOS and the BSDs read one `ps` table; elsewhere nothing
 *  is read, so no key is derived. */
function processReader({ platform = process.platform, fsImpl = fs, ps } = {}) {
  if (platform === "linux") {
    let boot = "";
    try { boot = fsImpl.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().slice(0, 8); } catch { /* unreadable: the tick alone */ }
    return (pid) => {
      try {
        const stat = fsImpl.readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const fields = stat.slice(close + 2).split(" ");
        let argv0 = "";
        try { argv0 = fsImpl.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] || ""; } catch { /* the comm still names it */ }
        return { pid, ppid: Number(fields[1]), start: `${boot}.${fields[19]}`, names: [stat.slice(stat.indexOf("(") + 1, close), argv0] };
      } catch { return null; }
    };
  }
  if (platform === "darwin" || /bsd$/.test(platform)) {
    let table = null;
    return (pid) => {
      if (table === null) {
        table = new Map();
        try {
          const text = ps ? ps() : require("node:child_process").execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "comm="],
            { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
          for (const line of String(text).split("\n")) {
            const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
            if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), start: m[3].replace(/\s+/g, "-"), names: [m[4].trim()] });
          }
        } catch { /* no table: no key */ }
      }
      return table.get(pid) ?? null;
    };
  }
  return () => null;
}

const baseName = (name) => String(name).split(/[\\/]/).pop();
/** Claude Code's and Codex's own processes, by the name they run under. */
function agentKind(proc) {
  const names = proc.names.map(baseName);
  if (names.some((name) => name === "claude" || name === "claude.exe")) return "claude";
  if (names.some((name) => name === "codex" || name === "codex.exe")) return "codex";
  return null;
}

/** The key that names this conversation, derived the same way, with no help from the model, by the CLI and the MCP server
 *  (recording it with an issued address) and by the hooks (reading the addresses under it). Walking up from this process,
 *  the nearest Claude Code or Codex process decides:
 *  - Claude Code documents no variable that names the session to its commands, so the key is that process, by its start
 *    time and pid (`claude:<start>:<pid>`): a Bash command, a stdio MCP server and a hook are all its descendants.
 *  - Codex gives its commands the root session id (CODEX_SESSION_ID; the main thread's CODEX_THREAD_ID, the same id, on a
 *    Codex without it), which its hooks receive as session_id: the key is `codex:<that id>`. It's also taken when the walk
 *    sees neither (a sandbox can hide ancestors), unless the command runs under Claude Code (CLAUDECODE), where the id
 *    could be an outer Codex's.
 *  Otherwise there's no key: nothing is recorded or read, so nothing wakes, and never with another conversation's
 *  addresses. */
function conversationKey({ pid = process.pid, env = process.env, read = processReader() } = {}) {
  const found = nearestAgentProcess(pid, read);
  if (found?.kind === "claude") return `claude:${found.proc.start}:${found.proc.pid}`;
  const codex = first(env.CODEX_SESSION_ID, env.CODEX_THREAD_ID);
  if (!UUID_RE.test(codex)) return null;
  return found?.kind === "codex" || (!found && !first(env.CLAUDECODE)) ? `codex:${codex.toLowerCase()}` : null;
}
const conversationKeyTag = (key) => `${CONVERSATION_KEY_TAG_PREFIX}${key}`;

/** The nearest Claude Code or Codex process at or above pid, with its kind; null when the walk sees neither. */
function nearestAgentProcess(pid, read) {
  for (let current = pid, hops = 0; current > 1 && hops < 64; hops++) {
    const proc = read(current);
    if (!proc) return null;
    const kind = agentKind(proc);
    if (kind) return { kind, proc };
    current = proc.ppid;
  }
  return null;
}
/** The nearest process of that kind (its pid and start time), when it's the nearest agent; null otherwise. */
function nearestAgent(pid, read, kind) {
  const found = nearestAgentProcess(pid, read);
  return found?.kind === kind ? found.proc : null;
}

/** Whether the process recorded by its pid and start time still runs: a pid given to a later process has another start
 *  time. When the start can't be read, whether the pid runs at all, so an unknown isn't taken for ended. */
function stillRunning(pid, start, { read = processReader(), isAlive = alive } = {}) {
  if (!(pid > 0)) return false;
  const proc = start ? read(pid) : null;
  return proc ? proc.start === start : isAlive(pid);
}

/** When a conversation's folder last changed: the newest time of the folder and its files. A live watcher's heartbeat
 *  rewrites a file that's already there, which changes that file's time and leaves the folder's alone. */
function touchedAt(folder) {
  let newest = fs.statSync(folder).mtimeMs;
  for (const name of fs.readdirSync(folder)) {
    try { newest = Math.max(newest, fs.statSync(path.join(folder, name)).mtimeMs); } catch { /* removed meanwhile */ }
  }
  return newest;
}

/** Whether the Claude Code process a conversation's waiter recorded, by its key (`claude:<start>:<pid>`), still runs. */
function waiterKeyRuns(folder, read) {
  let key = "";
  try { key = String(JSON.parse(fs.readFileSync(path.join(folder, "waiter.json"), "utf8")).key ?? ""); } catch { return false; }
  const at = key.lastIndexOf(":");
  return key.startsWith("claude:") && stillRunning(Number(key.slice(at + 1)), key.slice("claude:".length, at), { read });
}

/** One conversation's state: which waiter or watcher is current, the turn marker, and the tasks already shown. In the
 *  plugin's data folder (CLAUDE_PLUGIN_DATA, or Codex's PLUGIN_DATA), else a per-user temporary folder. Null when it can't
 *  be made: nothing wakes. `install` holds the few markers kept for the plugin's install, beside every conversation's. */
function conversationState(runtime, sessionId, { env = process.env, now = Date.now } = {}) {
  const data = first(env.CLAUDE_PLUGIN_DATA, env.PLUGIN_DATA)
    || path.join(os.tmpdir(), `openrig-hook-bridge-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  const root = path.join(data, "conversations");
  const dir = path.join(root, `${runtime}-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "")}`);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return null; }
  const file = (name) => path.join(dir, name);
  return {
    dir,
    install: {
      /** Creates the marker unless it's there: true for the one caller that made it. */
      claim: (name, value) => { try { fs.writeFileSync(path.join(data, name), JSON.stringify(value), { flag: "wx" }); return true; } catch { return false; } },
      remove: (name) => { try { fs.unlinkSync(path.join(data, name)); } catch { /* absent */ } },
    },
    read: (name, fallback) => { try { return JSON.parse(fs.readFileSync(file(name), "utf8")); } catch { return fallback; } },
    write: (name, value) => { try { fs.writeFileSync(file(name), JSON.stringify(value)); } catch { /* best effort */ } },
    exists: (name) => fs.existsSync(file(name)),
    remove: (name) => { try { fs.unlinkSync(file(name)); } catch { /* absent */ } },
    log: (line) => { try { fs.appendFileSync(file("wake.log"), `${new Date(now()).toISOString()} ${process.pid} ${line}\n`); } catch { /* best effort */ } },
    /** Removes the other conversations' folders that have gone a week untouched, unless their Claude Code still runs. */
    prune: (read = processReader()) => {
      try {
        for (const entry of fs.readdirSync(root)) {
          const other = path.join(root, entry);
          try {
            if (other !== dir && now() - touchedAt(other) > STATE_KEEP_MS && !waiterKeyRuns(other, read)) fs.rmSync(other, { recursive: true, force: true });
          } catch { /* best effort */ }
        }
      } catch { /* best effort */ }
    },
  };
}

/** A file this process can run. */
function runnable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

/** The `rig` the openrig plugin runs, for its hooks and its MCP server alike: OPENRIG_RIG_BIN when it names a file that
 *  runs, else the first `rig` on PATH, else the project's own install, <project>/node_modules/.bin/rig (the project is
 *  Claude Code's CLAUDE_PROJECT_DIR, or the folder given, a Codex session's). Null when there's none: an OpenRig installed
 *  only inside another project, or not at all. */
function findRig({ env = process.env, projectDir = first(env.CLAUDE_PROJECT_DIR) } = {}) {
  const onPath = String(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "rig"));
  const inProject = projectDir ? [path.join(projectDir, "node_modules", ".bin", "rig")] : [];
  return [first(env.OPENRIG_RIG_BIN), ...onPath, ...inProject].find((file) => file && runnable(file)) ?? null;
}

/** That `rig`, with --json: what it printed, parsed, or null when it couldn't be read (no daemon, say). */
function runRig(args, { env = process.env, bin = "rig", spawnSync = require("node:child_process").spawnSync } = {}) {
  try {
    // A long conversation's complete listing can exceed spawnSync's default 1 MiB stdout cap. The read already
    // asks for all matching rows; don't turn a valid history into an unreadable result before batching its tasks.
    const result = spawnSync(bin, args, { env, encoding: "utf8", timeout: 30000, maxBuffer: Infinity, stdio: ["ignore", "pipe", "ignore"] });
    if (result.error || result.status !== 0) return null;
    return JSON.parse(result.stdout || "null");
  } catch { return null; }
}

/** OpenRig read through findRig's `rig`; null when there's no `rig` to run. */
function rigReader(env, projectDir) {
  const bin = findRig({ env, projectDir });
  return bin ? (args) => runRig(args, { env, bin }) : null;
}

/** The PATH a login shell of this user gets. Codex runs a session's own commands in a login shell (`bash -lc`), so a `rig`
 *  in a folder the login profile adds, such as a `~/.local/bin` made after this app started, runs for the session's agent
 *  while the app's own PATH, which its hooks inherit, lacks it. Null when no login shell answers in time. */
function loginShellPath({ env = process.env, spawnSync = require("node:child_process").spawnSync } = {}) {
  // A profile may print; the PATH is what follows the last mark.
  const mark = "__OPENRIG_LOGIN_PATH__";
  try {
    const result = spawnSync(first(env.SHELL) || "/bin/sh", ["-lc", `printf '%s%s' '${mark}' "$PATH"`],
      { env, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
    if (result.error || result.status !== 0) return null;
    const out = String(result.stdout ?? "");
    const at = out.lastIndexOf(mark);
    return at < 0 ? null : out.slice(at + mark.length).trim() || null;
  } catch { return null; }
}

/** OpenRig read through the `rig` this session's own commands would run: findRig's, else the first on a login shell's PATH,
 *  run with that PATH so its `node` resolves the same way. Null when neither has one. */
function sessionRigReader(env, projectDir, loginPath = () => loginShellPath({ env })) {
  const direct = rigReader(env, projectDir);
  if (direct) return direct;
  const login = loginPath();
  return login && login !== env.PATH ? rigReader({ ...env, PATH: login }, projectDir) : null;
}

/** What a conversation is told when there's no `rig`: without it the hooks read nothing, and nothing else would tell the
 *  person that the team's questions won't come in by themselves. */
const NO_RIG_NOTICE = "OpenRig's automatic wake can't run in this conversation: the openrig plugin found no `rig` command "
  + "(OPENRIG_RIG_BIN doesn't name one, there's none on PATH, and none in this project's node_modules/.bin). Until it finds "
  + "one, your OpenRig team's questions and replies won't come into this conversation by themselves. To fix it, install "
  + "OpenRig where every session finds it (`npm install -g @openrig/cli`), or set OPENRIG_RIG_BIN to the full path of `rig` "
  + "in the environment this app starts with. The plugin says this once, not in every session; tell the person in plain words.\n";
const NO_RIG = "no-rig.json";

/** Says NO_RIG_NOTICE through `say` once for the plugin's install: someone who keeps OpenRig inside one project isn't told
 *  again in every other project's sessions. A session's own marker keeps its later Stops from looking again. True once
 *  said now. */
async function sayNoRigOnce(state, say, now) {
  if (state.exists(NO_RIG)) return false;
  state.write(NO_RIG, { at: now() });
  if (!state.install.claim(NO_RIG, { at: now() })) { state.log("no rig: already told for this plugin install"); return false; }
  if (await say(NO_RIG_NOTICE)) { state.log("no rig: told once for this plugin install"); return true; }
  state.install.remove(NO_RIG);
  state.remove(NO_RIG);
  state.log("no rig: the notice couldn't be written");
  return false;
}

/** A `rig` was found: a later loss is told once more. */
function forgetNoRig(state) {
  state.remove(NO_RIG);
  state.install.remove(NO_RIG);
}

/** The CLI lists newest first and has no cursor. Widen a full page until it includes the whole matching set: shown
 *  pending tasks and newer inherited handoffs must not hide an older question or the original issued route. */
function conversationRows(args, limit, rig) {
  for (;;) {
    const rows = rig(["queue", "list", ...args, "--limit", String(limit), "--json"]);
    if (!Array.isArray(rows)) return null;
    if (rows.length < limit) return rows;
    limit *= 2;
  }
}

/** The return-route addresses OpenRig issued under this conversation's key, each with the handed-over row that issued it;
 *  null when OpenRig couldn't be read. A row without the tag (an older daemon that ignored the filter) is never taken. */
function conversationRoutes(key, rig) {
  const tag = conversationKeyTag(key);
  const rows = conversationRows(["--tag", tag, "--all"], 100, rig);
  if (!Array.isArray(rows)) return null;
  const routes = new Map();
  for (const row of rows) {
    if (!row || typeof row.returnRoute !== "string" || !ISSUED_BASES.has(row.returnRouteBasis)) continue;
    if (!Array.isArray(row.tags) || !row.tags.includes(tag)) continue;
    // A route kept as member@rig@host names a conversation on another host, which this host's prompts don't reach.
    if (row.returnRoute.split("@").length !== 2 || routes.has(row.returnRoute)) continue;
    routes.set(row.returnRoute, { qitemId: String(row.qitemId), summary: typeof row.summary === "string" ? row.summary : null });
  }
  return routes;
}

/** The pending tasks at one route; null when OpenRig couldn't be read. */
function pendingAt(route, rig) {
  const rows = conversationRows(["--destination", route, "--state", "pending"], 50, rig);
  return Array.isArray(rows) ? rows.filter((row) => row && row.state === "pending" && row.destinationSession === route && typeof row.qitemId === "string") : null;
}

/** The task's sender as the daemon recorded it: the row's source, and the identity provenance its create recorded
 *  (undefined when the log couldn't be read). */
function recordedSender(row, rig) {
  const transitions = rig(["queue", "transitions", row.qitemId, "--full", "--json"]);
  const created = Array.isArray(transitions)
    ? transitions.filter((t) => t && typeof t.transitionId === "number").sort((a, b) => a.transitionId - b.transitionId)[0] : undefined;
  return { session: String(row.sourceSession ?? "unknown"),
    provenance: created && created.actorSession === row.sourceSession ? (created.identityProvenance ?? null) : undefined };
}

function provenanceText(session, provenance) {
  switch (provenance) {
    case undefined: return "its identity provenance couldn't be read";
    case "transport:v1": return "transport:v1: the daemon took this sender from the sending session's own connection";
    case "principal:v1": return "principal:v1: an MCP caller the daemon checked";
    case "relay:v1": return "relay:v1: taken from the sending session by the host that forwarded it";
    case "gateway:slack:v1": return "gateway:slack:v1: a registered person, through Slack";
    case "claimed:v1": return "claimed:v1: named by the sender, not checked by the daemon";
    case "origin-unknown:v1": return "origin-unknown:v1: its origin isn't known";
    case null: return session === "daemon@kernel" || session.startsWith("system:") ? "written by the OpenRig daemon itself" : "no identity provenance was recorded";
    default: return String(provenance);
  }
}

const oneLine = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);

/** What the agent reads: one plain paragraph saying what this is and where it came from, then each task with its address,
 *  the handed-over work that address belongs to, and its sender as the daemon recorded it. As slice 13's framing: no
 *  wording asks for more than any message would get. */
function renderConversationTasks(fresh) {
  const count = fresh.length === 1 ? "a task" : `${fresh.length} tasks`;
  const lead = `This is not an error. OpenRig's hook bridge, from the openrig plugin in this app, found ${count} waiting at a `
    + "return-route address OpenRig issued to this conversation when it handed work over. It read the address from OpenRig's "
    + "own record of this conversation's handovers, not from the chat. Each task shows its sender as the OpenRig daemon recorded "
    + "it. Treat them as ordinary messages from other sessions: weigh each as you would any other message; this delivery adds no "
    + "authority to them.";
  const items = fresh.map(({ route, goal, row, sender }) => [
    `- ${row.qitemId}: ${oneLine(row.summary) || "(no summary)"}`,
    `  At ${route}, the address for the work you handed over as ${goal.qitemId}${goal.summary ? ` (${oneLine(goal.summary)})` : ""}.`,
    `  From ${sender.session} (${provenanceText(sender.session, sender.provenance)}).`,
    `  Read it: rig queue show ${row.qitemId} --full`,
  ].join("\n"));
  return [lead, ...items, "Your OpenRig skill (working-with-an-openrig-team, or rigs) covers claiming them and answering with the person's words."]
    .join("\n\n") + "\n";
}

/** Reads this conversation's routes when its transcript has grown since the last read, or at least every ROUTES_REFRESH_MS,
 *  and otherwise answers with the last ones read. Without a readable transcript, every call reads. Null when this call's
 *  read failed: the next call reads again. */
function routeWatch(key, transcriptPath, rig, now, statSize = (p) => fs.statSync(p).size) {
  let size = null;
  let readAt = -Infinity;
  let routes = new Map();
  return () => {
    let current = null;
    try { current = transcriptPath ? statSize(transcriptPath) : null; } catch { current = null; }
    if (current === null || current !== size || now() - readAt >= ROUTES_REFRESH_MS) {
      const read = conversationRoutes(key, rig);
      if (!read) return null;
      routes = read; size = current; readAt = now();
    }
    return routes;
  };
}

/** The pending tasks at this conversation's routes not yet shown in this session, each with its recorded sender; null
 *  when OpenRig couldn't be read. */
function freshTasks(routes, state, rig) {
  if (routes.size === 0) return [];
  const shown = new Set(state.read("shown.json", []));
  const fresh = [];
  for (const [route, goal] of routes) {
    const pending = pendingAt(route, rig);
    if (!pending) return null;
    for (const row of pending) {
      if (!shown.has(row.qitemId) && !fresh.some((task) => task.row.qitemId === row.qitemId)) fresh.push({ route, goal, row });
    }
  }
  for (const task of fresh) task.sender = recordedSender(task.row, rig);
  return fresh;
}

/** A task is shown once per session: one the agent leaves pending doesn't wake it again (its skill's own check is the
 *  backstop), so a pending task can't loop the conversation. */
function markShown(state, fresh) {
  const shown = new Set(state.read("shown.json", []));
  for (const task of fresh) shown.add(task.row.qitemId);
  state.write("shown.json", [...shown]);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Claude Code UserPromptSubmit: a turn is running. */
function conversationTurn({ input = {}, deps = {} } = {}) {
  const env = deps.env ?? process.env;
  if (inSeat(env) || typeof input.session_id !== "string" || !input.session_id) return 0;
  const state = deps.state ?? conversationState("claude", input.session_id, { env });
  state?.write("turn.json", { at: (deps.now ?? Date.now)() });
  return 0;
}

/** Claude Code SessionStart and Stop (`asyncRewake`). Returns the exit code: 2 after writing tasks, or the no-`rig`
 *  notice, 0 otherwise. Only a conversation that handed work over with an address of its own waits: those addresses come
 *  from its own turns, and each turn's Stop starts a new waiter that reads them again. So a read that finds none ends
 *  this waiter rather than polling for two hours. A read that fails (a daemon restarting, say) doesn't: a conversation
 *  that handed work over is waiting for its team precisely because no turn is coming, so it's tried again after a
 *  longer wait each time, as the Codex watcher does, until the deadline. */
async function conversationWaiter({ input = {}, out = process.stderr, deps = {} } = {}) {
  const env = deps.env ?? process.env;
  if (inSeat(env)) return 0;
  const key = deps.key !== undefined ? deps.key : conversationKey({ env });
  if (typeof key !== "string" || !key.startsWith("claude:")) return 0;
  if (typeof input.session_id !== "string" || !input.session_id) return 0;
  const state = deps.state ?? conversationState("claude", input.session_id, { env });
  if (!state) return 0;
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  const rig = deps.rig !== undefined ? deps.rig : rigReader(env);
  // Nothing to read with: tell the conversation the way a task wakes it, once for the plugin's install.
  if (!rig) return (await sayNoRigOnce(state, (text) => writeAll(out, text), now)) ? 2 : 0;
  forgetNoRig(state);
  // The key names this conversation's Claude Code process: while it runs, another conversation's cleanup keeps this folder,
  // and so what was shown here, however long the conversation sits idle.
  const me = { pid: deps.pid ?? process.pid, startedAt: now(), event: typeof input.hook_event_name === "string" ? input.hook_event_name : "unknown", key };
  state.write("waiter.json", me);
  state.prune(deps.read);
  state.log(`armed ${me.event} for ${key}`);
  const routes = routeWatch(key, input.transcript_path, rig, now, deps.statSize);
  const deadline = me.startedAt + (deps.waiterMs ?? CONVERSATION_WAITER_MS);
  // The key ends with the conversation's claude pid: a waiter whose Claude Code has exited (killed with its terminal, say,
  // which needn't end its hooks) stops rather than polling to its deadline.
  const claudePid = Number(key.slice(key.lastIndexOf(":") + 1));
  // Consecutive failed reads: each waits twice as long as the one before, up to RETRY_MAX_MS.
  let failures = 0;
  const retryIn = () => Math.min(CONVERSATION_POLL_MS * 2 ** failures, RETRY_MAX_MS);
  while (now() < deadline) {
    if (state.read("waiter.json", {}).pid !== me.pid) { state.log("superseded"); return 0; }
    if (!(deps.alive ?? alive)(claudePid)) { state.log("stopped: the conversation's claude process ended"); return 0; }
    // A turn started after this waiter: nothing is written into it, and the turn's own Stop starts the next waiter.
    if (Number(state.read("turn.json", {}).at ?? 0) > me.startedAt) { await wait(CONVERSATION_POLL_MS); continue; }
    const current = routes();
    if (current && current.size === 0) { state.log("no address under this conversation's key: nothing to wait for until a turn hands work over"); return 0; }
    const fresh = current && freshTasks(current, state, rig);
    if (!fresh) {
      failures += 1;
      state.log(`OpenRig couldn't be read, trying again in ${retryIn() / 1000} s`);
      await wait(retryIn());
      continue;
    }
    failures = 0;
    if (fresh.length > 0) {
      if (!(await writeAll(out, renderConversationTasks(fresh)))) return 0;
      markShown(state, fresh);
      state.log(`woke with ${fresh.map((task) => task.row.qitemId).join(",")}`);
      return 2;
    }
    await wait(CONVERSATION_POLL_MS);
  }
  state.log("deadline");
  return 0;
}

/** Codex SessionStart (async): one detached watcher per session. A resumed, cleared or compacted session keeps the live one. */
function codexStart({ input = {}, deps = {} } = {}) {
  const env = deps.env ?? process.env;
  const sessionId = String(input.session_id ?? "");
  if (inSeat(env) || !UUID_RE.test(sessionId)) return 0;
  const state = deps.state ?? conversationState("codex", sessionId, { env });
  if (!state) return 0;
  const now = deps.now ?? Date.now;
  state.remove("stop.json");
  const current = state.read("watcher.json", {});
  if (current.pid && (deps.alive ?? alive)(current.pid) && now() - Number(current.beat ?? 0) < WATCHER_LIVE_MS) return 0;
  const spawn = deps.spawn ?? require("node:child_process").spawn;
  // The Codex process this hook runs under, by pid and start time, so the watcher stops if it exits without a SessionEnd,
  // and a later process given its pid doesn't keep the watcher running; none when it can't be seen.
  const codex = deps.codex !== undefined ? deps.codex : nearestAgent(process.pid, processReader(), "codex");
  const child = spawn(process.execPath, [__filename, "codex-watch", sessionId, typeof input.transcript_path === "string" ? input.transcript_path : "",
    String(codex?.pid || 0), codex?.start ?? ""], { detached: true, stdio: "ignore", env, cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : undefined });
  state.write("watcher.json", { pid: child.pid, beat: now() });
  child.unref?.();
  state.log(`started watcher ${child.pid}`);
  return 0;
}

/** Codex SessionEnd: the watcher stops at its next tick. */
function codexEnd({ input = {}, deps = {} } = {}) {
  const env = deps.env ?? process.env;
  const sessionId = String(input.session_id ?? "");
  if (inSeat(env) || !UUID_RE.test(sessionId)) return 0;
  const state = deps.state ?? conversationState("codex", sessionId, { env });
  state?.write("stop.json", { at: (deps.now ?? Date.now)() });
  state?.log("session ended");
  return 0;
}

/** How a Codex without `--resume` on `codex queue` (0.162.1, say) answers it: an unknown argument, before doing anything. */
const RESUME_REJECTED = /unexpected argument '--resume'|Found argument '--resume'|unrecognized (?:argument|option):? '?--resume/i;
/** Said once in a thread whose Codex has no `--resume`, ahead of the first tasks queued without it. */
const NO_RESUME_NOTICE = "This Codex's `codex queue` has no `--resume`, so OpenRig's hook bridge, from the openrig plugin, can "
  + "store the team's tasks for this chat but can't start a turn for them while the chat is idle: they come in at its next "
  + "turn, as these did. Codex 0.171.0 starts that turn by itself, so updating Codex brings them in as they arrive. The "
  + "plugin says this once in this chat; tell the person in plain words.\n\n";
const NO_RESUME = "no-resume.json";

/** `codex queue` stores the message for the thread, and with `--resume` (Codex 0.171.0) wakes it when idle; a busy thread,
 *  or one queued without `--resume`, gets it when its next turn ends. `resumeRejected` when this Codex refused the flag. */
function codexQueue(sessionId, text, { env = process.env, resume = true, spawnSync = require("node:child_process").spawnSync } = {}) {
  try {
    const result = spawnSync("codex", ["queue", "--thread", sessionId, "--message", text, ...(resume ? ["--resume"] : [])],
      { env, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    const ok = !result.error && result.status === 0;
    return { ok, detail: oneLine(result.error?.message ?? result.stderr ?? `exit ${result.status}`),
      resumeRejected: !ok && resume && RESUME_REJECTED.test(String(result.stderr ?? "")) };
  } catch (error) { return { ok: false, detail: oneLine(error?.message), resumeRejected: false }; }
}

/** The watcher's `codex queue`: with `--resume` until this Codex refuses it, then without it for the rest of the watch (the
 *  task waits for the thread's next turn), and the thread is told why once, ahead of the first tasks queued that way. */
function codexQueuer(sessionId, state, { env = process.env, now = Date.now, run = codexQueue } = {}) {
  let resume = true;
  return (text, { tasks = false } = {}) => {
    if (resume) {
      const tried = run(sessionId, text, { env, resume: true });
      if (!tried.resumeRejected) return tried;
      resume = false;
      state.log(`this codex queue has no --resume: queueing for the thread's next turn (${tried.detail})`);
    }
    const tell = tasks && !state.exists(NO_RESUME);
    const sent = run(sessionId, tell ? NO_RESUME_NOTICE + text : text, { env, resume: false });
    if (sent.ok && tell) state.write(NO_RESUME, { at: now() });
    return sent;
  };
}

/** The tasks in order, in batches whose rendered message fits in `max` bytes of UTF-8; a task too large for any batch goes
 *  alone. */
function byteBatches(fresh, max) {
  const batches = [];
  for (const task of fresh) {
    const last = batches[batches.length - 1];
    if (last && Buffer.byteLength(renderConversationTasks([...last, task])) <= max) last.push(task);
    else batches.push([task]);
  }
  return batches;
}

/** The Codex watcher. Returns 0 when its session ended, its Codex process exited (or its pid now names a process that
 *  started at another time), a newer watcher replaced it, or its rollout went idle with no Codex process to observe. */
async function codexWatch({ sessionId = "", transcriptPath = "", codexPid = 0, codexPidStart = "", deps = {} } = {}) {
  const env = deps.env ?? process.env;
  if (inSeat(env) || !UUID_RE.test(sessionId)) return 0;
  const key = `codex:${sessionId.toLowerCase()}`;
  const state = deps.state ?? conversationState("codex", sessionId, { env });
  if (!state) return 0;
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  // codex-start runs the watcher in the session's folder, which stands in for Claude Code's CLAUDE_PROJECT_DIR.
  const projectDir = deps.projectDir ?? process.cwd();
  const lookForRig = deps.rig !== undefined ? () => deps.rig : () => sessionRigReader(env, projectDir, deps.loginPath);
  let rig = lookForRig();
  const queue = deps.queue ?? codexQueuer(sessionId, state, { env, now });
  const statSize = deps.statSize ?? ((p) => fs.statSync(p).size);
  const me = deps.pid ?? process.pid;
  state.write("watcher.json", { pid: me, beat: now() });
  state.prune(deps.read);
  if (!rig) {
    // The person may install OpenRig in this very conversation, as the rigs skill has them do: keep looking, and watch from
    // the tick a `rig` turns up, instead of leaving the conversation without wakes until a new session.
    await sayNoRigOnce(state, (text) => queue(text).ok, now);
    state.log(`no rig yet: looking again every ${NO_RIG_RETRY_MS / 1000} s while this session runs`);
  }
  let routes = null;
  let size = null;
  let grewAt = now();
  // Consecutive ticks whose read or queue failed: each waits twice as long as the one before, up to RETRY_MAX_MS, so a
  // stopped daemon or a failing `codex queue` isn't retried, with a new process each time, every 15 seconds.
  let failures = 0;
  const retryIn = () => Math.min(CONVERSATION_POLL_MS * 2 ** failures, RETRY_MAX_MS);
  for (;;) {
    if (state.exists("stop.json")) { state.log("stopped: the session ended"); return 0; }
    if (state.read("watcher.json", {}).pid !== me) { state.log("superseded"); return 0; }
    // Read afresh each tick: a reader keeps the process table it read first.
    if (codexPid > 0 && !stillRunning(codexPid, codexPidStart, { read: deps.read ?? processReader(), isAlive: deps.alive ?? alive })) {
      state.log("stopped: the session's codex process ended");
      return 0;
    }
    state.write("watcher.json", { pid: me, beat: now() });
    let current = null;
    try { current = transcriptPath ? statSize(transcriptPath) : null; } catch { current = null; }
    if (current !== size) { size = current; grewAt = now(); }
    if (codexPid <= 0 && now() - grewAt > CODEX_IDLE_EXIT_MS) { state.log("stopped: the session's rollout went idle"); return 0; }
    if (!rig) {
      await wait(NO_RIG_RETRY_MS);
      rig = lookForRig();
      continue; // The session's checks above run again before the first read.
    }
    if (!routes) {
      forgetNoRig(state);
      state.log(`watching for ${key}`);
      routes = routeWatch(key, transcriptPath, rig, now, statSize);
    }
    const read = routes();
    const fresh = read && freshTasks(read, state, rig);
    if (!fresh) {
      failures += 1;
      state.log(`OpenRig couldn't be read, trying again in ${retryIn() / 1000} s`);
    } else if (fresh.length > 0) {
      // In order, in batches that each fit one argument with room for the notice codexQueuer may put ahead. Each is marked
      // shown once stored; after one fails, it and the rest come at a later tick.
      let queued = { ok: true, detail: "" };
      for (const batch of byteBatches(fresh, QUEUE_MESSAGE_MAX_BYTES - Buffer.byteLength(NO_RESUME_NOTICE))) {
        queued = queue(renderConversationTasks(batch), { tasks: true });
        if (!queued.ok) break;
        markShown(state, batch);
        state.log(`queued for the thread (stored, not proof it was read): ${batch.map((task) => task.row.qitemId).join(",")}`);
      }
      if (queued.ok) {
        failures = 0;
      } else {
        failures += 1;
        state.log(`codex queue failed, trying again in ${retryIn() / 1000} s: ${queued.detail}`);
      }
    } else {
      failures = 0;
    }
    await wait(retryIn());
  }
}

async function main() {
  const mode = process.argv[2];
  // A seat keeps its own delivery: the conversation modes end before reading anything.
  if (CONVERSATION_MODES.has(mode) && inSeat()) { process.exitCode = 0; return; }
  if (mode === "codex-watch") {
    await codexWatch({ sessionId: process.argv[3] ?? "", transcriptPath: process.argv[4] ?? "", codexPid: Number(process.argv[5] ?? 0) || 0,
      codexPidStart: process.argv[6] ?? "" }).catch(() => 0);
    process.exit(0);
  }
  const input = await readHookInput();
  if (mode === "turn") { await post("turn", { hookEvent: "UserPromptSubmit" }); process.exitCode = 0; return; }
  if (mode === "conversation-turn") { process.exitCode = conversationTurn({ input }); return; }
  if (mode === "codex-start") { process.exitCode = codexStart({ input }); return; }
  if (mode === "codex-end") { process.exitCode = codexEnd({ input }); return; }
  if (mode !== "waiter" && mode !== "conversation-waiter") { process.exitCode = 0; return; }
  const code = mode === "waiter"
    ? await waiter({ hookEvent: typeof input.hook_event_name === "string" ? input.hook_event_name : "unknown" }).catch(() => 0)
    : await conversationWaiter({ input }).catch(() => 0);
  // exitCode, not exit(): the process ends once its output is flushed. The batch was already written in full above; if
  // an idle connection still holds the loop open, end it shortly after, with the same code.
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
}

if (require.main === module) void main();
module.exports = {
  render, waiter, endpoint,
  CONVERSATION_KEY_TAG_PREFIX, conversationKey, conversationKeyTag, processReader, conversationRoutes, renderConversationTasks,
  conversationWaiter, conversationTurn, codexStart, codexEnd, codexWatch, findRig, loginShellPath,
};
