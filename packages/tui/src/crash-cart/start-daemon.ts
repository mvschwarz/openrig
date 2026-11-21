import { spawn } from "node:child_process";
import { DAEMON_START_READINESS_WAIT_MAX_SECONDS, daemonStartCommandTimeoutMs } from "@openrig/daemon/daemon-shutdown";

/** #3637: how much of each stream a start keeps for its error message: the end, where the failure is. */
export const DAEMON_START_OUTPUT_TAIL_CHARS = 16 * 1024;

export type DaemonStartError = Error & { code?: number | string | null; signal?: NodeJS.Signals | null; killed?: boolean };

/** #3637: runs a TUI `rig daemon start` like `execFile`, but reads its output as it arrives and keeps only the last
 * DAEMON_START_OUTPUT_TAIL_CHARS of stdout and of stderr. `execFile` collects it under the default 1 MiB `maxBuffer`,
 * so the progress line the CLI prints about every 20 s would stop the CLI after about 50 h of a wait the setting
 * allows to last about 25 days. Past `timeout` ms the command gets SIGTERM, as with `execFile`. */
export function runDaemonStart(
  file: string,
  args: readonly string[],
  options: { cwd: string | undefined; timeout: number },
  callback: (error: DaemonStartError | null, stdout: string, stderr: string) => void,
): void {
  let stdout = "";
  let stderr = "";
  let killed = false;
  let done = false;
  const keepTail = (tail: string, chunk: string): string => {
    const all = tail + chunk;
    return all.length > DAEMON_START_OUTPUT_TAIL_CHARS ? all.slice(-DAEMON_START_OUTPUT_TAIL_CHARS) : all;
  };
  const child = spawn(file, args, { cwd: options.cwd });
  // Like execFile, the timeout drops the pipes before the signal, so a grandchild that inherited them can't hold the
  // result until it exits.
  const timer = options.timeout > 0
    ? setTimeout(() => { killed = true; child.stdout.destroy(); child.stderr.destroy(); child.kill("SIGTERM"); }, options.timeout)
    : undefined;
  const finish = (error: DaemonStartError | null): void => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    callback(error, stdout, stderr);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout = keepTail(stdout, chunk); });
  child.stderr.on("data", (chunk: string) => { stderr = keepTail(stderr, chunk); });
  child.on("error", (error: DaemonStartError) => finish(error));
  child.on("close", (code, signal) => {
    if (code === 0 && !killed) return finish(null);
    const error: DaemonStartError = new Error(`Command failed: ${[file, ...args].join(" ")}\n${stderr}`);
    finish(Object.assign(error, { code, signal, killed }));
  });
}

/** #3637: the TUI's budget for a `rig daemon start` whose readiness wait is the resolved
 * daemon.start_readiness_wait_seconds (`rig config get … --json`'s value). A value that can't be read falls back to the
 * longest accepted wait: the CLI keeps its own deadline, so a longer backstop never lengthens a start, and a shorter
 * one could end a start that is still within its wait. */
export function daemonStartTimeoutMs(setting: unknown): number {
  const seconds = typeof setting === "number" && Number.isInteger(setting) && setting >= 1 && setting <= DAEMON_START_READINESS_WAIT_MAX_SECONDS
    ? setting
    : DAEMON_START_READINESS_WAIT_MAX_SECONDS;
  return daemonStartCommandTimeoutMs(seconds * 1000);
}

/** Starting a local instance must never silently target the default daemon or
 * launch kernel occupants before the user has selected them. */
export function daemonStartArgs(target: string): string[] {
  const url = new URL(target);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("This target is not a local daemon endpoint. Reconnect after its owner starts it; no local daemon was started.");
  }
  // The daemon's default bind already listens on 127.0.0.1, with Tailscale beside it when present; naming that host would
  // make it the only listener. Another loopback spelling isn't in the default bind, so it's still named.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return ["daemon", "start", "--no-kernel", ...(host === "127.0.0.1" ? [] : ["--host", host]), "--port", url.port || "80"];
}
