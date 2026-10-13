// Slice 01 (OPR.0.7.0.1) — one bounded read of the Claude login's usage windows. It runs only on an
// explicit refresh: ordinary provider reads never call it.
//
//   0. The `claude` executable is resolved on the reader's PATH; both steps run it by absolute path.
//   1. `claude auth status --json`: identity (only loggedIn, authMethod, email, orgId, and orgName and
//      subscriptionType as labels, are read), accepted only from a command that exits 0. A login that
//      isn't a claude.ai subscription, or none, is refused here: the screen never starts.
//   2. `claude --safe-mode --strict-mcp-config --tools "" --model <none> /usage` in a PRIVATE tmux server
//      (its own -S socket in a fresh temp dir, never the daemon's or a person's), read from the rendered
//      pane. `/usage` is a local command; the non-existent model makes any model request fail rather
//      than run. The only keys ever sent are the exit keys (Esc, Ctrl-C, Ctrl-C); a trust, sign-in or
//      y/n prompt stops the read unanswered.
//   3. `claude auth status --json` again: the identity must not have changed during the read.
//
// The whole read is bounded (45 s). On every exit, nothing it started keeps running: each `auth status`
// runs in its own process group, which is stopped (TERM, then KILL) when it ends or times out; the pane's
// process group is stopped the same way after the exit keys, then the private server is killed (by pid
// if kill-server fails) and its temp dir removed. A process that leaves its group (setsid) is out of reach.
// Claude runs with the HOME, CLAUDE_CONFIG_DIR and PATH a seat session gets, without TMUX, TMUX_PANE or
// any OpenRig seat variable, in the daemon's HOME. Side effects: like any Claude start in that config
// dir, it can update ~/.claude.json, add a history.jsonl line and a session file for the working
// directory, and refresh the login's token. The reader never opens a credentials file.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "../../adapters/shell-quote.js";
import { claudeUsageScreenReady } from "./claude-usage-screen.js";
import type { UsageReadOutcome } from "./usage-windows.js";

export type ClaudeUsageFailureReason =
  | "binary_not_found"
  | "tmux_unavailable"
  | "auth_status_failed"
  | "not_logged_in"
  | "not_subscription_login"
  | "interaction_required"
  | "usage_unavailable"
  | "unrecognized_shape"
  | "timeout"
  | "child_exited"
  | "identity_changed_during_read"
  | "identity_recheck_failed";

/** The `auth status` fields this reader uses; nothing else is kept. */
export interface ClaudeAuthFacts {
  loggedIn: boolean;
  authMethod: string | null;
  email: string | null;
  orgId: string | null;
  /** Labels only: never part of a key. */
  orgName: string | null;
  subscriptionType: string | null;
}

export type ClaudeUsageAnswer = { auth: ClaudeAuthFacts; screen: string };
export type ClaudeUsageReader = () => Promise<UsageReadOutcome<ClaudeUsageAnswer>>;

export interface ClaudeUsageReaderOptions {
  launchPath?: string;
  home?: string;
  claudeConfigDir?: string;
  deadlineMs?: number;
  pollMs?: number;
  now?: () => string;
  /** Where the private tmux server's temp dir is made (default: the OS temp dir). */
  tmpRoot?: string;
  /** How long a stopped process group gets after TERM before KILL (and after KILL before giving up). */
  graceMs?: number;
}

export const CLAUDE_USAGE_READ_DEADLINE_MS = 45_000;
/** A model name that doesn't exist: if `/usage` ever reached the model, the request is refused, not run. */
export const CLAUDE_USAGE_NO_MODEL = "openrig-usage-read-no-model";
export const CLAUDE_USAGE_SCREEN_ARGS = ["--safe-mode", "--strict-mcp-config", "--tools", "", "--model", CLAUDE_USAGE_NO_MODEL, "/usage"];
const AUTH_STATUS_MS = 10_000;
const GRACE_MS = 1_000;
const PROMPTS = /Do you trust the files|Is this a project you created|Sign in to Claude|Select login method|Enter y\/n|Press Enter to continue|Choose the text style/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The `claude` executable on the reader's own PATH, as an absolute path, or null. Both steps run this one
 *  binary, so a tmux (or pane shell) with another PATH can never start a different Claude. */
export function resolveClaudeExecutable(env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

/** The child environment: the seat's HOME/CLAUDE_CONFIG_DIR/PATH, never TMUX, TMUX_PANE or seat variables. */
export function claudeUsageReaderEnv(options: ClaudeUsageReaderOptions, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === "TMUX" || key === "TMUX_PANE" || key === "CLAUDECODE") continue;
    if (key.startsWith("OPENRIG_") || key.startsWith("RIGGED_") || key.startsWith("CLAUDE_CODE_")) continue;
    env[key] = value;
  }
  if (options.launchPath) env.PATH = options.launchPath;
  if (options.home) env.HOME = options.home;
  if (options.claudeConfigDir) env.CLAUDE_CONFIG_DIR = options.claudeConfigDir;
  env.TZ = "UTC";
  env.DISABLE_AUTOUPDATER = "1";
  env.TERM = "xterm-256color";
  return env;
}

interface Run { code: number | null; signal?: NodeJS.Signals | null; stdout: string; error?: NodeJS.ErrnoException; timedOut: boolean }

/** True once no process of the group remains, waiting up to `withinMs`. */
async function groupGone(pgid: number, withinMs: number): Promise<boolean> {
  const until = performance.now() + withinMs;
  for (;;) {
    try { process.kill(-pgid, 0); } catch { return true; }
    if (performance.now() >= until) return false;
    await sleep(20);
  }
}

/** Stop a process group: a moment to leave by itself, then TERM, then KILL, each bounded by `graceMs`. */
async function stopProcessGroup(pgid: number, graceMs: number): Promise<void> {
  for (const signal of [null, "SIGTERM", "SIGKILL"] as const) {
    if (signal) {
      try { process.kill(-pgid, signal); } catch { return; }
    }
    if (await groupGone(pgid, signal ? graceMs : Math.min(graceMs, 200))) return;
  }
}

/** `claude auth status --json` in its own process group; the group is stopped however the command ends,
 *  so nothing it started outlives it. Its output is taken once the command exits, not when its pipes close
 *  (a leftover child could hold them open). */
function runAuthStatus(file: string, env: NodeJS.ProcessEnv, cwd: string | undefined, timeoutMs: number, graceMs: number): Promise<Run> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, ["auth", "status", "--json"], { env, cwd, stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch (error) {
      resolve({ code: null, stdout: "", error: error as NodeJS.ErrnoException, timedOut: false });
      return;
    }
    let stdout = "";
    let timedOut = false;
    let settled = false;
    // Node reaps the child on its exit event; until then a killed child is a zombie that still has its pid.
    const reaped = new Promise<void>((resolveReap) => child.once("exit", () => resolveReap()));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    const finish = async (result: Omit<Run, "stdout" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) {
        await stopProcessGroup(child.pid, graceMs);
        // A killed group leaves the group list before Node reaps the child: wait, bounded, for the reap too
        // (as the Codex reader's stopGroup does), so the read never returns with its own child unreaped.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([reaped, new Promise((r) => { timer = setTimeout(r, graceMs); })]);
        clearTimeout(timer);
      }
      child.stdout?.destroy();
      resolve({ ...result, stdout, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void finish({ code: null, signal: null });
    }, Math.max(1, Math.floor(timeoutMs)));
    child.once("error", (error) => void finish({ code: null, error }));
    child.once("exit", (code, signal) => {
      // What it wrote before exiting may still be in the pipe: wait for the end, briefly.
      const done = () => void finish({ code, signal });
      if (child.stdout === null || child.stdout.readableEnded) done();
      else {
        child.stdout.once("end", done);
        setTimeout(done, 200);
      }
    });
  });
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string | undefined, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(file, args, { env, cwd, timeout: Math.max(1, Math.floor(timeoutMs)), maxBuffer: 1024 * 1024, killSignal: "SIGKILL" }, (error, stdout) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : null) : 0,
        stdout: String(stdout ?? ""),
        ...(err ? { error: err } : {}),
        timedOut: Boolean(err?.killed),
      });
    });
  });
}

export function claudeUsageReader(options: ClaudeUsageReaderOptions = {}): ClaudeUsageReader {
  const deadlineMs = options.deadlineMs ?? CLAUDE_USAGE_READ_DEADLINE_MS;
  const pollMs = options.pollMs ?? 250;
  const graceMs = options.graceMs ?? GRACE_MS;
  const now = options.now ?? (() => new Date().toISOString());
  return async () => {
    const env = claudeUsageReaderEnv(options);
    const cwd = options.home;
    const deadline = performance.now() + deadlineMs;
    const left = () => deadline - performance.now();
    const fail = (reason: ClaudeUsageFailureReason, detail: string) => ({ ok: false as const, at: now(), reason, detail });
    const claude = resolveClaudeExecutable(env);
    if (claude === null) return fail("binary_not_found", "no claude executable on the daemon's PATH");

    const authStatus = async (): Promise<{ facts: ClaudeAuthFacts } | { reason: ClaudeUsageFailureReason; detail: string }> => {
      const r = await runAuthStatus(claude, env, cwd, Math.min(AUTH_STATUS_MS, left()), graceMs);
      if (r.error?.code === "ENOENT") return { reason: "binary_not_found", detail: "no claude executable on the daemon's PATH" };
      if (r.timedOut) return { reason: "auth_status_failed", detail: "claude auth status did not answer in time" };
      if (r.error) return { reason: "auth_status_failed", detail: `claude auth status could not run (${r.error.code ?? r.error.message})` };
      // Facts come only from a command that succeeded, whatever JSON a failing one printed.
      if (r.code !== 0) return { reason: "auth_status_failed", detail: `claude auth status failed (${r.signal ? `signal ${r.signal}` : `exit ${r.code ?? "?"}`})` };
      let parsed: unknown;
      try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
      if (!isRecord(parsed)) return { reason: "auth_status_failed", detail: "claude auth status returned no JSON (exit 0)" };
      return {
        facts: {
          loggedIn: parsed.loggedIn === true,
          authMethod: stringOrNull(parsed.authMethod),
          email: stringOrNull(parsed.email),
          orgId: stringOrNull(parsed.orgId),
          orgName: stringOrNull(parsed.orgName),
          subscriptionType: stringOrNull(parsed.subscriptionType),
        },
      };
    };

    const before = await authStatus();
    if ("reason" in before) return fail(before.reason, before.detail);
    if (!before.facts.loggedIn) return fail("not_logged_in", "claude auth status reports no login");
    if (before.facts.authMethod !== "claude.ai") {
      return fail("not_subscription_login", `the login is not a claude.ai subscription (${before.facts.authMethod ?? "unknown method"})`);
    }

    const screen = await readScreen(claude, env, cwd, left, pollMs, now, options.tmpRoot ?? os.tmpdir(), graceMs);
    if (!screen.ok) return fail(screen.reason, screen.detail);

    const after = await authStatus();
    if ("reason" in after) return fail("identity_recheck_failed", `the identity could not be checked after the read: ${after.detail}`);
    const a = before.facts, b = after.facts;
    if (a.email !== b.email || a.orgId !== b.orgId || a.authMethod !== b.authMethod || !b.loggedIn) {
      return fail("identity_changed_during_read", "claude auth status changed during the read; no windows recorded");
    }
    return { ok: true, observedAt: screen.observedAt, auth: a, screen: screen.text };
  };
}

async function readScreen(
  claude: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  left: () => number,
  pollMs: number,
  now: () => string,
  tmpRoot: string,
  graceMs: number,
): Promise<{ ok: true; text: string; observedAt: string } | { ok: false; reason: ClaudeUsageFailureReason; detail: string }> {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "openrig-claude-usage-"));
  const socket = path.join(dir, "s");
  const tmux = (args: string[]) => run("tmux", ["-S", socket, "-f", "/dev/null", ...args], env, cwd, Math.max(1, Math.min(5_000, left())));
  // tmux sets TMUX/TMUX_PANE inside its panes; unset them so Claude never thinks it's nested or in a seat.
  // By absolute path (env too): the same binary auth status ran, whatever PATH tmux gives the pane.
  const command = `exec /usr/bin/env -u TMUX -u TMUX_PANE ${shellQuote(claude)} ${CLAUDE_USAGE_SCREEN_ARGS.map(shellQuote).join(" ")}`;
  // The pane's process (its process group leader) and the server, learnt once the session starts, so the
  // cleanup can reach them on every path. The pane stays after its process exits (remain-on-exit), so an
  // early exit is seen as a dead pane and its process group can still be stopped.
  let pids: { server: number; pane: number } | null = null;
  try {
    const started = await tmux(["start-server", ";", "set-option", "-g", "remain-on-exit", "on", ";",
      "new-session", "-d", "-s", "usage", "-x", "120", "-y", "50", ...(cwd ? ["-c", cwd] : []), command]);
    if (started.error?.code === "ENOENT") return { ok: false, reason: "tmux_unavailable", detail: "no tmux on the daemon's PATH" };
    if (started.code !== 0) return { ok: false, reason: "tmux_unavailable", detail: `tmux could not start a private server (exit ${started.code ?? "?"})` };
    const shown = await tmux(["display-message", "-p", "-t", "usage", "#{pid} #{pane_pid}"]);
    const [server, pane] = shown.stdout.trim().split(" ").map(Number);
    if (shown.code === 0 && Number.isInteger(server) && Number.isInteger(pane) && server! > 1 && pane! > 1) pids = { server: server!, pane: pane! };
    else return { ok: false, reason: "tmux_unavailable", detail: "tmux started but did not report the pane's process" };
    let ready = false;
    let last = "";
    while (left() > 0) {
      // A tmux call cut short by the read's bound is the bound running out, not a dead pane.
      const dead = await tmux(["display-message", "-p", "-t", "usage", "#{pane_dead}"]);
      if (dead.timedOut) break;
      const captured = await tmux(["capture-pane", "-p", "-t", "usage"]);
      if (captured.timedOut) break;
      if (dead.code !== 0 || dead.stdout.trim() === "1" || captured.code !== 0) {
        // A Claude Code without one of the start flags (such as --safe-mode) exits this way: a visible failure.
        return { ok: false, reason: "child_exited", detail: "claude exited before the usage screen rendered (a Claude Code without these flags, such as --safe-mode, exits this way)" };
      }
      last = captured.stdout;
      if (PROMPTS.test(last)) {
        return {
          ok: false,
          reason: "interaction_required",
          detail: /Do you trust the files|Is this a project you created/.test(last)
            ? `claude asked whether to trust the folder it runs in (${cwd ?? "the daemon's working directory"}), the daemon's HOME; nothing was answered. Every read stops here until that folder is trusted: start claude there once as this login and accept the trust prompt`
            : "claude asked for input (sign-in or a confirmation); nothing was answered",
        };
      }
      if (last.includes("Failed to load usage data")) return { ok: false, reason: "usage_unavailable", detail: "claude reported: Failed to load usage data" };
      if (claudeUsageScreenReady(last)) {
        // One more frame so the reset lines under the last window have rendered.
        if (ready) return { ok: true, text: last, observedAt: now() };
        ready = true;
      }
      await sleep(pollMs);
    }
    return { ok: false, reason: "timeout", detail: "the usage screen did not render within the read's 45 s bound" };
  } finally {
    await stopServer(socket, env, cwd, pids, graceMs);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Exit keys only (Esc, Ctrl-C, Ctrl-C), never text; then the pane's process group is stopped (TERM, then
 *  KILL), then the private server is killed, by pid if kill-server doesn't end it. */
async function stopServer(
  socket: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  pids: { server: number; pane: number } | null,
  graceMs: number,
): Promise<void> {
  const tmux = (args: string[]) => run("tmux", ["-S", socket, "-f", "/dev/null", ...args], env, cwd, 2_000);
  for (const key of ["Escape", "C-c", "C-c"]) {
    const sent = await tmux(["send-keys", "-t", "usage", key]);
    if (sent.code !== 0) break;
    await sleep(150);
  }
  // The pane runs in its own session and process group (tmux makes the pane process its leader).
  if (pids) await stopProcessGroup(pids.pane, graceMs);
  await tmux(["kill-server"]);
  if (pids && !(await pidGone(pids.server, graceMs))) {
    try { process.kill(pids.server, "SIGKILL"); } catch { /* already gone */ }
    await pidGone(pids.server, graceMs);
  }
}

async function pidGone(pid: number, withinMs: number): Promise<boolean> {
  const until = performance.now() + withinMs;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (performance.now() >= until) return false;
    await sleep(20);
  }
}
