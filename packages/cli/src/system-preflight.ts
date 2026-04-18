import net from "node:net";
import { accessSync, mkdirSync, constants } from "node:fs";
import { dirname } from "node:path";
import type { ConfigStore, RiggedConfig } from "./config-store.js";
import type { DaemonStatus } from "./daemon-lifecycle.js";
import { buildTmuxControlFailure, probeTmuxControlAsync } from "./tmux-health.js";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  error?: string;
  reason?: string;
  fix?: string;
}

export interface PreflightResult {
  ready: boolean;
  checks: PreflightCheck[];
}

interface PreflightDeps {
  exec: (cmd: string) => Promise<string>;
  configStore: ConfigStore;
  getDaemonStatus: () => Promise<DaemonStatus>;
  openrigHome?: string;
  riggedHome?: string;
}

interface RunOverrides {
  port?: number;
  host?: string;
}

const MIN_NODE_MAJOR = 20;

interface WritableHomeCheckDeps {
  mkdirp?: (path: string) => void;
  checkWritable?: (path: string) => void;
}

function parseNodeMajor(version: string): number {
  const match = version.match(/^v?(\d+)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

function checkPort(host: string, port: number): Promise<boolean> {
  if (port <= 0) return Promise.resolve(true); // port 0 is always available
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(false); // port is in use
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(true); // port is available
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(true); // timeout = nothing listening
    });
    socket.connect(port, host);
  });
}

export function buildWritableHomeCheck(
  config: RiggedConfig,
  openrigHome: string,
  deps: WritableHomeCheckDeps = {},
): PreflightCheck {
  const mkdirp = deps.mkdirp ?? ((dirPath: string) => mkdirSync(dirPath, { recursive: true }));
  const checkWritable = deps.checkWritable ?? ((dirPath: string) => accessSync(dirPath, constants.W_OK));

  const pathsToCheck = [
    { path: openrigHome, label: "OpenRig home" },
  ];
  const dbDir = dirname(config.db.path);
  if (dbDir && dbDir !== openrigHome && !dbDir.startsWith(openrigHome + "/")) {
    pathsToCheck.push({ path: dbDir, label: "Database directory" });
  }
  const transcriptPath = config.transcripts.path;
  if (transcriptPath && transcriptPath !== openrigHome && !transcriptPath.startsWith(openrigHome + "/")) {
    pathsToCheck.push({ path: transcriptPath, label: "Transcript directory" });
  }

  const writableErrors: string[] = [];
  for (const { path: dirPath, label } of pathsToCheck) {
    try {
      mkdirp(dirPath);
      checkWritable(dirPath);
    } catch {
      writableErrors.push(`Cannot write to ${dirPath} (${label}).`);
    }
  }

  if (writableErrors.length === 0) {
    return { name: "writable_home", ok: true };
  }

  return {
    name: "writable_home",
    ok: false,
    error: writableErrors.join(" "),
    reason: "OpenRig stores database, config, and transcripts in these directories.",
    fix: "Fix directory permissions, or change paths with rig config set db.path / transcripts.path.",
  };
}

export class SystemPreflight {
  private deps: PreflightDeps;

  constructor(deps: PreflightDeps) {
    this.deps = deps;
  }

  async run(overrides?: RunOverrides): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];
    const config = this.deps.configStore.resolve();
    const effectivePort = overrides?.port ?? config.daemon.port;
    const effectiveHost = overrides?.host ?? config.daemon.host;
    const openrigHome = this.deps.openrigHome ?? this.deps.riggedHome ?? "";

    // 1. Node version
    const major = parseNodeMajor(process.version);
    if (major >= MIN_NODE_MAJOR) {
      checks.push({ name: "node_version", ok: true });
    } else {
      checks.push({
        name: "node_version",
        ok: false,
        error: `Node.js ${process.version} is below the minimum (v${MIN_NODE_MAJOR}.0.0).`,
        reason: "OpenRig requires Node 20+ for built-in fetch, ESM, and stable API support.",
        fix: "Install Node 20+ via nvm, fnm, or your package manager.",
      });
    }

    // 2. tmux availability
    const tmuxProbe = await probeTmuxControlAsync(this.deps.exec);
    if (tmuxProbe.code === "not_installed") {
      checks.push({
        name: "tmux",
        ok: false,
        error: "tmux was not found in PATH.",
        reason: "OpenRig uses tmux to create and control agent sessions.",
        fix: "Install tmux (brew install tmux on macOS, apt install tmux on Debian/Ubuntu).",
      });
    } else if (tmuxProbe.available) {
      checks.push({ name: "tmux", ok: true });
    } else {
      const failure = buildTmuxControlFailure(tmuxProbe.detail ?? "unknown tmux control failure");
      checks.push({
        name: "tmux",
        ok: false,
        error: failure.message,
        reason: failure.reason,
        fix: failure.fix,
      });
    }

    // 3. Writable OpenRig home + transcript path
    checks.push(buildWritableHomeCheck(config, openrigHome));

    // 4. Daemon port availability
    const status = await this.deps.getDaemonStatus();
    const daemonOnSameEndpoint =
      status.state === "running" &&
      (status.host ?? "127.0.0.1") === effectiveHost &&
      status.port === effectivePort;

    if (daemonOnSameEndpoint) {
      // Our daemon is already running on this exact endpoint — skip
      checks.push({ name: "port_available", ok: true });
    } else {
      const available = await checkPort(effectiveHost, effectivePort);
      if (available) {
        checks.push({ name: "port_available", ok: true });
      } else {
        checks.push({
          name: "port_available",
          ok: false,
          error: `Port ${effectivePort} is already in use on ${effectiveHost}.`,
          reason: "The daemon cannot bind to a port that is already occupied.",
          fix: `Run rig config set daemon.port ${effectivePort + 1} and retry, or find the existing process with lsof -nP -iTCP:${effectivePort} -sTCP:LISTEN.`,
        });
      }
    }

    return {
      ready: checks.every((c) => c.ok),
      checks,
    };
  }
}
