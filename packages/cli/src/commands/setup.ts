import { Command } from "commander";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";
import { runDoctorChecks, type DoctorDeps } from "./doctor.js";
import { resolveDaemonPath } from "../daemon-lifecycle.js";
import { ConfigStore } from "../config-store.js";

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
  runtime: "claude-code" | "codex";
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
  exec: (cmd: string) => string;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  exists: (path: string) => boolean;
  platform?: NodeJS.Platform;
}

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
const RUNTIME_CONFIG_DISCLOSURE: RuntimeConfigDisclosure[] = [
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

function defaultDeps(): SetupDeps {
  return {
    exec: (cmd: string) => execSync(cmd, { encoding: "utf-8", timeout: 30_000 }),
    readFile: (p: string) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
    writeFile: (p: string, c: string) => writeFileSync(p, c, "utf-8"),
    exists: (p: string) => existsSync(p),
  };
}

export async function runSetup(deps: SetupDeps, opts: { dryRun?: boolean; full?: boolean; doctorDeps?: DoctorDeps }): Promise<SetupResult> {
  const profile = opts.full ? "full" : "core";
  const platform = deps.platform ?? process.platform;
  const stepIds = opts.full ? [...CORE_STEP_IDS, ...FULL_EXTRA_STEP_IDS] : [...CORE_STEP_IDS];
  const steps: SetupStep[] = [];

  if (opts.dryRun) {
    for (const id of stepIds) {
      steps.push({ id, status: "skipped", message: `Dry run: ${id} would be attempted.` });
    }
    return { profile, platform, ready: false, steps, runtimeConfig: RUNTIME_CONFIG_DISCLOSURE };
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
        deps.exec("brew install tmux");
        steps.push({ id: "tmux_install", status: "applied", message: "Installed tmux with Homebrew." });
      } catch (err) {
        steps.push({ id: "tmux_install", status: "fail", message: `Failed to install tmux: ${(err as Error).message}` });
      }
    }
  }

  // 3. cmux
  try {
    deps.exec("cmux capabilities --json");
    steps.push({ id: "cmux_install", status: "pass", message: "cmux available." });
  } catch {
    try {
      deps.exec("cmux --help");
      steps.push({ id: "cmux_install", status: "warn", message: "cmux installed but control unavailable.", fixHint: "Open cmux and enable socket control." });
    } catch {
      if (!brewOk) {
        steps.push({ id: "cmux_install", status: "skipped", message: "Skipped: Homebrew not available." });
      } else {
        try {
          deps.exec("brew install --cask cmux");
          steps.push({ id: "cmux_install", status: "applied", message: "Installed cmux with Homebrew." });
        } catch {
          steps.push({ id: "cmux_install", status: "warn", message: "cmux not installed. Open CMUX workflows will be unavailable.", fixHint: "Install cmux manually if needed." });
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
      deps.exec("npm install -g @anthropic-ai/claude-code");
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
      deps.exec("npm install -g @openai/codex");
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
            deps.exec(`brew install ${tool.brew}`);
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
  return { profile, platform, ready, steps, runtimeConfig: RUNTIME_CONFIG_DISCLOSURE, ...(verification ? { verification } : {}) };
}

function buildDefaultDoctorDeps(setupDeps: SetupDeps): DoctorDeps {
  const platform = setupDeps.platform ?? process.platform;
  const baseDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  return {
    exists: setupDeps.exists,
    baseDir,
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
