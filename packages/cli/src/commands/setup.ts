import { Command } from "commander";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";
import { runDoctorChecks, type DoctorDeps } from "./doctor.js";
import { resolveDaemonPath } from "../daemon-lifecycle.js";
import { ConfigStore } from "../config-store.js";
import {
  CMUX_SETTINGS_DISCLOSURE_PATH,
  isCmuxSocketControlCompatible,
  readCmuxSocketControlModeFromText,
  resolveCmuxSettingsPath,
  upsertCmuxSocketControlMode,
} from "../cmux-config.js";

export interface SetupStep {
  id: string;
  status: "pass" | "applied" | "warn" | "fail" | "skipped";
  message: string;
  reason?: string;
  fixHint?: string;
}

export interface VerificationCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skipped";
  message: string;
  reason?: string;
  fix?: string;
}

export interface RuntimeConfigDisclosure {
  scope: "global" | "project";
  runtime: "claude-code" | "codex" | "cmux";
  path: string;
  purpose: string;
}

export interface SetupResult {
  profile: "core" | "full";
  platform: string;
  ready: boolean;
  steps: SetupStep[];
  runtimeConfig: RuntimeConfigDisclosure[];
  verification?: {
    checks: VerificationCheck[];
  };
}

export interface SetupDeps {
  exec: (cmd: string, opts?: { timeoutMs?: number }) => string;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  exists: (path: string) => boolean;
  mkdirp?: (path: string) => void;
  platform?: NodeJS.Platform;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const INSTALL_COMMAND_TIMEOUT_MS = 5 * 60_000;
const CMUX_READY_ATTEMPTS = 5;
const CMUX_READY_DELAY_MS = 1_000;

const CORE_STEP_IDS = [
  "brew",
  "tmux_install",
  "cmux_install",
  "claude_install",
  "claude_auth",
  "codex_install",
  "codex_auth",
  "tmux_config",
  "verify",
];
const FULL_EXTRA_STEP_IDS = ["jq_install", "gh_install"];
const BASE_RUNTIME_CONFIG_DISCLOSURE: RuntimeConfigDisclosure[] = [
  {
    scope: "global",
    runtime: "claude-code",
    path: "~/.claude/settings.json",
    purpose: "Allow OpenRig commands without Claude permission prompts.",
  },
  {
    scope: "global",
    runtime: "claude-code",
    path: "~/.claude.json",
    purpose: "Pre-trust managed workspaces and mark Claude onboarding complete.",
  },
  {
    scope: "project",
    runtime: "claude-code",
    path: ".claude/settings.local.json",
    purpose: "Apply managed-session Claude permissions and context-collector statusLine config within the project.",
  },
  {
    scope: "project",
    runtime: "claude-code",
    path: ".mcp.json",
    purpose: "Configure project-local MCP servers for Claude-managed workspaces.",
  },
  {
    scope: "global",
    runtime: "codex",
    path: "~/.codex/config.toml",
    purpose: "Pre-trust managed workspaces and configure Codex MCP servers.",
  },
];

const DARWIN_RUNTIME_CONFIG_DISCLOSURE: RuntimeConfigDisclosure = {
  scope: "global",
  runtime: "cmux",
  path: CMUX_SETTINGS_DISCLOSURE_PATH,
  purpose: "Set cmux socket control to an OpenRig-compatible automation mode.",
};

function defaultDeps(): SetupDeps {
  return {
    exec: (cmd: string, opts?: { timeoutMs?: number }) =>
      execSync(cmd, {
        encoding: "utf-8",
        timeout: opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      }),
    readFile: (p: string) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
    writeFile: (p: string, c: string) => writeFileSync(p, c, "utf-8"),
    exists: (p: string) => existsSync(p),
    mkdirp: (p: string) => mkdirSync(p, { recursive: true }),
  };
}

function installCommand(deps: SetupDeps, cmd: string): string {
  return deps.exec(cmd, { timeoutMs: INSTALL_COMMAND_TIMEOUT_MS });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCmuxCapabilities(deps: SetupDeps, attempts = CMUX_READY_ATTEMPTS): Promise<boolean> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      deps.exec("cmux capabilities --json");
      return true;
    } catch {
      if (index < attempts - 1) {
        await sleep(CMUX_READY_DELAY_MS);
      }
    }
  }
  return false;
}

async function tryEnableCmuxControl(deps: SetupDeps, platform: NodeJS.Platform): Promise<boolean> {
  if (platform !== "darwin") return false;

  const settingsPath = resolveCmuxSettingsPath();
  const settingsText = deps.readFile(settingsPath);
  const currentMode = readCmuxSocketControlModeFromText(settingsText);
  if (currentMode.error) {
    return false;
  }

  try {
    deps.mkdirp?.(path.dirname(settingsPath));
    const next = upsertCmuxSocketControlMode(settingsText, "automation");
    if (next.changed) {
      deps.writeFile(settingsPath, next.content);
    }
  } catch {
    return false;
  }

  const shellReady = await waitForCmuxCapabilities(deps, 1);
  if (shellReady) {
    try {
      deps.exec("cmux reload-config");
    } catch {
      // Best effort: if reload fails, the daemon-side verification will surface it honestly.
    }
    return waitForCmuxCapabilities(deps, 1);
  }

  try {
    deps.exec("open -a /Applications/cmux.app");
  } catch {
    // Best effort: cmux may already be running or the app open may be blocked; capability probe decides readiness.
  }

  return waitForCmuxCapabilities(deps);
}

function buildRuntimeConfigDisclosure(platform: NodeJS.Platform): RuntimeConfigDisclosure[] {
  return platform === "darwin"
    ? [...BASE_RUNTIME_CONFIG_DISCLOSURE, DARWIN_RUNTIME_CONFIG_DISCLOSURE]
    : [...BASE_RUNTIME_CONFIG_DISCLOSURE];
}

async function probeDaemonCmuxStatus(doctorDeps?: DoctorDeps): Promise<"available" | "unavailable" | "skipped"> {
  const fetchFn = doctorDeps?.fetch;
  if (!fetchFn) return "skipped";
  const config = doctorDeps.configStore.resolve();
  const host = config.daemon.host;
  const port = config.daemon.port;

  try {
    const healthRes = await fetchFn(`http://${host}:${port}/healthz`);
    if (!healthRes.ok) return "skipped";
  } catch {
    return "skipped";
  }

  try {
    const cmuxRes = await fetchFn(`http://${host}:${port}/api/adapters/cmux/status`);
    if (!cmuxRes.ok || !cmuxRes.json) return "unavailable";
    const data = (await cmuxRes.json()) as { available?: boolean };
    return data.available ? "available" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function runSetup(deps: SetupDeps, opts: { dryRun?: boolean; full?: boolean; doctorDeps?: DoctorDeps }): Promise<SetupResult> {
  const profile = opts.full ? "full" : "core";
  const platform = deps.platform ?? process.platform;
  const runtimeConfig = buildRuntimeConfigDisclosure(platform);
  const stepIds = opts.full ? [...CORE_STEP_IDS, ...FULL_EXTRA_STEP_IDS] : [...CORE_STEP_IDS];
  const steps: SetupStep[] = [];

  if (opts.dryRun) {
    for (const id of stepIds) {
      steps.push({ id, status: "skipped", message: `Dry run: ${id} would be attempted.` });
    }
    return { profile, platform, ready: false, steps, runtimeConfig };
  }

  // Core steps
  // 1. Homebrew (macOS-first setup path)
  let brewOk = false;
  if (platform !== "darwin") {
    steps.push({
      id: "brew",
      status: "skipped",
      message: "Skipped: Homebrew setup path is only used on macOS.",
    });
  } else {
    try {
      deps.exec("brew --version");
      brewOk = true;
      steps.push({ id: "brew", status: "pass", message: "Homebrew available." });
    } catch {
      steps.push({
        id: "brew",
        status: "fail",
        message: "Homebrew not found.",
        reason: "Homebrew is required to install tmux and cmux on macOS.",
        fixHint: "Install Homebrew: https://brew.sh",
      });
    }
  }

  // 2. tmux
  try {
    deps.exec("tmux -V");
    steps.push({ id: "tmux_install", status: "pass", message: "tmux available." });
  } catch {
    if (!brewOk) {
      steps.push({ id: "tmux_install", status: "skipped", message: "Skipped: Homebrew not available.", reason: "tmux install requires Homebrew." });
    } else {
      try {
        installCommand(deps, "brew install tmux");
        steps.push({ id: "tmux_install", status: "applied", message: "Installed tmux with Homebrew." });
      } catch (err) {
        steps.push({ id: "tmux_install", status: "fail", message: `Failed to install tmux: ${(err as Error).message}` });
      }
    }
  }

  // 3. cmux
  const daemonCmuxBefore = await probeDaemonCmuxStatus(opts.doctorDeps);
  if (await waitForCmuxCapabilities(deps, 1)) {
    const socketMode = readCmuxSocketControlModeFromText(deps.readFile(resolveCmuxSettingsPath()));
    if (platform === "darwin" && socketMode.error) {
      steps.push({
        id: "cmux_install",
        status: "fail",
        message: "cmux settings file is unreadable.",
        reason: `OpenRig could not parse ${CMUX_SETTINGS_DISCLOSURE_PATH}: ${socketMode.error}`,
        fixHint: "Repair or remove the cmux settings file, then rerun `rig setup`.",
      });
    } else if (platform === "darwin" && !isCmuxSocketControlCompatible(socketMode.mode)) {
      if (await tryEnableCmuxControl(deps, platform)) {
        const daemonCmuxAfter = await probeDaemonCmuxStatus(opts.doctorDeps);
        if (daemonCmuxAfter === "unavailable") {
          steps.push({
            id: "cmux_install",
            status: "fail",
            message: "OpenRig updated cmux settings, but the running daemon still cannot control cmux.",
            reason: "The cmux settings file is now compatible, so the remaining blocker is in the live daemon/cmux session state.",
            fixHint: "Restart the daemon with `rig daemon start`, then rerun `rig doctor` to confirm cmux daemon control.",
          });
        } else {
          steps.push({
            id: "cmux_install",
            status: "applied",
            message: "Normalized cmux socket control to automation mode in ~/.config/cmux/settings.json.",
          });
        }
      } else {
        steps.push({
          id: "cmux_install",
          status: "fail",
          message: "cmux shell control works, but OpenRig could not normalize cmux socket control.",
          reason: "OpenRig needs a compatible cmux socket control mode so the daemon can open CMUX surfaces reliably.",
          fixHint: `Set automation.socketControlMode to "automation" in ${CMUX_SETTINGS_DISCLOSURE_PATH}, then rerun \`rig setup\` or \`rig doctor\`.`,
        });
      }
    } else if (daemonCmuxBefore === "unavailable") {
      steps.push({
        id: "cmux_install",
        status: "fail",
        message: "cmux shell control works, but the running daemon still cannot control cmux.",
        reason: "Current cmux settings already look compatible, so the remaining blocker is outside the cmux settings file OpenRig can repair automatically.",
        fixHint: "Run `rig doctor` for the exact daemon cmux diagnosis, then restart the daemon after clearing the underlying blocker.",
      });
    } else {
      steps.push({ id: "cmux_install", status: "pass", message: "cmux available." });
    }
  } else {
    try {
      deps.exec("cmux --help");

      if (await tryEnableCmuxControl(deps, platform)) {
        const daemonCmuxAfter = await probeDaemonCmuxStatus(opts.doctorDeps);
        if (daemonCmuxAfter === "unavailable") {
          steps.push({
            id: "cmux_install",
            status: "fail",
            message: "OpenRig enabled cmux socket control, but the running daemon still cannot control cmux.",
            reason: "The cmux app and settings are now in place, so the remaining blocker is in the live daemon/cmux session state.",
            fixHint: "Restart the daemon with `rig daemon start`, then rerun `rig doctor` to confirm cmux daemon control.",
          });
        } else {
          steps.push({
            id: "cmux_install",
            status: "applied",
            message: "Enabled cmux socket control in ~/.config/cmux/settings.json.",
          });
        }
      } else {
        steps.push({
          id: "cmux_install",
          status: platform === "darwin" ? "fail" : "warn",
          message: "cmux installed but control unavailable.",
          reason: "Open CMUX workflows need cmux socket control to be enabled.",
          fixHint: platform === "darwin"
            ? `Set automation.socketControlMode to "automation" in ${CMUX_SETTINGS_DISCLOSURE_PATH}, then rerun \`rig setup\` or \`rig doctor\`.`
            : "Open cmux, approve any first-run prompts, and rerun `rig setup` or `rig doctor`.",
        });
      }
    } catch {
      if (!brewOk) {
        steps.push({ id: "cmux_install", status: "skipped", message: "Skipped: Homebrew not available." });
      } else {
        try {
          installCommand(deps, "brew install --cask cmux");
          if (await tryEnableCmuxControl(deps, platform) || await waitForCmuxCapabilities(deps, 1)) {
            steps.push({ id: "cmux_install", status: "applied", message: "Installed cmux with Homebrew." });
          } else {
            steps.push({
              id: "cmux_install",
              status: platform === "darwin" ? "fail" : "warn",
              message: "Installed cmux, but control is still unavailable.",
              reason: "Open CMUX workflows need the cmux app to expose socket control after installation.",
              fixHint: "Open cmux, approve any first-run prompts, and rerun `rig setup` or `rig doctor`.",
            });
          }
        } catch (err) {
          steps.push({
            id: "cmux_install",
            status: "fail",
            message: `Failed to install cmux: ${(err as Error).message}`,
            reason: "Open CMUX workflows stay unavailable until the cmux app and CLI are installed.",
            fixHint: "Retry `brew install --cask cmux` after connectivity stabilizes, or install cmux manually.",
          });
        }
      }
    }
  }

  // 4. tmux config
  // 4. Claude Code runtime
  let claudeInstalled = false;
  try {
    deps.exec("claude --version");
    claudeInstalled = true;
    steps.push({ id: "claude_install", status: "pass", message: "Claude Code available." });
  } catch {
    try {
      installCommand(deps, "npm install -g @anthropic-ai/claude-code");
      deps.exec("claude --version");
      claudeInstalled = true;
      steps.push({ id: "claude_install", status: "applied", message: "Installed Claude Code with npm." });
    } catch (err) {
      steps.push({
        id: "claude_install",
        status: "fail",
        message: `Failed to install Claude Code: ${(err as Error).message}`,
        reason: "The demo rig launches Claude Code nodes, so the Claude CLI must be installed on this machine.",
        fixHint: "Install Claude Code with `npm install -g @anthropic-ai/claude-code`.",
      });
    }
  }

  if (claudeInstalled) {
    try {
      deps.exec("claude auth status");
      steps.push({ id: "claude_auth", status: "pass", message: "Claude Code authentication available." });
    } catch (err) {
      steps.push({
        id: "claude_auth",
        status: "fail",
        message: `Claude Code is installed but not ready to launch: ${(err as Error).message}`,
        reason: "The demo rig cannot launch Claude Code nodes until the Claude CLI is logged in and usable.",
        fixHint: "Run `claude auth login` or open `claude` once to complete authentication, then rerun `rig setup` or `rig doctor`.",
      });
    }
  } else {
    steps.push({
      id: "claude_auth",
      status: "skipped",
      message: "Skipped: Claude Code is not installed.",
      reason: "Authentication cannot be checked until the Claude Code CLI is installed.",
    });
  }

  // 5. Codex runtime
  let codexInstalled = false;
  try {
    deps.exec("codex --version");
    codexInstalled = true;
    steps.push({ id: "codex_install", status: "pass", message: "Codex available." });
  } catch {
    try {
      installCommand(deps, "npm install -g @openai/codex");
      deps.exec("codex --version");
      codexInstalled = true;
      steps.push({ id: "codex_install", status: "applied", message: "Installed Codex with npm." });
    } catch (err) {
      steps.push({
        id: "codex_install",
        status: "fail",
        message: `Failed to install Codex: ${(err as Error).message}`,
        reason: "The demo rig launches Codex nodes, so the Codex CLI must be installed on this machine.",
        fixHint: "Install Codex with `npm install -g @openai/codex`.",
      });
    }
  }

  if (codexInstalled) {
    try {
      deps.exec("codex login status");
      steps.push({ id: "codex_auth", status: "pass", message: "Codex authentication available." });
    } catch (err) {
      steps.push({
        id: "codex_auth",
        status: "fail",
        message: `Codex is installed but not ready to launch: ${(err as Error).message}`,
        reason: "The demo rig cannot launch Codex nodes until the Codex CLI is logged in and usable.",
        fixHint: "Run `codex login` and complete authentication, then rerun `rig setup` or `rig doctor`.",
      });
    }
  } else {
    steps.push({
      id: "codex_auth",
      status: "skipped",
      message: "Skipped: Codex is not installed.",
      reason: "Authentication cannot be checked until the Codex CLI is installed.",
    });
  }

  // 6. tmux config
  const TMUX_CONF = `${process.env["HOME"] ?? "~"}/.tmux.conf`;
  const MANAGED_MARKER = "# OpenRig managed block";
  const MANAGED_BLOCK = [
    MANAGED_MARKER,
    "set -g mouse on",
    "set -g history-limit 50000",
    `# End ${MANAGED_MARKER}`,
  ].join("\n");

  try {
    const existing = deps.readFile(TMUX_CONF);
    if (existing && existing.includes(MANAGED_MARKER)) {
      // Replace existing managed block
      const replaced = existing.replace(
        new RegExp(`${MANAGED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?# End ${MANAGED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        MANAGED_BLOCK,
      );
      deps.writeFile(TMUX_CONF, replaced);
      steps.push({ id: "tmux_config", status: "applied", message: "Updated OpenRig managed tmux config block." });
    } else if (existing) {
      deps.writeFile(TMUX_CONF, existing.trimEnd() + "\n\n" + MANAGED_BLOCK + "\n");
      steps.push({ id: "tmux_config", status: "applied", message: "Appended OpenRig managed tmux config block." });
    } else {
      deps.writeFile(TMUX_CONF, MANAGED_BLOCK + "\n");
      steps.push({ id: "tmux_config", status: "applied", message: "Created .tmux.conf with OpenRig managed block." });
    }
  } catch (err) {
    steps.push({ id: "tmux_config", status: "warn", message: `Could not update tmux config: ${(err as Error).message}` });
  }

  // 7. Verify
  const tmuxOk = steps.some((s) => s.id === "tmux_install" && (s.status === "pass" || s.status === "applied"));
  const anyFail = steps.some((s) => s.status === "fail");
  steps.push({
    id: "verify",
    status: anyFail ? "warn" : "pass",
    message: anyFail ? "Some setup steps failed. Run `rig doctor` for detailed diagnostics." : "Core setup verified.",
  });

  // Full profile extras
  if (opts.full) {
    for (const tool of [{ id: "jq_install", cmd: "jq", brew: "jq" }, { id: "gh_install", cmd: "gh", brew: "gh" }]) {
      try {
        deps.exec(`${tool.cmd} --version`);
        steps.push({ id: tool.id, status: "pass", message: `${tool.cmd} available.` });
      } catch {
        if (!brewOk) {
          steps.push({ id: tool.id, status: "skipped", message: `Skipped: Homebrew not available.` });
        } else {
          try {
            installCommand(deps, `brew install ${tool.brew}`);
            steps.push({ id: tool.id, status: "applied", message: `Installed ${tool.cmd} with Homebrew.` });
          } catch {
            steps.push({ id: tool.id, status: "warn", message: `Failed to install ${tool.cmd}.`, fixHint: `Install ${tool.cmd} manually.` });
          }
        }
      }
    }
  }

  // Run doctor-backed verification if not dry-run and doctorDeps available
  let verification: SetupResult["verification"];
  if (!opts.dryRun && opts.doctorDeps) {
    const doctorDeps = opts.doctorDeps;
    const doctor = runDoctorChecks(doctorDeps);
    const asyncResults = await Promise.all(doctor.asyncChecks);
    const allDoctorChecks = [...doctor.checks, ...asyncResults];
    verification = {
      checks: allDoctorChecks.map((c) => ({
        name: c.name,
        status: c.status,
        message: c.message,
        ...(c.reason ? { reason: c.reason } : {}),
        ...(c.fix ? { fix: c.fix } : {}),
      })),
    };
  }

  // ready = no fail statuses in steps or verification checks
  const stepsFailed = steps.some((s) => s.status === "fail");
  const verificationFailed = verification?.checks.some((c) => c.status === "fail") ?? false;
  const ready = !stepsFailed && !verificationFailed;
  return { profile, platform, ready, steps, runtimeConfig, ...(verification ? { verification } : {}) };
}

function buildDefaultDoctorDeps(setupDeps: SetupDeps): DoctorDeps {
  const platform = setupDeps.platform ?? process.platform;
  const baseDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  return {
    exists: setupDeps.exists,
    baseDir,
    readFile: setupDeps.readFile,
    exec: setupDeps.exec,
    checkPort: async (port: number) => {
      const net = await import("node:net");
      return new Promise<boolean>((resolve) => {
        const socket = new net.default.Socket();
        socket.once("connect", () => { socket.destroy(); resolve(false); });
        socket.once("error", () => resolve(true));
        socket.connect(port, "127.0.0.1");
      });
    },
    configStore: new ConfigStore(),
    platform: platform as NodeJS.Platform,
    mkdirp: (p: string) => mkdirSync(p, { recursive: true }),
    checkWritable: (p: string) => accessSync(p, constants.W_OK),
    fetch: globalThis.fetch,
  };
}

export function setupCommand(depsOverride?: SetupDeps): Command {
  const cmd = new Command("setup").description("Prepare the machine for OpenRig");

  cmd
    .option("--dry-run", "Show the plan without making changes")
    .option("--json", "Machine-readable JSON output")
    .option("--full", "Install broader operator workstation tools")
    .action(async (opts: { dryRun?: boolean; json?: boolean; full?: boolean }) => {
      const deps = depsOverride ?? defaultDeps();
      const doctorDeps = opts.dryRun ? undefined : buildDefaultDoctorDeps(deps);
      const result = await runSetup(deps, { dryRun: opts.dryRun, full: opts.full, doctorDeps });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!opts.dryRun && !result.ready) process.exitCode = 1;
        return;
      }

      console.log(`\nProfile: ${result.profile}`);
      console.log(`Platform: ${result.platform}\n`);
      console.log("OpenRig may modify runtime config in these locations:");
      for (const item of result.runtimeConfig) {
        console.log(`  - [${item.scope}] ${item.runtime} ${item.path} — ${item.purpose}`);
      }
      console.log("  - Note: already-running adopted sessions may need restart to pick up runtime config changes.\n");

      for (const step of result.steps) {
        const icon = step.status === "pass" ? "OK" : step.status === "applied" ? "APPLIED" : step.status === "warn" ? "WARN" : step.status === "skipped" ? "SKIP" : "FAIL";
        console.log(`  [${icon}] ${step.id}: ${step.message}`);
        if (step.reason) console.log(`       Why: ${step.reason}`);
        if (step.fixHint) console.log(`       Fix: ${step.fixHint}`);
      }

      console.log(`\n${result.ready ? "Setup complete." : "Some steps need attention. Run `rig doctor` for detailed diagnostics."}`);
      if (!opts.dryRun && !result.ready) process.exitCode = 1;
    });

  return cmd;
}
