import path from "node:path";
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { OPENRIG_HOME, LEGACY_RIGGED_HOME, readOpenRigEnv } from "./openrig-compat.js";

export interface DaemonState {
  pid: number;
  port: number;
  host?: string;
  db: string;
  startedAt: string;
}

export interface DaemonStatus {
  state: "running" | "stopped" | "stale";
  port?: number;
  host?: string;
  pid?: number;
  healthy?: boolean;
}

/** Build the daemon HTTP URL from status. Uses persisted host or defaults to 127.0.0.1. */
export function getDaemonUrl(status: DaemonStatus): string {
  return `http://${status.host ?? "127.0.0.1"}:${status.port}`;
}

export interface StartOptions {
  port?: number;
  host?: string;
  db?: string;
  transcriptsEnabled?: boolean;
  transcriptsPath?: string;
}

export interface LifecycleDeps {
  spawn: (cmd: string, args: string[], opts: {
    env: Record<string, string>;
    stdio: unknown;
    detached: boolean;
  }) => ChildProcess;
  fetch: (url: string) => Promise<{ ok: boolean }>;
  kill: (pid: number, signal: string) => boolean;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  removeFile: (path: string) => void;
  exists: (path: string) => boolean;
  mkdirp: (path: string) => void;
  openForAppend: (path: string) => number;
  isProcessAlive: (pid: number) => boolean;
}

export const OPENRIG_DIR = OPENRIG_HOME;
export const RIGGED_DIR = OPENRIG_DIR;
export const STATE_FILE = path.join(OPENRIG_DIR, "daemon.json");
export const LOG_FILE = path.join(OPENRIG_DIR, "daemon.log");
export const LEGACY_STATE_FILE = path.join(LEGACY_RIGGED_HOME, "daemon.json");
export const LEGACY_LOG_FILE = path.join(LEGACY_RIGGED_HOME, "daemon.log");

const DEFAULT_PORT = 7433;
const DEFAULT_DB = "openrig.sqlite";
const HEALTHZ_RETRIES = 20;
const HEALTHZ_DELAY_MS = 250;
const HEALTHZ_PROBE_TIMEOUT_MS = 250;

class HealthProbeTimeoutError extends Error {
  constructor(url: string) {
    super(`healthz probe timed out for ${url}`);
    this.name = "HealthProbeTimeoutError";
  }
}

function summarizeDaemonStartFailure(healthzUrl: string, logContent: string | null): string {
  const generic = `Daemon failed to start: healthz at ${healthzUrl} not responding`;
  const lines = (logContent ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return generic;

  const recentLines = lines.slice(-20);
  const recentBlock = recentLines.join("\n");

  if (/ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(recentBlock)) {
    const moduleName = /better[-_]?sqlite3/i.test(recentBlock) ? "better-sqlite3" : "the daemon's native module";
    const detail = recentLines.find((line) => /ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(line))
      ?? recentLines[recentLines.length - 1]!;
    return [
      `Daemon failed to start under Node ${process.version} (${process.execPath}).`,
      `${moduleName} could not load because its native binary does not match the active Node runtime.`,
      `Recent daemon log: ${detail}`,
      "Fix: switch back to the Node version used when @openrig/cli was installed, or reinstall @openrig/cli under the current node, then retry `rig daemon start`.",
    ].join(" ");
  }

  const detail = [...recentLines].reverse().find((line) => /error|ERR_|failed|exception|cannot|disk full/i.test(line))
    ?? recentLines[recentLines.length - 1]!;
  return `${generic}. Recent daemon log: ${detail}`;
}

export function resolveCliBaseDir(baseDir: string): string {
  return path.basename(baseDir) === "commands" ? path.resolve(baseDir, "..") : baseDir;
}

/** Pure resolver: prefers bundled daemon (npm install layout), falls back to monorepo. */
export function resolveDaemonPath(baseDir: string, exists: (p: string) => boolean): string {
  const cliBaseDir = resolveCliBaseDir(baseDir);
  const bundled = path.resolve(cliBaseDir, "../daemon");
  if (exists(path.join(bundled, "dist/index.js"))) return bundled;
  return path.resolve(cliBaseDir, "../../daemon");
}

export function getDaemonPath(): string {
  return resolveDaemonPath(import.meta.dirname, existsSync);
}

function readState(deps: LifecycleDeps): DaemonState | null {
  const stateFile = resolveLifecycleFile(deps, "daemon.json");
  if (!deps.exists(stateFile)) return null;
  const raw = deps.readFile(stateFile);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DaemonState;
  } catch {
    // Malformed daemon.json — treat as no state
    console.error("Warning: malformed daemon.json, treating as stopped");
    return null;
  }
}

function resolveLifecycleFile(deps: LifecycleDeps, filename: "daemon.json" | "daemon.log"): string {
  const primary = filename === "daemon.json" ? STATE_FILE : LOG_FILE;
  if (deps.exists(primary)) return primary;

  const legacy = filename === "daemon.json" ? LEGACY_STATE_FILE : LEGACY_LOG_FILE;
  if (deps.exists(legacy)) return legacy;

  return primary;
}

/** Check if a PID is an OpenRig daemon. Returns:
 *  - "openrig" — healthz responded (ok or not) → this is our daemon
 *  - "not_openrig" — connection refused → PID is alive but not listening on our port
 *  - "unresponsive" — pid is alive but healthz probe timed out
 *  - "dead" — PID not alive */
async function checkPid(state: DaemonState, deps: LifecycleDeps): Promise<"openrig" | "not_openrig" | "unresponsive" | "dead"> {
  if (!deps.isProcessAlive(state.pid)) return "dead";
  const host = state.host ?? "127.0.0.1";
  try {
    await fetchDaemonProbe(deps, `http://${host}:${state.port}/healthz`);
    // Any response (ok or not) means something is listening on our port → OpenRig
    return "openrig";
  } catch (err) {
    if (err instanceof HealthProbeTimeoutError) return "unresponsive";
    // Connection refused → PID alive but not our daemon
    return "not_openrig";
  }
}

/**
 * Scrub list: environment variable prefixes and exact names that should NOT
 * be forwarded from the operator shell into the daemon process. These are
 * terminal-emulator, GUI-session, and cmux-session variables that can break
 * adapter initialization when the daemon runs detached.
 */
const ENV_SCRUB_PREFIXES = ["CODEX_", "GHOSTTY_", "XPC_", "__CF"];
const ENV_SCRUB_EXACT = new Set([
  "CMUX_SOCKET_PATH",
  "CMUX_SURFACE_ID",
  "CMUX_WORKSPACE",
  "COLORTERM",
  "COMMAND_MODE",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERMINFO",
]);

export function buildDaemonEnv(
  baseEnv: Record<string, string>,
  opts: { port: number; host: string; db: string; transcriptsEnabled?: boolean; transcriptsPath?: string },
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (ENV_SCRUB_EXACT.has(key)) continue;
    if (ENV_SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  // Explicit OPENRIG_* overrides — always win over inherited values
  env["OPENRIG_PORT"] = String(opts.port);
  env["OPENRIG_HOST"] = opts.host;
  env["OPENRIG_DB"] = opts.db;
  if (opts.transcriptsEnabled !== undefined) {
    env["OPENRIG_TRANSCRIPTS_ENABLED"] = String(opts.transcriptsEnabled);
  }
  if (opts.transcriptsPath) {
    env["OPENRIG_TRANSCRIPTS_PATH"] = opts.transcriptsPath;
  }

  return env;
}

export async function startDaemon(opts: StartOptions, deps: LifecycleDeps): Promise<DaemonState> {
  // Check if already running
  const existing = readState(deps);
  if (existing) {
    const pidState = await checkPid(existing, deps);
    if (pidState === "openrig") {
      // Our daemon is running (possibly unhealthy, but alive on our port)
      throw new Error(`Daemon already running (pid ${existing.pid} on port ${existing.port})`);
    }
    if (pidState === "unresponsive") {
      throw new Error(`Existing daemon process (pid ${existing.pid} on port ${existing.port}) is unresponsive — recover it before starting a new daemon.`);
    }
    // "dead" or "not_rigged" → stale state, safe to proceed
  }

  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? "127.0.0.1";
  const db = opts.db ?? DEFAULT_DB;
  const daemonEntry = path.join(getDaemonPath(), "dist/index.js");

  deps.mkdirp(OPENRIG_DIR);

  const logFd = deps.openForAppend(LOG_FILE);

  const child = deps.spawn(process.execPath, [daemonEntry], {
    env: buildDaemonEnv(process.env as Record<string, string>, {
      port,
      host,
      db,
      transcriptsEnabled: opts.transcriptsEnabled,
      transcriptsPath: opts.transcriptsPath,
    }),
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });

  child.unref();

  const pid = child.pid!;

  // Poll healthz
  const healthzUrl = `http://${host}:${port}/healthz`;
  let healthy = false;
  for (let i = 0; i < HEALTHZ_RETRIES; i++) {
    try {
      const res = await fetchDaemonProbe(deps, healthzUrl);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTHZ_DELAY_MS));
  }

  if (!healthy) {
    try { deps.kill(pid, "SIGTERM"); } catch { /* best effort */ }
    const logContent = deps.readFile(resolveLifecycleFile(deps, "daemon.log"));
    throw new Error(summarizeDaemonStartFailure(healthzUrl, logContent));
  }

  const state: DaemonState = {
    pid,
    port,
    host,
    db,
    startedAt: new Date().toISOString(),
  };

  deps.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

export async function stopDaemon(deps: LifecycleDeps): Promise<void> {
  const state = readState(deps);
  if (!state) return; // Not running — clean exit
  const stateFile = resolveLifecycleFile(deps, "daemon.json");

  const pidState = await checkPid(state, deps);
  if (pidState === "dead") {
    // Already dead — clean up stale state
    deps.removeFile(stateFile);
    return;
  }
  if (pidState === "not_openrig") {
    // PID alive but not our daemon (reused PID) — clean up state, don't kill
    deps.removeFile(stateFile);
    return;
  }

  // pidState === "openrig" or "unresponsive" — safe to SIGTERM
  deps.kill(state.pid, "SIGTERM");

  // Wait briefly for process to exit
  let exited = false;
  for (let i = 0; i < 20; i++) {
    if (!deps.isProcessAlive(state.pid)) {
      exited = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (exited) {
    deps.removeFile(stateFile);
  } else {
    throw new Error(`Daemon (pid ${state.pid}) did not exit after SIGTERM — state file preserved`);
  }
}

export async function getDaemonStatus(deps: LifecycleDeps): Promise<DaemonStatus> {
  // If OPENRIG_URL is set, bypass daemon.json and probe that URL directly
  const openrigUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
  if (openrigUrl) {
    try {
      const res = await fetchDaemonProbe(deps, `${openrigUrl}/healthz`);
      const url = new URL(openrigUrl);
      return { state: "running", port: Number(url.port) || 7433, host: url.hostname || "127.0.0.1", healthy: res.ok };
    } catch {
      return { state: "stopped" };
    }
  }

  const state = readState(deps);
  if (!state) return { state: "stopped" };

  if (!deps.isProcessAlive(state.pid)) {
    // Process dead — stale state
    deps.removeFile(resolveLifecycleFile(deps, "daemon.json"));
    return { state: "stale" };
  }

  // Process alive — check healthz
  const host = state.host ?? "127.0.0.1";
  let healthy = false;
  try {
    const res = await fetchDaemonProbe(deps, `http://${host}:${state.port}/healthz`);
    healthy = res.ok;
  } catch {
    // healthz unreachable
  }

  // pid alive = running (state file preserved either way)
  return { state: "running", port: state.port, host, pid: state.pid, healthy };
}

export function readLogs(deps: LifecycleDeps): string | null {
  const logFile = resolveLifecycleFile(deps, "daemon.log");
  if (!deps.exists(logFile)) return null;
  return deps.readFile(logFile);
}

export function tailLogs(deps: LifecycleDeps, opts: { follow: boolean }): void {
  const logFile = resolveLifecycleFile(deps, "daemon.log");
  if (!deps.exists(logFile)) return;

  const args = opts.follow ? ["-f", logFile] : [logFile];
  const child = deps.spawn("tail", args, {
    env: process.env as Record<string, string>,
    stdio: "inherit" as unknown,
    detached: false,
  });
  child.unref();
}

async function fetchDaemonProbe(deps: LifecycleDeps, url: string): Promise<{ ok: boolean }> {
  return await Promise.race([
    deps.fetch(url),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new HealthProbeTimeoutError(url)), HEALTHZ_PROBE_TIMEOUT_MS);
    }),
  ]);
}
