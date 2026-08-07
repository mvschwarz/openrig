import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WakeRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Runs a headless one-shot command with a bounded timeout. Injectable for tests. */
export type WakeRunner = (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<WakeRunResult>;

export interface WakeDeps {
  runner: WakeRunner;
  /** Locate the session file for a size advisory (pin 5). Optional. */
  fileLocator?: (token: string) => { path: string; sizeBytes: number } | null;
}

export interface WakeArgs {
  question: string;
  token: string;
  runtime: "claude" | "codex";
  timeoutMs?: number;
}

export interface WakeOutcome {
  ran: boolean;
  answer?: string;
  timedOut?: boolean;
  /** true when the wake process exited non-zero (bad token / missing binary /
   *  auth fail) — an honest failure, NOT a successful empty answer. */
  failed?: boolean;
  code?: number;
  message?: string;
  advisory?: string;
}

/** Default bounded wake timeout — long enough for a real recall, short enough
 *  that a hang surfaces instead of blocking forever (founder datapoint: ~minutes
 *  on a 635 MB session file). */
export const DEFAULT_WAKE_TIMEOUT_MS = 180_000;
const WAKE_LARGE_FILE_BYTES = 200 * 1024 * 1024; // 200 MB
/** The wake prompt is no-preamble by default — raw answers, not essays (pin 5). */
const NO_PREAMBLE = "Answer directly and concisely, with no preamble. Question: ";

/**
 * Build the HEADLESS one-shot resume command. `claude -p --resume <token>`
 * prints the answer and EXITS — the wake target is the session FILE, so the
 * process goes back to cold with no lingering process (pin 2/3, mini-PRD A).
 * codex uses `codex exec resume` (adapter-honest; session-file size lags the host).
 */
export function buildWakeCommand(runtime: "claude" | "codex", token: string, question: string): { cmd: string; args: string[] } {
  const prompt = `${NO_PREAMBLE}${question}`;
  if (runtime === "codex") {
    return { cmd: "codex", args: ["exec", "resume", token, prompt] };
  }
  return { cmd: "claude", args: ["-p", "--resume", token, prompt] };
}

/** Default runner: execFile with a hard timeout. Resolving means the child
 *  exited (back-to-cold) — we never retain a handle. */
export const defaultWakeRunner: WakeRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
      const timedOut = !!(e && e.killed && e.signal === "SIGTERM");
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        timedOut,
      });
    });
  });

/** Default file locator for the size advisory: scan ~/.claude/projects/<cwd>/<token>.jsonl. */
export function defaultWakeFileLocator(token: string): { path: string; sizeBytes: number } | null {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(root, d.name, `${token}.jsonl`);
      if (existsSync(p)) return { path: p, sizeBytes: statSync(p).size };
    }
  } catch {
    /* best-effort advisory only */
  }
  return null;
}

/**
 * L3 — wake a session by its resume token, ask one (possibly batched) question,
 * capture the snapshot answer, and let the process go back to cold. EXECUTES —
 * the only level with runtime cost/side effects; it runs ONLY when explicitly
 * invoked (never an implicit escalation from a failed L1/L2 search). Bounded
 * timeout + large-file advisory — never a silent hang.
 */
export async function runWake(deps: WakeDeps, args: WakeArgs): Promise<WakeOutcome> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;

  let advisory: string | undefined;
  const located = deps.fileLocator?.(args.token);
  if (located && located.sizeBytes > WAKE_LARGE_FILE_BYTES) {
    advisory = `Session file is large (${(located.sizeBytes / 1024 / 1024).toFixed(0)} MB); waking may take minutes — a large session file lags the host. If it hangs, retry with a longer timeout or a background wake.`;
  }

  const { cmd, args: cmdArgs } = buildWakeCommand(args.runtime, args.token, args.question);
  const res = await deps.runner(cmd, cmdArgs, { timeoutMs });

  if (res.timedOut) {
    return {
      ran: true,
      timedOut: true,
      advisory,
      message: `Wake did not return within ${Math.round(timeoutMs / 1000)}s. The session may be large or slow — retry with a longer --wake-timeout or a background wake. This is a bounded timeout, not a silent hang.`,
    };
  }

  // A non-zero exit is a FAILURE, not a successful empty answer — surface it
  // honestly (same doctrine as L1/L2 honest-degraded). Only exit 0 is an answer.
  if (res.code !== 0) {
    const detail = res.stderr.trim();
    return {
      ran: true,
      failed: true,
      code: res.code ?? undefined,
      advisory,
      message: `Wake failed (exit ${res.code ?? "unknown"})${detail ? `: ${detail}` : ""}. The token may be invalid/expired, the runtime binary missing, or auth required.`,
    };
  }

  return { ran: true, answer: res.stdout.trim(), advisory };
}
