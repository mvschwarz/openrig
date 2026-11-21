import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const PRODUCER = "openrig-cursor-launch-windows 1";
const env = process.env;

/** Managed run authority belongs to the parent runner, never this native TUI or its probes. */
delete env.OPENRIG_RUN_ID;
delete env.OPENRIG_ACTIVITY_HOOK_TOKEN;

// Each seat gets its own Cursor config folder unless one is already set, so a seat never rewrites the person's Cursor
// state. Cursor's login isn't in it: it lives in the OS credential store.
if (!env.CURSOR_CONFIG_DIR && env.OPENRIG_HOME) {
  env.CURSOR_CONFIG_DIR = join(env.OPENRIG_HOME, "state", "cursor", encodeURIComponent(env.OPENRIG_NODE_ID || env.OPENRIG_SESSION_NAME || "default"));
  mkdirSync(env.CURSOR_CONFIG_DIR, { recursive: true });
}

/**
 * The agent as an executable plus leading arguments.
 *
 * `OPENRIG_CURSOR_AGENT` wins so a probe can point at a stub, and may name a `.js`/`.mjs` script (run by this Node), a
 * native `.exe`, or the CLI's install directory. Otherwise the installed CLI is found by its version directory.
 */
function resolveAgent() {
  const configured = env.OPENRIG_CURSOR_AGENT;
  if (configured) {
    const fromConfigured = entryUnder(configured);
    if (fromConfigured) return fromConfigured;
    if (/\.(mjs|cjs|js)$/i.test(configured) && existsSync(configured)) return [process.execPath, configured];
    if (/\.exe$/i.test(configured) && existsSync(configured)) return [configured];
    throw new Error(`OPENRIG_CURSOR_AGENT points at no usable Cursor entry: ${configured}`);
  }
  for (const root of installRoots()) {
    const entry = newestVersionEntry(root) ?? newestVersionEntry(join(root, "versions"));
    if (entry) return entry;
  }
  throw new Error("Cursor CLI wasn't found: set OPENRIG_CURSOR_AGENT, or install cursor-agent");
}

/** A version directory's own node + index.js, when the given path is (or is inside) a Cursor install. */
function entryUnder(candidate) {
  const roots = [];
  if (/\.(cmd|ps1|bat)$/i.test(candidate)) roots.push(dirname(candidate));
  else if (statIsDirectory(candidate)) roots.push(candidate);
  if (!roots.length) return null;
  for (const root of roots) {
    const entry = newestVersionEntry(root) ?? newestVersionEntry(join(root, "versions"));
    if (entry) return entry;
  }
  return null;
}

function statIsDirectory(value) {
  try { return statSync(value).isDirectory(); } catch { return false; }
}

/** `versions/<date>-<build>[-<time>]-<commit>/`, newest first, each holding `node.exe` and `index.js`. */
function newestVersionEntry(root) {
  let names;
  try { names = readdirSync(root); } catch { return null; }
  const versions = names
    .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i.test(name))
    .sort()
    .reverse();
  for (const version of versions) {
    const dir = join(root, version);
    const node = join(dir, "node.exe");
    const index = join(dir, "index.js");
    if (existsSync(node) && existsSync(index)) return [realpathSync.native(node), index];
  }
  return null;
}

/** Where a cursor-agent install keeps `versions/`: the env, the per-user installs, and each PATH entry naming it. */
function installRoots() {
  const roots = [];
  // A seat's launch PATH is curated and needn't name the CLI, so the per-user install locations are checked directly.
  const home = env.USERPROFILE || env.HOME;
  for (const base of [env.LOCALAPPDATA, env.APPDATA, home && join(home, ".local", "share"), home && join(home, ".local")]) {
    if (base) roots.push(join(base, "cursor-agent"));
  }
  if (home) roots.push(join(home, ".cursor-agent"));
  for (const dir of (env.PATH ?? "").split(";")) {
    if (dir && /cursor/i.test(dir)) roots.push(dir.replace(/^"(.*)"$/, "$1"));
  }
  return roots;
}

/** Write this attempt's record where OpenRig asked for it; nothing when it didn't ask. */
function report(record) {
  const target = env.OPENRIG_LAUNCH_RESULT;
  if (!target) return;
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ format: 1, attempt: env.OPENRIG_LAUNCH_ATTEMPT ?? "", harness: "cursor", producer: PRODUCER, ...record }), { flag: "wx", mode: 0o600 });
  renameSync(tmp, target);
}

function plainId(value) {
  return typeof value === "string" && value.length > 0 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

/** Where Cursor keeps this chat for this working directory. */
function chatStore(id) {
  if (!env.CURSOR_CONFIG_DIR) return null;
  return join(env.CURSOR_CONFIG_DIR, "chats", createHash("md5").update(process.cwd(), "utf8").digest("hex"), id, "store.db");
}

// Start an interactive pane. Cursor retains its workspace and tool approval prompts.


/** The seat's declared model goes to a new chat and to a resume; Cursor honours it in both (measured). */
function modelArgs() {
  return modelId() ? ["--model", modelId()] : [];
}

// Cursor uses max for OpenRig’s xhigh effort.
const EFFORT_MAP = {
  none: "none", minimal: "none",
  low: "low",
  medium: "medium", med: "medium",
  high: "high",
  xhigh: "max", max: "max",
};

function cursorEffortFor(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.hasOwn(EFFORT_MAP, normalized) ? EFFORT_MAP[normalized] : undefined;
}

/**
 * Which model to launch: the seat's model family with its effort folded into Cursor's own id spelling.
 *
 * An unmapped effort leaves the declared model exactly as it arrived — the runtime's default, never a substituted level.
 */
function modelId() {
  const declared = env.OPENRIG_MODEL?.trim();
  if (!declared) return undefined;
  const mapped = cursorEffortFor(env.OPENRIG_EFFORT);
  if (!mapped) return declared;
  const family = modelFamily(declared);
  return family ? `${family}-${mapped}` : declared;
}

/** The declared model with any effort suffix removed, so the effort is applied once and never doubled. */
function modelFamily(declared) {
  const stripped = declared.replace(/-(none|low|medium|high|max)$/i, "");
  // Only strip when what's left is still a family: a model whose own name ends in one of those words keeps it.
  return stripped.includes("-") ? stripped : declared;
}

/**
 * `create-chat` prints its id and then keeps running. Wait for the first line, then terminate the whole tree: the agent
 * starts its own child, so killing only this child would leave that one behind.
 */
async function createChat([program, ...prefix]) {
  const dist = env.OPENRIG_DAEMON_DIST;
  if (!dist) throw new Error("Set OPENRIG_DAEMON_DIST to the installed daemon's dist directory.");
  const { spawnWindowsJobProcess } = await import(pathToFileURL(join(dist, "domain", "windows-job-process.js")).href);
  return new Promise((resolve) => {
    const child = spawnWindowsJobProcess(program, [...prefix, "create-chat"], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let settled = false;
    const finish = (id) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      // Terminate the tree whether or not an id arrived: `create-chat` never exits on its own.
      child.kill();
      child.once("close", () => resolve({ id, stderr }));
    };
    const poll = setInterval(() => {
      const line = stdout.split(/\r?\n/)[0]?.trim();
      if (line) finish(line);
    }, 50);
    // Leave time for the owned process to close and the pane to spawn before the daemon's 20s receipt deadline.
    const timer = setTimeout(() => finish(null), 15_000);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(stdout.split(/\r?\n/)[0]?.trim() || null));
  });
}

/** Start the agent and stay its parent, so the pane's foreground process is this launcher for the seat's lifetime.
 *  The terminal is inherited: a TUI renders only when it owns the pane outright. */
function runAgent(agent, args, nativeRef) {
  const [program, ...prefix] = agent;
  const child = spawn(program, [...prefix, ...args], { env, windowsHide: false, stdio: "inherit" });
  child.once("spawn", () => report({ nativeRef }));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { try { child.kill(signal); } catch { /* the child may already be gone */ } });
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on("error", (error) => {
    process.stderr.write(`openrig-cursor-launch: couldn't start Cursor: ${error.message}\n`);
    process.exit(1);
  });
}

let agent;
try { agent = resolveAgent(); }
catch (error) {
  // Nothing was started and no record is written, so the seat's identity reads as unavailable rather than confirmed.
  process.stderr.write(`openrig-cursor-launch: ${error.message}\n`);
  process.exit(1);
}

const resumeRef = env.OPENRIG_RESUME_REF;
if (resumeRef) {
  if (!plainId(resumeRef)) {
    process.stderr.write("openrig-cursor-launch: refusing an unusual chat id\n");
    process.exit(2);
  }
  const store = chatStore(resumeRef);
  // Checked before starting: `--resume` on an id Cursor doesn't hold opens a new empty chat instead of failing.
  if (store && !existsSync(store)) {
    report({ error: "missing" });
    process.stderr.write(`openrig-cursor-launch: Cursor has no chat ${resumeRef} in ${env.CURSOR_CONFIG_DIR} for ${process.cwd()}; starting nothing\n`);
    process.exit(1);
  }
  runAgent(agent, ["--resume", resumeRef, ...modelArgs()], resumeRef);
} else {
  const created = await createChat(agent);
  if (!plainId(created.id)) {
    // No usable id: report nothing, so OpenRig shows the identity as unavailable.
    const detail = created.stderr.trim() ? `: ${created.stderr.trim().slice(0, 200)}` : "";
    process.stderr.write(`openrig-cursor-launch: create-chat gave no usable id${detail}\n`);
    process.exitCode = 1;
  } else {
    runAgent(agent, ["--resume", created.id, ...modelArgs()], created.id);
  }
}
