import { Command } from "commander";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { execSync } from "node:child_process";
import { resolveDaemonPath } from "../daemon-lifecycle.js";
import { ConfigStore } from "../config-store.js";
import { buildWritableHomeCheck } from "../system-preflight.js";

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skipped";
  message: string;
  reason?: string;
  fix?: string;
}

export interface DoctorDeps {
  exists: (p: string) => boolean;
  baseDir: string;
  exec: (cmd: string) => string;
  checkPort: (port: number) => Promise<boolean>;
  configStore: Pick<ConfigStore, "resolve">;
  platform?: NodeJS.Platform;
  mkdirp?: (path: string) => void;
  checkWritable?: (path: string) => void;
  fetch?: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>;
}

const MIN_NODE_MAJOR = 20;
const DEFAULT_PORT = 7433;

function defaultCheckPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(true); });
    socket.connect(port, "127.0.0.1");
  });
}

export function runDoctorChecks(deps: DoctorDeps): { checks: DoctorCheck[]; portCheck: Promise<DoctorCheck>; asyncChecks: Promise<DoctorCheck>[] } {
  const checks: DoctorCheck[] = [];
  const platform = deps.platform ?? process.platform;

  // 1. Daemon dist
  const daemonPath = resolveDaemonPath(deps.baseDir, deps.exists);
  const daemonEntry = path.join(daemonPath, "dist/index.js");
  if (deps.exists(daemonEntry)) {
    checks.push({ name: "daemon_dist", status: "pass", message: `Daemon dist found at ${daemonPath}` });
  } else {
    checks.push({
      name: "daemon_dist",
      status: "fail",
      message: "Daemon dist not found.",
      reason: "The daemon compiled output is required to start the OpenRig daemon process.",
      fix: "Run 'npm run build:package' from the repo root, or reinstall with 'npm install -g @openrig/cli'.",
    });
  }

  // 2. UI dist
  const uiDistPath = path.resolve(daemonPath, "..", "ui", "dist", "index.html");
  if (deps.exists(uiDistPath)) {
    checks.push({ name: "ui_dist", status: "pass", message: "UI dist found." });
  } else {
    checks.push({
      name: "ui_dist",
      status: "fail",
      message: "UI dist not found.",
      reason: "The pre-built UI assets are required for the dashboard to render.",
      fix: "Run 'npm run build:package' from the repo root, or reinstall with 'npm install -g @openrig/cli'.",
    });
  }

  // 3. Node version
  const major = parseInt(process.version.replace(/^v/, ""), 10);
  if (major >= MIN_NODE_MAJOR) {
    checks.push({ name: "node_version", status: "pass", message: `Node ${process.version}` });
  } else {
    checks.push({
      name: "node_version",
      status: "fail",
      message: `Node ${process.version} is below minimum (v${MIN_NODE_MAJOR}).`,
      reason: "OpenRig requires Node 20+ for built-in fetch, ESM, and stable API support.",
      fix: "Install Node 20+ via nvm, fnm, or your package manager.",
    });
  }

  // 4. tmux
  try {
    const ver = deps.exec("tmux -V").trim();
    checks.push({ name: "tmux", status: "pass", message: ver });
    if (platform === "darwin") {
      const mouseMode = readTmuxMouseMode(deps);
      if (mouseMode === "on") {
        checks.push({
          name: "tmux_mouse",
          status: "pass",
          message: "tmux mouse mode enabled.",
        });
      } else if (mouseMode === "off") {
        checks.push({
          name: "tmux_mouse",
          status: "warn",
          message: "tmux mouse mode appears disabled.",
          reason: "On macOS, scrolling and text selection inside tmux panes is much smoother with mouse mode enabled.",
          fix: "Run `tmux set -g mouse on` for the current tmux server. To keep it enabled, add `set -g mouse on` to `~/.tmux.conf` and reload with `tmux source-file ~/.tmux.conf`.",
        });
      }
    }
  } catch {
    checks.push({
      name: "tmux",
      status: "fail",
      message: "tmux not found.",
      reason: "OpenRig uses tmux to manage agent sessions.",
      fix: "Install tmux: brew install tmux (macOS), apt install tmux (Linux).",
    });
  }

  // 5. cmux shell check (optional but recommended for Open CMUX workflows)
  let shellCmuxPassed = false;
  try {
    deps.exec("cmux capabilities --json");
    shellCmuxPassed = true;
    checks.push({
      name: "cmux_shell",
      status: "pass",
      message: "cmux shell control available.",
    });
  } catch (err) {
    try {
      deps.exec("cmux --help");
      const socketMode = platform === "darwin" ? readCmuxSocketControlMode(deps) : null;
      const modeHint = socketMode && !isCmuxSocketControlCompatible(socketMode)
        ? ` Likely cause on macOS: cmux socketControlMode is '${socketMode}'. Tell the user to allow OpenRig/cmux socket control, then rerun 'rig doctor'.`
        : "";
      checks.push({
        name: "cmux_shell",
        status: "warn",
        message: "cmux installed, but control unavailable right now.",
        reason: "OpenRig can run without cmux, but Open CMUX actions and cmux-aware node control will be unavailable until cmux control works.",
        fix: `Open the cmux app, verify control access/socket sharing is enabled for OpenRig, then rerun 'rig doctor'. If you are running this for someone else, tell the user that cmux is optional but required for Open CMUX. If you do not need cmux features, you can ignore this warning.${modeHint}`,
      });
    } catch {
      checks.push({
        name: "cmux_shell",
        status: "warn",
        message: "cmux not found.",
        reason: "OpenRig can run without cmux, but Open CMUX actions and surface control will be unavailable.",
        fix: "Install and launch cmux if you want Open CMUX support. If you are running this for someone else, tell the user that cmux is optional and only needed for Open CMUX workflows.",
      });
    }
    void err;
  }

  // 6. Writable state paths (shared with preflight)
  const config = deps.configStore.resolve();
  const writableCheck = buildWritableHomeCheck(config, path.dirname(config.db.path), {
    mkdirp: deps.mkdirp,
    checkWritable: deps.checkWritable,
  });
  checks.push({
    name: writableCheck.name,
    status: writableCheck.ok ? "pass" : "fail",
    message: writableCheck.ok ? "Writable state paths verified." : writableCheck.error ?? "State paths are not writable.",
    reason: writableCheck.reason,
    fix: writableCheck.fix,
  });

  // 7. Port availability (async) — daemon already running on that port counts as OK
  const portCheck = deps.checkPort(DEFAULT_PORT).then(async (available): Promise<DoctorCheck> => {
    if (available) {
      return { name: "port", status: "pass", message: `Port ${DEFAULT_PORT} available.` };
    }
    // Port in use — check if it's our daemon via healthz
    try {
      const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/healthz`);
      if (res.ok) {
        return { name: "port", status: "pass", message: `Port ${DEFAULT_PORT} in use by OpenRig daemon.` };
      }
    } catch { /* not our daemon */ }
    return {
      name: "port",
      status: "fail",
      message: `Port ${DEFAULT_PORT} is in use by another process.`,
      reason: "The daemon needs this port to serve the API and UI.",
      fix: `Stop the process using port ${DEFAULT_PORT}, or start the daemon on a different port with: rig daemon start --port <port>`,
    };
  });

  // 8. Daemon cmux control (async, only when shell cmux passed)
  const asyncChecks: Promise<DoctorCheck>[] = [portCheck];
  if (shellCmuxPassed) {
    const fetchFn = deps.fetch ?? globalThis.fetch;
    const daemonCmuxCheck = (async (): Promise<DoctorCheck> => {
      try {
        const healthRes = await fetchFn(`http://127.0.0.1:${DEFAULT_PORT}/healthz`);
        if (!healthRes.ok) {
          return { name: "cmux_daemon", status: "skipped", message: "Daemon not running. Skipping daemon cmux check." };
        }
      } catch {
        return { name: "cmux_daemon", status: "skipped", message: "Daemon not reachable. Skipping daemon cmux check." };
      }

      try {
        const cmuxRes = await fetchFn(`http://127.0.0.1:${DEFAULT_PORT}/api/adapters/cmux/status`);
        if (cmuxRes.ok && cmuxRes.json) {
          const data = (await cmuxRes.json()) as { available?: boolean };
          if (data.available) {
            return { name: "cmux_daemon", status: "pass", message: "Daemon cmux control available." };
          }
          return buildCmuxDaemonWarning(deps, platform);
        }
      } catch { /* fetch failed */ }

      return buildCmuxDaemonWarning(deps, platform);
    })();
    asyncChecks.push(daemonCmuxCheck);
  }

  return { checks, portCheck, asyncChecks };
}

function readCmuxSocketControlMode(deps: DoctorDeps): string | null {
  try {
    const mode = deps.exec("defaults read com.cmuxterm.app socketControlMode").trim();
    return mode || null;
  } catch {
    return null;
  }
}

function isCmuxSocketControlCompatible(mode: string | null): boolean {
  return mode === "automation" || mode === "allowAll";
}

function buildCmuxDaemonWarning(deps: DoctorDeps, platform: NodeJS.Platform): DoctorCheck {
  const socketMode = platform === "darwin" ? readCmuxSocketControlMode(deps) : null;

  if (platform === "darwin" && socketMode && !isCmuxSocketControlCompatible(socketMode)) {
    return {
      name: "cmux_daemon",
      status: "warn",
      message: "Shell cmux works, but the daemon cannot control cmux.",
      reason: `cmux socketControlMode is '${socketMode}', so the daemon cannot attach as an external cmux client yet.`,
      fix: "Run `rig setup` to set cmux socket control to automation, then restart the daemon with `rig daemon start`. If you change cmux manually, rerun `rig doctor` after the prompt is cleared.",
    };
  }

  return {
    name: "cmux_daemon",
    status: "warn",
    message: "Shell cmux works, but the daemon cannot control cmux.",
    reason: "The daemon inherited a terminal/session environment that broke cmux adapter initialization.",
    fix: "Restart the daemon with `rig daemon start` after setup. If it still fails, inspect the daemon log with `rig daemon logs`.",
  };
}

function readTmuxMouseMode(deps: DoctorDeps): "on" | "off" | null {
  try {
    const mode = deps.exec("tmux show-options -gqv mouse").trim().toLowerCase();
    if (mode === "on" || mode === "off") return mode;
    return null;
  } catch {
    return null;
  }
}

export function doctorCommand(depsOverride?: DoctorDeps): Command {
  const cmd = new Command("doctor").description("Verify OpenRig install health");

  cmd
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps: DoctorDeps = depsOverride ?? {
        exists: existsSync,
        baseDir: import.meta.dirname,
        exec: (c: string) => execSync(c, { encoding: "utf-8" }),
        checkPort: defaultCheckPort,
        configStore: new ConfigStore(),
        mkdirp: (dirPath: string) => mkdirSync(dirPath, { recursive: true }),
        checkWritable: (dirPath: string) => accessSync(dirPath, constants.W_OK),
      };

      const { checks, asyncChecks } = runDoctorChecks(deps);
      const resolvedAsync = await Promise.all(asyncChecks);
      const allChecks = [...checks, ...resolvedAsync];
      const healthy = allChecks.every((c) => c.status !== "fail");

      if (opts.json) {
        console.log(JSON.stringify({ healthy, checks: allChecks }, null, 2));
        if (!healthy) process.exitCode = 1;
        return;
      }

      for (const check of allChecks) {
        const icon = check.status === "pass" ? "OK" : check.status === "warn" ? "WARN" : check.status === "skipped" ? "SKIP" : "FAIL";
        console.log(`  [${icon}] ${check.name}: ${check.message}`);
        if (check.reason) console.log(`       Why: ${check.reason}`);
        if (check.fix) console.log(`       Fix: ${check.fix}`);
      }

      console.log("");
      console.log(healthy ? "System checks look good." : "Some checks failed.");
      if (!healthy) process.exitCode = 1;
    });

  return cmd;
}
