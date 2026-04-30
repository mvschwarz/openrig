import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { HostEntry } from "./host-registry.js";

/**
 * Structured result of a cross-host command. Distinguishes SSH-layer failures
 * (couldn't reach the remote shell) from remote-command failures (reached the
 * remote shell, but the command itself returned non-zero). This distinction
 * is load-bearing: collapsing both into "failed" hides the operational
 * difference between "fix your SSH" and "fix your remote rig daemon."
 */
export type CrossHostResult =
  | { ok: true; failedStep: "none"; stdout: string; stderr: string; remoteExitCode: 0 }
  | { ok: false; failedStep: "ssh-unreachable"; sshStderr: string }
  | { ok: false; failedStep: "permission-gate"; sshStderr: string; hint?: string }
  | { ok: false; failedStep: "remote-daemon-unreachable"; stdout: string; stderr: string; remoteExitCode: number }
  | { ok: false; failedStep: "remote-command-failed"; stdout: string; stderr: string; remoteExitCode: number };

export type FailedStep = CrossHostResult["failedStep"];

/**
 * Pluggable spawn function for testing. The default uses Node's
 * `child_process.spawn` directly. Tests inject a mock that returns a
 * controllable process-like object.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
) => ChildProcess;

export interface RunCrossHostCommandOpts {
  /** Optional stdin to write to the spawned ssh process (forwarded to remote stdin). */
  stdin?: string;
  /** Inject a non-default spawn function (used in tests). */
  spawn?: SpawnFn;
  /** Connect timeout in seconds for the underlying ssh invocation. Default: 10. */
  connectTimeoutSeconds?: number;
}

/**
 * Run a remote rig command via single-hop ssh. Returns a structured result
 * that maps each failure mode named in the dossier to a distinct
 * `failedStep` value.
 *
 * Important: this function does NOT collapse remote `--verify` semantics into
 * the SSH exit code. Callers that pass `--verify` get the remote command's
 * stdout (containing `Verified: yes`/`no`) verbatim; the remote rig is
 * authoritative on verification. SSH success (exit 0) just means "we reached
 * the remote shell and it ran the command", not "the verify passed."
 */
export async function runCrossHostCommand(
  host: HostEntry,
  argv: readonly string[],
  opts: RunCrossHostCommandOpts = {},
): Promise<CrossHostResult> {
  if (host.transport !== "ssh") {
    return {
      ok: false,
      failedStep: "ssh-unreachable",
      sshStderr: `host '${host.id}': transport '${host.transport}' is not supported (v0 supports ssh only)`,
    };
  }
  if (argv.length === 0) {
    return {
      ok: false,
      failedStep: "ssh-unreachable",
      sshStderr: "internal: empty argv passed to runCrossHostCommand",
    };
  }

  const sshOpts: string[] = [];
  if (host.user) {
    sshOpts.push("-l", host.user);
  }
  const connectTimeout = opts.connectTimeoutSeconds ?? 10;
  sshOpts.push("-o", `ConnectTimeout=${connectTimeout}`);
  // No BatchMode — operators may legitimately use password / interactive auth.
  // Stay deferential to ~/.ssh/config defaults.

  const remoteCommandLine = argv.map(shellQuote).join(" ");
  const fullArgs = [...sshOpts, host.target, remoteCommandLine];

  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const child = spawn("ssh", fullArgs);

  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.write(opts.stdin);
    child.stdin.end();
  } else if (child.stdin) {
    child.stdin.end();
  }

  let stdout = "";
  let stderr = "";
  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });
  }

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code: number | null) => resolve(code ?? -1));
    child.on("error", (err: Error) => {
      stderr += `\n[spawn error] ${err.message}`;
      resolve(-1);
    });
  });

  return classifyResult(exitCode, stdout, stderr);
}

/**
 * Map the spawned ssh exit code + stderr signature to a structured result.
 *
 * - Exit 0 → success.
 * - Exit 255 → ssh-layer failure. If stderr matches a known permission/auth
 *   gate (Permission denied, Keychain, host key verification), classify as
 *   `permission-gate` with a hint pointing at the field-note diagnostic.
 *   Otherwise classify as `ssh-unreachable`.
 * - Any other non-zero → ssh succeeded but the remote rig command failed.
 *   If the remote stderr matches the daemon-not-running signature, classify
 *   as `remote-daemon-unreachable`; otherwise `remote-command-failed`.
 */
export function classifyResult(exitCode: number, stdout: string, stderr: string): CrossHostResult {
  if (exitCode === 0) {
    return { ok: true, failedStep: "none", stdout, stderr, remoteExitCode: 0 };
  }
  if (exitCode === 255 || exitCode === -1) {
    if (looksLikePermissionGate(stderr)) {
      return {
        ok: false,
        failedStep: "permission-gate",
        sshStderr: stderr,
        hint: "See openrig-work/field-notes/2026-04-29-l4-3-d6-claude-keychain-over-ssh-diagnostic.md for guidance on Keychain-over-SSH issues.",
      };
    }
    return { ok: false, failedStep: "ssh-unreachable", sshStderr: stderr };
  }
  if (looksLikeDaemonUnreachable(stderr) || looksLikeDaemonUnreachable(stdout)) {
    return {
      ok: false,
      failedStep: "remote-daemon-unreachable",
      stdout,
      stderr,
      remoteExitCode: exitCode,
    };
  }
  return {
    ok: false,
    failedStep: "remote-command-failed",
    stdout,
    stderr,
    remoteExitCode: exitCode,
  };
}

const PERMISSION_GATE_PATTERNS = [
  /Permission denied/i,
  /Host key verification failed/i,
  /Keychain/i,
  /Could not request authentication agent/i,
  /no mutual signature algorithm/i,
];

function looksLikePermissionGate(stderr: string): boolean {
  return PERMISSION_GATE_PATTERNS.some((re) => re.test(stderr));
}

const DAEMON_UNREACHABLE_PATTERNS = [
  /Daemon not running/i,
  /Failed to fetch .* from daemon/i,
  /ECONNREFUSED.*localhost/i,
];

function looksLikeDaemonUnreachable(text: string): boolean {
  return DAEMON_UNREACHABLE_PATTERNS.some((re) => re.test(text));
}

/**
 * Single-quote shell escaping. Wraps the input in single quotes, escaping
 * any embedded single quotes via `'\''`. Safe for passing as a single arg
 * to a remote POSIX shell.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
