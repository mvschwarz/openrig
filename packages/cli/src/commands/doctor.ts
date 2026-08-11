import { Command } from "commander";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { execSync } from "node:child_process";
import { resolveDaemonPath } from "../daemon-lifecycle.js";
import { ConfigStore } from "../config-store.js";
import { buildWritableHomeCheck } from "../system-preflight.js";
import {
  CMUX_SETTINGS_DISCLOSURE_PATH,
  isCmuxSocketControlCompatible,
  readCmuxSocketControlModeFromText,
  resolveCmuxSettingsPath,
} from "../cmux-config.js";
import { buildTmuxControlFailure, probeTmuxControl } from "../tmux-health.js";
import { parse as parseYaml } from "yaml";
import { compareSpecToLive, topologyFromRigSpec, topologyFromLiveLogicalIds } from "@openrig/daemon/spec-conformance";

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
  readFile: (path: string) => string | null;
  exec: (cmd: string) => string;
  checkPort: (port: number, host: string) => Promise<boolean>;
  configStore: Pick<ConfigStore, "resolve">;
  platform?: NodeJS.Platform;
  mkdirp?: (path: string) => void;
  checkWritable?: (path: string) => void;
  fetch?: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>;
  /**
   * Build B — path to a rig spec to check against the RUNNING rig of the same name (`--spec`).
   *
   * Supplied explicitly because it cannot be discovered. Nothing persists a running rig's spec
   * path: the `rigs` table has no spec/rigRoot column, `rig_services.rig_root` is empty, and
   * `projection_manifest.source_spec` is empty. The daemon does not remember which file described
   * the rig it is running. Absent, the check SKIPS with that reason rather than passing.
   */
  specPath?: string;
  /** Live seat ids (`<pod>.<member>`) for the spec's rig; null when the topology cannot be read. */
  fetchLiveLogicalIds?: (rigName: string) => Promise<string[] | null>;
}

const MIN_NODE_MAJOR = 20;
const DEFAULT_PORT = 7433;

function defaultCheckPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(true); });
    socket.connect(port, host);
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
  const tmuxProbe = probeTmuxControl((cmd) => deps.exec(cmd));
  if (tmuxProbe.code === "not_installed") {
    checks.push({
      name: "tmux",
      status: "fail",
      message: "tmux not found.",
      reason: "OpenRig uses tmux to manage agent sessions.",
      fix: "Install tmux: brew install tmux (macOS), apt install tmux (Linux).",
    });
  } else if (tmuxProbe.available && tmuxProbe.version) {
    checks.push({ name: "tmux", status: "pass", message: tmuxProbe.version });
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
  } else {
    const failure = buildTmuxControlFailure(tmuxProbe.detail ?? "unknown tmux control failure");
    checks.push({
      name: "tmux",
      status: "fail",
      message: failure.message,
      reason: failure.reason,
      fix: failure.fix,
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
      const modeHint = socketMode?.error
        ? ` Likely cause on macOS: ${CMUX_SETTINGS_DISCLOSURE_PATH} is unreadable (${socketMode.error}).`
        : socketMode && !isCmuxSocketControlCompatible(socketMode.mode) && socketMode.source === "default"
        ? ` Likely cause on macOS: cmux is still using its default automation.socketControlMode '${socketMode.mode}'.`
        : socketMode && !isCmuxSocketControlCompatible(socketMode.mode)
        ? ` Likely cause on macOS: automation.socketControlMode is '${socketMode.mode}' in ${CMUX_SETTINGS_DISCLOSURE_PATH}.`
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

  // 7. Port availability (async) — daemon already running on that port counts as OK.
  // OPR.0.4.7 slice-05 item-4b: resolve the daemon host+port ONCE from config and use
  // BOTH for checkPort, healthz, the cmux URL, and messages (a daemon on a non-default
  // configured host/port must not be reported missing). Defaults stay 127.0.0.1:7433.
  const daemonHost = config.daemon.host ?? "127.0.0.1";
  const daemonPort = config.daemon.port ?? DEFAULT_PORT;
  const daemonBase = `http://${daemonHost}:${daemonPort}`;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const portCheck = deps.checkPort(daemonPort, daemonHost).then(async (available): Promise<DoctorCheck> => {
    if (available) {
      return { name: "port", status: "pass", message: `Port ${daemonHost}:${daemonPort} available.` };
    }
    // Port in use — check if it's our daemon via healthz
    try {
      const res = await fetchFn(`${daemonBase}/healthz`);
      if (res.ok) {
        return { name: "port", status: "pass", message: `Port ${daemonHost}:${daemonPort} in use by OpenRig daemon.` };
      }
    } catch { /* not our daemon */ }
    return {
      name: "port",
      status: "fail",
      message: `Port ${daemonHost}:${daemonPort} is in use by another process.`,
      reason: "The daemon needs this port to serve the API and UI.",
      fix: `Stop the process using port ${daemonPort}, or start the daemon on a different port with: rig daemon start --port <port>`,
    };
  });

  // 8. Daemon cmux control (async, only when shell cmux passed)
  const asyncChecks: Promise<DoctorCheck>[] = [portCheck];
  if (shellCmuxPassed) {
    const daemonCmuxCheck = (async (): Promise<DoctorCheck> => {
      try {
        const healthRes = await fetchFn(`${daemonBase}/healthz`);
        if (!healthRes.ok) {
          return { name: "cmux_daemon", status: "skipped", message: "Daemon healthz not ok. Skipping daemon cmux check." };
        }
      } catch {
        return { name: "cmux_daemon", status: "skipped", message: "Daemon not reachable. Skipping daemon cmux check." };
      }

      try {
        const cmuxRes = await fetchFn(`${daemonBase}/api/adapters/cmux/status`);
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

  asyncChecks.push(buildSpecConformanceCheck(deps));

  return { checks, portCheck, asyncChecks };
}

/**
 * Build B — does the rig spec still describe the rig that is running?
 *
 * Nothing writes a spec back after `rig expand`, and the spec is what a bundle export copies
 * verbatim, so a rig can outgrow its own description silently. This is the check that says so —
 * and, once a spec is reconciled by hand, the check that VERIFIES the write-back landed instead of
 * someone eyeballing YAML.
 *
 * SKIPS rather than passes when it has no input. A check that cannot find its subject and stays
 * quiet is indistinguishable from one that looked and found nothing wrong.
 */
async function buildSpecConformanceCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = "spec_live_conformance";
  if (!deps.specPath) {
    return {
      name,
      status: "skipped",
      message: "No --spec given; spec-vs-live topology not checked.",
      reason:
        "A running rig's spec path is not persisted anywhere (the rigs table has no spec/rigRoot column), so this check cannot discover it.",
      fix: "rig doctor --spec <path/to/rig.yaml>",
    };
  }

  const raw = deps.readFile(deps.specPath);
  if (raw === null) {
    return { name, status: "fail", message: `Rig spec could not be read at ${deps.specPath}.` };
  }

  let spec: { name?: unknown; pods?: unknown };
  try {
    spec = parseYaml(raw) as { name?: unknown; pods?: unknown };
  } catch (err) {
    return { name, status: "fail", message: `Rig spec at ${deps.specPath} is not valid YAML: ${(err as Error).message}` };
  }
  const rigName = typeof spec?.name === "string" ? spec.name : "";
  if (!rigName || !Array.isArray(spec?.pods)) {
    return { name, status: "fail", message: `Rig spec at ${deps.specPath} declares no name or no pods.` };
  }

  const liveIds = deps.fetchLiveLogicalIds ? await deps.fetchLiveLogicalIds(rigName) : null;
  if (liveIds === null) {
    return {
      name,
      status: "skipped",
      message: `Live topology for '${rigName}' could not be read; conformance unknown.`,
      reason: "Absence of live data is not evidence of conformance, so this is reported as unknown rather than passing.",
    };
  }

  const result = compareSpecToLive(topologyFromRigSpec(spec as never), topologyFromLiveLogicalIds(liveIds));
  if (result.conforms) {
    return {
      name,
      status: "pass",
      message: `Spec matches the running rig '${rigName}' (${result.spec.pods} pods/${result.spec.seats} seats).`,
    };
  }
  return {
    name,
    status: "warn",
    message: `Rig '${rigName}': ${result.message}`,
    reason: "A bundle export copies the SPEC verbatim, so this rig would export smaller than it runs.",
    fix: "Reconcile the spec with the running topology, then re-run this check to verify the write-back.",
  };
}

function readCmuxSocketControlMode(deps: DoctorDeps) {
  return readCmuxSocketControlModeFromText(deps.readFile(resolveCmuxSettingsPath()));
}

function buildCmuxDaemonWarning(deps: DoctorDeps, platform: NodeJS.Platform): DoctorCheck {
  const socketMode = platform === "darwin" ? readCmuxSocketControlMode(deps) : null;

  if (platform === "darwin" && socketMode?.error) {
    return {
      name: "cmux_daemon",
      status: "warn",
      message: "Shell cmux works, but the daemon cannot control cmux.",
      reason: `${CMUX_SETTINGS_DISCLOSURE_PATH} is unreadable: ${socketMode.error}`,
      fix: `Repair ${CMUX_SETTINGS_DISCLOSURE_PATH} or remove it so cmux can regenerate the template, then rerun \`rig setup\` or \`rig doctor\`.`,
    };
  }

  if (platform === "darwin" && socketMode && !isCmuxSocketControlCompatible(socketMode.mode)) {
    const reason = socketMode.source === "default"
      ? `cmux is still using its default automation.socketControlMode '${socketMode.mode}', so the daemon cannot attach as an external cmux client yet.`
      : `automation.socketControlMode is '${socketMode.mode}' in ${CMUX_SETTINGS_DISCLOSURE_PATH}, so the daemon cannot attach as an external cmux client yet.`;
    return {
      name: "cmux_daemon",
      status: "warn",
      message: "Shell cmux works, but the daemon cannot control cmux.",
      reason,
      fix: `Run \`rig setup\` to set automation.socketControlMode to "automation" in ${CMUX_SETTINGS_DISCLOSURE_PATH}, then restart the daemon with \`rig daemon start\`.`,
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
    .option("--spec <path>", "Rig spec to check against the running rig of the same name (spec-vs-live topology)")
    .action(async (opts: { json?: boolean; spec?: string }) => {
      const deps: DoctorDeps = depsOverride ?? {
        exists: existsSync,
        baseDir: import.meta.dirname,
        readFile: (p: string) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
        exec: (c: string) => execSync(c, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }),
        checkPort: defaultCheckPort,
        configStore: new ConfigStore(),
        mkdirp: (dirPath: string) => mkdirSync(dirPath, { recursive: true }),
        checkWritable: (dirPath: string) => accessSync(dirPath, constants.W_OK),
        specPath: opts.spec ? path.resolve(opts.spec) : undefined,
        // Returns null on ANY failure to read the live side. The conformance check treats null as
        // "unknown" and skips — an unreachable daemon must never read as a matching topology.
        fetchLiveLogicalIds: async (rigName: string): Promise<string[] | null> => {
          try {
            const cfg = new ConfigStore().resolve();
            const base = `http://${cfg.daemon.host ?? "127.0.0.1"}:${cfg.daemon.port ?? DEFAULT_PORT}`;
            const rigsRes = await fetch(`${base}/api/rigs`);
            if (!rigsRes.ok) return null;
            const rigs = (await rigsRes.json()) as Array<{ id?: string; name?: string }>;
            const rig = rigs.find((r) => r.name === rigName);
            if (!rig?.id) return null;
            const nodesRes = await fetch(`${base}/api/rigs/${rig.id}/nodes`);
            if (!nodesRes.ok) return null;
            const nodes = (await nodesRes.json()) as Array<{ logicalId?: string | null }>;
            return nodes.map((n) => n.logicalId ?? "");
          } catch {
            return null;
          }
        },
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
