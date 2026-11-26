import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { continuationArguments, captureClaudeContinuation, resumedClaudeArguments, continuationPermission, continuationChoiceNotes, rewriteLegacyCollectorSettings, rewriteLegacyCollectorCommand } from "../src/domain/claude-continuation-launch.js";
import { managedClaudeNodeCommand } from "../src/domain/claude-activity-hooks.js";
import { throttledCollectorCommand } from "../src/domain/claude-statusline-throttle.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { readNativeProcessLaunch } from "../src/domain/native-process-arguments.js";
import { contextCollectorPath } from "../src/domain/telemetry-state-paths.js";

const help = `  --settings <file-or-json>  Settings
  --model <model>  Model
  --effort <level>  Effort
  -r, --resume [id]  Resume
  --session-id <id>  Identity
  --fork-session  Fork
  --permission-mode <mode>  Mode
  --add-dir <dirs...>  Directories
  --chrome  Chrome
  --name <name>  Name`;

it("retains quoted settings/model/options and replaces native identity without replaying the prompt", () => {
  const original = ["/native/claude", "--settings", "/my rules/settings.json", "--model=opus", "--permission-mode", "auto", "--add-dir", "/a b", "/Ω", "--chrome", "--session-id", "original", "do the startup work"];
  const launch = continuationArguments(original, help);
  expect(launch.args).toEqual(original.slice(1, -3));
  expect(launch.warnings).toEqual(["A positional startup input was not replayed."]);
  expect(resumedClaudeArguments(launch, [], "original", "high")).toEqual([...original.slice(1, -3), "--effort", "high", "--resume", "original"]);
  expect(continuationPermission(launch)).toBe("--permission-mode auto");
});

it("keeps inline JSON bytes, updates existing effort, removes fork/old resume, and names unknowns without their values", () => {
  const launch = continuationArguments(["claude", "--settings={\"permissions\":{\"allow\":[\"Read(/a b)\"]}}", "--effort=low", "--fork-session", "--resume", "old", "--future-option=private-value"], help);
  expect(resumedClaudeArguments(launch, [], "same", "max")).toEqual(["--settings={\"permissions\":{\"allow\":[\"Read(/a b)\"]}}", "--effort", "max", "--resume", "same"]);
  expect(launch.warnings).toEqual(["Running option --future-option could not be mapped; not carried."]);
  expect(continuationPermission(launch)).toBe("");
});

it("an unavailable capture uses generated arguments without a new hold", () => {
  expect(resumedClaudeArguments({ warnings: ["unavailable"] }, ["--settings", "generated", "--resume", "same"], "same")).toEqual(["--settings", "generated", "--resume", "same"]);
});

describe.skipIf(!["linux", "darwin"].includes(process.platform))("native launch capture, owned scratch process only", () => {
  it("reads exact argv/config/environment and excludes old auth from the continuation", async () => {
    const child = spawn(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000)', "a b", "Ω"], {
      env: { PATH: process.env.PATH!, HOME: "/tmp", CLAUDE_CONFIG_DIR: "/custom config", CUSTOM_SETTING: "a=b\nΩ", NPM_TOKEN: "synthetic-unrelated-secret-2853", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old-token" }, stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await once(child.stdout!, "data");
      const actual = await readNativeProcessLaunch(child.pid!);
      expect(actual?.argv.slice(-2)).toEqual(["a b", "Ω"]);
      expect(actual?.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/custom config", CUSTOM_SETTING: "a=b\nΩ" });
      const kept = await captureClaudeContinuation(child.pid!, "/definitely-unavailable-claude", async env => Object.keys(env).filter(k => k === "NPM_TOKEN"));
      expect(JSON.stringify(kept)).not.toMatch(/synthetic-unrelated-secret-2853|synthetic-old-token|a=b/);
      expect(kept.configDir).toBe("/custom config");
      expect(kept).not.toHaveProperty("env");
      expect(Object.keys(actual!.env).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CUSTOM_SETTING", "HOME", "NPM_TOKEN", "PATH"]);
      expect(kept.warnings.join(" ")).toContain("NPM_TOKEN");
      expect(kept.warnings.join(" ")).toContain("ordinary arguments");
      expect(kept.args).toBeUndefined();
      const send = vi.fn(async () => ({ ok: true as const }));
      const tmux = { sendShellCommand: send, getPaneCommand: async () => "claude", capturePaneContent: async () => "", getPanePid: async () => null, listPanes: async () => [] } as never;
      const adapter = new ClaudeCodeAdapter({ tmux, sleep: async () => {}, seatLaunchEnvironment: { command: async (_session: string, command: string) => command } as never });
      const result = await adapter.launchHarness({ id: "b", nodeId: "n", tmuxSession: "owned-fixture", updatedAt: "", cwd: "/tmp", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
        claudeExecutable: "/native/claude", claudeLaunch: kept }, { name: "owned-fixture", resumeToken: "same" });
      const dispatched = vi.mocked(send).mock.calls[0];
      expect(JSON.stringify(dispatched)).not.toMatch(/synthetic-unrelated-secret-2853|synthetic-old-token|a=b/);
      expect(JSON.stringify(result)).not.toMatch(/synthetic-unrelated-secret-2853|synthetic-old-token|a=b/);
      expect(JSON.stringify(dispatched)).toContain("CLAUDE_CONFIG_DIR");

    } finally { child.kill("SIGTERM"); await once(child, "close"); }
  }, 15_000);
});

it("carries a required option value beginning with a dash", () => {
  expect(continuationArguments(["claude", "--settings", "-rules.json", "--model", "opus"], help).args).toEqual(["--settings", "-rules.json", "--model", "opus"]);
});

it("selected posture replaces a running bypass while the running model is retained", () => {
  const launch = { args: ["--dangerously-skip-permissions", "--model", "opus", "--permission-mode=auto"], warnings: [] };
  expect(resumedClaudeArguments(launch, [], "same", "high", "--permission-mode acceptEdits")).toEqual(["--model", "opus", "--effort", "high", "--permission-mode", "acceptEdits", "--resume", "same"]);
});

it("names saved posture and model differences without changing the model", () => {
  const launch = { args: ["--dangerously-skip-permissions", "--model", "opus"], warnings: [] };
  expect(continuationChoiceNotes(launch, "--permission-mode acceptEdits", "sonnet")).toEqual([
    "The saved permission posture --permission-mode acceptEdits replaces the running --dangerously-skip-permissions.",
    "The running model opus is kept instead of the saved model sonnet.",
  ]);
  expect(continuationChoiceNotes({ args: [], warnings: [] }, "--permission-mode acceptEdits", "sonnet")).toContain("The running model (no --model flag) is kept instead of the saved model sonnet.");
});

// #3893 review: a seat launched before the collector moved (#3768) replays its captured launch arguments on a
// native resume, so a captured --settings still naming the cwd collector must be rewritten to the instance copy.
describe("rewriteLegacyCollectorSettings", () => {
  const cwd = "/seat";
  const stateDir = "/home";
  const legacy = "/seat/.openrig/context-collector.cjs";
  const current = "/home/state/claude-context-collector/context-collector.cjs";
  const contextDir = "/home/state/context-usage";
  const providerDir = "/home/state/provider-usage";
  const plainLegacy = managedClaudeNodeCommand("node", legacy, contextDir, providerDir);
  const plainCurrent = managedClaudeNodeCommand("node", current, contextDir, providerDir);
  const throttledLegacy = throttledCollectorCommand({ collectorCommand: plainLegacy, contextDir, sessionName: "dev", seconds: 30 });
  const throttledCurrent = throttledCollectorCommand({ collectorCommand: plainCurrent, contextDir, sessionName: "dev", seconds: 30 });

  function settingsJson(command: string) {
    return JSON.stringify({ permissions: { allow: ["Read"] }, statusLine: { type: "command", command }, autoMode: { block: "off" } });
  }

  it("rewrites a plain legacy collector command inside inline --settings, keeping the other keys", () => {
    const args = ["--model", "opus", "--settings", settingsJson(plainLegacy), "--resume", "same"];
    const rewritten = rewriteLegacyCollectorSettings(args, { cwd, stateDir });
    expect(JSON.parse(rewritten[3]!).statusLine.command).toBe(plainCurrent);
    expect(JSON.parse(rewritten[3]!).permissions).toEqual({ allow: ["Read"] });
    expect(JSON.parse(rewritten[3]!).autoMode).toEqual({ block: "off" });
    expect(rewritten.slice(0, 2)).toEqual(["--model", "opus"]);
    expect(rewritten[4]).toBe("--resume");
  });

  it("rewrites the legacy script inside a throttled wrapper, leaving the throttle check alone", () => {
    const args = [`--settings=${settingsJson(throttledLegacy)}`];
    const rewritten = rewriteLegacyCollectorSettings(args, { cwd, stateDir });
    expect(JSON.parse(rewritten[0]!.slice("--settings=".length)).statusLine.command).toBe(throttledCurrent);
  });

  it.each(["owned legacy", "user wrapper"])("cleans up a legacy file only when replay repoints its owned command: %s", (kind) => {
    const folder = mkdtempSync(join(tmpdir(), "continuation-collector-"));
    try {
      const legacyDir = join(folder, ".openrig");
      const script = join(legacyDir, "context-collector.cjs");
      mkdirSync(legacyDir);
      writeFileSync(script, "// older collector\n");
      const command = kind === "owned legacy" ? managedClaudeNodeCommand("node", script, contextDir, providerDir)
        : `sh './my-wrapper.sh' '${script}'`;
      const args = ["--settings", settingsJson(command)];

      const rewritten = rewriteLegacyCollectorSettings(args, { cwd: folder, stateDir });

      if (kind === "owned legacy") {
        expect(JSON.parse(rewritten[1]!).statusLine.command).toBe(managedClaudeNodeCommand("node", contextCollectorPath(stateDir), contextDir, providerDir));
        expect(existsSync(script)).toBe(false);
        expect(existsSync(legacyDir)).toBe(false);
      } else {
        expect(rewritten).toEqual(args);
        expect(readFileSync(script, "utf8")).toBe("// older collector\n");
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it("leaves an already-moved command, a user's own command and foreign settings alone", () => {
    const user = `echo '${legacy}'`;
    const composed = `${plainLegacy} | cat`;
    const args = ["--settings", settingsJson(plainCurrent), "--settings", settingsJson(user), "--settings", settingsJson(composed),
      "--settings", "/someone/else.json", "--model", "opus"];
    expect(rewriteLegacyCollectorSettings(args, { cwd, stateDir })).toEqual(args);
  });

  it("leaves arguments without a --settings value alone", () => {
    const args = ["--model", "opus", "--permission-mode", "auto"];
    expect(rewriteLegacyCollectorSettings(args, { cwd, stateDir })).toEqual(args);
  });

  it("rewrites one legacy command per settings value, and nothing else", () => {
    expect(rewriteLegacyCollectorCommand(plainLegacy, legacy, current)).toBe(plainCurrent);
    expect(rewriteLegacyCollectorCommand(throttledLegacy, legacy, current)).toBe(throttledCurrent);
    expect(rewriteLegacyCollectorCommand(plainCurrent, legacy, current)).toBeNull();
    expect(rewriteLegacyCollectorCommand(`echo '${legacy}'`, legacy, current)).toBeNull();
  });
});
