import { exec, execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { ArgvExecFn, ExecFn } from "./tmux.js";
import { mayStartTmuxServer, reportTmuxServerLimit, TMUX_SERVER_LIMIT_PREFIX, tmuxServerStartCommand } from "../tmux-server-start.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
// exec's 1 MiB default holds about a dozen 1000-line panes; a batched capture chains 24 (#161). A bound, not an allocation.
export const TMUX_MAX_BUFFER = 64 * 1024 * 1024;
export const TMUX_EXEC_TIMEOUT_MS = 30_000;

// The first client seeds tmux's global environment. Seat credentials still arrive through
// the explicit per-session config channel, never through the daemon's ambient credentials.
function tmuxClientEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["OPENRIG_ACTIVITY_HOOK_TOKEN", "RIGGED_ACTIVITY_HOOK_TOKEN", "OPENRIG_AUTH_BEARER_TOKEN",
    "OPENRIG_TERMINAL_BEARER_TOKEN", "OPENRIG_RELAY_INBOUND_TOKEN", "OPENRIG_RELAY_OUTBOUND_TOKEN"]) delete env[key];
  return env;
}

const tmuxExecOptions = { windowsHide: true, maxBuffer: TMUX_MAX_BUFFER, timeout: TMUX_EXEC_TIMEOUT_MS, killSignal: "SIGKILL" as const };

function warnTmuxDeadline(err: unknown, started: number, argv: string[]): void {
  const failure = err as { killed?: boolean; signal?: string } | null;
  if (!failure?.killed || failure.signal !== "SIGKILL" || performance.now() - started < TMUX_EXEC_TIMEOUT_MS) return;
  let command = 1;
  while (argv[command]?.startsWith("-")) command += ["-L", "-S", "-f", "-c", "-T"].includes(argv[command]!) ? 2 : 1;
  const paneTarget = argv.indexOf("-t", command + 1);
  const sessionTarget = ["new-session", "detach-client"].includes(argv[command] ?? "") ? argv.indexOf("-s", command + 1) : -1;
  const target = paneTarget >= 0 ? paneTarget : sessionTarget;
  // Name the operation and target, never payloads, environment values or whole command lines.
  console.warn("[tmux] execution deadline exceeded; client killed", {
    command: argv[command] ?? argv[0], target: target < 0 ? "(server)" : argv[target + 1] ?? "(unknown)", timeoutMs: TMUX_EXEC_TIMEOUT_MS,
  });
  if (err instanceof Error) err.message = "tmux did not answer within 30 s and its client was ended; the write may still have happened. Check with rig capture before resending.\n" + err.message;
}

/**
 * The first regular executable `name` on `pathEnv`, in execvp order. Null when there is none, or when an
 * entry before it is relative or empty: those depend on the cwd, so the bare name is left to the shell.
 */
export function resolveOnPath(name: string, pathEnv: string | undefined): string | null {
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!isAbsolute(dir)) return null;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not here: the next entry */ }
  }
  return null;
}

// Looked up once per PATH value: a tmux installed earlier on PATH later is seen after a daemon restart.
let resolved: { name: string; pathEnv: string | undefined; file: string | null } | undefined;
function resolvedOnPath(name: string): string | null {
  const pathEnv = process.env.PATH;
  if (resolved?.name !== name || resolved.pathEnv !== pathEnv) resolved = { name, pathEnv, file: resolveOnPath(name, pathEnv) };
  return resolved.file;
}

/** The file could not be started at all (missing, not executable, a missing interpreter, no `#!` line): nothing ran. */
function isSpawnError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.syscall?.startsWith("spawn") === true;
}

function extractExecOutput(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const stdout = typeof (err as { stdout?: unknown }).stdout === "string"
    ? (err as { stdout: string }).stdout.trim()
    : "";
  const stderr = typeof (err as { stderr?: unknown }).stderr === "string"
    ? (err as { stderr: string }).stderr.trim()
    : "";
  return [stdout, stderr].filter(Boolean).join("\n");
}

/** The exec error with its output appended for a human reader, and tmux's own stderr kept apart as `execStderr`: a
 *  chained capture prints the earlier panes to stdout before it fails, and that pane text must not classify it. */
function withExecOutput(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const output = extractExecOutput(err);
  const thrown = output && !err.message.includes(output) ? new Error(`${err.message}\n${output}`) : err;
  const stderr = (err as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? Object.assign(thrown, { execStderr: stderr }) : thrown;
}

/**
 * Production ExecFn for TmuxAdapter.
 * Wraps child_process.exec (shell command string) and returns stdout.
 */
export const execCommand: ExecFn = async (cmd: string): Promise<string> => {
  try {
    const { stdout, stderr } = await execAsync(tmuxStartShell(cmd), { env: /^tmux(?:\s|$)/.test(cmd) ? tmuxClientEnvironment() : process.env });
    reportTmuxServerLimit(stderr);
    return stdout;
  } catch (err) {
    reportTmuxServerLimit((err as { stderr?: unknown }).stderr);
    throw withExecOutput(err);
  }
};

function tmuxStartShell(cmd: string, replaceShell = false): string {
  const creating = process.platform !== "win32" && /^tmux\s/.test(cmd)
    && /(?:^|\s)(?:new-session|start-server|attach-session|-D)(?:\s|$)/.test(cmd.replaceAll("'", ""))
    ? TMUX_SERVER_LIMIT_PREFIX : "";
  return creating + (replaceShell && /^tmux\s/.test(cmd) ? `exec ${cmd}` : cmd);
}

/** Replace the shell only for tmux clients; other adapter commands keep shell builtins such as kill. */
export const execTmuxCommand: ExecFn = async (cmd: string): Promise<string> => {
  const started = performance.now();
  try {
    const result = await execFileAsync("/bin/sh", ["-c", tmuxStartShell(cmd, true)], { ...tmuxExecOptions, env: tmuxClientEnvironment() });
    reportTmuxServerLimit(result.stderr);
    return result.stdout;
  } catch (err) {
    reportTmuxServerLimit((err as { stderr?: unknown }).stderr);
    // Tokens are diagnostic labels only; the command is executed by the shell without rewriting its arguments.
    const labels = (cmd.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(word => word.replace(/^(['"])(.*)\1$/, "$2"));
    warnTmuxDeadline(err, started, labels);
    throw withExecOutput(err);
  }
};

/**
 * Production ArgvExecFn for TmuxAdapter.
 * Ordinary commands run directly via execFile. Server-creating POSIX commands
 * use a child shell to raise only their inherited soft file limit, then exec the
 * unchanged argv. Other POSIX commands use a resolved path to avoid libuv's
 * repeated PATH spawns on the event loop. Windows keeps the psmux alias on PATH.
 */
export const execArgvCommand: ArgvExecFn = async (argv: string[]): Promise<string> => {
  const [bin, ...args] = argv;
  if (!bin) throw new Error("execArgvCommand: empty argv");
  const started = performance.now();
  // Nothing ran when no file was found: a shell also finds tmux through an entry the lookup skips, such as a literal
  // `~/bin`, and reports a missing one as the shell transport does.
  const opts = { ...tmuxExecOptions, env: tmuxClientEnvironment() };
  const run = async (file: string | null) => {
    const command = tmuxServerStartCommand(mayStartTmuxServer(args) ? bin : file ?? bin, args);
    const result = command.file !== "/bin/sh" && !file
      ? await execFileAsync("/bin/sh", ["-c", 'exec "$0" "$@"', bin, ...args], opts)
      : await execFileAsync(command.file, command.args, opts);
    reportTmuxServerLimit(result.stderr);
    return result;
  };
  try {
    if (process.platform === "win32") return (await execFileAsync(bin, args, opts)).stdout;
    const file = resolvedOnPath(bin);
    try {
      return (await run(file)).stdout;
    } catch (err) {
      if (!file || !isSpawnError(err)) throw err;
      // Nothing ran, so the shell runs it once and reaches tmux as the shell transport does. The next call looks up again,
      // so a reinstalled tmux is started directly once it is back.
      resolved = undefined;
      return (await run(null)).stdout;
    }
  } catch (err) {
    reportTmuxServerLimit((err as { stderr?: unknown }).stderr);
    warnTmuxDeadline(err, started, argv);
    throw withExecOutput(err);
  }
};

/**
 * Starts a long-lived tmux client (the daemon's control client, tmux-control.ts) as execArgvCommand starts tmux: the
 * file resolved on PATH, else, or when that file could not be started, `/bin/sh` once. Resolves once the process runs,
 * and rejects with the spawn error when even the shell could not start. POSIX only, as control mode is.
 */
export async function spawnTmuxClient(args: string[]): Promise<ChildProcessWithoutNullStreams> {
  const opts = { stdio: "pipe" as const, windowsHide: true, env: tmuxClientEnvironment() };
  const started = (file: string | null) => new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
    const command = tmuxServerStartCommand(mayStartTmuxServer(args) ? "tmux" : file ?? "tmux", args);
    const child = command.file !== "/bin/sh" && !file
      ? spawn("/bin/sh", ["-c", 'exec "$0" "$@"', "tmux", ...args], opts) : spawn(command.file, command.args, opts);
    if (mayStartTmuxServer(args)) {
      let notice = "";
      child.stderr.on("data", data => {
        notice = (notice + String(data)).slice(-512);
        reportTmuxServerLimit(notice);
      });
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.off("error", reject);
      resolve(child);
    });
  });
  const file = resolvedOnPath("tmux");
  try {
    return await started(file);
  } catch (err) {
    if (!file || !isSpawnError(err)) throw err;
    // Nothing ran: the next start looks tmux up again.
    resolved = undefined;
    return started(null);
  }
}
