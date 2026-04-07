import { Command } from "commander";
import { existsSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { execSync } from "node:child_process";
import { resolveDaemonPath } from "../daemon-lifecycle.js";

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

  // 5. Port availability (async) — daemon already running on that port counts as OK
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
      };

      const { checks, portCheck } = runDoctorChecks(deps);
      const portResult = await portCheck;
      const allChecks = [...checks, portResult];
      const allPass = allChecks.every((c) => c.status === "pass");

      if (opts.json) {
        console.log(JSON.stringify({ healthy: allPass, checks: allChecks }, null, 2));
        if (!allPass) process.exitCode = 1;
        return;
      }

      for (const check of allChecks) {
        const icon = check.status === "pass" ? "OK" : check.status === "warn" ? "WARN" : "FAIL";
        console.log(`  [${icon}] ${check.name}: ${check.message}`);
        if (check.reason) console.log(`       Why: ${check.reason}`);
        if (check.fix) console.log(`       Fix: ${check.fix}`);
      }

      console.log("");
      console.log(allPass ? "All checks passed." : "Some checks failed.");
      if (!allPass) process.exitCode = 1;
    });

  return cmd;
}
