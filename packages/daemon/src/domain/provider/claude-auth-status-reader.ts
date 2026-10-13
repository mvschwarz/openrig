// Slice 01 (OPR.0.7.0.1) — the identity half of the Claude usage view: one bounded `claude auth status --json`,
// run only on an explicit refresh (ordinary provider reads never call it). The windows come from the seats'
// status-line samples (claude-usage-windows.ts); this answers which login the daemon's Claude config dir holds.
//
// `claude` is resolved on the reader's PATH and run by absolute path, in its own process group with stdin
// closed, bounded (10 s); however it ends, its group is stopped (a moment, TERM, KILL) and the child reaped, so
// nothing it started keeps running. Facts are taken only from an exit-0 answer, with one exception from Claude's
// documented contract: logged out, it prints {"loggedIn": false, ...} and exits 1, which is not_logged_in (no
// identity fact is taken from it). Any other nonzero exit is auth_status_failed, whatever it printed. Only loggedIn, authMethod, email and orgId are read, plus orgName and
// subscriptionType as labels. It runs with the HOME, CLAUDE_CONFIG_DIR and PATH a seat session gets, without
// TMUX, TMUX_PANE or any OpenRig seat variable. It starts a Claude CLI process, not a session; what that
// process may write in the config dir is open for the native run. The reader never opens a credentials file.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { UsageReadOutcome } from "./usage-windows.js";

export type ClaudeAuthFailureReason = "binary_not_found" | "auth_status_failed" | "not_logged_in" | "not_subscription_login";

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

export type ClaudeAuthAnswer = { auth: ClaudeAuthFacts };
export type ClaudeAuthReader = () => Promise<UsageReadOutcome<ClaudeAuthAnswer>>;

export interface ClaudeAuthReaderOptions {
  launchPath?: string;
  home?: string;
  claudeConfigDir?: string;
  timeoutMs?: number;
  /** How long a stopped process group gets after TERM before KILL (and after KILL before giving up). */
  graceMs?: number;
  now?: () => string;
}

export const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 10_000;
const GRACE_MS = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The `claude` executable on the reader's own PATH, as an absolute path, or null. */
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
export function claudeAuthReaderEnv(options: ClaudeAuthReaderOptions, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
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
  env.DISABLE_AUTOUPDATER = "1";
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
        let reapTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([reaped, new Promise((r) => { reapTimer = setTimeout(r, graceMs); })]);
        clearTimeout(reapTimer);
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

export function claudeAuthStatusReader(options: ClaudeAuthReaderOptions = {}): ClaudeAuthReader {
  const timeoutMs = options.timeoutMs ?? CLAUDE_AUTH_STATUS_TIMEOUT_MS;
  const graceMs = options.graceMs ?? GRACE_MS;
  const now = options.now ?? (() => new Date().toISOString());
  return async () => {
    const env = claudeAuthReaderEnv(options);
    const fail = (reason: ClaudeAuthFailureReason, detail: string) => ({ ok: false as const, at: now(), reason, detail });
    const claude = resolveClaudeExecutable(env);
    if (claude === null) return fail("binary_not_found", "no claude executable on the daemon's PATH");
    const r = await runAuthStatus(claude, env, options.home, timeoutMs, graceMs);
    if (r.error?.code === "ENOENT") return fail("binary_not_found", "no claude executable on the daemon's PATH");
    if (r.timedOut) return fail("auth_status_failed", `claude auth status did not answer within ${Math.round(timeoutMs / 1000)} s`);
    if (r.error) return fail("auth_status_failed", `claude auth status could not run (${r.error.code ?? r.error.message})`);
    let parsed: unknown;
    try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
    if (r.code !== 0) {
      // Facts come only from a command that succeeded. The one exception is Claude's documented logged-out answer:
      // exit 1 exactly. Any other exit (9, a signal...) is an unexpected failure, whatever the JSON says.
      if (!r.signal && r.code === 1 && isRecord(parsed) && parsed.loggedIn === false) {
        return fail("not_logged_in", `claude auth status reports no login (exit ${r.code ?? "?"})`);
      }
      return fail("auth_status_failed", `claude auth status failed (${r.signal ? `signal ${r.signal}` : `exit ${r.code ?? "?"}`})`);
    }
    if (!isRecord(parsed)) return fail("auth_status_failed", "claude auth status returned no JSON (exit 0)");
    const auth: ClaudeAuthFacts = {
      loggedIn: parsed.loggedIn === true,
      authMethod: stringOrNull(parsed.authMethod),
      email: stringOrNull(parsed.email),
      orgId: stringOrNull(parsed.orgId),
      orgName: stringOrNull(parsed.orgName),
      subscriptionType: stringOrNull(parsed.subscriptionType),
    };
    if (!auth.loggedIn) return fail("not_logged_in", "claude auth status reports no login");
    if (auth.authMethod !== "claude.ai") {
      return fail("not_subscription_login", `the login is not a claude.ai subscription (${auth.authMethod ?? "unknown method"})`);
    }
    return { ok: true, observedAt: now(), auth };
  };
}
