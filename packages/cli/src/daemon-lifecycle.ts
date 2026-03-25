import path from "node:path";
import type { ChildProcess } from "node:child_process";

export interface DaemonState {
  pid: number;
  port: number;
  db: string;
  startedAt: string;
}

export interface DaemonStatus {
  state: "running" | "stopped" | "stale";
  port?: number;
  pid?: number;
  healthy?: boolean;
}

export interface StartOptions {
  port?: number;
  db?: string;
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

export const RIGGED_DIR = path.join(process.env["HOME"] ?? "~", ".rigged");
export const STATE_FILE = path.join(RIGGED_DIR, "daemon.json");
export const LOG_FILE = path.join(RIGGED_DIR, "daemon.log");

const DEFAULT_PORT = 7433;
const DEFAULT_DB = "rigged.sqlite";
const HEALTHZ_RETRIES = 20;
const HEALTHZ_DELAY_MS = 250;

export function getDaemonPath(): string {
  return path.resolve(import.meta.dirname, "../../daemon");
}

function readState(deps: LifecycleDeps): DaemonState | null {
  if (!deps.exists(STATE_FILE)) return null;
  const raw = deps.readFile(STATE_FILE);
  if (!raw) return null;
  return JSON.parse(raw) as DaemonState;
}

export async function startDaemon(opts: StartOptions, deps: LifecycleDeps): Promise<DaemonState> {
  // Check if already running
  const existing = readState(deps);
  if (existing && deps.isProcessAlive(existing.pid)) {
    throw new Error(`Daemon already running (pid ${existing.pid} on port ${existing.port})`);
  }

  const port = opts.port ?? DEFAULT_PORT;
  const db = opts.db ?? DEFAULT_DB;
  const daemonEntry = path.join(getDaemonPath(), "dist/index.js");

  // Ensure ~/.rigged exists
  deps.mkdirp(RIGGED_DIR);

  const logFd = deps.openForAppend(LOG_FILE);

  const child = deps.spawn("node", [daemonEntry], {
    env: {
      ...process.env as Record<string, string>,
      RIGGED_PORT: String(port),
      RIGGED_DB: db,
    },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });

  child.unref();

  const pid = child.pid!;

  // Poll healthz
  const healthzUrl = `http://localhost:${port}/healthz`;
  let healthy = false;
  for (let i = 0; i < HEALTHZ_RETRIES; i++) {
    try {
      const res = await deps.fetch(healthzUrl);
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
    throw new Error(`Daemon failed to start: healthz at ${healthzUrl} not responding`);
  }

  const state: DaemonState = {
    pid,
    port,
    db,
    startedAt: new Date().toISOString(),
  };

  deps.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

export async function stopDaemon(deps: LifecycleDeps): Promise<void> {
  const state = readState(deps);
  if (!state) return; // Not running — clean exit

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
    deps.removeFile(STATE_FILE);
  } else {
    throw new Error(`Daemon (pid ${state.pid}) did not exit after SIGTERM — state file preserved`);
  }
}

export async function getDaemonStatus(deps: LifecycleDeps): Promise<DaemonStatus> {
  const state = readState(deps);
  if (!state) return { state: "stopped" };

  if (!deps.isProcessAlive(state.pid)) {
    // Process dead — stale state
    deps.removeFile(STATE_FILE);
    return { state: "stale" };
  }

  // Process alive — check healthz
  let healthy = false;
  try {
    const res = await deps.fetch(`http://localhost:${state.port}/healthz`);
    healthy = res.ok;
  } catch {
    // healthz unreachable
  }

  // pid alive = running (state file preserved either way)
  return { state: "running", port: state.port, pid: state.pid, healthy };
}

export function readLogs(deps: LifecycleDeps): string | null {
  if (!deps.exists(LOG_FILE)) return null;
  return deps.readFile(LOG_FILE);
}

export function tailLogs(deps: LifecycleDeps, opts: { follow: boolean }): void {
  if (!deps.exists(LOG_FILE)) return;

  const args = opts.follow ? ["-f", LOG_FILE] : [LOG_FILE];
  const child = deps.spawn("tail", args, {
    env: process.env as Record<string, string>,
    stdio: "inherit" as unknown,
    detached: false,
  });
  child.unref();
}
