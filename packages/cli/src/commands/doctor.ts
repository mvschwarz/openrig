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
  status: "pass" | "warn" | "fail";
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

export function runDoctorChecks(deps: DoctorDeps): { checks: DoctorCheck[]; portCheck: Promise<DoctorCheck> } {
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
  } catch {
    checks.push({
      name: "tmux",
      status: "fail",
      message: "tmux not found.",
      reason: "OpenRig uses tmux to manage agent sessions.",
      fix: "Install tmux: brew install tmux (macOS), apt install tmux (Linux).",
    });
  }

  // 5. cmux (optional but recommended for Open CMUX workflows)
  try {
    deps.exec("cmux capabilities --json");
    checks.push({
      name: "cmux",
      status: "pass",
      message: "cmux control available.",
    });
  } catch (err) {
    try {
      deps.exec("cmux --help");
      const socketMode = platform === "darwin" ? readCmuxSocketControlMode(deps) : null;
      const modeHint = socketMode && socketMode !== "allowAll"
        ? ` Likely cause on macOS: cmux socketControlMode is '${socketMode}'. Tell the user to allow OpenRig/cmux socket control, then rerun 'rig doctor'.`
        : "";
      checks.push({
        name: "cmux",
        status: "warn",
        message: "cmux installed, but control unavailable right now.",
        reason: "OpenRig can run without cmux, but Open CMUX actions and cmux-aware node control will be unavailable until cmux control works.",
        fix: `Open the cmux app, verify control access/socket sharing is enabled for OpenRig, then rerun 'rig doctor'. If you are running this for someone else, tell the user that cmux is optional but required for Open CMUX. If you do not need cmux features, you can ignore this warning.${modeHint}`,
      });
    } catch {
      checks.push({
        name: "cmux",
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

  return { checks, portCheck };
}

function readCmuxSocketControlMode(deps: DoctorDeps): string | null {
  try {
    const mode = deps.exec("defaults read com.cmuxterm.app socketControlMode").trim();
    return mode || null;
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

      const { checks, portCheck } = runDoctorChecks(deps);
      const portResult = await portCheck;
      const allChecks = [...checks, portResult];
      const healthy = allChecks.every((c) => c.status !== "fail");

      if (opts.json) {
        console.log(JSON.stringify({ healthy, checks: allChecks }, null, 2));
        if (!healthy) process.exitCode = 1;
        return;
      }

      for (const check of allChecks) {
        const icon = check.status === "pass" ? "OK" : check.status === "warn" ? "WARN" : "FAIL";
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
