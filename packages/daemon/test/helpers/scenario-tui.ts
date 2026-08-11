/**
 * Slice 51-02 delta D7 — scenario TUI PROVISIONING (opt-in, bounded, fail-loud).
 *
 * The `tui_socket` surface reads the shipped TUI's control socket, which exists
 * only INSIDE a running TUI process — nothing else creates it. Merely spawning
 * the TUI and proceeding leaves the first read racing a socket that may not be
 * listening yet: `readTuiSocket` rejects immediately on a connect error and the
 * `expect` poller does not catch observation errors, so the scenario would ABORT
 * rather than poll.
 *
 * So provisioning WAITS, boundedly, for a real `state` round-trip — the same
 * query the surface reader makes — while watching for early process exit, and
 * fails with a NAMED error on either. Teardown runs on success and on every
 * failure path (the caller wraps it in try/finally).
 *
 * The TUI runs in the scaffold's OWN tmux server (D5) with the scaffold socket
 * path, so provisioning cannot touch the operator's TUI or fleet server.
 */

import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

/** Thrown when the TUI could not be provisioned (early exit or readiness timeout). */
export class TuiProvisioningError extends Error {
  readonly reason: "early_exit" | "readiness_timeout";
  constructor(reason: "early_exit" | "readiness_timeout", detail: string) {
    super(`TUI provisioning failed (${reason}): ${detail}`);
    this.name = "TuiProvisioningError";
    this.reason = reason;
  }
}

/** A provisioned TUI: its control-socket path and an idempotent teardown. */
export interface ProvisionedTui {
  socketPath: string;
  stop(): Promise<void>;
}

/** The process handle provisioning needs — narrowed so tests inject a fake. */
export interface TuiProcessLike {
  /** Resolves with the exit code when the process exits; never rejects. */
  exited: Promise<number | null>;
  /** True once the process has exited. */
  hasExited(): boolean;
  kill(): void;
}

export interface ProvisionTuiOptions {
  socketPath: string;
  /** Spawn the TUI. Injected so the readiness/exit paths are unit-testable. */
  spawnTui: () => TuiProcessLike;
  /** Total readiness bound in ms. */
  readinessTimeoutMs?: number;
  /** Interval between readiness probes in ms. */
  probeIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Probe override (defaults to a real `state` round-trip on the socket). */
  probe?: (socketPath: string) => Promise<boolean>;
}

const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_PROBE_INTERVAL_MS = 100;

/**
 * One `state` round-trip on the control socket. Returns true only when the TUI
 * answers with a parseable line — i.e. the exact contract the surface reader
 * depends on, not merely "the socket file exists".
 */
export function probeTuiState(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    const conn = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => { conn.destroy(); done(false); }, timeoutMs);
    conn.on("connect", () => conn.write("state\n"));
    conn.on("data", (b) => {
      buf += b.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buf.slice(0, nl);
      conn.end();
      try { JSON.parse(line); done(true); } catch { done(false); }
    });
    conn.on("error", () => { clearTimeout(timer); done(false); });
  });
}

/**
 * Spawn the TUI and wait — boundedly — until its control socket answers `state`.
 * Fails NAMED on early exit or timeout, killing the process either way so no
 * orphan survives. On success the caller owns `stop()`.
 */
export async function provisionTui(opts: ProvisionTuiOptions): Promise<ProvisionedTui> {
  const {
    socketPath,
    spawnTui,
    readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    probe = (p: string) => probeTuiState(p),
  } = opts;

  const proc = spawnTui();
  let exitCode: number | null | undefined;
  void proc.exited.then((code) => { exitCode = code; });

  const stop = async (): Promise<void> => {
    if (!proc.hasExited()) proc.kill();
    await proc.exited.catch(() => null);
  };

  const start = now();
  for (;;) {
    if (proc.hasExited()) {
      // Early exit beats readiness: a dead TUI never listens, and waiting out the
      // full bound would report a timeout for what is really a crash.
      await stop();
      throw new TuiProvisioningError(
        "early_exit",
        `the TUI process exited (code ${String(exitCode)}) before its control socket answered \`state\` at ${socketPath}`,
      );
    }
    if (await probe(socketPath)) {
      return { socketPath, stop };
    }
    if (now() - start >= readinessTimeoutMs) {
      await stop();
      throw new TuiProvisioningError(
        "readiness_timeout",
        `the control socket at ${socketPath} did not answer \`state\` within ${readinessTimeoutMs}ms (process still running)`,
      );
    }
    await sleep(probeIntervalMs);
  }
}

/** Spawn the shipped TUI binary as a detached-from-terminal child process. */
export function spawnShippedTui(tuiBin: string, env: Record<string, string | undefined>): TuiProcessLike {
  const child: ChildProcess = spawn(process.execPath, [tuiBin], {
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let exited = false;
  const exitedPromise = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => { exited = true; resolve(code); });
    child.on("error", () => { exited = true; resolve(null); });
  });
  return {
    exited: exitedPromise,
    hasExited: () => exited,
    kill: () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } },
  };
}
