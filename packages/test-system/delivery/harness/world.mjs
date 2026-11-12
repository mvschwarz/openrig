// One cell's world: a fresh home, a stand-in model, a private OpenRig daemon and its own tmux server, and one seat
// running the real program under test against the stand-in. Everything is built from nothing for each cell and torn
// down at the end with a normal stop, and it's meant to run inside contain.mjs's loopback-only namespace.
//
// Nothing here reads or writes the person's own home, profile, accounts or daemon: the environment is built from an
// allowlist, not inherited, so the caller's HOME, OPENRIG_*, TMUX, CLAUDE_CONFIG_DIR, CODEX_HOME and credentials never
// reach the cell. The program's only credential is a dummy token that the stand-in accepts.

import { execFile, spawn } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startMessagesStandIn } from "../stand-ins/messages.mjs";
import { startResponsesStandIn } from "../stand-ins/responses.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The credential a program is given: obviously not a real one, and the only one in the cell. */
export const DUMMY_TOKEN = "delivery-suite-dummy-token-not-a-credential";
export const RIG = "dlv";

async function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); });
  });
}

/** The environment every process in the cell starts from, and nothing else. */
function cellEnv({ root, home, sockets, binDirs, realTmux, arm, tmuxLog }) {
  return {
    HOME: home,
    USER: process.env.USER ?? "delivery",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "delivery",
    SHELL: "/bin/sh",
    PATH: [...binDirs, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    TZ: "UTC",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMUX_TMPDIR: sockets,
    TMPDIR: join(root, "tmp"),
    OPENRIG_HOME: join(home, ".openrig"),
    OPENRIG_NO_KERNEL: "1",
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    DELIVERY_REAL_TMUX: realTmux,
    DELIVERY_TMUX_LOG: tmuxLog,
    DELIVERY_ARM: arm,
    DELIVERY_INJECT_DIR: join(root, "inject"),
  };
}

/** What the seat's program is given through its rig spec: the stand-in, a dummy token, and no update or telemetry
 *  traffic. Claude Code's model settings reach a seat only this way (or through the daemon's provider allowlist). */
function seatEnv(kind, standInUrl) {
  if (kind === "claude") {
    return {
      ANTHROPIC_BASE_URL: standInUrl,
      ANTHROPIC_AUTH_TOKEN: DUMMY_TOKEN,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    };
  }
  return {};
}

/** Codex reaches the stand-in as a custom provider, which also skips its login screen. OpenRig adds the workspace's
 *  trust to this same file at launch. */
function codexConfig(standInUrl) {
  return [
    'model = "stand-in"',
    'model_provider = "standin"',
    "check_for_update_on_startup = false",
    "",
    "[model_providers.standin]",
    'name = "stand-in"',
    `base_url = "${standInUrl}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

function rigSpec(kind, env) {
  const runtime = kind === "claude" ? "claude-code" : "codex";
  const envLines = Object.entries(env).map(([key, value]) => `          ${key}: ${JSON.stringify(value)}`);
  return [
    'version: "0.2"',
    `name: ${RIG}`,
    "pods:",
    "  - id: p",
    "    label: Delivery",
    "    members:",
    `      - id: seat`,
    '        agent_ref: "local:agents/worker"',
    "        profile: default",
    `        runtime: ${runtime}`,
    "        cwd: .",
    ...(envLines.length ? ["        env:", ...envLines] : []),
    "    edges: []",
    "",
  ].join("\n");
}

// The seat's agent: the shared pool imported as built-in agents do, selecting OpenRig's own plugin (its skills and, on
// Claude Code, its hooks) and the managed activity hooks, as a normal seat has. It leaves out the shared default
// settings and MCP fragment, which turn on network MCP servers a cell can't reach.
const WORKER = ["name: worker", 'version: "1.0.0"', "imports:", "  - ref: local:../../shared", "resources:", "  skills: []", "profiles:", "  default:", "    uses:",
  "      skills: []", "      plugins: [shared:openrig-core]", "      runtime_resources: [shared:claude-activity-hooks]", ""].join("\n");

/** The shared spec pool of the OpenRig under test: a package keeps it in daemon/specs, a checkout in packages/daemon. */
function sharedSpecs(openrig) {
  const pkg = dirname(dirname(realpathSync(openrig)));
  const found = [join(pkg, "daemon", "specs", "agents", "shared"), join(pkg, "..", "daemon", "specs", "agents", "shared")].find((d) => existsSync(join(d, "agent.yaml")));
  if (!found) throw new Error(`no shared agent specs beside ${openrig}`);
  return found;
}

/**
 * Open a cell. `program` is { kind: "claude" | "codex", bin } with bin the installed binary's absolute path; `openrig`
 * is the absolute path of the `rig` entry under test (its bin-wrapper.js). `script` is the stand-in's script.
 */
export async function openCell({ dir, arm, program, openrig, script, realTmux, readyTimeoutMs = 120_000, claudeSettings = null }) {
  const root = resolve(dir);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const work = join(root, "work");
  const logs = join(root, "logs");
  for (const d of [home, bin, work, logs, join(root, "tmp"), join(root, "inject"), join(root, "rig", "agents", "worker"), join(home, ".openrig"), join(home, ".claude"), join(home, ".codex")]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  // A unix socket's path is limited to about 108 bytes, and a cell's own directory can be deep, so its tmux socket
  // lives in a short private directory of its own instead, removed when the cell closes.
  const sockets = mkdtempSync("/tmp/dlv-");
  chmodSync(sockets, 0o700);
  if (Buffer.byteLength(join(sockets, `tmux-${process.getuid()}`, "default")) > 100) throw new Error(`the tmux socket path under ${sockets} is too long`);
  // Who the cell's processes are, for a reap from outside if this process is stopped before it can close the cell.
  writeFileSync(join(root, "identity.json"), JSON.stringify({ home, sockets }));
  // The program and the logging tmux come first on PATH; node is needed by the rig CLI and a node-based program.
  symlinkSync(join(HERE, "tmux"), join(bin, "tmux"));
  symlinkSync(program.bin, join(bin, program.kind));
  const tmuxLog = join(logs, "tmux-argv.jsonl");
  const env = cellEnv({ root, home, sockets, binDirs: [bin, dirname(process.execPath)], realTmux, arm, tmuxLog });

  const steps = [];
  const record = (step) => { const entry = { at: new Date().toISOString(), ...step }; steps.push(entry); appendFileSync(join(logs, "steps.jsonl"), `${JSON.stringify(entry)}\n`); };

  const standInLog = join(logs, "stand-in.jsonl");
  const standIn = program.kind === "claude"
    ? await startMessagesStandIn({ script, logPath: standInLog })
    : await startResponsesStandIn({ script, logPath: standInLog });
  record({ step: "stand-in", url: standIn.url, tmuxSockets: sockets });
  if (program.kind === "codex") writeFileSync(join(home, ".codex", "config.toml"), codexConfig(standIn.url), { mode: 0o600 });
  // A case's own Claude settings, such as allowing one harmless command, so a busy case isn't a permission case.
  if (program.kind === "claude" && claudeSettings) writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(claudeSettings, null, 2), { mode: 0o600 });

  const rig = async (args, { timeout = 60_000, allowFail = false } = {}) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [openrig, ...args], { env, cwd: work, timeout, maxBuffer: 16 << 20 });
      record({ step: "rig", args, exit: 0 });
      return { exit: 0, stdout, stderr };
    } catch (error) {
      record({ step: "rig", args, exit: error.code ?? null, signal: error.signal ?? null, stderr: String(error.stderr ?? "").slice(0, 2000) });
      if (!allowFail) throw new Error(`rig ${args.join(" ")} failed (${error.code ?? error.signal}): ${String(error.stderr ?? error.message).trim().slice(0, 600)}`);
      return { exit: error.code ?? null, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
    }
  };
  // The harness's own tmux reads go straight to the real binary, so the argv log holds only OpenRig's calls.
  const tmux = async (args) => (await run(realTmux, args, { env, timeout: 15_000 })).stdout;

  const port = await freePort();
  env.OPENRIG_URL = `http://127.0.0.1:${port}`;
  const cell = { root, home, env, logs, standIn, rig, tmux, steps, record, session: null, port, program, sockets };
  // From here on processes exist, so a cell that fails to open still stops everything it started.
  try {
    await rig(["daemon", "start", "--port", String(port), "--no-kernel"], { timeout: 90_000 });
    const shared = sharedSpecs(openrig);
    cpSync(shared, join(root, "rig", "shared"), { recursive: true });
    writeFileSync(join(root, "rig", "agents", "worker", "agent.yaml"), WORKER);
    record({ step: "seat-profile", plugins: ["shared:openrig-core"], runtimeResources: ["shared:claude-activity-hooks"], sharedFrom: shared });
    const specPath = join(root, "rig", "rig.yaml");
    writeFileSync(specPath, rigSpec(program.kind, seatEnv(program.kind, standIn.url)));
    await rig(["up", specPath, "--json", "--yes", "--cwd", work], { timeout: 180_000 });
    cell.session = await waitReady(cell, program.kind, readyTimeoutMs);
    return cell;
  } catch (error) {
    await closeCell(cell).catch((closeError) => record({ step: "close-after-failure", error: String(closeError) }));
    throw error;
  }
}

/** The seat's node row, as `rig ps --nodes` serves it. */
export async function seatNode(cell) {
  const { stdout } = await cell.rig(["ps", "--nodes", "--rig", RIG, "--full", "--json"], { allowFail: true });
  try {
    const parsed = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed : parsed.entries ?? [];
    return rows[0] ?? null;
  } catch { return null; }
}

/** The seat's pane: the program running in it and what the screen shows. */
export async function paneState(cell, target = cell.session) {
  const info = (await cell.tmux(["display-message", "-p", "-t", target, "#{pane_current_command}\t#{pane_pid}\t#{window_width}x#{window_height}\t#{pane_in_mode}"])).trim().split("\t");
  const screen = await cell.tmux(["capture-pane", "-p", "-t", target]);
  return { command: info[0], panePid: Number(info[1]), size: info[2], inMode: info[3] === "1", screen };
}

/** A process's name and parent from /proc/<pid>/stat. The name can hold spaces and parentheses, so the fields are
 *  read after the last ")". */
export function parseStat(pid, stat) {
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  return { pid, comm: stat.slice(stat.indexOf("(") + 1, close), state: fields[0], ppid: Number(fields[1]) };
}

function procStat(pid) {
  try { return parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return null; }
}

function procExe(pid) {
  try { return realpathSync(`/proc/${pid}/exe`); } catch { return null; }
}

/** Every process under `pid`, with its executable: a program can run as a child of the launch script, so the pane's
 *  foreground command alone doesn't say which program is running. */
export function processTree(pid) {
  const all = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map((name) => procStat(Number(name))).filter(Boolean);
  const out = [];
  const visit = (parent) => {
    for (const child of all.filter((p) => p.ppid === parent)) { out.push({ ...child, exe: procExe(child.pid) }); visit(child.pid); }
  };
  const self = procStat(pid);
  if (self) out.push({ ...self, exe: procExe(pid) });
  visit(pid);
  return out;
}

/** The program's own process in the seat's pane: one running a file from the program's install (its executable, or
 *  the script node was given). The entry on PATH may be a launcher for a binary vendored beside it, as Codex's is.
 *  Null when the pane holds only a shell. */
export function programProcess(cell, panePid) {
  const entry = realpathSync(cell.program.bin);
  const install = entry.includes("/node_modules/") ? `${entry.split("/node_modules/")[0]}/` : `${dirname(entry)}/`;
  const fromInstall = (path) => typeof path === "string" && (path === entry || path.startsWith(install));
  return processTree(panePid).find((p) => {
    if (p.state === "Z") return false;
    if (fromInstall(p.exe)) return true;
    try { return readFileSync(`/proc/${p.pid}/cmdline`, "utf8").split("\0").some((arg) => arg.startsWith("/") && fromInstall(realpathSync(arg))); } catch { return false; }
  }) ?? null;
}

/** Wait until OpenRig reports the seat ready and the real program is running in its pane (not a shell it fell back
 *  to). A seat that never gets there fails the cell with what was seen. */
async function waitReady(cell, kind, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await seatNode(cell);
    const session = last?.canonicalSessionName;
    if (session && last.startupStatus === "ready") {
      const pane = await paneState(cell, session);
      const native = programProcess(cell, pane.panePid);
      cell.record({ step: "ready", session, startupStatus: last.startupStatus, pane: { command: pane.command, size: pane.size },
        program: native && { pid: native.pid, comm: native.comm, exe: native.exe } });
      if (!native) {
        throw new Error(`the seat is ready but no ${kind} process runs in its pane (foreground: ${pane.command})\n${pane.screen}`);
      }
      cell.programPid = native.pid;
      cell.paneId = (await cell.tmux(["display-message", "-p", "-t", session, "#{pane_id}"])).trim();
      return session;
    }
    if (last?.startupStatus === "failed" || last?.startupStatus === "attention_required") break;
    await sleep(1000);
  }
  let screen = "";
  if (last?.canonicalSessionName) { try { screen = (await paneState(cell, last.canonicalSessionName)).screen; } catch { /* the pane may be gone */ } }
  throw new Error(`the seat didn't become ready: ${JSON.stringify({ startupStatus: last?.startupStatus, latestError: last?.latestError })}\n${screen}`);
}

/** Whether an environment (/proc/<pid>/environ: NUL-separated entries) belongs to the cell: an entry that is exactly
 *  its HOME or its tmux socket directory. A suffix such as XHOME=<cell home> isn't one. */
export function ownsEnviron(environ, { home, sockets }) {
  const entries = environ.split("\0");
  return entries.includes(`HOME=${home}`) || (!!sockets && entries.includes(`TMUX_TMPDIR=${sockets}`));
}

/** This user's processes started for the cell (see ownsEnviron), by its identity: { home, sockets }. */
export function processesOf(identity) {
  const uid = String(process.getuid());
  return readdirSync("/proc").filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid).flatMap((name) => {
    try {
      if (readFileSync(`/proc/${name}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1] !== uid) return [];
      return ownsEnviron(readFileSync(`/proc/${name}/environ`, "latin1"), identity) ? [procStat(Number(name))].filter(Boolean) : [];
    } catch { return []; }
  }).filter((p) => p.state !== "Z");
}

export const cellProcesses = (cell) => processesOf({ home: cell.home, sockets: cell.sockets });

/** SIGTERM whatever of the cell's is still running, then SIGKILL what's left, then look again: returns { steps,
 *  unresolved }. `steps` is what was signalled; `unresolved` is every process still running after a bounded re-scan,
 *  plus every signal that failed for a reason other than the process being gone (ESRCH). Usable from inside the cell
 *  and, by its identity file, from the parent after the cell's own process is gone. The socket directory is removed only
 *  when nothing is unresolved, so a surviving tmux server keeps its socket for inspection. `deps` replace the process
 *  table and the signal call in tests. */
export async function reapByIdentity(identity, { list = processesOf, kill = (pid, signal) => process.kill(pid, signal), pause = sleep } = {}) {
  const steps = [];
  const failed = new Map();
  const signal = (procs, name) => {
    for (const p of procs) {
      try { kill(p.pid, name); } catch (error) {
        if (error?.code !== "ESRCH") failed.set(p.pid, { pid: p.pid, comm: p.comm, error: `${name}: ${error?.code ?? error?.message ?? error}` });
      }
    }
  };
  let left = list(identity);
  if (left.length) {
    steps.push({ signal: "SIGTERM", processes: left.map(({ pid, comm }) => ({ pid, comm })) });
    signal(left, "SIGTERM");
    for (let i = 0; i < 20 && left.length; i++) { await pause(250); left = list(identity); }
    if (left.length) {
      steps.push({ signal: "SIGKILL", processes: left.map(({ pid, comm }) => ({ pid, comm })) });
      signal(left, "SIGKILL");
      for (let i = 0; i < 8 && left.length; i++) { await pause(250); left = list(identity); }
    }
  }
  const unresolved = [...left.map(({ pid, comm }) => failed.get(pid) ?? { pid, comm }), ...[...failed.values()].filter((f) => !left.some((p) => p.pid === f.pid))];
  if (!unresolved.length && identity.sockets?.startsWith("/tmp/dlv-")) rmSync(identity.sockets, { recursive: true, force: true });
  return { steps, unresolved };
}

/** Stop the cell normally: the rig, then the daemon, then its private tmux server, then the stand-in. Whatever of the
 *  cell's is still running after that is reaped and recorded: a cell never outlives its run. */
export async function closeCell(cell) {
  if (cell.env.OPENRIG_URL) {
    await cell.rig(["down", RIG, "--json", "--yes"], { allowFail: true, timeout: 90_000 });
    await cell.rig(["daemon", "stop"], { allowFail: true, timeout: 60_000 });
  }
  try { await cell.tmux(["kill-server"]); } catch { /* already gone */ }
  await cell.standIn.close();
  const reaped = await reapByIdentity({ home: cell.home, sockets: cell.sockets });
  for (const step of reaped.steps) cell.record({ step: "reap", ...step });
  if (reaped.unresolved.length) cell.record({ step: "reap-unresolved", unresolved: reaped.unresolved });
  cell.unresolved = reaped.unresolved;
  cell.record({ step: "closed" });
}

export { sleep, existsSync };
