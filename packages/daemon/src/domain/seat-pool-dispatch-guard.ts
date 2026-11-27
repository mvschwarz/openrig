import { spawn } from "node:child_process";
import { isTmuxCredentialEnvKey } from "../adapters/tmux-credential-env.js";

// #4061 (Ask 1): the seat pool's dispatch guard, an opt-in check the operator sets with the pool block's
// `dispatch_guard` (an argv: an absolute executable and its own arguments, never a shell string). The executor runs it
// once per planned move, before its final re-check, under the model's custody lease, so its timeout is short.
//
// The command gets `--qitem=<id> --from=<session> --to=<session>` after its own arguments (the `=` form, so a value
// that starts with `-` can't read as one of its own options), no stdin and the daemon's environment without its
// credentials, like everything else a spec runs (through the tmux client). Exit 0 lets the move go. Exit 75 (EX_TEMPFAIL: try again later) vetoes it: the row is skipped this cycle and planned again on the next
// one. Anything else (it can't be started, it times out, it is killed, it exits with another code) is a guard error, and
// the move goes ahead: a broken guard never freezes a pool. A dedicated veto code keeps an ordinary crash (exit 1, a
// shell's `set -e`, an argument error) from reading as a veto.

/** How long the guard may run before it is killed and the move goes ahead. */
export const SEAT_POOL_DISPATCH_GUARD_TIMEOUT_MS = 2_000;
/** The exit code that vetoes a move (sysexits EX_TEMPFAIL). */
export const SEAT_POOL_DISPATCH_GUARD_VETO_EXIT = 75;
/** The most of the guard's stdout or stderr kept for the job's notes. */
const OUTPUT_CAP = 4_096;
/** The longest text one note carries. */
const NOTE_CAP = 200;
/** How long its output is still read after the guard exited while something it started holds the pipes. */
const EXIT_GRACE_MS = 100;

/** One planned move, as the guard is asked about it. */
export interface SeatPoolDispatchGuardInput {
  argv: readonly string[];
  qitemId: string;
  from: string;
  to: string;
}

/** What the guard said: go, a veto (with the first line of its stdout), or an error (the move goes ahead). */
export type SeatPoolDispatchGuardVerdict =
  | { verdict: "allow" }
  | { verdict: "veto"; message?: string }
  | { verdict: "error"; message: string };

/** Runs the guard for one move. Never rejects. */
export type SeatPoolDispatchGuardRunner = (input: SeatPoolDispatchGuardInput) => Promise<SeatPoolDispatchGuardVerdict>;

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > NOTE_CAP ? `${line.slice(0, NOTE_CAP)}…` : line;
}

/** The daemon's environment without the names that grant authority or access, which a spec's command never gets. */
function guardEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (isTmuxCredentialEnvKey(key)) delete env[key];
  return env;
}

/** The daemon's guard runner: the argv by `spawn`, no shell, killed (its whole process group) at the timeout. */
export function runSeatPoolDispatchGuard(
  input: SeatPoolDispatchGuardInput,
  opts: { timeoutMs?: number } = {},
): Promise<SeatPoolDispatchGuardVerdict> {
  const timeoutMs = opts.timeoutMs ?? SEAT_POOL_DISPATCH_GUARD_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const finish = (verdict: SeatPoolDispatchGuardVerdict) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      resolve(verdict);
    };
    const [file, ...own] = input.argv;
    if (!file) { finish({ verdict: "error", message: "no command" }); return; }
    let child: ReturnType<typeof spawn>;
    try {
      // detached: its own process group, so the timeout's kill reaches what it started too.
      child = spawn(file, [...own, `--qitem=${input.qitemId}`, `--from=${input.from}`, `--to=${input.to}`], {
        shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: guardEnvironment(),
      });
    } catch (error) {
      finish({ verdict: "error", message: `could not start: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    // Decoded by the stream, so a character split across two writes is kept whole.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { if (stdout.length < OUTPUT_CAP) stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { if (stderr.length < OUTPUT_CAP) stderr += chunk; });
    /** The guard's own exit, once it has exited: the verdict, even when the timeout comes before its output is read. */
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    /** Kills the guard's process group and lets go of its pipes: nothing it started outlives its verdict that way. */
    const killGroup = () => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    timer = setTimeout(() => {
      killGroup();
      if (exited) settle(exited.code, exited.signal);
      else finish({ verdict: "error", message: `timed out after ${timeoutMs} ms` });
    }, Math.max(1, Math.floor(timeoutMs)));
    child.on("error", (error) => finish({ verdict: "error", message: `could not start: ${error.message}` }));
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) return finish({ verdict: "allow" });
      if (code === SEAT_POOL_DISPATCH_GUARD_VETO_EXIT) {
        const message = firstLine(stdout);
        return finish(message ? { verdict: "veto", message } : { verdict: "veto" });
      }
      const why = firstLine(stderr);
      const how = code === null ? `killed by ${signal ?? "a signal"}` : `exited ${code}`;
      return finish({ verdict: "error", message: why ? `${how}: ${why}` : how });
    };
    // The verdict is the exit code. Its output is read until the pipes close, or briefly after the exit when something it
    // started still holds them; the exit code is not lost to that.
    child.on("close", (code, signal) => settle(code, signal));
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      if (done) return;
      // Still open after the grace: something it started holds the pipes, and goes with its group.
      grace = setTimeout(() => {
        killGroup();
        settle(code, signal);
      }, EXIT_GRACE_MS);
    });
  });
}
